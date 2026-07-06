/**
 * 27 · nexus agent + schedule(admin-only;自定义存储).
 * agent → NEXUS:SENTINEL:{id}(+ SET 索引);schedule → NEXUS:SCHEDULE:DEF(RedisJSON)+ ZSET 索引.
 * schedule 用远未来 fire_at + 一次性(recurrence null),测完即删,保证 hermetic.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const FAR_FUTURE = 4102444800000; // 2100-01-01,调度器不会触发

gate('27 · nexus agent + schedule (admin)', () => {
    let redis, agentId;
    const schedId = `e2e-sched-${process.pid}`;

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);
    afterAll(async () => {
        if (agentId) { await redis.del(`NEXUS:SENTINEL:${agentId}`); await redis.sRem('NEXUS:SENTINEL:SET', agentId); }
        await redis.del(`NEXUS:SCHEDULE:DEF:${schedId}`); await redis.zRem('NEXUS:SCHEDULE', schedId);
        await redis.quit();
    });

    test('agent.create → ①API ②落库(+SET 索引)', async () => {
        const a = V.assertResult(await rpc('nexus.sentinel.create', { name: `e2e-agent-${process.pid}`, authorityRole: 'test:role', eventSubscriptions: [] }, ADMIN_TOKEN), 'agent.create');
        agentId = a.id;
        expect(a.status).toBe('ACTIVE');
        await V.assertRecord(redis, `NEXUS:SENTINEL:${agentId}`, { name: `e2e-agent-${process.pid}`, status: 'ACTIVE' });
        expect(await redis.sIsMember('NEXUS:SENTINEL:SET', agentId)).toBeTruthy();
        await V.assertNoErrors(redis, ['nexus']);
    });

    test('agent.get / list reflect it', async () => {
        expect(V.assertResult(await rpc('nexus.sentinel.get', { id: agentId }, ADMIN_TOKEN)).id).toBe(agentId);
        expect(V.assertResult(await rpc('nexus.sentinel.list', {}, ADMIN_TOKEN)).items.some((x) => x.id === agentId)).toBe(true);
    });

    test('schedule.create(one-shot, far future) → 落库(RedisJSON + ZSET)→ delete', async () => {
        V.assertResult(await rpc('nexus.schedule.create', { schedule_id: schedId, fire_at: FAR_FUTURE, recurrence_ms: null, action: { kind: 'emit_event', stream: 'EVENT:E2E', type: 'e2e.tick' }, enabled: true }, ADMIN_TOKEN), 'schedule.create');

        const def = await redis.json.get(`NEXUS:SCHEDULE:DEF:${schedId}`);
        expect(def).toBeTruthy();
        expect(def.fire_at).toBe(FAR_FUTURE);
        expect(await redis.zScore('NEXUS:SCHEDULE', schedId)).toBe(FAR_FUTURE);

        V.assertResult(await rpc('nexus.schedule.delete', { schedule_id: schedId }, ADMIN_TOKEN), 'schedule.delete');
        expect(await redis.exists(`NEXUS:SCHEDULE:DEF:${schedId}`)).toBe(0);
        expect(await redis.zScore('NEXUS:SCHEDULE', schedId)).toBeNull();
    });
});
