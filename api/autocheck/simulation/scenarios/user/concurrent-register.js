/**
 * 场景: User 并发注册去重 + session 隔离
 *
 * 测试 1 — 同名并发注册（TOCTOU 竞态）
 *   N 个请求同时注册同一个用户名，理论上只有 1 个应成功。
 *   验证：user:name:{name} 只指向一个 uid；user:ids 里无孤儿记录。
 *
 * 测试 2 — 不同名并发注册
 *   N 个不同名用户同时注册，全部应成功。
 *   验证：每个 uid 唯一；user:name:{name} 正确映射；无数据交叉。
 *
 * 测试 3 — 并发登录 session 隔离
 *   N 个已注册用户同时登录，验证每个 token 的 session 数据指向正确的 uid，
 *   不存在 A 的 token 里混入 B 的 uid 的情况。
 */

const crypto = require('crypto');
const path   = require('path');

function makeUserConfig() {
    return {
        serviceName: 'user',
        redis: {
            userPrefix:      'user:',
            userNamePrefix:  'user:name:',
            userIdSet:       'user:ids',
            challengePrefix: 'challenge:',
            sessionPrefix:   'session:',
        },
        defaultIterations: 1,   // 测试用极低迭代，加快速度
        idLengths: { user: 16 },
        defaultLanguage: 'zh',
    };
}

function makeLogic(redis) {
    const userLogic = require(path.join(__dirname, '../../../../core/user/logic/user'));
    return userLogic(redis, makeUserConfig());
}

function makeCredentials(name) {
    const salt = crypto.randomBytes(8).toString('hex');
    const hash = crypto.createHash('sha256').update(`pw_${name}` + salt).digest('hex');
    return { salt, hash };
}

async function loginFull(logic, redis, name, hash, config) {
    const { challenge } = await logic.loginRequest({ name });
    const response = crypto.createHash('sha256').update(challenge + hash).digest('hex');
    return logic.loginVerify({ name, challenge, response, deviceId: `dev_${name}` });
}

// ─── 测试 1: 同名并发注册 ────────────────────────────────────────────────────
async function testDuplicateRegistration(redis) {
    console.log('\n[Test 1] Concurrent duplicate registration (TOCTOU check)');
    const logic = makeLogic(redis);
    const name = 'duplicate_user';
    const N = 8;

    const results = await Promise.allSettled(
        Array.from({ length: N }, () => {
            const { salt, hash } = makeCredentials(name);
            return logic.register({ name, salt, hash });
        })
    );

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed    = results.filter(r => r.status === 'rejected');

    // 验证：user:name: 只应指向一个 uid
    const storedUid = await redis.get(`user:name:${name}`);
    const allIds    = await redis.sMembers('user:ids');

    // 孤儿检查：user:ids 里的每个 uid 都应有对应的 user: 记录
    let orphans = 0;
    for (const uid of allIds) {
        const exists = await redis.exists(`user:${uid}`);
        if (!exists) orphans++;
    }

    const ok = succeeded.length === 1 && orphans === 0 && storedUid !== null;

    console.log(`  Attempts: ${N}  Succeeded: ${succeeded.length}  Failed: ${failed.length}`);
    console.log(`  Orphan UIDs: ${orphans}`);
    if (ok) {
        console.log('  ✅ Only 1 registration succeeded, no orphan records');
    } else {
        if (succeeded.length !== 1)
            console.log(`  ❌ Expected 1 success, got ${succeeded.length} — TOCTOU race detected`);
        if (orphans > 0)
            console.log(`  ❌ ${orphans} orphan uid(s) in user:ids without user: record`);
    }
    return ok;
}

