/**
 * 场景: Router 核心安全性测试
 *
 * 测试 1 — 权限门控矩阵（checkAccess）
 *   验证 guest / 无权限用户 / 有权限用户 / admin / 公开方法的访问控制矩阵。
 *   任何一个误判都是安全漏洞。
 *
 * 测试 2 — 限流并发计数精度（ratelimit.checkLimit）
 *   N 个并发请求打同一个方法+身份，Redis INCR 必须原子正确。
 *   验证：允许数 == max，超出全被拦截，key 有正确 TTL。
 *
 * 测试 3 — Session 并发解析隔离（resolveSessionUser）
 *   10 个不同 session 同时解析，每个必须返回对应用户，不能交叉。
 *
 * 测试 4 — 动态权限刷新（Scheme F）
 *   session 创建后更新 user:{uid} 的 permit，
 *   下一次 resolveSessionUser 必须读到新权限，不能用 session 里的旧数据。
 *
 * 测试 5 — _tasks 白名单三重校验
 *   来源/目标服务/方法 任一不在白名单 → 任务被阻断。
 *   全部通过 → 任务被执行（mock axios 捕获调用）。
 */

const path = require('path');

// ─── 路径工具 ─────────────────────────────────────────────────────────────
const ROUTER_ROOT = path.join(__dirname, '../../../../router');

function load(mod) {
    const p = require.resolve(path.join(ROUTER_ROOT, mod));
    delete require.cache[p];
    return require(p);
}

// ─── 测试 1: 权限门控矩阵 ─────────────────────────────────────────────────
function testCheckAccessMatrix() {
    console.log('\n[Test 1] Permission gate matrix (checkAccess)');

    const { checkAccess } = load('handlers/access');   // 原 handlers/permit 已改名为 handlers/access

    const METHOD       = 'sale.order.create';
    const SERVICE_NAME = 'sale';

    const cases = [
        // [描述, sessionUser, 期望 allowed]
        ['guest (no permit)',
            { username: 'guest', permit: { allow_all: false, services: {} } },
            false],
        ['user with empty services',
            { uid: 'u1', permit: { allow_all: false, services: {} } },
            false],
        ['user with wrong service',
            { uid: 'u1', permit: { allow_all: false, services: { commodity: ['commodity.product.list'] } } },
            false],
        ['user with correct service + method',
            { uid: 'u1', permit: { allow_all: false, services: { sale: ['sale.order.create'] } } },
            true],
        ['user with wildcard method',
            { uid: 'u1', permit: { allow_all: false, services: { sale: ['*'] } } },
            true],
        ['admin (allow_all)',
            { uid: 'u1', permit: { allow_all: true, services: {} } },
            true],
    ];

    let passed = 0;
    const failures = [];

    for (const [desc, sessionUser, expected] of cases) {
        const { allowed } = checkAccess(sessionUser, SERVICE_NAME, METHOD);
        if (allowed === expected) {
            passed++;
        } else {
            failures.push(`  ❌ "${desc}": expected allowed=${expected}, got ${allowed}`);
        }
    }

    const ok = failures.length === 0;
    console.log(`  Cases: ${cases.length}  Passed: ${passed}  Failed: ${failures.length}`);
    failures.forEach(f => console.log(f));
    if (ok) console.log('  ✅ All permission cases correct');
    return ok;
}

