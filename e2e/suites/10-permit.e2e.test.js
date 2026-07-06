/**
 * 10 · permit 杠杆(Router checkAccess,§5/§7).
 * 最小 permit → collection.payment.record 被挡(可达但 Forbidden);
 * 直写 user:{uid}.permit 放宽(Scheme F 实时生效)→ 同样调用成功.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { createAndLogin, setPermit, cleanupUser } = require('../harness/identity');

describe('10 · permit lever (Router checkAccess)', () => {
    let redis;
    const name = `e2e-permit-${process.pid}`;
    let uid, token;
    const madePayments = [];

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await createAndLogin({ name, password: 'pw' }));
    });
    afterAll(async () => {
        for (const id of madePayments) { await redis.del(`COLLECTION:PAYMENT:${id}`); await redis.sRem('COLLECTION:PAYMENT:INDEX', id); }
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    test('minimal permit → collection.payment.record is Forbidden (reachable, not -32601)', async () => {
        const res = await rpc('collection.payment.record', { amount: 10, currency: 'CNY' }, token);
        const err = V.assertRpcError(res, undefined, 'minimal permit should be forbidden');
        expect(err.code).not.toBe(-32601);   // 不是"方法不存在" → 说明可达,是权限被挡
    });

    test('widen permit (services.collection=[*]) → same call succeeds', async () => {
        await setPermit(redis, uid, { allow_all: false, services: { collection: ['*'] } });

        const res = await rpc('collection.payment.record', { amount: 10, currency: 'CNY', orderId: `o-${process.pid}` }, token);
        const p = V.assertResult(res, 'record after widen');
        madePayments.push(p.id);
        expect(p.state).toBe('RECEIVED');
        expect(p.amount).toBe(10);
    });
});
