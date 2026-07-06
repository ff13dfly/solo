/**
 * 102 · generated fulfillment profile — lint-clean (可检测) AND landable (可落地).
 *
 * Proves the "describe → generate → lint → land" pipeline end-to-end on the LIVE mesh:
 *
 *   可检测 — take a PROFILE produced from an NL requirement (the artifact a generator
 *            returns) and run the PRODUCTION linter (apps/fulfillment/logic/lint.js)
 *            against the REAL cross-service introspection index → assert 0 errors. A
 *            generated profile that would silently misbehave (hallucinated source method /
 *            pick field / unbacked condition var / hallucinated ACTION method) is rejected
 *            HERE, before activation — not discovered in production.
 *
 *   可落地 — fulfillment.profile.create the same profile, build an instance, and drive it
 *            through the state machine (DRAFT --pay--> PAID --review/approve--> CONFIRMED),
 *            each transition dispatching a _task to the real market.order.* method
 *            → assert the order actually reaches CONFIRMED. The generated JSON executes.
 *
 * NL requirement behind GENERATED_PROFILE:
 *   "订单先收款,再复核放行,否则冻结:DRAFT --pay--> PAID(market.order.pay);
 *    PAID 收 review 事件带 decision —— approve 且金额≤50000 → CONFIRMED(market.order.confirm),
 *    否则 → HELD(market.order.hold)。金额从 market.order.get 拉取。"
 *
 * full profile only (needs fulfillment + market + Router _task dispatch).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
process.env.LOG_DIR = process.env.LOG_DIR || path.join(os.tmpdir(), `solo-e2e-102-${process.pid}`);

const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

// Production linter + the SAME index-build the CI hermetic suite uses (real introspection).
const API_ROOT = path.join(__dirname, '..', '..', 'api');
const { lintProfile, buildMethodIndex } = require(path.join(API_ROOT, 'apps/fulfillment/logic/lint'));
function realMethodIndex() {
    const arrs = [];
    for (const tier of ['core', 'apps']) {
        const dir = path.join(API_ROOT, tier);
        if (!fs.existsSync(dir)) continue;
        for (const svc of fs.readdirSync(dir)) {
            const f = path.join(dir, svc, 'handlers', 'introspection.js');
            if (fs.existsSync(f)) { try { arrs.push(require(f)); } catch (_) { /* skip unloadable */ } }
        }
    }
    return buildMethodIndex(arrs);
}

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PID = process.pid;

const PROFILE_ID = `gen-profile-102-${PID}`;
const { WL_KEY, TASK_WHITELIST_SUPERSET } = require('../lib/whitelist');

// ── the GENERATED artifact (NL → JSON; grounded in real methods + market.order.get's
//    real return field `amount`). This is exactly what a generator would hand back. ──
const GENERATED_PROFILE = {
    id: PROFILE_ID,
    name: '货款放行履约流程 (generated)',
    meta_fields: [
        { key: 'amount', source: { service: 'market', method: 'order.get', params: { id: { var: 'instance.meta.orderId' } }, pick: 'amount' } },
        { key: 'decision' }, // supplied at transition time via the review event's metaUpdate
    ],
    transitions: [
        { event: 'pay', from: 'DRAFT', to: 'PAID', condition: null,
          actions: [{ type: 'task', method: 'market.order.pay', params: { id: { var: 'instance.meta.orderId' } } }] },
        { event: 'review', from: 'PAID', to: 'CONFIRMED',
          condition: { and: [{ '==': [{ var: 'instance.meta.decision' }, 'approve'] }, { '<=': [{ var: 'instance.meta.amount' }, 50000] }] },
          actions: [{ type: 'task', method: 'market.order.confirm', params: { id: { var: 'instance.meta.orderId' } } }] },
        { event: 'review', from: 'PAID', to: 'HELD',
          condition: { or: [{ '!=': [{ var: 'instance.meta.decision' }, 'approve'] }, { '>': [{ var: 'instance.meta.amount' }, 50000] }] },
          actions: [{ type: 'task', method: 'market.order.hold', params: { id: { var: 'instance.meta.orderId' } } }] },
    ],
};

gate('102 · generated fulfillment profile — lint-clean AND landable', () => {
    let redis, prevWhitelist, orderId, instanceId;

    // 90s headroom (inside the bumped 150s test timeouts): landing a generated profile traverses
    // a long async chain (transition → Router _task → market order) that lags under full-run
    // load; the old 30s (60×500) flaked there. The order DOES reach the state, just slowly.
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
        // Allow fulfillment _tasks to dispatch to market.order.* (full-replace + restore).
        prevWhitelist = await redis.get(WL_KEY);
        // Shared superset (seeded at harness boot) — same value every run so the Router's
        // 60s whitelist cache never flips and no market _task is wrongly blocked (§5.6③).
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

    // ── 可检测 ──────────────────────────────────────────────────────────────────
    test('detectable: generated profile lints clean (0 errors) against the real introspection index', () => {
        const { errors, warnings } = lintProfile(GENERATED_PROFILE, realMethodIndex());
        if (errors.length) console.error('[102] lint errors:', errors);
        console.log(`[102] lint: ${errors.length} errors, ${warnings.length} warnings (warnings are advisory)`);
        expect(errors).toEqual([]);
    });

    // ── 可落地 ──────────────────────────────────────────────────────────────────
    test('landable: create the generated profile + an order + a DRAFT instance', async () => {
        V.assertResult(await rpc('fulfillment.profile.create', GENERATED_PROFILE, ADMIN_TOKEN), 'profile.create');
        const order = V.assertResult(await rpc('market.order.create', { orderRef: `gen-102-${PID}`, amount: 5000, currency: 'CNY' }, ADMIN_TOKEN), 'order.create');
        orderId = order.id;
        const inst = V.assertResult(await rpc('fulfillment.instance.create', { sourceId: orderId, profileId: PROFILE_ID, meta: { orderId } }, ADMIN_TOKEN), 'instance.create');
        instanceId = inst.id;
        expect(inst.state).toBe('DRAFT');
    }, 30_000);

    test('landable: `pay` drives DRAFT→PAID and its _task advances the order to PAID', async () => {
        const r = V.assertResult(await rpc('fulfillment.instance.transition', { id: instanceId, event: 'pay' }, ADMIN_TOKEN), 'transition(pay)');
        expect(r.state).toBe('PAID');
        const order = await pollOrderState(orderId, 'PAID');
        expect(order && order.state).toBe('PAID');
    }, 120_000);

    test('landable: `review` with decision=approve drives PAID→CONFIRMED and confirms the order', async () => {
        const r = V.assertResult(await rpc('fulfillment.instance.transition', { id: instanceId, event: 'review', metaUpdate: { decision: 'approve', amount: 5000 } }, ADMIN_TOKEN), 'transition(review)');
        expect(r.state).toBe('CONFIRMED');                       // condition-branching picked the CONFIRMED rule
        const order = await pollOrderState(orderId, 'CONFIRMED');
        expect(order && order.state).toBe('CONFIRMED');
    }, 120_000);

    test('no service-side errors across fulfillment + market', async () => {
        await V.assertNoErrors(redis, ['fulfillment', 'market']);
    });
});
