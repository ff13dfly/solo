/**
 * bot-suspend.test.js — 可逆 bot 暂停(toFix §二.identity "无可逆 bot 暂停")。
 *
 * 契约:suspend = status→SUSPENDED + 杀掉全部活 session(自刷新被读侧 ACTIVE 门挡死,
 * 不再"revoke 后 still-ACTIVE 自重发");resume = status→ACTIVE(token 由 admin 重发)。
 * hermetic:Map 支撑的 fake redis(复用 bot-revoke 的形状)。
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-bot-suspend-${process.pid}`);

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
        _kv: kv,
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

const UID = 'system.suspend-bot';
const sKey = (t) => `${config.redis.sessionPrefix}${t}`;
const botKey = `${config.redis.bot.prefix}${UID}`;

describe('reversible bot suspension', () => {
    let redis, bot;
    beforeEach(async () => {
        redis = makeFakeRedis();
        bot = createBot(redis, config);
        await bot.create({ uid: UID, permit: { allow_all: false, services: { collection: ['*'] } } });
    });

    test('suspend flips status, kills live sessions, and is idempotent', async () => {
        const { token } = await bot.issueToken({ uid: UID });
        expect(await redis.get(sKey(token))).not.toBeNull();

        const res = await bot.suspend({ uid: UID });
        expect(res.status).toBe('SUSPENDED');
        expect(res.revoked).toBe(1);
        expect(await redis.get(sKey(token))).toBeNull();             // live session dead
        expect(JSON.parse(await redis.get(botKey)).status).toBe('SUSPENDED');

        const again = await bot.suspend({ uid: UID });               // idempotent
        expect(again.revoked).toBe(0);
    });

    test('suspended bot cannot issue or self-refresh (read gates bite)', async () => {
        await bot.suspend({ uid: UID });
        // jsonrpc errors are plain {code,message} descriptors, not Error instances →
        // match on the message field rather than toThrow.
        await expect(bot.issueToken({ uid: UID })).rejects.toMatchObject({ message: expect.stringMatching(/not active/i) });
        await expect(bot.tokenRefresh({}, UID)).rejects.toMatchObject({ message: expect.stringMatching(/not active/i) });
    });

    test('resume restores ACTIVE and re-enables issuance (full reversibility)', async () => {
        await bot.suspend({ uid: UID });
        const res = await bot.resume({ uid: UID });
        expect(res.status).toBe('ACTIVE');

        const { token } = await bot.issueToken({ uid: UID });
        expect(await redis.get(sKey(token))).not.toBeNull();

        const refreshed = await bot.tokenRefresh({}, UID);
        expect(refreshed.token).toBeTruthy();
    });

    test('suspend/resume of an unknown bot throws NOT_FOUND-style error', async () => {
        await expect(bot.suspend({ uid: 'system.ghost' })).rejects.toBeDefined();
        await expect(bot.resume({ uid: 'system.ghost' })).rejects.toBeDefined();
    });
});
