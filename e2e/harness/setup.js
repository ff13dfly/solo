/**
 * jest globalSetup — 整栈 bring-up(§6,移植自 api/tests/e2e/setup.js).
 *
 * 顺序:Redis(自起或复用)→ 清 ERROR:QUEUE + 注入 admin 会话 → 起 Router
 *      → 起 profile 内各服务 → system.service.add 注册 → (full)播 bot token
 *      → 写 context + pids 文件.
 *
 * profile(E2E_PROFILE,默认 lite):
 *   lite = [user, collection],workers 全关,无 bot,纯 redis-server 即可.
 *   full = 整栈 + workers + bot token(需 redis-stack).
 *
 * external 哨兵:探到端口已起则复用(pid 记 'external',teardown 不杀).
 * 进程/redis pid 写 os.tmpdir()/solo-e2e-pids.json 供 teardown(独立进程)读.
 */
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createClient } = require('redis');

const { API_DIR, SERVICES, PROFILES, PORT_OFFSET } = require('./catalog');
const ctxFile = require('../lib/context');
const { ADMIN_TOKEN } = require('./identity');
const { WL_KEY, TASK_WHITELIST_SUPERSET } = require('../lib/whitelist');
const { BOT_PERMITS } = require('../../deploy/bot-permits');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6699';
const ROUTER_PORT = parseInt(process.env.ROUTER_PORT || String(8600 + PORT_OFFSET), 10);
const ROUTER_RPC = `http://localhost:${ROUTER_PORT}/`;
const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const PID_FILE = path.join(os.tmpdir(), 'solo-e2e-pids.json');

const pids = { redis: null, services: {} };   // value: number | 'external'

// ── network helpers ─────────────────────────────────────────────────────────

function post(url, body, token = null) {
    return new Promise((resolve, reject) => {
        const raw = JSON.stringify(body);
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const req = http.request(url, { method: 'POST', headers }, (res) => {
            let d = ''; res.on('data', (c) => (d += c));
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(raw); req.end();
    });
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 3000 }, (res) => {
            let d = ''; res.on('data', (c) => (d += c));
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function pingRpc(url) {
    try { const r = await post(url, { jsonrpc: '2.0', method: 'ping', params: {}, id: 1 }); return r.status === 200; }
    catch { return false; }
}

// 通用就绪探针:TCP 端口可连(服务都在 init 完成后才 listen,故端口开≈就绪).
function portOpen(port) {
    return new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
        sock.on('error', () => resolve(false));
        sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
    });
}

// administrator 是特例:只有 POST /jsonrpc(无 /auth/seed),由 Router ensureAdministratorService 自动纳管.
function readyProbe(name, port) {
    if (name === 'administrator') return () => portOpen(port);
    return () => httpGet(`http://localhost:${port}/auth/seed`).then((r) => r.status === 200).catch(() => false);
}

// node-redis v4 默认 reconnectStrategy 会对拒绝连接无限重试(connect() 永不抛)→ 探针必须 fail-fast.
// 且必须挂 'error' 监听,否则未处理的 error 事件会让进程行为异常.
function mkClient(failFast = false) {
    const opts = { url: REDIS_URL };
    if (failFast) opts.socket = { reconnectStrategy: false, connectTimeout: 1500 };
    const c = createClient(opts);
    c.on('error', () => { /* swallow — connect()/probe 的抛错才是信号 */ });
    return c;
}

async function redisAlive() {
    const c = mkClient(true);
    try { await c.connect(); await c.ping(); await c.quit(); return true; }
    catch { try { await c.quit(); } catch {} return false; }
}

async function waitFor(label, probe, timeoutMs = 25_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await probe()) return;
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`[E2E] ${label} not ready within ${timeoutMs}ms`);
}

// ── spawning ────────────────────────────────────────────────────────────────

function spawnNode(label, entryPath, env = {}) {
    const proc = spawn(process.execPath, [entryPath], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
    });
    proc.stdout.on('data', (d) => process.stdout.write(`  [${label}] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`  [${label}:err] ${d}`));
    proc.on('error', () => { /* ENOENT etc — readiness probe will time out and surface it */ });
    return proc;
}

// Run a one-shot node script to completion (mock bootstrap / workflow injection).
function runNodeOnce(label, entryPath, env = {}, args = []) {
    return new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [entryPath, ...args], {
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', (d) => process.stdout.write(`  [${label}] ${d}`));
        proc.stderr.on('data', (d) => process.stderr.write(`  [${label}:err] ${d}`));
        proc.on('error', reject);
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited ${code}`))));
    });
}

