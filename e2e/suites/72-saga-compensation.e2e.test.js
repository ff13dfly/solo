/**
 * 72 · Saga compensation runs against REAL services (orchestrator §7).
 *
 * A workflow charges (commits a real payment), then a later step fails. The engine must
 * auto-run the charge step's `compensate` (in reverse) against the live collection service:
 *   ① compensation SUCCEEDS → a real reversal payment is posted, with params resolved from
 *      the committed step's result ($step.charge.result.id / .amount); run = FAILED, the
 *      EVENT:WORKFLOW:STATUS event carries compensated:true.
 *   ② compensation FAILS → EVENT:WORKFLOW:DEAD_LETTER is emitted (never silently swallowed).
 *
 * Async path (orchestrator.run.enqueue → worker runs under the system.orchestrator bot,
 * whose seeded permit covers collection:['*'], so the footprint pre-check passes with no
 * grant). Full profile only.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, { timeout = 25000, interval = 400 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(interval); }
    return null;
}
const TERMINAL = ['FAILED', 'DONE', 'DEADLETTER', 'STALLED', 'ABORTED'];

// Find the latest payload for a workflow id in a WORKFLOW event stream.
async function findEvent(redis, stream, type, wfId) {
    const entries = await redis.xRange(stream, '-', '+').catch(() => []);
    const matches = entries
        .map((e) => e.message)
        .filter((m) => m && m.type === type)
        .map((m) => { try { return JSON.parse(m.payload); } catch { return null; } })
        .filter((p) => p && p.workflow_id === wfId);
    return matches.length ? matches[matches.length - 1] : null;
}

gate('72 · Saga compensation against real services', () => {
    let redis;
    const sfx = process.pid;
    const wfIds = [];
    const runIds = [];
    const payIds = [];

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);
    afterAll(async () => {
        if (!redis) return;
        for (const id of wfIds) { await redis.del(`ORCHESTRATOR:WORKFLOW:${id}`); await redis.sRem('ORCHESTRATOR:WORKFLOW_INDEX', id); }
        for (const id of runIds) { await redis.del(`ORCHESTRATOR:RUN:${id}`); await redis.sRem('ORCHESTRATOR:RUN_INDEX', id); }
        for (const id of payIds) { await redis.del(`COLLECTION:PAYMENT:${id}`); await redis.sRem('COLLECTION:PAYMENT:INDEX', id); }
        await redis.quit();
    });

    async function seedAndRun(wfId, steps) {
        const now = Date.now();
        await redis.json.set(`ORCHESTRATOR:WORKFLOW:${wfId}`, '$', {
            id: wfId, category: 'e2e-saga', priority: 50, name: 'saga comp', desc: 'compensation on failure',
            tags: [], examples: [], negative: [], keywords: [], required_inputs: [], optional_inputs: [], synonyms: {},
            steps, resolvers: {}, allowed_triggers: ['event'], event_subscriptions: [],
            status: 'ACTIVE', submittedBy: 'e2e', approvals: [], createdAt: now, updatedAt: now,
        });
        await redis.sAdd('ORCHESTRATOR:WORKFLOW_INDEX', wfId);
        wfIds.push(wfId);

        const cmd = V.assertResult(await rpc('orchestrator.run.enqueue', { workflowId: wfId, input: {}, triggerSource: 'event' }, ADMIN_TOKEN), 'run.enqueue');
        const runId = cmd.runId;
        expect(runId).toBeTruthy();
        runIds.push(runId);

        const run = await poll(async () => {
            const r = await redis.json.get(`ORCHESTRATOR:RUN:${runId}`).catch(() => null);
            return r && TERMINAL.includes(r.status) ? r : null;
        });
        return { runId, run };
    }

    test('compensation SUCCEEDS: a real reversal payment is posted with resolved params', async () => {
        const order = `saga-${sfx}`;
        const { run } = await seedAndRun(`wfSagaOk${sfx}`, [
            { id: 'charge', service: 'collection', method: 'collection.payment.record',
              params: { amount: 100, currency: 'CNY', orderId: order }, compensate: 'reverse_charge' },
            // deterministic failure: settle a payment id that does not exist
            { id: 'ship', service: 'collection', method: 'collection.payment.settle',
              params: { id: `missing-${sfx}` } },
            // compensation-only step (referenced by charge.compensate) — posts a reversal entry,
            // resolving amount + the original payment id from the committed charge step.
            { id: 'reverse_charge', service: 'collection', method: 'collection.payment.record',
              params: { amount: '$step.charge.result.amount', currency: 'CNY', source: 'saga-reversal',
                        externalRef: '$step.charge.result.id', orderId: `saga-rev-${sfx}` } },
        ]);

        expect(run).toBeTruthy();
        expect(run.status).toBe('FAILED');
        expect(run.failedStep).toBe('ship');

        // engine view: the failure event records that compensation ran cleanly
        const ev = await findEvent(redis, 'EVENT:WORKFLOW:STATUS', 'workflow.run.failed', `wfSagaOk${sfx}`);
        expect(ev).toBeTruthy();
        expect(ev.compensated).toBe(true);
        expect(ev.compensation_failed).toBe(false);

        // the run doc PERSISTS the rollback outcome (the operator UI reads run.compensation)
        expect(run.compensation).toBeTruthy();
        expect(run.compensation.ran).toBe(true);
        expect(run.compensation.failed).toBe(false);
        expect((run.compensation.entries || []).map((e) => e.forStep)).toContain('charge');

        // real-service view: list payments, find the original charge + the reversal it produced
        const list = V.assertResult(await rpc('collection.payment.list', { page: 1, pageSize: 200 }, ADMIN_TOKEN), 'payment.list');
        const charge = (list.items || []).find((p) => p.orderId === order && p.source !== 'saga-reversal');
        const reversal = (list.items || []).find((p) => p.orderId === `saga-rev-${sfx}` && p.source === 'saga-reversal');
        expect(charge).toBeTruthy();
        expect(reversal).toBeTruthy();
        if (charge) payIds.push(charge.id);
        if (reversal) payIds.push(reversal.id);

        // PROOF the compensation step ran the real method with params resolved from the committed step
        expect(reversal.externalRef).toBe(charge.id);   // $step.charge.result.id
        expect(reversal.amount).toBe(100);              // $step.charge.result.amount
    }, 40_000);

    test('compensation FAILS → EVENT:WORKFLOW:DEAD_LETTER (never silently swallowed)', async () => {
        const order = `sagaf-${sfx}`;
        const { run } = await seedAndRun(`wfSagaErr${sfx}`, [
            { id: 'charge', service: 'collection', method: 'collection.payment.record',
              params: { amount: 50, currency: 'CNY', orderId: order }, compensate: 'bad_reverse' },
            { id: 'ship', service: 'collection', method: 'collection.payment.settle',
              params: { id: `missing2-${sfx}` } },
            // compensation that itself FAILS (settles a non-existent payment → NOT_FOUND)
            { id: 'bad_reverse', service: 'collection', method: 'collection.payment.settle',
              params: { id: `nope-${sfx}` } },
        ]);

        expect(run).toBeTruthy();
        expect(run.status).toBe('FAILED');

        const dl = await poll(async () => findEvent(redis, 'EVENT:WORKFLOW:DEAD_LETTER', 'workflow.compensation.failed', `wfSagaErr${sfx}`));
        expect(dl).toBeTruthy();
        expect(dl.compensation_failures).toBeGreaterThanOrEqual(1);

        // clean up the one committed payment
        const list = V.assertResult(await rpc('collection.payment.list', { page: 1, pageSize: 200 }, ADMIN_TOKEN), 'payment.list');
        const charge = (list.items || []).find((p) => p.orderId === order);
        if (charge) payIds.push(charge.id);
    }, 40_000);

    test('REVERSE order: two committed compensable steps undo last-committed-first', async () => {
        // charge_a then charge_b both commit; ship fails → compensations must run in REVERSE
        // commit order: reverse_b (for charge_b) BEFORE reverse_a (for charge_a).
        const oa = `sagaA-${sfx}`, ob = `sagaB-${sfx}`;
        const { run } = await seedAndRun(`wfSagaRev${sfx}`, [
            { id: 'charge_a', service: 'collection', method: 'collection.payment.record',
              params: { amount: 100, currency: 'CNY', orderId: oa }, compensate: 'reverse_a' },
            { id: 'charge_b', service: 'collection', method: 'collection.payment.record',
              params: { amount: 200, currency: 'CNY', orderId: ob }, compensate: 'reverse_b' },
            // deterministic failure AFTER both commits
            { id: 'ship', service: 'collection', method: 'collection.payment.settle',
              params: { id: `missingR-${sfx}` } },
            // compensation-only steps (reverse iteration runs these last-committed-first)
            { id: 'reverse_a', service: 'collection', method: 'collection.payment.record',
              params: { amount: '$step.charge_a.result.amount', currency: 'CNY', source: 'saga-reversal',
                        externalRef: '$step.charge_a.result.id', orderId: `saga-revA-${sfx}` } },
            { id: 'reverse_b', service: 'collection', method: 'collection.payment.record',
              params: { amount: '$step.charge_b.result.amount', currency: 'CNY', source: 'saga-reversal',
                        externalRef: '$step.charge_b.result.id', orderId: `saga-revB-${sfx}` } },
        ]);

        expect(run).toBeTruthy();
        expect(run.status).toBe('FAILED');
        expect(run.failedStep).toBe('ship');

        // THE PROOF: compensation_order lists the compensated forward steps in execution order,
        // which must be the REVERSE of the commit order [charge_a, charge_b].
        const ev = await findEvent(redis, 'EVENT:WORKFLOW:STATUS', 'workflow.run.failed', `wfSagaRev${sfx}`);
        expect(ev).toBeTruthy();
        expect(ev.compensated).toBe(true);
        expect(ev.compensation_failed).toBe(false);
        expect(ev.compensation_order).toEqual(['charge_b', 'charge_a']);   // last-committed undone first

        // real-service view: both reversals posted, each bound to its own charge
        const list = V.assertResult(await rpc('collection.payment.list', { page: 1, pageSize: 200 }, ADMIN_TOKEN), 'payment.list');
        const byOrder = (o) => (list.items || []).find((p) => p.orderId === o);
        const cA = byOrder(oa), cB = byOrder(ob), rA = byOrder(`saga-revA-${sfx}`), rB = byOrder(`saga-revB-${sfx}`);
        for (const p of [cA, cB, rA, rB]) { expect(p).toBeTruthy(); if (p) payIds.push(p.id); }
        expect(rA.externalRef).toBe(cA.id);
        expect(rB.externalRef).toBe(cB.id);
        expect(rA.amount).toBe(100);
        expect(rB.amount).toBe(200);
    }, 40_000);
});
