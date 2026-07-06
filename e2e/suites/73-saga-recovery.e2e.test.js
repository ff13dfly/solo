/**
 * 73 · Crash recovery via run.retry is idempotent — re-driving a STALLED run does NOT
 * double-commit (the headline risk of the retry button).
 *
 * Setup simulates a crash: a STALLED run entity for a one-step charge workflow. We then
 * orchestrator.run.retry TWICE (flipping it back to STALLED between). Because run.retry
 * preserves the original triggerId, the re-run's idempotency key is identical, so the
 * second charge dedups at the collection service — exactly ONE payment exists, not two.
 *
 * Async path (worker runs under system.orchestrator, permit covers collection:['*']).
 * Full profile only.
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

gate('73 · crash recovery (run.retry) is idempotent', () => {
    let redis;
    const sfx = process.pid;
    const wfId = `wfRecov${sfx}`;
    const runId = `runRecov${sfx}`;
    const triggerId = `recov-${sfx}`;
    const order = `recov-${sfx}`;
    const dedupKey = `COLLECTION:DEDUP:wf:${wfId}:${triggerId}:charge`;
    // second workflow — the checkpoint test (real async run records committedSteps)
    const chkWf = `wfChk${sfx}`;
    const chkOrderA = `chk-a-${sfx}`, chkOrderB = `chk-b-${sfx}`;
    let chkRunId = null;
    // third — the stall-scanner test (a seeded stale RUNNING run gets flipped + alerted)
    const stallWf = `wfStall${sfx}`;
    const stallRunId = `runStall${sfx}`;
    // fourth — durable Saga compensation: attempts persist across STALLED/retry cycles and
    // eventually reach "exhausted" instead of retrying a broken compensation forever (P2, 2026-07-03)
    const durWf = `wfSagaDur${sfx}`;
    const durOrder = `sagadur-${sfx}`;
    let durRunId = null;

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);
    afterAll(async () => {
        if (!redis) return;
        for (const w of [wfId, chkWf, stallWf, durWf]) { await redis.del(`ORCHESTRATOR:WORKFLOW:${w}`); await redis.sRem('ORCHESTRATOR:WORKFLOW_INDEX', w); }
        for (const r of [runId, chkRunId, stallRunId, durRunId].filter(Boolean)) { await redis.del(`ORCHESTRATOR:RUN:${r}`); await redis.sRem('ORCHESTRATOR:RUN_INDEX', r); }
        await redis.del(dedupKey);
        const orders = new Set([order, chkOrderA, chkOrderB, durOrder]);
        const list = await rpc('collection.payment.list', { page: 1, pageSize: 200 }, ADMIN_TOKEN);
        for (const p of (list.result?.items || [])) {
            if (orders.has(p.orderId)) { await redis.del(`COLLECTION:PAYMENT:${p.id}`); await redis.sRem('COLLECTION:PAYMENT:INDEX', p.id); }
        }
        await redis.quit();
    });

    async function seedStalledRun() {
        const now = Date.now();
        await redis.json.set(`ORCHESTRATOR:RUN:${runId}`, '$', {
            id: runId, workflowId: wfId, input: {}, triggerSource: 'event', triggerId,
            trace: null, parentEventId: null, enqueuedAt: now, attempts: 0,
            status: 'STALLED', startedAt: now - 999999, stalledAt: now,
        });
        await redis.sAdd('ORCHESTRATOR:RUN_INDEX', runId);
    }
    async function retryToDone() {
        V.assertResult(await rpc('orchestrator.run.retry', { id: runId }, ADMIN_TOKEN), 'run.retry');
        const done = await poll(async () => {
            const r = await redis.json.get(`ORCHESTRATOR:RUN:${runId}`).catch(() => null);
            return r && r.status === 'DONE' ? r : null;
        });
        expect(done).toBeTruthy();
        return done;
    }
    async function paymentsForOrder() {
        const list = V.assertResult(await rpc('collection.payment.list', { page: 1, pageSize: 200 }, ADMIN_TOKEN), 'payment.list');
        return (list.items || []).filter((p) => p.orderId === order);
    }

    test('a one-step charge workflow recovered twice produces exactly ONE payment', async () => {
        const now = Date.now();
        await redis.json.set(`ORCHESTRATOR:WORKFLOW:${wfId}`, '$', {
            id: wfId, category: 'e2e-recov', priority: 50, name: 'recovery', desc: 'idempotent re-drive',
            tags: [], examples: [], negative: [], keywords: [], required_inputs: [], optional_inputs: [], synonyms: {},
            steps: [{ id: 'charge', service: 'collection', method: 'collection.payment.record',
                      params: { amount: 100, currency: 'CNY', orderId: order } }],
            resolvers: {}, allowed_triggers: ['event'], event_subscriptions: [],
            status: 'ACTIVE', submittedBy: 'e2e', approvals: [], createdAt: now, updatedAt: now,
        });
        await redis.sAdd('ORCHESTRATOR:WORKFLOW_INDEX', wfId);

        // ── first recovery: STALLED → retry → DONE, charge commits one payment
        await seedStalledRun();
        await retryToDone();
        expect(await paymentsForOrder()).toHaveLength(1);
        // the preserved-triggerId idempotency key landed in collection's dedup store
        expect(await redis.exists(dedupKey)).toBe(1);

        // ── simulate it stalling AGAIN, then retry once more
        const cur = await redis.json.get(`ORCHESTRATOR:RUN:${runId}`);
        await redis.json.set(`ORCHESTRATOR:RUN:${runId}`, '$', { ...cur, status: 'STALLED', stalledAt: Date.now() });
        await retryToDone();

        // THE PROOF: the re-run's charge deduped — still exactly one payment, no double-commit
        expect(await paymentsForOrder()).toHaveLength(1);
    }, 60_000);

    test('committedSteps: a real async run checkpoints each committed step (survives to DONE)', async () => {
        // A normal 2-step async run — the worker passes onStepCommit → run.checkpoint, so the run
        // entity accrues committedSteps as each step commits, and they survive the DONE transition.
        // (This is the wiring 73's recovery test relies on but never exercises live — it seeds STALLED.)
        const now = Date.now();
        await redis.json.set(`ORCHESTRATOR:WORKFLOW:${chkWf}`, '$', {
            id: chkWf, category: 'e2e-recov', priority: 50, name: 'checkpoint', desc: 'committedSteps via onStepCommit',
            tags: [], examples: [], negative: [], keywords: [], required_inputs: [], optional_inputs: [], synonyms: {},
            steps: [
                { id: 'chargeA', service: 'collection', method: 'collection.payment.record', params: { amount: 10, currency: 'CNY', orderId: chkOrderA } },
                { id: 'chargeB', service: 'collection', method: 'collection.payment.record', params: { amount: 20, currency: 'CNY', orderId: chkOrderB } },
            ],
            resolvers: {}, allowed_triggers: ['event'], event_subscriptions: [],
            status: 'ACTIVE', submittedBy: 'e2e', approvals: [], createdAt: now, updatedAt: now,
        });
        await redis.sAdd('ORCHESTRATOR:WORKFLOW_INDEX', chkWf);

        const cmd = V.assertResult(await rpc('orchestrator.run.enqueue', { workflowId: chkWf, input: {}, triggerSource: 'event' }, ADMIN_TOKEN), 'run.enqueue');
        chkRunId = cmd.runId;
        expect(chkRunId).toBeTruthy();

        const done = await poll(async () => {
            const r = await redis.json.get(`ORCHESTRATOR:RUN:${chkRunId}`).catch(() => null);
            return r && r.status === 'DONE' ? r : null;
        });
        expect(done).toBeTruthy();
        // onStepCommit → checkpoint recorded each committed step IN ORDER, and done() preserved them
        expect(done.committedSteps).toEqual(['chargeA', 'chargeB']);
        // false-stall fix: each checkpoint refreshes lastActivity, so a progressing run isn't flagged STALLED
        expect(done.lastActivity).toBeGreaterThanOrEqual(now);
    }, 40_000);

    test('stall scanner: a stale RUNNING run is flipped to STALLED + an ops alert is sent', async () => {
        // Simulate a worker death mid-run: a RUNNING run whose last activity predates RUN_STALL_MS
        // (10min default — NOT lowered, so real runs in other suites are never falsely flagged; the
        // harness only lowers RUN_STALL_SCAN_MS to 2s so the sweep fires promptly here).
        const old = Date.now() - 700_000;   // ~11.6 min ago > 10 min threshold
        await redis.json.set(`ORCHESTRATOR:RUN:${stallRunId}`, '$', {
            id: stallRunId, workflowId: stallWf, input: {}, triggerSource: 'event', triggerId: `stall-${sfx}`,
            trace: null, parentEventId: null, enqueuedAt: old, attempts: 0,
            status: 'RUNNING', startedAt: old, lastActivity: old, committedSteps: ['stepA'],
        });
        await redis.sAdd('ORCHESTRATOR:RUN_INDEX', stallRunId);

        // the worker's stall scanner sweeps RUNNING runs and flips the stale one
        const stalled = await poll(async () => {
            const r = await redis.json.get(`ORCHESTRATOR:RUN:${stallRunId}`).catch(() => null);
            return r && r.status === 'STALLED' ? r : null;
        }, { timeout: 25_000, interval: 700 });
        expect(stalled).toBeTruthy();
        expect(stalled.stalledAt).toBeGreaterThan(0);

        // and it alerts ops: notification.send(type: ops.run_stalled) carrying committedSteps + the runId
        const alert = await poll(async () => {
            const ids = await redis.zRange(`NOTIFICATION:INBOX:ops`, 0, -1).catch(() => []);
            for (const id of ids) {
                const m = await V.readKey(redis, `NOTIFICATION:MSG:${id}`).catch(() => null);
                if (m && m.type === 'ops.run_stalled' && m.payload && m.payload.runId === stallRunId) return m;
            }
            return null;
        }, { timeout: 10_000, interval: 500 });
        expect(alert).toBeTruthy();
        expect(alert.payload.committedSteps).toEqual(['stepA']);   // alert tells ops what already ran
    }, 40_000);

    test('durable Saga compensation: attempts persist across STALLED/retry cycles, eventually "exhausted" (P2, 2026-07-03)', async () => {
        // A compensation that is genuinely broken (settles a payment id that never exists — the
        // exact deterministic-failure trick 72-saga-compensation.e2e.test.js uses) must not be
        // retried forever across "operator re-drives a STALLED run" cycles. Each retry persists
        // its attempt on the run ENTITY (compensationProgress), and once the attempt count hits
        // the configured cap the run stops calling the broken compensation at all — it flips
        // straight to 'exhausted' from the persisted cursor.
        const now = Date.now();
        await redis.json.set(`ORCHESTRATOR:WORKFLOW:${durWf}`, '$', {
            id: durWf, category: 'e2e-recov', priority: 50, name: 'saga durable', desc: 'compensation retry cap',
            tags: [], examples: [], negative: [], keywords: [], required_inputs: [], optional_inputs: [], synonyms: {},
            steps: [
                { id: 'charge', service: 'collection', method: 'collection.payment.record',
                  params: { amount: 30, currency: 'CNY', orderId: durOrder }, compensate: 'bad_reverse' },
                { id: 'ship', service: 'collection', method: 'collection.payment.settle', params: { id: `missdur-${sfx}` } },
                // always fails: settling a payment id that never exists (same trick as 72's "compensation FAILS" case)
                { id: 'bad_reverse', service: 'collection', method: 'collection.payment.settle', params: { id: `nopedur-${sfx}` } },
            ],
            resolvers: {}, allowed_triggers: ['event'], event_subscriptions: [],
            status: 'ACTIVE', submittedBy: 'e2e', approvals: [], createdAt: now, updatedAt: now,
        });
        await redis.sAdd('ORCHESTRATOR:WORKFLOW_INDEX', durWf);

        const cmd = V.assertResult(await rpc('orchestrator.run.enqueue', { workflowId: durWf, input: {}, triggerSource: 'event' }, ADMIN_TOKEN), 'run.enqueue');
        durRunId = cmd.runId;
        expect(durRunId).toBeTruthy();

        async function waitFailed() {
            const r = await poll(async () => {
                const doc = await redis.json.get(`ORCHESTRATOR:RUN:${durRunId}`).catch(() => null);
                return doc && doc.status === 'FAILED' ? doc : null;
            });
            expect(r).toBeTruthy();
            return r;
        }
        async function simulateCrashAndRetry() {
            const cur = await redis.json.get(`ORCHESTRATOR:RUN:${durRunId}`);
            await redis.json.set(`ORCHESTRATOR:RUN:${durRunId}`, '$', { ...cur, status: 'STALLED', stalledAt: Date.now() });
            V.assertResult(await rpc('orchestrator.run.retry', { id: durRunId }, ADMIN_TOKEN), 'run.retry');
        }

        // round 1: the first (real, synchronous) failure — attempts:1, persisted on the run entity
        let doc = await waitFailed();
        expect(doc.compensationProgress).toBeTruthy();
        expect(doc.compensationProgress.charge).toMatchObject({ status: 'failed', attempts: 1 });

        // keep "crashing" (STALLED) + retrying until the cap kicks in — bounded so a config change
        // (or a regression that removes the cap) fails the test instead of hanging forever.
        let round = 1;
        const MAX_ROUNDS_SAFETY = 10;
        while (doc.compensationProgress.charge.status !== 'exhausted' && round < MAX_ROUNDS_SAFETY) {
            await simulateCrashAndRetry();
            doc = await waitFailed();
            round += 1;
            expect(doc.compensationProgress.charge.attempts).toBeLessThanOrEqual(round);   // never exceeds rounds-so-far
        }
        expect(doc.compensationProgress.charge.status).toBe('exhausted');
        const attemptsAtExhaustion = doc.compensationProgress.charge.attempts;
        expect(attemptsAtExhaustion).toBeGreaterThan(0);
        expect(doc.compensation.entries.find((e) => e.forStep === 'charge')).toMatchObject({ status: 'exhausted' });

        // THE PROOF: one more crash+retry past exhaustion does NOT bump attempts further — no new
        // RPC call was made against the broken compensation, it was skipped from the cursor.
        await simulateCrashAndRetry();
        const after = await waitFailed();
        expect(after.compensationProgress.charge.attempts).toBe(attemptsAtExhaustion);
        expect(after.compensationProgress.charge.status).toBe('exhausted');
    }, 120_000);
});
