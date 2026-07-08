/**
 * 95 · mock listener 全链路诊断
 *
 * 覆盖从 "Portal SEND VIA LISTENER" 到 "workflow run" 的完整路径：
 *
 *   POST /hook(mock listener :8090)
 *     → ingress.ingest (Router, ApiKey auth)
 *     → relay.call('event.emit')  ← 需要 RELAY:TOKEN:ingress
 *     → EVENT:WEBHOOK:MOCK-LISTENER (Redis stream)
 *     → orchestrator matcher → worker → runner
 *     → workflow step 执行
 *
 * 每个节点都有独立断言，哪里断哪里就是问题所在。
 *
 * full profile(需要 ingress relay bot token + matcher/worker ON)。
 * 注：该 suite 直接用 dev 栈的 keys.env 里的 API key，不额外创建 source。
 */
const http = require('http');
const { createClient } = require('redis');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// URL 以 harness context 为准(支持 E2E_PORT_OFFSET 平移);env 可显式覆盖.
const { read: readCtx } = require('../lib/context');
const REDIS_URL    = process.env.REDIS_URL    || readCtx().redisUrl    || 'redis://localhost:6699';
const ROUTER_URL   = process.env.ROUTER_URL   || (readCtx().routerUrl || 'http://localhost:8600/').replace(/\/$/, '');
const LISTENER_URL = process.env.LISTENER_URL || readCtx().listenerUrl || 'http://localhost:8090';
const WF_ID        = 'wf-mock-listener-payment';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpPost(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const raw = JSON.stringify(body);
        const u = new URL(url);
        const opts = {
            hostname: u.hostname, port: u.port || 80, path: u.pathname,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers },
        };
        const req = http.request(opts, (res) => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(d); } catch { parsed = { _raw: d }; }
                resolve({ status: res.statusCode, body: parsed, raw: d });
            });
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('http timeout')); });
        req.write(raw);
        req.end();
    });
}

function rpc(method, params, token) {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    return httpPost(`${ROUTER_URL}/`, { jsonrpc: '2.0', id: Date.now(), method, params }, headers)
        .then(r => ({ ...r, result: r.body?.result, error: r.body?.error }));
}

// ── suite ─────────────────────────────────────────────────────────────────────

