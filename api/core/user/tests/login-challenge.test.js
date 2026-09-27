/**
 * login-challenge.test.js — 挑战-响应登录的并发与归一化。
 * hermetic:注入 Map 支撑的 fake redis,直接驱动 logic/user.js。
 *
 * 🔴 challenge 曾按用户名只存一个槽(`challenge:<name>`):同一个号并发登录两次,
 * 后发的 request 覆盖先发的,先发的那个必报 "Invalid or expired challenge";
 * verify 还拿原样的 name 拼键,request('Ops') 存进 ops、verify('Ops') 去读 Ops,恒失败。
 * 见 docs/feedback/done/user-login-challenge-one-slot-per-name.md
 * WAL 审计写盘 → LOG_DIR 指临时目录,避免污染 api/logs(须在 require logic 之前)。
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-login-challenge-${process.pid}`);

const crypto = require('crypto');
const createUser = require('../logic/user');
const config = require('../config');

function makeFakeRedis() {
    const kv = new Map();
    const sets = new Map();
    const counters = new Map();
    const getSet = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));
    const apply = {
        set: (k, v) => { kv.set(k, v); return 'OK'; },
        setEx: (k, _s, v) => { kv.set(k, v); return 'OK'; },
        del: (k) => { const had = kv.delete(k); sets.delete(k); return had ? 1 : 0; },
        sAdd: (k, m) => { const s = getSet(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        expire: () => 1,
        persist: () => 1,
        exists: (k) => (kv.has(k) ? 1 : 0),
    };
    return {
        keys: () => [...kv.keys()],
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async getDel(k) { const v = kv.has(k) ? kv.get(k) : null; kv.delete(k); return v; },
        async set(k, v) { return apply.set(k, v); },
        async setEx(k, s, v) { return apply.setEx(k, s, v); },
        async del(k) { return apply.del(k); },
        async sAdd(k, m) { return apply.sAdd(k, m); },
        async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
        async sRem(k, m) { const s = sets.get(k); if (!s) return 0; let n = 0; for (const x of [].concat(m)) if (s.delete(x)) n++; return n; },
        async exists(k) { return kv.has(k) ? 1 : 0; },
        async persist() { return 1; },
        async incr(k) { const n = (counters.get(k) || 0) + 1; counters.set(k, n); return n; },
        async expire(k, s) { return apply.expire(k, s); },
        multi() {
            const ops = [];
            const chain = {
                set(k, v) { ops.push(['set', k, v]); return chain; },
                setEx(k, s, v) { ops.push(['setEx', k, s, v]); return chain; },
                sAdd(k, m) { ops.push(['sAdd', k, m]); return chain; },
                expire(k, s) { ops.push(['expire', k, s]); return chain; },
                persist(k) { ops.push(['persist', k]); return chain; },
                exists(k) { ops.push(['exists', k]); return chain; },
                del(k) { ops.push(['del', k]); return chain; },
                async exec() { return ops.map(([op, ...args]) => apply[op](...args)); },
            };
            return chain;
        },
    };
}

const NAME = 'ops';
const SALT = 'a'.repeat(32);
const HASH = 'b'.repeat(64);
const respond = (challenge, hash = HASH) => crypto.createHash('sha256').update(challenge + hash).digest('hex');

describe('login challenge — one key per challenge, not one slot per name', () => {
    let redis, user, uid;
    const verify = (challenge, name = NAME) =>
        user.loginVerify({ name, challenge, response: respond(challenge), deviceId: 'dev-1' });

    beforeEach(async () => {
        redis = makeFakeRedis();
        user = createUser(redis, config);
        ({ uid } = await user.register({ name: NAME, salt: SALT, hash: HASH }));
    });

    test('A request → B request → A verify:先发的不再被覆盖(此前 A 恒失败)', async () => {
        const a = await user.loginRequest({ name: NAME });
        const b = await user.loginRequest({ name: NAME });
        await expect(verify(a.challenge)).resolves.toMatchObject({ success: true, uid });
        await expect(verify(b.challenge)).resolves.toMatchObject({ success: true, uid });
    });

    test('A request → B request → B verify → A verify:B 用完不连带删掉 A(此前 A 恒失败)', async () => {
        const a = await user.loginRequest({ name: NAME });
        const b = await user.loginRequest({ name: NAME });
        await expect(verify(b.challenge)).resolves.toMatchObject({ success: true });
        await expect(verify(a.challenge)).resolves.toMatchObject({ success: true });
    });

    test('并发:同一个号同时两轮 request → verify,两个都拿到各自的 token', async () => {
        const run = async () => verify((await user.loginRequest({ name: NAME })).challenge);
        const [x, y] = await Promise.all([run(), run()]);
        expect(x.token).toBeTruthy();
        expect(y.token).toBeTruthy();
        expect(x.token).not.toBe(y.token);
    });

    test('一次性:同一个 challenge 第二次 verify 失败', async () => {
        const { challenge } = await user.loginRequest({ name: NAME });
        await verify(challenge);
        await expect(verify(challenge)).rejects.toMatchObject({ code: -32603 });
    });

    test('答错也会烧掉 challenge:不能拿同一个 challenge 反复试密码', async () => {
        const { challenge } = await user.loginRequest({ name: NAME });
        await expect(user.loginVerify({ name: NAME, challenge, response: respond(challenge, 'c'.repeat(64)) }))
            .rejects.toMatchObject({ code: expect.any(Number) });
        await expect(verify(challenge)).rejects.toMatchObject({ code: -32603 });
    });

    test('verify 与 request 同一套名字归一化(此前 verify("Ops") 恒失败)', async () => {
        const { challenge } = await user.loginRequest({ name: 'Ops' });
        await expect(verify(challenge, '  Ops ')).resolves.toMatchObject({ success: true, uid });
    });

    test('畸形 challenge 直接拒绝,不去 Redis 拼键', async () => {
        await expect(verify('*')).rejects.toMatchObject({ code: -32603 });
        await expect(verify('x'.repeat(32))).rejects.toMatchObject({ code: -32603 });
    });

    test('request 之后账号被软删:旧 challenge 换不出 token(此前照发)', async () => {
        const { challenge } = await user.loginRequest({ name: NAME });
        await user.remove({ id: uid });
        await expect(verify(challenge)).rejects.toMatchObject({ code: -32001 });
    });

    test('名字在 TTL 内易主(destroy + 重注册):旧 challenge 不能兑给新账号', async () => {
        const { challenge } = await user.loginRequest({ name: NAME });
        await user.destroy({ id: uid });
        await user.register({ name: NAME, salt: SALT, hash: HASH });
        await expect(verify(challenge)).rejects.toMatchObject({ code: -32603 });
    });

    test('成功登录后不残留 challenge 键', async () => {
        const { challenge } = await user.loginRequest({ name: NAME });
        await verify(challenge);
        expect(redis.keys().filter((k) => k.startsWith(config.redis.challengePrefix))).toEqual([]);
    });
});
