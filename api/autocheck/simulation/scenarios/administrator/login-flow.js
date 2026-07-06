/**
 * 场景: Administrator 登录流程 + Challenge 安全性
 *
 * 测试 1 — 完整登录流程
 *   loginRequest → loginVerify → session 内容核对（不信任响应体，直接读 Redis）
 *
 * 测试 2 — Challenge 一次性（replay 防御）
 *   用同一个 challenge 调用两次 loginVerify，第二次必须失败
 *
 * 测试 3 — 并发登录 session 隔离
 *   N 次并发登录（每次独立的 loginRequest+loginVerify），
 *   每个 token 对应的 session.username 必须正确
 *
 * 测试 4 — saveAdmin 阻塞检测
 *   saveAdmin 使用 pbkdf2Sync（同步），记录耗时，超过阈值则警告
 *
 * 注意：administrator 使用独立的 login_hash（PBKDF2），
 *       与 user service 的 sha256(password+salt) 体系不同。
 */

const crypto = require('crypto');
const path   = require('path');

const ADMIN_USERNAME = 'test_admin';
const ADMIN_PASSWORD = 'test_password_123';
const SESSION_PREFIX = 'session:';

function makeConfig(redis) {
    return {
        serviceName: 'administrator',
        redisUrl: null,               // 由外部注入 client，不自己连接
        defaultIterations: 1,         // 测试用低迭代（pbkdf2 加快速度）
        challengeTtl: 5000,           // 5s
        sessionTtl: 300,
        redis: {
            userKeyPrefix:    'administrator:user:',
            sessionKeyPrefix: SESSION_PREFIX,
            errorQueuePrefix: 'ERROR:QUEUE:',
            activeServicesKey: 'active_services',
        },
    };
}

// 覆盖 config（identity.js 直接 require('../config')，需 patch）
function patchConfig(overrides) {
    const configPath = require.resolve(
        path.join(__dirname, '../../../../core/administrator/config')
    );
    delete require.cache[configPath];
    const original = require(configPath);
    Object.assign(original, overrides);
    return original;
}

// 生成 admin 的 login_hash（PBKDF2，与 saveAdmin 相同算法）
function makeLoginHash(password, username, salt, iterations = 1) {
    return crypto.pbkdf2Sync(
        password + username,
        Buffer.from(salt, 'hex'),
        iterations,
        32,
        'sha256'
    ).toString('hex');
}

// 直接写入 administrator 用户记录到 Redis（不依赖 saveAdmin）
async function seedAdmin(redis, cfg) {
    const salt = crypto.randomBytes(16).toString('hex');
    const loginHash = makeLoginHash(ADMIN_PASSWORD, ADMIN_USERNAME, salt, cfg.defaultIterations);
    const userData = {
        username:   ADMIN_USERNAME,
        salt,
        iterations: cfg.defaultIterations,
        login_hash: loginHash,
        role:       'admin',
        permit:     { allow_all: true },
        updatedAt:  new Date().toISOString(),
    };
    await redis.set(`${cfg.redis.userKeyPrefix}${ADMIN_USERNAME}`, JSON.stringify(userData));
    return userData;
}

function loadIdentity() {
    const id = path.join(__dirname, '../../../../core/administrator/logic/identity');
    delete require.cache[require.resolve(id)];
    const identity = require(id);
    // Prevent cleanup() from disconnecting the shared test Redis client
    identity.cleanup = async () => {};
    return identity;
}

// ─── 测试 1: 完整登录流程 ─────────────────────────────────────────────────────
async function testFullLoginFlow(redis, cfg) {
    console.log('\n[Test 1] Full login flow + session content verification');
    const identity = loadIdentity();
    await identity.init(redis);

    try {
        const { challenge, salt, iterations } = await identity.loginRequest({ username: ADMIN_USERNAME });
        const userData = JSON.parse(await redis.get(`${cfg.redis.userKeyPrefix}${ADMIN_USERNAME}`));
        const response = crypto.createHash('sha256').update(challenge + userData.login_hash).digest('hex');

        const { token } = await identity.loginVerify({ username: ADMIN_USERNAME, challenge, response });

        // 从 Redis 直接读 session（不信任响应体）
        const sessionRaw = await redis.get(`${SESSION_PREFIX}${token}`);
        if (!sessionRaw) {
            console.log('  ❌ Session not found in Redis');
            return false;
        }
        const session = JSON.parse(sessionRaw);

        const ok = session.username === ADMIN_USERNAME && session.role === 'admin';
        if (ok) {
            console.log(`  ✅ Session correct: username=${session.username}, role=${session.role}`);
        } else {
            console.log(`  ❌ Session mismatch: got username=${session.username}, role=${session.role}`);
        }
        return ok;
    } finally {
        await identity.cleanup();
    }
}

