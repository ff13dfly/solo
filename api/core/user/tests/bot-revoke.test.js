/**
 * bot-revoke.test.js — token 主动吊销(security.md 方案 b:USER:SESSIONS:{uid} 反向索引)。
 * hermetic:注入 Map 支撑的 fake redis,验"签发即入索引 / revoke 杀全部 session + 清索引"。
 *
 * 🔴 两类 principal 都要覆盖。这份文件原先只有 `system.test-bot` 一个 uid,于是
 * security.md 把"按 uid 吊销其全部 live session"记为已修复、并拿它当守护——而人类账号
 * 的登录路径根本没写那个反向索引,revoke 对浏览器账号删 0 条还返回成功。测试只测了
 * 已经工作的那一半,所以它一直是绿的。下面的 human 组就是当初缺的那一半。
 * 见 docs/feedback/account-deletion-does-not-revoke-live-sessions.md
 * WAL 审计写盘 → LOG_DIR 指临时目录,避免污染 api/logs(须在 require logic 之前)。
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-bot-revoke-${process.pid}`);

const crypto = require('crypto');
const createBot = require('../logic/bot');
const createUser = require('../logic/user');
const config = require('../config');

function makeFakeRedis() {
    const kv = new Map();
    const sets = new Map();
    const zsets = new Map();
    const counters = new Map();
    const getSet = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));
    const getZset = (k) => (zsets.has(k) ? zsets.get(k) : zsets.set(k, new Map()).get(k));
    const apply = {
        set: (k, v) => { kv.set(k, v); return 'OK'; },
        setEx: (k, _s, v) => { kv.set(k, v); return 'OK'; },
        del: (k) => { const had = kv.delete(k); sets.delete(k); return had ? 1 : 0; },
        sAdd: (k, m) => { const s = getSet(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        sRem: (k, m) => { const s = sets.get(k); return s && s.delete(m) ? 1 : 0; },
        zAdd: (k, { score, value }) => { getZset(k).set(value, score); return 1; },
        zRem: (k, m) => { const z = zsets.get(k); return z && z.delete(m) ? 1 : 0; },
        expire: () => 1,
    };
    return {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v) { return apply.set(k, v); },
        async setEx(k, s, v) { return apply.setEx(k, s, v); },
        async del(k) { return apply.del(k); },
        async sAdd(k, m) { return apply.sAdd(k, m); },
        async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
        async sRem(k, m) { return apply.sRem(k, m); },
        async incr(k) { const n = (counters.get(k) || 0) + 1; counters.set(k, n); return n; },
        async zAdd(k, entry) { return apply.zAdd(k, entry); },
        async zRem(k, m) { return apply.zRem(k, m); },
        async expire(k, s) { return apply.expire(k, s); },
        multi() {
            const ops = [];
            const chain = {
                set(k, v) { ops.push(['set', k, v]); return chain; },
                setEx(k, s, v) { ops.push(['setEx', k, s, v]); return chain; },
                sAdd(k, m) { ops.push(['sAdd', k, m]); return chain; },
                zAdd(k, entry) { ops.push(['zAdd', k, entry]); return chain; },
                expire(k, s) { ops.push(['expire', k, s]); return chain; },
                del(k) { ops.push(['del', k]); return chain; },
                async exec() { return ops.map(([op, ...args]) => apply[op](...args)); },
            };
            return chain;
        },
    };
}

const UID = 'system.test-bot';
const sKey = (t) => `${config.redis.sessionPrefix}${t}`;
const idxKey = `${config.redis.userSessionsPrefix}${UID}`;

describe('bot token revocation (USER:SESSIONS reverse index)', () => {
    let redis, bot;
    beforeEach(async () => {
        redis = makeFakeRedis();
        bot = createBot(redis, config);
        await bot.create({ uid: UID, permit: { allow_all: false, services: { collection: ['*'] } } });
    });

    test('issueToken → session 落库且入 uid 反向索引', async () => {
        const { token } = await bot.issueToken({ uid: UID });
        expect(await redis.get(sKey(token))).toBeTruthy();
        expect(await redis.sMembers(idxKey)).toContain(token);
    });

    test('revoke → 杀掉该 uid 全部 live session + 清空索引', async () => {
        const a = await bot.issueToken({ uid: UID });
        const b = await bot.tokenRefresh({}, UID);            // 同 uid 第二个 session
        expect((await redis.sMembers(idxKey)).length).toBe(2);

        const res = await bot.revoke({ uid: UID });
        expect(res).toMatchObject({ uid: UID, revoked: 2 });
        expect(await redis.get(sKey(a.token))).toBeNull();    // 两个 session 都没了
        expect(await redis.get(sKey(b.token))).toBeNull();
        expect((await redis.sMembers(idxKey)).length).toBe(0); // 索引清空
    });

    test('revoke 缺 uid → 报错', async () => {
        await expect(bot.revoke({})).rejects.toMatchObject({ code: expect.any(Number) });
    });

    test('revoke 无 session 的 uid → revoked 0', async () => {
        expect((await bot.revoke({ uid: 'system.nobody' })).revoked).toBe(0);
    });
});

// ── 人类账号:登录即入索引,revoke / 删号都要真的断掉 ────────────────────────
describe('human account revocation (the half that used to be missing)', () => {
    const NAME = 'alice';
    const SALT = 'a'.repeat(32);
    const HASH = 'b'.repeat(64);
    let redis, user, bot, uid;

    // 真实走一遍挑战-响应握手,而不是直接塞 session:——捷径会把"登录是否写索引"
    // 这个正要验的东西绕过去。
    async function login() {
        const { challenge } = await user.loginRequest({ name: NAME });
        const response = crypto.createHash('sha256').update(challenge + HASH).digest('hex');
        const r = await user.loginVerify({ name: NAME, challenge, response, deviceId: 'dev-1' });
        return r.token;
    }

    beforeEach(async () => {
        redis = makeFakeRedis();
        user = createUser(redis, config);
        bot = createBot(redis, config);
        ({ uid } = await user.register({ name: NAME, salt: SALT, hash: HASH }));
    });

    test('登录写入 USER:SESSIONS 反向索引(此前是裸 setEx)', async () => {
        const token = await login();
        expect(await redis.get(sKey(token))).toBeTruthy();
        expect(await redis.sMembers(`${config.redis.userSessionsPrefix}${uid}`)).toContain(token);
    });

    test('user.token.revoke 对人类 uid 真的删 session(此前返回 revoked:0 + 成功)', async () => {
        const t1 = await login();
        const t2 = await login();
        const res = await bot.revoke({ uid });
        expect(res.revoked).toBe(2);
        expect(await redis.get(sKey(t1))).toBeNull();
        expect(await redis.get(sKey(t2))).toBeNull();
        expect(await redis.sMembers(`${config.redis.userSessionsPrefix}${uid}`)).toEqual([]);
    });

    test('软删账号 = 吊销:remove 之后旧 token 的 session 不复存在', async () => {
        const token = await login();
        const res = await user.remove({ id: uid });
        expect(res.revoked).toBe(1);
        expect(await redis.get(sKey(token))).toBeNull();
    });

    test('硬删账号 = 吊销:destroy 之后旧 token 的 session 不复存在', async () => {
        const token = await login();
        const res = await user.destroy({ id: uid });
        expect(res.revoked).toBe(1);
        expect(await redis.get(sKey(token))).toBeNull();
    });

    test('remove 幂等:重复调用不炸,且仍报告吊销条数', async () => {
        await login();
        await user.remove({ id: uid });
        const again = await user.remove({ id: uid });
        expect(again.success).toBe(true);
        expect(again.revoked).toBe(0);
    });
});