// ─── 测试 2: 不同名并发注册 ──────────────────────────────────────────────────
async function testConcurrentUniqueRegistration(redis) {
    console.log('\n[Test 2] Concurrent unique registration');
    const logic = makeLogic(redis);
    const N = 12;
    const users = Array.from({ length: N }, (_, i) => {
        const name = `user_${String(i).padStart(3, '0')}`;
        return { name, ...makeCredentials(name) };
    });

    const results = await Promise.allSettled(
        users.map(u => logic.register({ name: u.name, salt: u.salt, hash: u.hash }))
    );

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed    = results.filter(r => r.status === 'rejected');

    // 验证：每个 name 的 uid 唯一且不相同
    const uids = await Promise.all(users.map(u => redis.get(`user:name:${u.name}`)));
    const uniqueUids = new Set(uids.filter(Boolean));
    const allIds = await redis.sMembers('user:ids');

    let orphans = 0;
    for (const uid of allIds) {
        const exists = await redis.exists(`user:${uid}`);
        if (!exists) orphans++;
    }

    const ok = succeeded.length === N && uniqueUids.size === N && orphans === 0;

    console.log(`  Attempts: ${N}  Succeeded: ${succeeded.length}  Failed: ${failed.length}`);
    console.log(`  Unique UIDs: ${uniqueUids.size}/${N}  Orphans: ${orphans}`);
    if (ok) {
        console.log('  ✅ All registrations succeeded with unique UIDs');
    } else {
        if (succeeded.length !== N)
            console.log(`  ❌ Expected ${N} successes, got ${succeeded.length}`);
        if (uniqueUids.size !== N)
            console.log(`  ❌ UID collision: only ${uniqueUids.size} unique UIDs for ${N} users`);
        if (orphans > 0)
            console.log(`  ❌ ${orphans} orphan records`);
    }
    return ok;
}

// ─── 测试 3: 并发登录 session 隔离 ──────────────────────────────────────────
async function testSessionIsolation(redis) {
    console.log('\n[Test 3] Concurrent login session isolation');
    const logic  = makeLogic(redis);
    const config = makeUserConfig();
    const N = 10;

    // 先注册 N 个用户
    const users = [];
    for (let i = 0; i < N; i++) {
        const name = `sess_user_${i}`;
        const { salt, hash } = makeCredentials(name);
        await logic.register({ name, salt, hash });
        users.push({ name, hash });
    }

    // 并发登录
    const loginResults = await Promise.allSettled(
        users.map(u => loginFull(logic, redis, u.name, u.hash, config))
    );

    const drifts = [];
    for (let i = 0; i < N; i++) {
        const r = loginResults[i];
        if (r.status === 'rejected') {
            drifts.push({ user: users[i].name, error: r.reason?.message });
            continue;
        }
        const { token, uid } = r.value;

        // 从 Redis 直接读 session，不信任响应体
        const sessionRaw = await redis.get(`${config.redis.sessionPrefix}${token}`);
        if (!sessionRaw) {
            drifts.push({ user: users[i].name, type: 'SESSION_NOT_IN_REDIS' });
            continue;
        }
        const session = JSON.parse(sessionRaw);

        // 验证：session.uid 应等于登录时返回的 uid
        if (session.uid !== uid) {
            drifts.push({
                user:     users[i].name,
                type:     'SESSION_UID_MISMATCH',
                expected: uid,
                actual:   session.uid,
            });
        }

        // 验证：session.name 应是本用户的 name
        if (session.name !== users[i].name) {
            drifts.push({
                user:     users[i].name,
                type:     'SESSION_NAME_DRIFT',
                expected: users[i].name,
                actual:   session.name,
            });
        }
    }

    const ok = drifts.length === 0;
    const succeeded = loginResults.filter(r => r.status === 'fulfilled').length;
    console.log(`  Logins: ${N}  Succeeded: ${succeeded}  Drifts: ${drifts.length}`);
    if (ok) {
        console.log('  ✅ All sessions correctly isolated');
    } else {
        drifts.forEach(d => console.log(`  ❌ ${d.user}: ${d.type || d.error}`));
    }
    return ok;
}

// ─── 入口 ────────────────────────────────────────────────────────────────────
async function run(redis) {
    console.log('\n═══ User Service Simulation ═══');

    // 顺序执行（每个测试后 flush，避免互相污染）
    const r1 = await testDuplicateRegistration(redis);
    await redis.flushDb();
    const r2 = await testConcurrentUniqueRegistration(redis);
    await redis.flushDb();
    const r3 = await testSessionIsolation(redis);

    console.log('\n═══ Summary ═══');
    [
        ['Duplicate registration dedup (TOCTOU)', r1],
        ['Concurrent unique registration',        r2],
        ['Concurrent login session isolation',    r3],
    ].forEach(([label, ok]) =>
        console.log(`  ${ok ? '✅' : '❌'} ${label}`)
    );
    console.log('');

    return r1 && r2 && r3;
}

module.exports = { run };