// ─── 测试 2: Challenge 一次性（replay 防御）──────────────────────────────────
async function testChallengeReplay(redis, cfg) {
    console.log('\n[Test 2] Challenge one-time use (replay attack prevention)');
    const identity = loadIdentity();
    await identity.init(redis);

    try {
        const { challenge } = await identity.loginRequest({ username: ADMIN_USERNAME });
        const userData = JSON.parse(await redis.get(`${cfg.redis.userKeyPrefix}${ADMIN_USERNAME}`));
        const response = crypto.createHash('sha256').update(challenge + userData.login_hash).digest('hex');

        // 第一次验证 — 应成功
        let firstOk = false;
        try {
            await identity.loginVerify({ username: ADMIN_USERNAME, challenge, response });
            firstOk = true;
        } catch (_) {}

        // 第二次用同一 challenge — 应失败
        let secondFailed = false;
        try {
            await identity.loginVerify({ username: ADMIN_USERNAME, challenge, response });
        } catch (_) {
            secondFailed = true;
        }

        const ok = firstOk && secondFailed;
        if (ok) {
            console.log('  ✅ First verify succeeded, replay correctly rejected');
        } else {
            if (!firstOk)  console.log('  ❌ First verify failed unexpectedly');
            if (!secondFailed) console.log('  ❌ Replay was NOT rejected — challenge reuse allowed');
        }
        return ok;
    } finally {
        await identity.cleanup();
    }
}

// ─── 测试 3: 并发登录 session 隔离 ───────────────────────────────────────────
async function testConcurrentLogin(redis, cfg) {
    console.log('\n[Test 3] Concurrent logins — session isolation');
    const identity = loadIdentity();
    await identity.init(redis);
    const N = 8;

    try {
        const userData = JSON.parse(await redis.get(`${cfg.redis.userKeyPrefix}${ADMIN_USERNAME}`));

        // N 次独立的 loginRequest（每次产生不同 challenge）
        const challenges = await Promise.all(
            Array.from({ length: N }, () => identity.loginRequest({ username: ADMIN_USERNAME }))
        );

        // 并发 loginVerify
        const verifyResults = await Promise.allSettled(
            challenges.map(({ challenge }) => {
                const response = crypto.createHash('sha256').update(challenge + userData.login_hash).digest('hex');
                return identity.loginVerify({ username: ADMIN_USERNAME, challenge, response });
            })
        );

        const succeeded = verifyResults.filter(r => r.status === 'fulfilled');
        const drifts = [];

        for (const r of succeeded) {
            const { token } = r.value;
            const sessionRaw = await redis.get(`${SESSION_PREFIX}${token}`);
            if (!sessionRaw) { drifts.push('SESSION_MISSING'); continue; }
            const session = JSON.parse(sessionRaw);
            if (session.username !== ADMIN_USERNAME) {
                drifts.push(`USERNAME_DRIFT:${session.username}`);
            }
        }

        const ok = succeeded.length === N && drifts.length === 0;
        console.log(`  Logins: ${N}  Succeeded: ${succeeded.length}  Drifts: ${drifts.length}`);
        if (ok) {
            console.log('  ✅ All sessions correctly isolated');
        } else {
            drifts.forEach(d => console.log(`  ❌ ${d}`));
        }
        return ok;
    } finally {
        await identity.cleanup();
    }
}

// ─── 测试 4: saveAdmin 同步阻塞耗时 ──────────────────────────────────────────
async function testSaveAdminBlocking(redis, cfg) {
    console.log('\n[Test 4] saveAdmin pbkdf2Sync blocking time');

    // 用生产级迭代数测耗时（200000 次），但不真的跑那么多，用 1000 次估算
    const BENCH_ITERATIONS = 1000;
    const salt = crypto.randomBytes(16).toString('hex');

    const start = Date.now();
    crypto.pbkdf2Sync(
        ADMIN_PASSWORD + ADMIN_USERNAME,
        Buffer.from(salt, 'hex'),
        BENCH_ITERATIONS,
        32,
        'sha256'
    );
    const elapsed = Date.now() - start;
    // 线性外推到 200000 次
    const estimated200k = Math.round(elapsed * (200000 / BENCH_ITERATIONS));

    const WARN_THRESHOLD_MS = 500;
    const ok = estimated200k < WARN_THRESHOLD_MS;

    console.log(`  pbkdf2Sync @ ${BENCH_ITERATIONS} iters: ${elapsed}ms`);
    console.log(`  Estimated @ 200000 iters: ~${estimated200k}ms`);
    if (ok) {
        console.log('  ✅ Within acceptable range');
    } else {
        console.log(`  ⚠️  saveAdmin will block event loop ~${estimated200k}ms per call`);
        console.log('     Consider crypto.pbkdf2() (async) or moving to worker thread');
    }
    return true; // 仅警告，不阻断
}

// ─── 入口 ────────────────────────────────────────────────────────────────────
async function run(redis) {
    console.log('\n═══ Administrator Service Simulation ═══');

    const cfg = patchConfig(makeConfig(redis));

    await seedAdmin(redis, cfg);

    const r1 = await testFullLoginFlow(redis, cfg);
    await redis.flushDb(); await seedAdmin(redis, cfg);

    const r2 = await testChallengeReplay(redis, cfg);
    await redis.flushDb(); await seedAdmin(redis, cfg);

    const r3 = await testConcurrentLogin(redis, cfg);
    await redis.flushDb(); await seedAdmin(redis, cfg);

    const r4 = await testSaveAdminBlocking(redis, cfg);

    console.log('\n═══ Summary ═══');
    [
        ['Full login flow + session verification', r1],
        ['Challenge one-time use (replay prevention)', r2],
        ['Concurrent login session isolation', r3],
        ['saveAdmin blocking time check', r4],
    ].forEach(([label, ok]) =>
        console.log(`  ${ok ? '✅' : '❌'} ${label}`)
    );
    console.log('');

    return r1 && r2 && r3 && r4;
}

module.exports = { run };
