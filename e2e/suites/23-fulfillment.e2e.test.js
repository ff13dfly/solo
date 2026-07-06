/**
 * 23 · fulfillment 状态机:instance(自定义存储 + history)四连(无 WAL).
 *
 * 历史注:profile.create 曾存在 id/key 错位 bug(entity factory 生成 key 而非用 clientId),
 * 当时绕过方式是直接 Redis 注入 profile。该 bug 已在 entity.js clientId:true 分支修复;
 * 本套已改回走真实 profile.create API,并断言 profile.get 可以用同一 id 取到。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('23 · fulfillment instance (state machine)', () => {
    let redis, uid, token, instanceId;
    const name   = `e2e-fulfil-${process.pid}`;
    const profId = `e2e-prof-${process.pid}`;

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await sessionUser(redis, name, { fulfillment: ['*'] }));
        // 走真实 API 建 profile(clientId:true 已修复,id 直接作 Redis key)
        V.assertResult(await rpc('fulfillment.profile.create', {
            id: profId,
            name: 'E2E profile',
            transitions: [{ event: 'start', from: 'DRAFT', to: 'PROCESSING', condition: null, actions: [] }],
        }, token), 'profile.create in beforeAll');
    }, 20_000);

    afterAll(async () => {
        await rpc('fulfillment.profile.destroy', { id: profId }, token).catch(() => {});
        if (instanceId) { await redis.del(`FULFILLMENT:INSTANCE:${instanceId}`); await redis.sRem('FULFILLMENT:INSTANCE:INDEX', instanceId); }
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    test('profile.create → get 用同一 id 可取回(clientId 路径)', async () => {
        const got = V.assertResult(await rpc('fulfillment.profile.get', { id: profId }, token), 'profile.get');
        expect(got.id).toBe(profId);
        expect(got.status).toBe('ACTIVE');
        expect(got.transitions[0].event).toBe('start');
    });

    test('instance.create → ①API ②落库(自定义存储,DRAFT,createdBy=uid,+SET 索引)', async () => {
        const inst = V.assertResult(await rpc('fulfillment.instance.create', { sourceId: `ORD-${process.pid}`, profileId: profId, meta: { k: 'v' } }, token), 'instance.create');
        instanceId = inst.id;
        expect(inst.state).toBe('DRAFT');

        const rec = await V.assertRecord(redis, `FULFILLMENT:INSTANCE:${instanceId}`, { state: 'DRAFT', createdBy: uid });
        expect(rec.sourceId).toBe(`ORD-${process.pid}`);
        expect(Array.isArray(rec.history)).toBe(true);
        expect(await redis.sIsMember('FULFILLMENT:INSTANCE:INDEX', instanceId)).toBeTruthy();
        await V.assertNoErrors(redis, ['fulfillment']);
    });

    test('instance.get / list reflect it', async () => {
        expect(V.assertResult(await rpc('fulfillment.instance.get', { id: instanceId }, token)).id).toBe(instanceId);
        expect(V.assertResult(await rpc('fulfillment.instance.list', { state: 'DRAFT' }, token)).items.some((x) => x.id === instanceId)).toBe(true);
    });
});
