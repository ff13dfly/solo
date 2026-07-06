/**
 * 103 · fulfillment.profile.generate — NL requirement → lint-clean candidate → landable.
 *
 * Step 3 (productionized) end-to-end on the LIVE mesh:
 *   1. call fulfillment.profile.generate({ requirement }) — the service bridges to the LLM
 *      (relay → agent.chat; offline mock returns a canned order-flow profile), runs the
 *      production linter against the real introspection index, and repairs on errors.
 *   2. assert the returned CANDIDATE is lint-clean (ok=true, 0 errors) — 可检测.
 *   3. create it, build an instance, drive DRAFT→PAID→CONFIRMED with each transition
 *      dispatching a _task to the real market.order.* — assert the order reaches CONFIRMED.
 *      The generated-via-RPC profile actually lands and runs — 可落地.
 *
 * full profile only (needs fulfillment + market + agent[mock] + Router _task dispatch).
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PID = process.pid;

const PROFILE_ID = `gen-rpc-103-${PID}`;
const { WL_KEY, TASK_WHITELIST_SUPERSET } = require('../lib/whitelist');
const REQUIREMENT = [
    '订单先收款,再人工/AI 复核才放行,否则冻结:',
    'DRAFT 收到 pay 事件 → 标记订单已付,进入 PAID;',
    'PAID 收到 review 事件带 decision —— approve 且金额不超过 50000 → 确认订单,进入 CONFIRMED;否则 → 冻结订单,进入 HELD。',
].join('\n');

gate('103 · fulfillment.profile.generate — generate → lint-clean → landable', () => {
    let redis, prevWhitelist, candidate, orderId, instanceId;

    // 90s headroom (inside the bumped 150s test timeouts): landing a generated profile traverses
    // a long async chain (transition → Router _task → market order) that lags under full-run load.
    async function pollOrderState(id, want, { tries = 180, delay = 500 } = {}) {
        let last = null;
        for (let i = 0; i < tries; i++) {
            const r = await rpc('market.order.get', { id }, ADMIN_TOKEN);
            last = r.result;
            if (last && last.state === want) return last;
            await sleep(delay);
        }
        return last;
    }

    beforeAll(async () => {
        redis = await redisLib.connect();
        prevWhitelist = await redis.get(WL_KEY);
        // Shared superset (seeded at harness boot) — value never flips → no §5.6③ cache race.
        await redis.set(WL_KEY, JSON.stringify(TASK_WHITELIST_SUPERSET));
    }, 30_000);

    afterAll(async () => {
        if (!redis) return;
        if (prevWhitelist) await redis.set(WL_KEY, prevWhitelist); else await redis.del(WL_KEY);
        if (instanceId) { await redis.del(`FULFILLMENT:INSTANCE:${instanceId}`); await redis.sRem('FULFILLMENT:INSTANCE:INDEX', instanceId); }
        if (orderId) { await redis.del(`MARKET:ORDER:${orderId}`); await redis.sRem('MARKET:ORDER:INDEX', orderId); }
        await redis.del(`FULFILLMENT:PROFILE:${PROFILE_ID}`);
        await redis.sRem('FULFILLMENT:PROFILE:INDEX', PROFILE_ID);
        await redis.quit();
    }, 30_000);

    // ── Step 3: the generate RPC returns a lint-clean candidate (可检测) ──
    test('generate: NL requirement → lint-clean profile candidate (ok=true, 0 errors)', async () => {
        const res = V.assertResult(await rpc('fulfillment.profile.generate', { requirement: REQUIREMENT, profileId: PROFILE_ID }, ADMIN_TOKEN), 'profile.generate');
        console.log(`[103] generate: ok=${res.ok} attempts=${res.attempts} errors=${res.lintReport.errors.length} warnings=${res.lintReport.warnings.length}`);
        if (!res.ok) console.error('[103] lint errors:', res.lintReport.errors);
        expect(res.ok).toBe(true);
        expect(res.lintReport.errors).toEqual([]);
        expect(res.profile && Array.isArray(res.profile.transitions)).toBe(true);
        expect(res.profile.transitions.length).toBeGreaterThanOrEqual(2);
        candidate = res.profile;
        candidate.id = PROFILE_ID;   // generate already stamps it; belt-and-suspenders for create()
    }, 120_000);

    // ── 可落地: the generated candidate creates + executes ──
    test('land: create the candidate + an order + a DRAFT instance', async () => {
        V.assertResult(await rpc('fulfillment.profile.create', candidate, ADMIN_TOKEN), 'profile.create');
        const order = V.assertResult(await rpc('market.order.create', { orderRef: `gen-103-${PID}`, amount: 5000, currency: 'CNY' }, ADMIN_TOKEN), 'order.create');
        orderId = order.id;
        const inst = V.assertResult(await rpc('fulfillment.instance.create', { sourceId: orderId, profileId: PROFILE_ID, meta: { orderId } }, ADMIN_TOKEN), 'instance.create');
        instanceId = inst.id;
        expect(inst.state).toBe('DRAFT');
    }, 30_000);

    test('land: pay → PAID, then review/approve → CONFIRMED (order confirmed via _tasks)', async () => {
        const paid = V.assertResult(await rpc('fulfillment.instance.transition', { id: instanceId, event: 'pay' }, ADMIN_TOKEN), 'transition(pay)');
        expect(paid.state).toBe('PAID');
        expect((await pollOrderState(orderId, 'PAID'))?.state).toBe('PAID');

        const confirmed = V.assertResult(await rpc('fulfillment.instance.transition', { id: instanceId, event: 'review', metaUpdate: { decision: 'approve', amount: 5000 } }, ADMIN_TOKEN), 'transition(review)');
        expect(confirmed.state).toBe('CONFIRMED');
        expect((await pollOrderState(orderId, 'CONFIRMED'))?.state).toBe('CONFIRMED');
    }, 120_000);

    test('no service-side errors across fulfillment + market + agent', async () => {
        await V.assertNoErrors(redis, ['fulfillment', 'market', 'agent']);
    });
});
