/**
 * session-migrate.test.js — user 服务启动时的一次性迁移。
 * hermetic:Map 假 Redis(scanIterator 按 node-redis v5 的「逐批 yield 数组」形态)。
 *
 * 修复之前发出去的两类 token,不迁就一直够不着(admin/operator 在用就一直续期,永不过期):
 *   1. 不在 USER:SESSIONS 索引里的 session —— v1.2.16 前人类登录从不进索引;之后的又会因
 *      索引 TTL 早于滑动续期的 session 过期而掉出去 ⇒ user.token.revoke 看不见它们。
 *   2. anchor 落在保留命名空间里的 passport session —— 在 Router 眼里就是那个内部账号 / bot。
 * 见 docs/planning/security.md(2026-09-27)。
 */
const { migrateLiveSessions, MARKER } = require('../logic/session-migrate');

const config = { redis: { sessionPrefix: 'session:', userSessionsPrefix: 'USER:SESSIONS:' } };

function fakeRedis() {
    const kv = new Map(), sets = new Map(), ttlKeys = new Set();
    return {
        kv, sets, ttlKeys,
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v) { kv.set(k, v); return 'OK'; },
        async del(k) { return kv.delete(k) ? 1 : 0; },
        async exists(k) { return kv.has(k) ? 1 : 0; },
        async sAdd(k, m) { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(m); return 1; },
        async persist(k) { ttlKeys.delete(k); return 1; },
        async *scanIterator({ MATCH }) {
            const pre = MATCH.replace(/\*$/, '');
            const keys = [...kv.keys()].filter((k) => k.startsWith(pre));
            for (let i = 0; i < keys.length; i += 2) yield keys.slice(i, i + 2);   // batches, like v5
        },
    };
}

const put = (r, token, blob) => r.kv.set(`session:${token}`, typeof blob === 'string' ? blob : JSON.stringify(blob));
const members = (r, uid) => [...(r.sets.get(`USER:SESSIONS:${uid}`) || [])].sort();

describe('migrateLiveSessions', () => {
    test('🔴 未进索引的人类 / 旧版无 type 的 session 被补进索引,索引 TTL 被去掉', async () => {
        const r = fakeRedis();
        put(r, 't-human', { uid: 'u1', type: 'internal', role: 'admin' });
        put(r, 't-legacy', { uid: 'u1', role: 'admin' });            // v1.2.16 前:没有 type 字段
        r.ttlKeys.add('USER:SESSIONS:u1');
        const out = await migrateLiveSessions(r, config);
        expect(out).toMatchObject({ indexed: 2, purged: 0 });
        expect(members(r, 'u1')).toEqual(['t-human', 't-legacy']);
        expect(r.ttlKeys.has('USER:SESSIONS:u1')).toBe(false);
    });

    test.each([
        ['system.nexus', 'bot 命名空间'],
        ['bot:system.nexus', 'user:bot:<id> 就是 bot 记录'],
    ])('🔴 anchor 为 %s(%s)的 passport session 被删掉', async (anchor) => {
        const r = fakeRedis();
        put(r, 't-evil', { uid: anchor, type: 'external', kind: 'external', permit: {} });
        const out = await migrateLiveSessions(r, config);
        expect(out.purged).toBe(1);
        expect(await r.get('session:t-evil')).toBeNull();
    });

    test('🔴 anchor 撞上内部账号 uid 的 passport session 被删掉', async () => {
        const r = fakeRedis();
        r.kv.set('user:ADMINuid00000001', JSON.stringify({ id: 'ADMINuid00000001' }));
        put(r, 't-evil', { uid: 'ADMINuid00000001', type: 'external', kind: 'external' });
        expect((await migrateLiveSessions(r, config)).purged).toBe(1);
        expect(await r.get('session:t-evil')).toBeNull();
    });

    test('正常 passport session 进索引,但保留它自己的 TTL(不滑动,24h 固定)', async () => {
        const r = fakeRedis();
        put(r, 't-ext', { uid: 'alice@x.com', type: 'external', kind: 'external' });
        r.ttlKeys.add('USER:SESSIONS:alice@x.com');
        await migrateLiveSessions(r, config);
        expect(members(r, 'alice@x.com')).toEqual(['t-ext']);
        expect(r.ttlKeys.has('USER:SESSIONS:alice@x.com')).toBe(true);
    });

    test('没有 uid 的(administrator)、坏 JSON 的 session 跳过,不炸', async () => {
        const r = fakeRedis();
        put(r, 't-admin-svc', { username: 'admin', role: 'admin' });
        put(r, 't-broken', '{not json');
        const out = await migrateLiveSessions(r, config);
        expect(out).toMatchObject({ indexed: 0, purged: 0, skipped: 2 });
        expect(await r.get('session:t-admin-svc')).toBeTruthy();
    });

    test('只跑一次:marker 在就直接返回', async () => {
        const r = fakeRedis();
        put(r, 't1', { uid: 'u1', type: 'internal' });
        expect(await migrateLiveSessions(r, config)).not.toBeNull();
        expect(await r.get(MARKER)).toBeTruthy();
        put(r, 't2', { uid: 'u2', type: 'internal' });
        expect(await migrateLiveSessions(r, config)).toBeNull();
        expect(members(r, 'u2')).toEqual([]);
    });
});