// ─── 测试 2: 限流并发计数精度 ─────────────────────────────────────────────
async function testRateLimitConcurrency(redis) {
    console.log('\n[Test 2] Rate limit concurrent precision');

    const ratelimit = load('handlers/ratelimit');
    const METHOD    = 'test.ratelimit.method';
    const IDENTITY  = 'test_user_rl';
    const MAX       = 5;
    const TOTAL     = 20;
    const rule      = { window: 30, max: MAX, by: 'user' };

    // 20 个并发请求
    const results = await Promise.all(
        Array.from({ length: TOTAL }, () =>
            ratelimit.checkLimit(redis, METHOD, IDENTITY, rule)
        )
    );

    const allowed  = results.filter(r => r.allowed).length;
    const blocked  = results.filter(r => !r.allowed).length;

    // 检查 Redis 里的计数值
    const now      = Date.now();
    const windowKey = Math.floor(now / (rule.window * 1000));
    const redisKey  = `RL:${METHOD}:${IDENTITY}:${windowKey}`;
    const counter   = parseInt(await redis.get(redisKey) || '0');
    const ttl       = await redis.ttl(redisKey);

    const ok = allowed === MAX && counter === TOTAL && ttl > 0;

    console.log(`  Total: ${TOTAL}  Allowed: ${allowed} (expected ${MAX})  Blocked: ${blocked}`);
    console.log(`  Redis counter: ${counter} (expected ${TOTAL})  TTL: ${ttl}s (expected >0)`);

    if (allowed !== MAX)    console.log(`  ❌ Rate limit over/undercounted — allowed ${allowed} instead of ${MAX}`);
    if (counter !== TOTAL)  console.log(`  ❌ Counter inconsistency — ${counter} != ${TOTAL} total attempts`);
    if (ttl <= 0)           console.log(`  ❌ Rate limit key has no TTL — will leak permanently`);
    if (ok)                 console.log('  ✅ Rate limiting correct and atomic');

    return ok;
}

// ─── 测试 3: Session 并发解析隔离 ─────────────────────────────────────────
async function testSessionIsolation(redis) {
    console.log('\n[Test 3] Concurrent session resolution isolation');

    const { resolveSessionUser } = load('handlers/auth');
    const N = 10;

    // 写入 N 个不同的 session
    const sessions = Array.from({ length: N }, (_, i) => ({
        token: `test_token_${i}`,
        uid:   `uid_${i}`,
        name:  `user_${i}`,
        permit: { allow_all: false, services: {} },
    }));

    for (const s of sessions) {
        await redis.set(`session:${s.token}`, JSON.stringify({
            uid: s.uid, name: s.name, permit: s.permit,
        }));
    }

    // 并发解析所有 session
    const resolved = await Promise.all(
        sessions.map(s => resolveSessionUser(s.token, redis))
    );

    const drifts = resolved
        .map((r, i) => ({ r, expected: sessions[i] }))
        .filter(({ r, expected }) => r.uid !== expected.uid || r.name !== expected.name);

    const ok = drifts.length === 0;
    console.log(`  Sessions: ${N}  Drifts: ${drifts.length}`);
    drifts.forEach(({ r, expected }) =>
        console.log(`  ❌ Expected uid=${expected.uid}, got uid=${r.uid}`)
    );
    if (ok) console.log('  ✅ All sessions resolved correctly in parallel');
    return ok;
}

// ─── 测试 4: 动态权限刷新（Scheme F）─────────────────────────────────────
async function testDynamicPermitRefresh(redis) {
    console.log('\n[Test 4] Dynamic permit refresh (Scheme F)');

    const { resolveSessionUser } = load('handlers/auth');

    const token = 'test_dynamic_permit_token';
    const uid   = 'uid_dynamic_test';

    // Session 里存旧权限（无任何服务访问权）
    await redis.set(`session:${token}`, JSON.stringify({
        uid,
        name: 'dynamic_user',
        permit: { allow_all: false, services: {} },
    }));

    // user:{uid} 里存新权限（admin）
    await redis.set(`user:${uid}`, JSON.stringify({
        id: uid,
        name: 'dynamic_user',
        permit: { allow_all: true, services: {} },
        status: 'ACTIVE',
    }));

    const resolved = await resolveSessionUser(token, redis);

    // Scheme F 应该读 user: 里的新权限，不用 session 里的旧数据
    const ok = resolved.permit?.allow_all === true;

    if (ok) {
        console.log('  ✅ Dynamic permit refresh working — session stale permit overridden by user record');
    } else {
        console.log('  ❌ Still using session permit — dynamic refresh not working');
        console.log(`     resolved.permit.allow_all = ${resolved.permit?.allow_all}`);
    }
    return ok;
}

