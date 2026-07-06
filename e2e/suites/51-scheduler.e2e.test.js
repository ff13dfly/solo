/**
 * 51 · nexus 时间驱动调度真实触发(到点 fire).
 *   ① 一次性 schedule 到点 → scheduler 经 system.nexus emit_event → EVENT 流 +1,且从 zset 移除
 *   ② 循环 schedule 到点 → 触发后**重新挂载**(zset score 推到下一次 fire_at)
 * full profile;harness 已把 NEXUS_SCHEDULER_TICK_MS=1000(默认 30s 太慢)+ 注册表加 system.nexus→EVENT:E2E:*.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, { timeout = 15000, interval = 300 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(interval); }
    return null;
}
async function xlen(redis, s) { try { return await redis.xLen(s); } catch { return 0; } }

gate('51 · nexus scheduler firing', () => {
    let redis;
    const oneShot = `e2e-cron-${process.pid}`;
    const recur = `e2e-cron-rec-${process.pid}`;

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);
    afterAll(async () => {
        for (const id of [oneShot, recur]) { await redis.del(`NEXUS:SCHEDULE:DEF:${id}`); await redis.zRem('NEXUS:SCHEDULE', id); }
        await redis.quit();
    });

    test('① 一次性 schedule 到点 → emit_event 落流 + 从 zset 移除', async () => {
        const stream = 'EVENT:E2E:CRON';
        const before = await xlen(redis, stream);
        const fireAt = Date.now() + 2500;   // 2.5s 后到点(tick=1s)
        V.assertResult(await rpc('nexus.schedule.create', {
            schedule_id: oneShot, fire_at: fireAt, recurrence_ms: null,
            action: { kind: 'emit_event', stream, type: 'e2e.tick', payload: { n: 1 } }, enabled: true,
        }, ADMIN_TOKEN), 'schedule.create(one-shot)');

        // 到点后:scheduler 触发 → 事件落流
        const fired = await poll(async () => (await xlen(redis, stream)) > before, { timeout: 15000 });
        expect(fired).toBe(true);
        // 一次性:从 NEXUS:SCHEDULE zset 移除(不再重挂)
        expect(await redis.zScore('NEXUS:SCHEDULE', oneShot)).toBeNull();
    }, 40_000);

    test('② 循环 schedule 到点 → 触发后重新挂载到下一次 fire_at', async () => {
        const stream = 'EVENT:E2E:REC';
        const before = await xlen(redis, stream);
        const fireAt = Date.now() + 2500;
        const RECUR = 60_000;
        V.assertResult(await rpc('nexus.schedule.create', {
            schedule_id: recur, fire_at: fireAt, recurrence_ms: RECUR,
            action: { kind: 'emit_event', stream, type: 'e2e.rec', payload: {} }, enabled: true,
        }, ADMIN_TOKEN), 'schedule.create(recurring)');

        const fired = await poll(async () => (await xlen(redis, stream)) > before, { timeout: 15000 });
        expect(fired).toBe(true);
        // 循环:仍在 zset,且 score 被推到下一次(≈ firedAt + RECUR,远晚于原 fire_at)
        const next = await poll(async () => {
            const s = await redis.zScore('NEXUS:SCHEDULE', recur);
            return (s && s > fireAt + RECUR / 2) ? s : null;
        }, { timeout: 8000 });
        expect(next).toBeTruthy();
    }, 40_000);
});