async function startRedisIfNeeded(dataDir) {
    if (await redisAlive()) { pids.redis = 'external'; console.log(`[E2E] Redis already up at ${REDIS_URL}.`); return; }
    const port = (REDIS_URL.match(/:(\d+)/) || [])[1] || '6699';
    // 优先 redis-stack(RedisJSON)——即便 lite,user/collection 的 SYSTEM:SEMANTIC 也走 JSON.SET,
    // 纯 redis-server 会让 boot 期 JSON.SET 失败、污染 ERROR:QUEUE.
    //
    // --dir 必须显式指到 per-run 空目录:redis-stack-server 不给 --dir 时会用它
    // conf 里的共享持久化目录(/opt/homebrew/var/db/redis-stack),启动即加载几百 MB
    // 的陈年 dump —— ① 就绪探针超时 → 静默退化到纯 redis-server(无 RedisJSON,
    // 全栈 JSON 写悄悄失败);② 即便加载成功,"全新 Redis"里其实灌满了旧 dev 状态。
    const candidates = ['redis-stack-server', 'redis-server'];
    for (const bin of candidates) {
        const args = ['--port', port, '--save', '', '--appendonly', 'no'];
        if (dataDir) { fs.mkdirSync(dataDir, { recursive: true }); args.push('--dir', dataDir); }
        const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'], detached: false });
        let failed = false;
        proc.on('error', () => { failed = true; });
        try {
            await waitFor(`Redis(${bin})`, redisAlive, 15000);
            pids.redis = proc.pid;
            console.log(`[E2E] Started ${bin} on ${port} (pid ${proc.pid}).`);
            if (PROFILE === 'full' && bin !== 'redis-stack-server') {
                console.warn(`[E2E] WARNING: full profile wants redis-stack (RedisJSON); started ${bin} — orchestrator/storage may fail.`);
            }
            return;
        } catch {
            try { proc.kill('SIGTERM'); } catch {}
            if (!failed) { /* started but never became ready — try next */ }
        }
    }
    throw new Error(`[E2E] Redis not reachable at ${REDIS_URL} and could not start redis-server/redis-stack-server.\n  Start it: redis-server --port ${port} --save "" --daemonize yes`);
}

// ── full-profile bot tokens(§6 step 4 / §13 决策 1:RPC 真链路) ───────────────

// 事件注册表覆盖(full):让 collection/market 的 _event piggyback 过 Router 白名单.
// 缺这俩 source → checkRegistry BLOCKED → EVENT:* 流为空(events.js:113).
// 与 deploy/mock/inject-workflows.js 的 FIXTURE_REGISTRY 一致(stream→[type]).
const FIXTURE_REGISTRY = {
    collection: { 'EVENT:PAYMENT:RECEIVED': ['payment.received'], 'EVENT:PAYMENT:SETTLED': ['payment.settled'] },
    market:     { 'EVENT:SHIPMENT:CREATED': ['shipment.created'], 'EVENT:SHIPMENT:SHIPPED': ['shipment.shipped'] },
    // ingress 经 system.ingress bot 的 event.emit 发 EVENT:WEBHOOK:{source}(33-ingress 需要).
    'system.ingress': { 'EVENT:WEBHOOK:*': ['webhook.received'] },
    // nexus scheduler 经 system.nexus bot emit_event(51-scheduler 用 EVENT:E2E:* 测).
    'system.nexus': { 'EVENT:E2E:*': ['*'] },
    // fulfillment 每次状态转换后经 system.fulfillment bot emit EVENT:FULFILLMENT:TRANSITIONED.
    'system.fulfillment': { 'EVENT:FULFILLMENT:*': ['*'] },
    // e2e-admin 的测试流(94-event-id-dedup 直接 event.emit 验 Router 的 event_id 去重)。
    'e2e-admin': { 'EVENT:E2EDEDUP:*': ['e2e.dedup'] },
};