// ─── 测试 5: _tasks 白名单三重校验 ───────────────────────────────────────
async function testTaskWhitelist(redis) {
    console.log('\n[Test 5] _tasks whitelist enforcement (source / target / method)');

    // 写白名单到 Redis
    const whitelist = {
        user: {
            allowFrom:    ['sale'],
            allowMethods: ['user.permit.update'],
        },
    };
    const configMod = load('config');
    await redis.set(configMod.redis.taskWhitelistKey, JSON.stringify(whitelist));

    // Mock axios & keypair
    const axiosMod = require('axios');
    const captured = [];
    const blocked  = [];
    const originalPost = axiosMod.post;
    axiosMod.post = async (url, body) => { captured.push({ url, method: body.method }); return {}; };

    const originalWarn = console.warn;
    console.warn = (...args) => { if (args[0]?.includes('BLOCKED')) blocked.push(args[0]); };

    const { processTasks } = load('handlers/tasks');

    const fakeKeypair = (() => {
        const nacl = require('tweetnacl');
        return nacl.sign.keyPair();
    })();

    const SERVICES = {
        user: { url: 'http://localhost:8710/jsonrpc' },
    };

    // 5a: 合法任务（sale → user.permit.update）
    await processTasks(
        [{ service: 'user', method: 'user.permit.update', params: { uid: 'x', permit: {} } }],
        'testuser', false, SERVICES, fakeKeypair, redis, 'sale', {}
    );

    // 5b: 非法来源（authority → user）
    await processTasks(
        [{ service: 'user', method: 'user.permit.update', params: {} }],
        'testuser', false, SERVICES, fakeKeypair, redis, 'authority', {}
    );

    // 5c: 非法方法（sale → user.account.destroy）
    await processTasks(
        [{ service: 'user', method: 'user.account.destroy', params: {} }],
        'testuser', false, SERVICES, fakeKeypair, redis, 'sale', {}
    );

    // 5d: 非白名单服务（sale → storage）
    await processTasks(
        [{ service: 'storage', method: 'storage.asset.upload', params: {} }],
        'testuser', false, SERVICES, fakeKeypair, redis, 'sale', {}
    );

    // 恢复
    axiosMod.post = originalPost;
    console.warn = originalWarn;

    const ok = captured.length === 1 && blocked.length === 3;

    console.log(`  Dispatched (expected 1): ${captured.length}`);
    console.log(`  Blocked (expected 3): ${blocked.length}`);
    if (ok) {
        console.log('  ✅ Whitelist correctly allows valid task and blocks 3 invalid cases');
    } else {
        if (captured.length !== 1) console.log(`  ❌ Expected 1 dispatch, got ${captured.length}`);
        if (blocked.length !== 3)  console.log(`  ❌ Expected 3 blocked, got ${blocked.length}`);
    }
    return ok;
}

// ─── 入口 ────────────────────────────────────────────────────────────────
async function run(redis) {
    console.log('\n═══ Router Core Security Simulation ═══');

    const r1 = testCheckAccessMatrix();
    await redis.flushDb();

    const r2 = await testRateLimitConcurrency(redis);
    await redis.flushDb();

    const r3 = await testSessionIsolation(redis);
    await redis.flushDb();

    const r4 = await testDynamicPermitRefresh(redis);
    await redis.flushDb();

    const r5 = await testTaskWhitelist(redis);

    console.log('\n═══ Summary ═══');
    [
        ['Permission gate matrix',                    r1],
        ['Rate limit concurrent precision',           r2],
        ['Session concurrent resolution isolation',   r3],
        ['Dynamic permit refresh (Scheme F)',         r4],
        ['_tasks whitelist three-factor enforcement', r5],
    ].forEach(([label, ok]) =>
        console.log(`  ${ok ? '✅' : '❌'} ${label}`)
    );
    console.log('');

    return r1 && r2 && r3 && r4 && r5;
}

module.exports = { run };