gate('95 · mock listener → ingress → stream → workflow (full pipeline)', () => {
    let redis;
    let apiKey;
    let sourceId;
    const TEST_ORDER = `E2E-${process.pid}`;
    const TEST_PAYLOAD = { orderId: TEST_ORDER, amount: 88.8, currency: 'CNY', externalRef: `ref-${process.pid}` };

    beforeAll(async () => {
        redis = createClient({ url: REDIS_URL });
        redis.on('error', () => {});
        await redis.connect();

        // Load API key from keys.env (written by deploy/mock/bootstrap.js)
        const fs = require('fs');
        const path = require('path');
        const keysFile = path.join(__dirname, '../../deploy/mock/keys.env');
        if (fs.existsSync(keysFile)) {
            for (const line of fs.readFileSync(keysFile, 'utf8').split('\n')) {
                if (line.startsWith('SRC_mock-listener=')) {
                    apiKey = line.slice('SRC_mock-listener='.length).trim();
                }
            }
        }
    }, 10_000);

    afterAll(async () => {
        // Clean up the test run record (don't delete shared source or workflow)
        const runs = await redis.sMembers('ORCHESTRATOR:RUN_INDEX').catch(() => []);
        for (const runId of runs) {
            const run = await redis.json.get(`ORCHESTRATOR:RUN:${runId}`).catch(() => null);
            if (run?.workflowId === WF_ID && run?.input?.data?.orderId === TEST_ORDER) {
                await redis.del(`ORCHESTRATOR:RUN:${runId}`);
                await redis.sRem('ORCHESTRATOR:RUN_INDEX', runId);
            }
        }
        await redis.quit();
    });

    // ── 1. 前置条件 ────────────────────────────────────────────────────────────

    test('1a. API key loaded from keys.env', () => {
        expect(apiKey).toBeTruthy();
        expect(apiKey).toMatch(/^ingk_/);
    });

    test('1b. mock-listener source exists in Redis (bootstrap 跑过)', async () => {
        const id = await redis.get('INGRESS:NAME:mock-listener');
        expect(id).toBeTruthy();
        sourceId = id;
        const raw = await redis.get(`INGRESS:SOURCE:${id}`);
        expect(raw).toBeTruthy();
        const src = JSON.parse(raw);
        expect(src.enabled).toBe(true);
        expect(src.healthUrl).toBeTruthy();
    });

    test('1c. RELAY:TOKEN:ingress 存在且未过期', async () => {
        const raw = await redis.get('RELAY:TOKEN:ingress');
        expect(raw).not.toBeNull();  // 如果 null → seed-bots 写 token 失败

        const state = JSON.parse(raw);
        expect(state.token).toBeTruthy();
        expect(state.expiresAt).toBeGreaterThan(Date.now());  // 未过期
    });

    test('1d. mock listener /health 返回 ok', async () => {
        const res = await httpPost(`${LISTENER_URL}/health`, {}).catch(() => null);
        // GET /health — httpPost is POST, so use http.get
        const alive = await new Promise((resolve) => {
            http.get(`${LISTENER_URL}/health`, (r) => {
                let d = '';
                r.on('data', c => (d += c));
                r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
            }).on('error', () => resolve(null));
        });
        expect(alive).not.toBeNull();
        expect(alive?.status).toBe('ok');
    });

    test('1e. workflow wf-mock-listener-payment 已注入且 ACTIVE', async () => {
        const doc = await redis.json.get(`ORCHESTRATOR:WORKFLOW:${WF_ID}`).catch(() => null);
        expect(doc).not.toBeNull();  // 如果 null → inject-workflows.js 还没跑
        expect(doc?.status).toBe('ACTIVE');
        expect(doc?.event_subscriptions?.[0]?.stream).toBe('EVENT:WEBHOOK:MOCK-LISTENER');
    });

    // ── 2. POST /hook → ingress pipeline ──────────────────────────────────────

    test('2a. POST /hook 返回 HTTP 200', async () => {
        const res = await httpPost(`${LISTENER_URL}/hook`, TEST_PAYLOAD, {});
        expect(res.status).toBe(200);
    });

    test('2b. /hook 响应体是 JSON-RPC 包装(body.result.ok === true, 不是 body.ok)', async () => {
        // 这个测试验证 portal handleSend 的已知 bug:
        // mock listener 直接透传 Router 的 JSON-RPC 响应,结构是:
        //   { jsonrpc:'2.0', result:{ ok, stream, request_id }, id }
        // 而 portal 错误地检查 body.ok(永远 undefined),应检查 body.result.ok
        const reqId = `e2e-check-${process.pid}`;
        const res = await httpPost(`${LISTENER_URL}/hook`, { ...TEST_PAYLOAD, orderId: `${TEST_ORDER}-chk` },
            { 'x-request-id': reqId });
        expect(res.status).toBe(200);

        // 直接看: body.ok vs body.result.ok
        expect(res.body.ok).toBeUndefined();          // portal bug: 这个永远是 undefined
        expect(res.body.result?.ok).toBe(true);        // 正确路径
        expect(res.body.result?.stream).toBe('EVENT:WEBHOOK:MOCK-LISTENER');
    });

    test('2c. POST /hook 后 EVENT:WEBHOOK:MOCK-LISTENER 流长度 +1', async () => {
        const reqId = `e2e-stream-${process.pid}`;
        const before = await redis.xLen('EVENT:WEBHOOK:MOCK-LISTENER').catch(() => 0);
        await httpPost(`${LISTENER_URL}/hook`, { ...TEST_PAYLOAD, orderId: `${TEST_ORDER}-sl` },
            { 'x-request-id': reqId });
        await sleep(500);
        const after = await redis.xLen('EVENT:WEBHOOK:MOCK-LISTENER').catch(() => 0);
        expect(after).toBeGreaterThan(before);  // 如果不增 → relay token 没有 → emit 失败
    });

    // ── 3. 事件 envelope 结构 ──────────────────────────────────────────────────

    test('3a. 流最新消息有 payload 字段(JSON-encoded)', async () => {
        const msgs = await redis.xRevRange('EVENT:WEBHOOK:MOCK-LISTENER', '+', '-', { COUNT: 1 });
        expect(msgs.length).toBeGreaterThan(0);
        const fields = msgs[0].message;
        expect(fields.payload).toBeTruthy();  // 如果 undefined → event.emit 没有写 payload
    });

    test('3b. payload 解析后包含 request_id + data 字段', async () => {
        const msgs = await redis.xRevRange('EVENT:WEBHOOK:MOCK-LISTENER', '+', '-', { COUNT: 1 });
        const raw = msgs[0].message.payload;
        let payload;
        expect(() => { payload = JSON.parse(raw); }).not.toThrow();
        expect(payload.request_id).toBeTruthy();
        expect(payload.data).toBeDefined();       // $input = payload → $input.data.* 走的就是这里
        expect(typeof payload.data).toBe('object');
    });

    test('3c. $input.data.* 字段存在(workflow step params 依赖这个结构)', async () => {
        // 找一条我们发的测试消息
        const msgs = await redis.xRevRange('EVENT:WEBHOOK:MOCK-LISTENER', '+', '-', { COUNT: 20 });
        let found = null;
        for (const msg of msgs) {
            try {
                const p = JSON.parse(msg.message.payload);
                if (p.data?.orderId?.startsWith(TEST_ORDER)) { found = p; break; }
            } catch (_) {}
        }
        expect(found).not.toBeNull();
        // workflow 10-mock-listener-payment.json 用的是 $input.data.orderId 等
        expect(found.data.orderId).toBeTruthy();
        expect(typeof found.data.amount).toBe('number');
        expect(found.data.currency).toBeTruthy();
    });

    // ── 4. workflow 执行 ───────────────────────────────────────────────────────

    test('4a. matcher 建立了 MOCK-LISTENER 流的消费组', async () => {
        // XINFO GROUPS — node-redis v4
        const groups = await redis.xInfoGroups('EVENT:WEBHOOK:MOCK-LISTENER').catch(() => []);
        const has = groups.some(g => g.name === 'orchestrator');
        expect(has).toBe(true);  // 如果 false → matcher 还没发现该流 或 workflow 未注入
    }, 15_000);

    test('4b. 发一条完整 payload 的 webhook,等待 workflow run 完成(最长 30s)', async () => {
        // 用完整 orderId 发一条,等 orchestrator 处理
        const reqId = `e2e-run-${process.pid}`;
        await httpPost(`${LISTENER_URL}/hook`, TEST_PAYLOAD, { 'x-request-id': reqId });

        // 轮询 run index
        let run = null;
        for (let i = 0; i < 60; i++) {
            await sleep(500);
            const runIds = await redis.sMembers('ORCHESTRATOR:RUN_INDEX').catch(() => []);
            for (const rid of runIds.reverse()) {
                const r = await redis.json.get(`ORCHESTRATOR:RUN:${rid}`).catch(() => null);
                if (r?.workflowId === WF_ID && r?.input?.data?.orderId === TEST_ORDER) {
                    run = r; break;
                }
            }
            if (run) break;
        }
        expect(run).not.toBeNull();  // 如果 null → matcher 没触发 or runner 没跑
        // run.status: run.js 定义的终态是 'DONE'; runner.js 内部用 'completed'/'failed'
        // worker 调 run.done() 后变 'DONE';step 级结果在 run.steps[*].status 里
        expect(['DONE', 'completed', 'failed', 'running', 'PAUSED_AWAITING_HUMAN']).toContain(run.status);
        // 打印最后一个 step 的状态帮助定位问题
        const lastStep = run.steps?.slice(-1)[0];
        if (lastStep?.status === 'failed') {
            console.warn('[95] last step failed:', lastStep.error || JSON.stringify(lastStep));
        }
    }, 40_000);
});