async function seedBots() {
    // permit 覆盖事件链所需方法 —— 单一真源 deploy/bot-permits.js(dev seed-bots 共用同一份)。
    // e2e 与 dev 的 seeding 流程不同(此处走 {svc}.token.set RPC),但 permit 数据同源不再手工镜像。
    const BOTS = BOT_PERMITS;
    for (const [uid, services] of Object.entries(BOTS)) {
        const svc = uid.split('.')[1];
        const permit = { allow_all: false, services };
        await post(ROUTER_RPC, { jsonrpc: '2.0', method: 'user.bot.create', params: { uid, permit }, id: `bot-${uid}` }, ADMIN_TOKEN);
        // Idempotent re-seed: bots persist in redis-stack (6699) across runs, so create is a
        // no-op the second time. Always push the current permit so permit changes (e.g. adding
        // agent.decide) actually take effect instead of silently keeping the stale grant.
        await post(ROUTER_RPC, { jsonrpc: '2.0', method: 'user.bot.update', params: { uid, permit }, id: `botup-${uid}` }, ADMIN_TOKEN);
        const issued = await post(ROUTER_RPC, { jsonrpc: '2.0', method: 'user.bot.issue.token', params: { uid }, id: `tok-${uid}` }, ADMIN_TOKEN);
        const { token, expiresAt } = issued.body?.result || {};
        if (!token) { console.warn(`[E2E] bot ${uid}: issue.token returned no token (${issued.body?.error?.message || '?'})`); continue; }
        const set = await post(ROUTER_RPC, { jsonrpc: '2.0', method: `${svc}.token.set`, params: { token, expiresAt, sub: uid }, id: `set-${uid}` }, ADMIN_TOKEN);
        if (set.body?.error) console.warn(`[E2E] ${svc}.token.set: ${set.body.error.message}`);
        else console.log(`[E2E] seeded bot token for ${uid}.`);
    }
}

// ── main ────────────────────────────────────────────────────────────────────

