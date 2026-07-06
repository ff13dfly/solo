/**
 * 35 · fieldmask 数据级权限(按用户 constraints 遮蔽字段)的真链路。
 *
 * 此前 RBAC 只测到方法级(能不能调);本suite补**数据级**:同一个方法、同一条数据,
 * 不同用户因 permit.constraints 不同,拿到的字段不同。打通整条:
 *   user.permit.constraints(写在 user:{uid})
 *     → Router 鉴权(Scheme F 实时读 permit)→ forward 把 constraints 打进 X-Router-Token
 *     → collection 的 auth 解出 req.constraints
 *     → collection.payment.get/list handler 调 fieldmask.apply 按 constraints 遮蔽
 *     → 断言:A(无约束)看得到 amount,B(hide amount)看不到。
 *
 * full profile(需 user + router + collection 夹具)。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN, createAndLogin, setPermit, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('35 · fieldmask 数据级权限（按用户 constraints 遮蔽字段）', () => {
    let redis, userA, userB, paymentId;
    const nameA = `e2e-fm-see-${process.pid}`;
    const nameB = `e2e-fm-hide-${process.pid}`;
    const orderId = `fm-${process.pid}`;

    beforeAll(async () => {
        redis = await redisLib.connect();

        // A：有 collection 方法权限、无 constraints → 能看到 amount
        userA = await createAndLogin({ name: nameA });
        await setPermit(redis, userA.uid, { allow_all: false, services: { collection: ['*'] } });

        // B：同样的方法权限，但 constraints 遮蔽 amount → 看不到
        userB = await createAndLogin({ name: nameB });
        await setPermit(redis, userB.uid, {
            allow_all: false,
            services: { collection: ['*'] },
            constraints: {
                'collection.payment.get':  { hide: ['amount'] },
                'collection.payment.list': { hide: ['amount'] },
            },
        });

        // admin 录一笔带 amount 的 payment
        const p = V.assertResult(await rpc('collection.payment.record', { amount: 888, currency: 'CNY', orderId }, ADMIN_TOKEN), 'record');
        paymentId = p.id;
    }, 30_000);

    afterAll(async () => {
        if (userA) await cleanupUser(redis, { uid: userA.uid, name: nameA });
        if (userB) await cleanupUser(redis, { uid: userB.uid, name: nameB });
        if (paymentId) { await redis.del(`COLLECTION:PAYMENT:${paymentId}`); await redis.sRem('COLLECTION:PAYMENT:INDEX', paymentId); }
        await redis.quit();
    });

    test('payment.get：A 看得到 amount，B 看不到（同一条数据）', async () => {
        const a = V.assertResult(await rpc('collection.payment.get', { id: paymentId }, userA.token), 'get as A');
        expect(a.id).toBe(paymentId);
        expect(a.amount).toBe(888);                  // A 无约束 → 全字段可见

        const b = V.assertResult(await rpc('collection.payment.get', { id: paymentId }, userB.token), 'get as B');
        expect(b.id).toBe(paymentId);                // 其余字段照常返回
        expect(b.orderId).toBe(orderId);
        expect(b.amount).toBeUndefined();            // ← amount 被 constraints 遮蔽
    }, 30_000);

    test('payment.list：A 的 items 带 amount，B 的不带（行还在，字段被遮）', async () => {
        const a = V.assertResult(await rpc('collection.payment.list', { pageSize: 500 }, userA.token), 'list as A');
        const itemA = a.items.find((x) => x.id === paymentId);
        expect(itemA?.amount).toBe(888);

        const b = V.assertResult(await rpc('collection.payment.list', { pageSize: 500 }, userB.token), 'list as B');
        const itemB = b.items.find((x) => x.id === paymentId);
        expect(itemB).toBeTruthy();                  // 行仍可见（不是整行被删）
        expect(itemB.amount).toBeUndefined();        // ← 只是 amount 被遮蔽
    }, 30_000);
});
