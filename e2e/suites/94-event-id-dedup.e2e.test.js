/**
 * 94 · Router event_id idempotency (event.md §4.7 / D4).
 *
 * The Router suppresses a re-delivered event carrying the SAME caller-supplied `event_id`
 * (SET EVENT:DEDUP:{event_id} NX EX) — so a background loop that emitted then crashed before
 * acking won't double-write on re-send. Previously only unit-tested (router/tests/events.test.js);
 * this drives it live through `event.emit`.
 *
 * Harness registers `e2e-admin` (the admin session source) for `EVENT:E2EDEDUP:*` / `e2e.dedup`
 * so the admin token can emit there past the registry whitelist. Full profile only.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('94 · Router event_id dedup (suppress re-delivery)', () => {
    let redis;
    const sfx = process.pid;
    const stream = `EVENT:E2EDEDUP:${sfx}`;
    const idA = `dedup-${sfx}-aaaa`;   // matches /^[A-Za-z0-9_-]{8,64}$/
    const idB = `dedup-${sfx}-bbbb`;

    const emit = (event_id) => rpc('event.emit', { stream, type: 'e2e.dedup', event_id, payload: { n: 1 } }, ADMIN_TOKEN);
    const xlen = () => redis.xLen(stream).catch(() => 0);

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);
    afterAll(async () => {
        if (!redis) return;
        await redis.del(stream);
        await redis.del(`EVENT:DEDUP:${idA}`);
        await redis.del(`EVENT:DEDUP:${idB}`);
        await redis.quit();
    });

    test('same event_id is written once, re-send suppressed; a new id still writes', async () => {
        // ① first emit lands
        const r1 = V.assertResult(await emit(idA), 'emit #1');
        expect(r1.written).toBe(1);
        expect(r1.deduped).toBe(0);
        expect(await xlen()).toBe(1);

        // ② re-send with the SAME event_id is suppressed — not written, deduped counter ticks
        const r2 = V.assertResult(await emit(idA), 'emit #2 (same id)');
        expect(r2.written).toBe(0);
        expect(r2.deduped).toBe(1);
        expect(await xlen()).toBe(1);          // THE PROOF: still exactly one entry on the stream

        // ③ a DIFFERENT event_id writes — proves it's id-specific dedup, not a blanket block
        const r3 = V.assertResult(await emit(idB), 'emit #3 (new id)');
        expect(r3.written).toBe(1);
        expect(await xlen()).toBe(2);
    }, 30_000);
});