module.exports = async function globalSetup() {
    const logDir = path.join(os.tmpdir(), `solo-e2e-logs-${process.pid}`);
    fs.mkdirSync(logDir, { recursive: true });
    process.env.LOG_DIR = logDir;   // 必须在 spawn 服务前设(logger.js 模块加载即固化).

    const names = PROFILES[PROFILE] || PROFILES.lite;
    console.log(`\n[E2E] profile=${PROFILE}  services=[router, ${names.join(', ')}]  logDir=${logDir}`);

    // 1. Redis
    await startRedisIfNeeded(path.join(logDir, 'redis'));

    // 2. 注入 admin 会话(allow_all,无 user:{uid} → Scheme F 不覆盖).
    //    ERROR:QUEUE 的清理放到栈就绪后(下方 step 6b),抹掉 boot 期环境噪声,
    //    让 assertNoErrors 只测"测试引发"的错误.
    const redis = mkClient();
    await redis.connect();
    await redis.set(
        `session:${ADMIN_TOKEN}`,
        JSON.stringify({ uid: 'e2e-admin', username: 'e2e-admin', role: 'admin', permit: { allow_all: true, services: {} } }),
        { EX: 6 * 3600 },
    );
    // Seed the _tasks whitelist superset ONCE, before any service boots. Kept at a single
    // stable value for the whole run so the Router's 60s in-process cache never reads a
    // market-less whitelist and wrongly blocks a pipeline _task (BACKLOG §5.6③). Pipeline
    // suites reference the same constant, so the value never flips.
    await redis.set(WL_KEY, JSON.stringify(TASK_WHITELIST_SUPERSET));
    await redis.quit();

    // NODE_ENV=production:关键. jest 默认置 NODE_ENV=test,会被子进程继承,触发
    // library/auth.js 的"本地鉴权 bypass"(isLocal && NODE_ENV==='test')→ 服务跳过 Router
    // token 解析、req.user 永远 undefined → 等于没测真签名路径(违背 §1 "真签名转发").
    // 显式置 production,强制走真实 Ed25519 token 校验.
    // RATE_LIMIT_DISABLED: e2e 全部流量来自单一 IP(127.0.0.1),会撞 Router 默认 500/分
    // (尤其 30-injection 对 user.register 的 fuzz 批量)。e2e 不测限流行为(那是
    // router/tests/ratelimit.test.js 的 hermetic 单测),Router 启动即关掉限流闸。
    const commonEnv = { REDIS_URL, LOG_DIR: logDir, DEBUG: 'false', NODE_ENV: 'production', ROUTER_URL: `http://localhost:${ROUTER_PORT}`, GATEWAY_SECRET_KEY: 'e2e-gateway-test-secret-key', NEXUS_SCHEDULER_TICK_MS: '1000', RATE_LIMIT_DISABLED: 'true',
        // Router 对 administrator 不走注册表,而是按这个 env(默认 8680)直连——不传的话
        // harness router 会把 admin.* 全部转发到宿主机 8680(若 dev 栈在跑就是 dev 的
        // administrator,读写 dev 的 Redis;没在跑就全 5xx)。必须显式指到本栈实例。
        ADMINISTRATOR_SERVICE_URL: `http://localhost:${SERVICES.administrator.port}`,
        // gateway.webhook.send 的 SSRF 守卫默认拒 loopback —— e2e 的"外部端点"就是本机监听器
        WEBHOOK_ALLOW_LOOPBACK: '1',
        // nexus 消费者可靠性:小退避 + 低死信阈值,让 67-nexus-dlq 几秒内到 DLQ.
        NEXUS_CONSUMER_BLOCK_MS: '1000', NEXUS_MAX_DELIVERIES: '2', NEXUS_RETRY_BASE_MS: '600' };
    const workerEnv = PROFILE === 'full' ? {} : { ORCH_WORKER: 'false', ORCH_MATCHER: 'false', NEXUS_CONSUMER: 'false', NEXUS_SCHEDULER: 'false', NOTIFICATION_WORKER: 'false' };

    // 3. Router(先起,所有服务依赖它)
    if (await pingRpc(ROUTER_RPC)) {
        pids.services.router = 'external';
        console.log(`[E2E] Router already running on ${ROUTER_PORT}.`);
    } else {
        const p = spawnNode('router', path.join(API_DIR, SERVICES.router.path), { ...commonEnv, PORT: String(ROUTER_PORT) });
        pids.services.router = p.pid;
        await waitFor(`router:${ROUTER_PORT}`, () => pingRpc(ROUTER_RPC));
        console.log(`[E2E] Router ready (pid ${p.pid}).`);
    }

    // 3b. 取 Router 真实公钥下发给各服务(ROUTER_PUBLIC_KEY),不依赖硬编码默认值匹配 .keypair.
    let routerPublicKey = null;
    try {
        const keyRes = await httpGet(`http://localhost:${ROUTER_PORT}/auth/key`);
        routerPublicKey = keyRes.body?.publicKey || null;
        if (routerPublicKey) console.log(`[E2E] Router public key: ${routerPublicKey}`);
    } catch (e) { console.warn(`[E2E] could not fetch Router /auth/key (${e.message}); services fall back to hardcoded default.`); }
    const svcEnv = { ...commonEnv, ...workerEnv };
    if (routerPublicKey) svcEnv.ROUTER_PUBLIC_KEY = routerPublicKey;

    // 3c. storage 字节后端(local-oss-server, :8755). storage 的 provider=local 不落自身磁盘,
    //     而是把字节 PUT 到这个 OSS 模拟器(driver-local ↔ local-oss-server,与 prod 同一条码路).
    //     不起它 → 每个 storage.asset.upload 连 8755 被拒 → ECONNREFUSED. 它不是 Solo 微服务
    //     (无 Router 鉴权/introspection),故不注册到 Router;仅 full profile(含 storage)需要.
    //     secret 必须与 storage 服务一致 → 写进 svcEnv 让 storage 也用同一个.
    if (names.includes('storage')) {
        const LOCAL_OSS_PORT = 8755 + PORT_OFFSET;
        const LOCAL_OSS_SECRET = 'solo-e2e-oss-secret';
        const ossRoot = path.join(logDir, 'oss');
        fs.mkdirSync(ossRoot, { recursive: true });
        svcEnv.LOCAL_OSS_SECRET = LOCAL_OSS_SECRET;   // storage driver-local 用同一 secret 调后端
        svcEnv.LOCAL_OSS_ENDPOINT = `http://localhost:${LOCAL_OSS_PORT}`;
        const ossProbe = () => httpGet(`http://localhost:${LOCAL_OSS_PORT}/`).then((r) => r.status === 200).catch(() => false);
        if (await ossProbe()) {
            pids.services['local-oss'] = 'external';
            console.log(`[E2E] local-oss already up on ${LOCAL_OSS_PORT}.`);
        } else {
            const p = spawnNode('local-oss', path.join(__dirname, 'local-oss-entry.js'), {
                PORT: String(LOCAL_OSS_PORT), LOCAL_OSS_SECRET, LOCAL_OSS_ROOT: ossRoot, LOG_DIR: logDir,
            });
            pids.services['local-oss'] = p.pid;
            await waitFor(`local-oss:${LOCAL_OSS_PORT}`, ossProbe, 15_000);
            console.log(`[E2E] local-oss byte backend ready (pid ${p.pid}).`);
        }
    }

    // 4. 各服务
    for (const name of names) {
        const svc = SERVICES[name];
        const probe = readyProbe(name, svc.port);
        if (await probe()) { pids.services[name] = 'external'; console.log(`[E2E] ${name} already up on ${svc.port}.`); continue; }
        // agent: 用离线 mock provider(无 key、确定性),供 nexus autorun 闭环 e2e(66).
        // orchestrator: 把 stall 扫描间隔降到 2s(只降扫描频率,RUN_STALL_MS 仍默认 10min →
        //   只翻"真老"的 RUNNING run,不误伤其他套的新鲜 run),让 73 的 stall-scanner 测可触发。
        const perSvc = name === 'agent' ? { AI_PROVIDER: 'mock' }
            : name === 'orchestrator' ? { RUN_STALL_SCAN_MS: '2000' }
            // user: enable passport SELF-SERVICE issuance —
            //   'e2e-passport' (suite 111): OTP mode → row-isolated 'e2e-external' role.
            //   'e2e-device' (suite 113): device/TOFU mode → routes to bot account 'e2e-guest-bot'
            //   (the test seeds that bot's permit). echo returns the OTP code for upgrade.
            : name === 'user' ? { PASSPORT_ISSUANCE_BYAPP: '{"e2e-passport":"otp","e2e-device":"device"}', PASSPORT_DEFAULT_ROLE_BYAPP: '{"e2e-passport":"e2e-external"}', PASSPORT_DEFAULT_BOT_BYAPP: '{"e2e-device":"system.e2eguestbot"}', PASSPORT_OTP_ECHO: '1' }
            : {};
        const p = spawnNode(name, path.join(API_DIR, svc.path), { ...svcEnv, ...perSvc, PORT: String(svc.port) });
        pids.services[name] = p.pid;
        await waitFor(`${name}:${svc.port}`, probe, 25_000);
        console.log(`[E2E] ${name} ready (pid ${p.pid}).`);
    }

    // 5. 注册到 Router(幂等;握手同步). administrator 由 Router 自动纳管,跳过.
    for (const name of names) {
        if (name === 'administrator') continue;
        const r = await post(ROUTER_RPC, { jsonrpc: '2.0', method: 'system.service.add', params: { url: `http://localhost:${SERVICES[name].port}` }, id: `reg-${name}` }, ADMIN_TOKEN);
        if (r.body?.error) console.warn(`[E2E] register ${name}: ${r.body.error.message}`);
        else console.log(`[E2E] registered ${name}.`);
    }

    // 6. full:bot token(+ 工作流注入交给 90 套自己处理).
    if (PROFILE === 'full') await seedBots();

    // 6a'. (full) mock-listener 链路(95/96 需要,原先要手工跑 dev 栈 + deploy/mock 工具):
    //      ① bootstrap.js → ingress source + keys.env(对 harness 的全新 redis 幂等重建);
    //      ② inject-workflows --active → wf-mock-listener-payment 等 ACTIVE 工作流
    //        (它也写事件注册表,但 6b 紧随其后用 harness 的超集覆盖——顺序 load-bearing);
    //      ③ 起 listener(:8090),用 keys.env 里的 API key 经 Router 调 ingress.ingest。
    let listenerUrl = null;
    if (PROFILE === 'full') {
        const DEPLOY_MOCK = path.join(API_DIR, '..', 'deploy', 'mock');
        const LISTENER_PORT = parseInt(process.env.MOCK_PORT || String(8090 + PORT_OFFSET), 10);
        listenerUrl = `http://localhost:${LISTENER_PORT}`;
        const listenerProbe = () => httpGet(`http://localhost:${LISTENER_PORT}/health`).then((r) => r.status === 200).catch(() => false);
        // keys.env 是 dev 栈共用的文件:harness 一律用 logDir 下的 per-run 副本,
        // 避免把 dev 正在用的 API key 顶掉(那个 key 注册在 dev 的 Redis 里).
        const keysFile = path.join(logDir, 'mock-keys.env');
        try {
            await runNodeOnce('mock-bootstrap', path.join(DEPLOY_MOCK, 'bootstrap.js'), {
                REDIS_URL, HEALTH_URL: `http://localhost:${LISTENER_PORT}/health`, MOCK_KEYS_FILE: keysFile,
            });
            // ONLY the listener workflow (95/96). The other 5 chain fixtures subscribe to
            // PAYMENT/SHIPMENT events — left ACTIVE for a whole run they cascade on every
            // unrelated suite's events and pollute keyspace/WAL assertions (20/54/64/98).
            await runNodeOnce('mock-workflows', path.join(DEPLOY_MOCK, 'inject-workflows.js'), { REDIS_URL },
                ['--active', '--only', 'wf-mock-listener-payment']);

            if (await listenerProbe()) {
                pids.services['mock-listener'] = 'external';
                console.log(`[E2E] mock-listener already up on ${LISTENER_PORT}.`);
            } else {
                let apiKey = null;
                if (fs.existsSync(keysFile)) {
                    for (const line of fs.readFileSync(keysFile, 'utf8').split('\n')) {
                        if (line.startsWith('SRC_mock-listener=')) apiKey = line.slice('SRC_mock-listener='.length).trim();
                    }
                }
                if (!apiKey) throw new Error('keys.env missing SRC_mock-listener after bootstrap');
                const p = spawnNode('mock-listener', path.join(DEPLOY_MOCK, 'listener.js'), {
                    MOCK_PORT: String(LISTENER_PORT),
                    ROUTER_URL: `http://localhost:${ROUTER_PORT}`,
                    INGRESS_API_KEY: apiKey,
                    SOURCE_NAME: 'mock-listener',
                    LISTENER_ARCHIVE_DIR: path.join(logDir, 'listener-mock-listener'),
                });
                pids.services['mock-listener'] = p.pid;
                await waitFor(`mock-listener:${LISTENER_PORT}`, listenerProbe, 15_000);
                console.log(`[E2E] mock-listener ready on ${LISTENER_PORT} (pid ${p.pid}).`);
            }
        } catch (e) {
            // fail-soft:链路装不齐只影响 95/96,不拖垮整栈(其余 50+ 套照跑).
            console.warn(`[E2E] mock-listener chain setup failed (95/96 will fail): ${e.message}`);
        }
    }

    // 6b. (full)写事件注册表覆盖;栈就绪后清 ERROR:QUEUE(抹掉 boot 期噪声).
    const r2 = mkClient();
    await r2.connect();
    if (PROFILE === 'full') {
        await r2.set('SYSTEM:CONFIG:EVENT_REGISTRY', JSON.stringify(FIXTURE_REGISTRY));
        console.log('[E2E] event-registry override written (collection, market).');
    }
    for await (const k of r2.scanIterator({ MATCH: 'ERROR:QUEUE:*', COUNT: 500 })) {
        await r2.del(Array.isArray(k) ? k[0] : k);
    }
    await r2.quit();

    // 7. context + pids
    const services = { router: ROUTER_PORT };
    for (const n of names) services[n] = SERVICES[n].port;
    ctxFile.write({ redisUrl: REDIS_URL, routerUrl: ROUTER_RPC, logDir, adminToken: ADMIN_TOKEN, profile: PROFILE, services, listenerUrl });
    fs.writeFileSync(PID_FILE, JSON.stringify(pids));
    console.log(`[E2E] stack ready.\n`);
};
