/**
 * 20 · collection 四连断言示范(§8 的标准结构).
 * 一个写操作同时验证:①API 结果 ②Redis 落库(+INDEX) ③WAL(create/user) ④无异常 key.
 * collection 是 Entity-Factory 实体(COLLECTION:PAYMENT:{id} + :INDEX + WAL),最适合示范.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { createAndLogin, setPermit, cleanupUser } = require('../harness/identity');

const ALLOW_PREFIXES = [
    'COLLECTION:PAYMENT:',   // data key + :INDEX
    'EVENT:PAYMENT:',        // _event piggyback 写的流
    'session:', 'user:', 'challenge:',
    'SYSTEM:', 'active_services', 'system:capability', 'RELAY:TOKEN:',
    'ERROR:QUEUE:', 'RL:',
];

describe('20 · collection four-layer assertion', () => {
    let redis;
    const name = `e2e-coll-${process.pid}`;
    let uid, token;
    const made = [];

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await createAndLogin({ name, password: 'pw' }));
        await setPermit(redis, uid, { allow_all: false, services: { collection: ['*'] } });
    });
    afterAll(async () => {
        for (const id of made) { await redis.del(`COLLECTION:PAYMENT:${id}`); await redis.sRem('COLLECTION:PAYMENT:INDEX', id); }
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    test('record → ①API ②落库 ③WAL ④无异常', async () => {
        const before = await V.snapshotKeyspace(redis);

        // ① API
        const p = V.assertResult(await rpc('collection.payment.record', { amount: 42, currency: 'CNY', orderId: `ord-${process.pid}`, source: 'e2e' }, token), 'record');
        made.push(p.id);
        expect(p.state).toBe('RECEIVED');

        const key = `COLLECTION:PAYMENT:${p.id}`;

        // ② Redis 落库:形状 + 自动字段 + INDEX 成员
        await V.assertRecord(redis, key, { state: 'RECEIVED', amount: 42, currency: 'CNY', status: 'ACTIVE' }, { indexKey: 'COLLECTION:PAYMENT:INDEX' });

        // ③ WAL:create 行,user = 调用方(测试用户 uid),before:null
        V.assertWal(undefined, key, 'create', { user: uid, after: { state: 'RECEIVED' } });

        // ③ happy-path:collection 的 ERROR:QUEUE 空
        await V.assertNoErrors(redis, ['collection']);

        // ④ 无异常:只允许预期前缀新增
        const after = await V.snapshotKeyspace(redis);
        const { unexpected } = V.diffKeyspace(before, after, ALLOW_PREFIXES);
        expect(unexpected).toEqual([]);
    });

    test('get + list reflect the record', async () => {
        const id = made[0];
        const g = V.assertResult(await rpc('collection.payment.get', { id }, token), 'get');
        expect(g.id).toBe(id);

        // pageSize 放大:list 是成员存在性断言,不应依赖默认分页(共享栈里 payment 累积会把它挤出首页)
        const l = V.assertResult(await rpc('collection.payment.list', { pageSize: 1000 }, token), 'list');
        expect(l.items.some((x) => x.id === id)).toBe(true);
    });
});
