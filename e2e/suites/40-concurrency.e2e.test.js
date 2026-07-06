/**
 * 40 · 并发正确性(race correctness)—— 在单个 test 内用 Promise.all 发 N 个并发请求,
 * 断言**聚合不变量**(不依赖具体时序,故确定、不 flaky)。
 *   ① user.register 同名并发 → 恰好 1 成功(SET NX TOCTOU 护栏)
 *   ② collection 并发 create → N 个不同 id + INDEX 一致(entity NX 抢占 + MULTI/EXEC)
 *   ③ ingress 并发同 request_id → 恰好 1 条进流(SET NX EX 去重)
 *   ④ 同实体并发 update → 不丢更新(读改写/乐观锁)—— 探针,可能暴露 last-writer-wins 丢写
 * 纯负载/吞吐不在此(那是 perf 工具的事)。full profile.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sha256, randomHex } = require('../lib/crypto');
const { ADMIN_TOKEN, createAndLogin, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const N = 25;
const range = (n) => Array.from({ length: n }, (_, i) => i);

gate('40 · concurrency (race correctness)', () => {
    let redis;
    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);
    afterAll(async () => { await redis.quit(); });

    test('① register 同名并发 → 恰好 1 成功(SET NX TOCTOU)', async () => {
        const name = `e2e-conc-reg-${process.pid}`;
        const results = await Promise.all(range(N).map((i) => {
            const salt = randomHex(16);
            return rpc('user.register', { name, salt, hash: sha256(`pw${i}` + salt) });
        }));
        const winners = results.filter((r) => r.result && r.result.uid);
        expect(winners.length).toBe(1);                                   // 恰好 1 个抢到名字
        const uid = await redis.get(`user:name:${name}`);
        expect(uid).toBe(winners[0].result.uid);                          // 映射指向赢家
        expect(await redis.sCard('user:ids')).toBeGreaterThanOrEqual(1);

        await cleanupUser(redis, { uid, name });
    }, 40_000);

    test('② collection 并发 create → N 个不同 id + INDEX 一致', async () => {
        const results = await Promise.all(range(N).map((i) =>
            rpc('collection.payment.record', { amount: 1, currency: 'CNY', orderId: `conc-${process.pid}-${i}` }, ADMIN_TOKEN)));
        const ids = results.map((r) => r.result && r.result.id).filter(Boolean);
        expect(ids.length).toBe(N);                                       // 全部成功
        expect(new Set(ids).size).toBe(N);                               // id 全不同(无碰撞/覆盖)
        for (const id of ids) {
            expect(await redis.exists(`COLLECTION:PAYMENT:${id}`)).toBe(1);
            expect(await redis.sIsMember('COLLECTION:PAYMENT:INDEX', id)).toBeTruthy();   // 无孤儿
        }
        for (const id of ids) { await redis.del(`COLLECTION:PAYMENT:${id}`); await redis.sRem('COLLECTION:PAYMENT:INDEX', id); }
    }, 40_000);

    test('③ ingress 并发同 request_id → 恰好 1 条进流(SET NX EX 去重)', async () => {
        const sname = `concsrc${process.pid}`;
        const s = V.assertResult(await rpc('ingress.source.create', { name: sname, dedupTtlSec: 120 }, ADMIN_TOKEN), 'source.create');
        const before = await redis.xLen(s.stream).catch(() => 0);
        const reqId = `conc-req-${process.pid}`;
        await Promise.all(range(N).map(() =>
            rpc('ingress.ingest', { request_id: reqId, data: { x: 1 } }, null, { authHeader: `ApiKey ${s.apiKey}` })));
        expect((await redis.xLen(s.stream)) - before).toBe(1);            // 去重:恰好 1 条

        await rpc('ingress.source.delete', { id: s.id }, ADMIN_TOKEN).catch(() => {});
        await redis.del(`INGRESS:NAME:${sname}`); await redis.del(s.stream);
    }, 40_000);

    test('④ 同实体并发 update → 不丢更新(每个并发写一个不同 meta key)', async () => {
        const name = `e2e-conc-upd-${process.pid}`;
        const { uid } = await createAndLogin({ name });
        await Promise.all(range(N).map((i) =>
            rpc('user.account.update', { uid, meta: { [`k${i}`]: i } }, ADMIN_TOKEN)));
        const user = JSON.parse(await redis.get(`user:${uid}`));
        const present = range(N).filter((i) => user.meta && `k${i}` in user.meta);
        // 理想:N 个并发 meta patch 互不覆盖,全部保留(user.update 注释声称"concurrent patches don't clobber").
        expect(present.length).toBe(N);

        await cleanupUser(redis, { uid, name });
    }, 40_000);
});
