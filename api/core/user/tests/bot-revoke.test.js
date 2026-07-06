/**
 * bot-revoke.test.js — token 主动吊销(security.md 方案 b:USER:SESSIONS:{uid} 反向索引)。
 * hermetic:注入 Map 支撑的 fake redis,验"签发即入索引 / revoke 杀全部 session + 清索引"。
 * WAL 审计写盘 → LOG_DIR 指临时目录,避免污染 api/logs(须在 require logic 之前)。
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-bot-revoke-${process.pid}`);

const createBot = require('../logic/bot');
const config = require('../config');

function makeFakeRedis() {
    const kv = new Map();
    const sets = new Map();
    const getSet = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));
    const apply = {
        set: (k, v) => { kv.set(k, v); return 'OK'; },
        setEx: (k, _s, v) => { kv.set(k, v); return 'OK'; },
        del: (k) => { const had = kv.delete(k); sets.delete(k); return had ? 1 : 0; },
        sAdd: (k, m) => { const s = getSet(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        sRem: (k, m) => { const s = sets.get(k); return s && s.delete(m) ? 1 : 0; },
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
        async expire(k, s) { return apply.expire(k, s); },
        multi() {
            const ops = [];
            const chain = {
                set(k, v) { ops.push(['set', k, v]); return chain; },
                setEx(k, s, v) { ops.push(['setEx', k, s, v]); return chain; },
                sAdd(k, m) { ops.push(['sAdd', k, m]); return chain; },
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
