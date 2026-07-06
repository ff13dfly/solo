/**
 * Saga compensation durability across restarts — v1-implementation-plan.md P2 (2026-07-03).
 *
 * Two layers, both hermetic (fake redis, MockRouter, no real Redis/HTTP):
 *
 *   §1 runner.js unit-level (via the real harness's exposed `logic.runner`) — feeds a
 *      hand-built `compensationProgress` cursor directly, asserting resume-from-cursor
 *      (already-succeeded entries are NOT re-invoked) and retry-cap exhaustion (a
 *      compensation that keeps failing stops being retried after
 *      config.worker.compensationMaxAttempts rounds).
 *
 *   §2 full wiring (run.js + worker.js) — drives worker.processOne twice with the SAME
 *      runId, simulating "orchestrator crashed mid-compensation" by flipping the run doc
 *      to STALLED and calling the real run.requeue() between rounds (mirrors the real
 *      operator-triggered orchestrator.run.retry path), asserting the persisted
 *      compensationProgress on the run ENTITY carries the cursor + attempt count forward.
 */
const { createHarness } = require('./utils/harness');
const config = require('../config');

const R = config.redis;

describe('§1 runCompensations — resume-from-cursor (runner.js unit level)', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(async () => { await h.stop(); });

    const WF = {
        id: 'wf_resume', name: 'resume', desc: 'x', category: 'test',
        steps: [
            { id: 'stepA', service: 'svcA', method: 'svcA.do', params: {}, compensate: 'undoA' },
            { id: 'stepB', service: 'svcB', method: 'svcB.do', params: {}, compensate: 'undoB' },
            { id: 'stepC', service: 'svcC', method: 'svcC.do', params: {} },
            { id: 'undoA', service: 'svcA', method: 'svcA.undo', params: {} },
            { id: 'undoB', service: 'svcB', method: 'svcB.undo', params: {} },
        ],
    };

    test('an entry already "success" in the prior-round cursor is skipped, not re-invoked', async () => {
        h.mock.on('svcA.do', () => ({ ok: true }));
        h.mock.on('svcB.do', () => ({ ok: true }));
        h.mock.on('svcC.do', () => { throw new Error('svcC down'); });
        h.mock.on('svcA.undo', () => ({ undone: true }));   // would fail the test if called again
        h.mock.on('svcB.undo', () => ({ undone: true }));
        await h.seedWorkflow(WF);

        // Simulate: a prior round already compensated stepA successfully (crash happened
        // after that but before undoB / run.fail()).
        const compensationProgress = { stepA: { compensate: 'undoA', status: 'success', attempts: 1 } };

        const res = await h.logic.runner.run(
            { workflowId: 'wf_resume', input: {}, runId: 'run_resume_1', compensationProgress },
            {}, null,
        );

        expect(res.status).toBe('failed');
        expect(res.compensation.failed).toBe(false);
        // reverse order: undoB (fresh) then undoA (skipped-from-cursor)
        expect(res.compensation.entries).toHaveLength(2);
        expect(res.compensation.entries[0]).toMatchObject({ forStep: 'stepB', status: 'success' });
        expect(res.compensation.entries[0].skipped).toBeUndefined();
        expect(res.compensation.entries[1]).toMatchObject({ forStep: 'stepA', status: 'success', skipped: true, attempts: 1 });

        // svcA.undo was never called this round — genuinely skipped, not silently re-run.
        expect(h.mock.count('svcA.undo')).toBe(0);
        expect(h.mock.count('svcB.undo')).toBe(1);
    });

    test('a compensation stuck at the attempt cap is marked "exhausted" and not retried again', async () => {
        h.mock.on('svcA.do', () => ({ ok: true }));
        h.mock.on('svcC.do', () => { throw new Error('svcC down'); });
        h.mock.on('svcA.undo', () => { throw new Error('undoA gateway down'); });   // always fails
        await h.seedWorkflow({
            id: 'wf_cap', name: 'cap', desc: 'x', category: 'test',
            steps: [
                { id: 'stepA', service: 'svcA', method: 'svcA.do', params: {}, compensate: 'undoA' },
                { id: 'stepC', service: 'svcC', method: 'svcC.do', params: {} },
                { id: 'undoA', service: 'svcA', method: 'svcA.undo', params: {} },
            ],
        });

        const cap = config.worker.compensationMaxAttempts;

        // Prior rounds already burned through the entire cap (persisted attempts == cap),
        // each attempt having failed.
        const compensationProgress = { stepA: { compensate: 'undoA', status: 'failed', attempts: cap } };

        const res = await h.logic.runner.run(
            { workflowId: 'wf_cap', input: {}, runId: 'run_cap_1', compensationProgress },
            {}, null,
        );

        expect(res.status).toBe('failed');
        expect(res.compensation.failed).toBe(true);
        expect(res.compensation.entries[0]).toMatchObject({ forStep: 'stepA', status: 'exhausted', attempts: cap });
        // the cap was already reached BEFORE this round — svcA.undo must not be called again.
        expect(h.mock.count('svcA.undo')).toBe(0);
    });

    test('without a cursor (sync path / first round), behavior is unchanged — every entry attempted fresh', async () => {
        h.mock.on('svcA.do', () => ({ ok: true }));
        h.mock.on('svcC.do', () => { throw new Error('down'); });
        h.mock.on('svcA.undo', () => ({ undone: true }));
        await h.seedWorkflow(WF.steps ? { ...WF, steps: [WF.steps[0], WF.steps[2], WF.steps[3]] } : WF);

        const res = await h.run('wf_resume', {});   // harness's plain sync-style call, no compensationProgress
        expect(res.status).toBe('failed');
        expect(res.compensation.entries[0]).toMatchObject({ forStep: 'stepA', status: 'success', attempts: 1 });
        expect(h.mock.count('svcA.undo')).toBe(1);
    });
});

describe('§2 durable compensation — full wiring via worker.processOne + run.requeue (simulated restart)', () => {
    let h;
    const fakeRelay = { async getToken() { return 'bot-token'; }, async call() { /* no-op: quiets fail-soft ops-notify warnings */ } };
    beforeEach(async () => { h = await createHarness({ relay: fakeRelay }); });
    afterEach(async () => { await h.stop(); });

    const WF = {
        id: 'wf_saga', name: 'durable', desc: 'x', category: 'test',
        allowed_triggers: ['event'],   // driven via worker.processOne, not sync RPC
        steps: [
            { id: 'stepA', service: 'svcA', method: 'svcA.do', params: {}, compensate: 'undoA' },
            { id: 'stepC', service: 'svcC', method: 'svcC.do', params: {} },
            { id: 'undoA', service: 'svcA', method: 'svcA.undo', params: {} },
        ],
    };

    function runKey(id) { return `${R.runPrefix}${id}`; }

    // Simulates "the orchestrator process crashed mid-compensation": flips the run doc
    // straight to STALLED (bypassing the real stall-scan timer, which only cares about
    // wall-clock — the point of this test is what happens on resume, not how STALLED is
    // reached; worker.test.js already covers the scanner itself).
    async function simulateCrashToStalled(id) {
        const doc = await h.redis.json.get(runKey(id));
        await h.redis.json.set(runKey(id), '$', { ...doc, status: 'STALLED', stalledAt: Date.now() });
    }

    test('attempt count on the run ENTITY survives a simulated restart and eventually reaches "exhausted"', async () => {
        h.mock.on('user.permit.get', () => ({ allow_all: true }));   // H6 footprint pre-check (async runs execute as the bot)
        h.mock.on('svcA.do', () => ({ ok: true }));
        h.mock.on('svcC.do', () => { throw new Error('svcC down'); });
        h.mock.on('svcA.undo', () => { throw new Error('undoA gateway down'); });   // always fails
        await h.seedWorkflow(WF);

        const cap = config.worker.compensationMaxAttempts;
        const cmd = { runId: 'run_durable_1', workflowId: 'wf_saga', input: {}, triggerSource: 'event' };

        // Round 1: runs to completion (FAILED — a same-process compensation failure is
        // already terminal today; this round's persisted attempts is what a genuine
        // mid-flight crash would ALSO have left behind via onCompensationCommit).
        await h.logic.worker.processOne(h.redis, JSON.stringify(cmd));
        let doc = await h.redis.json.get(runKey(cmd.runId));
        expect(doc.status).toBe('FAILED');
        expect(doc.compensationProgress.stepA).toMatchObject({ status: 'failed', attempts: 1 });
        expect(h.mock.count('svcA.undo')).toBe(1);

        // Simulate: instead of accepting FAILED, the orchestrator crashed right after
        // committing this attempt but before run.fail() ever persisted — an operator's
        // STALLED alert fires and they retry. Drive (cap - 1) more rounds the same way.
        for (let round = 2; round <= cap; round++) {
            await simulateCrashToStalled(cmd.runId);
            const { cmd: requeued } = await h.logic.run.requeue({ id: cmd.runId });
            await h.logic.worker.processOne(h.redis, JSON.stringify(requeued));
            doc = await h.redis.json.get(runKey(cmd.runId));
            expect(doc.compensationProgress.stepA).toMatchObject({ status: 'failed', attempts: round });
        }
        expect(h.mock.count('svcA.undo')).toBe(cap);   // one real attempt per round, up to the cap

        // One more simulated restart, past the cap: must NOT call the broken compensation
        // again — it flips straight to 'exhausted' from the persisted cursor.
        await simulateCrashToStalled(cmd.runId);
        const { cmd: finalRequeue } = await h.logic.run.requeue({ id: cmd.runId });
        await h.logic.worker.processOne(h.redis, JSON.stringify(finalRequeue));

        doc = await h.redis.json.get(runKey(cmd.runId));
        expect(doc.status).toBe('FAILED');
        expect(doc.compensationProgress.stepA.status).toBe('exhausted');
        expect(doc.compensation.entries[0]).toMatchObject({ forStep: 'stepA', status: 'exhausted' });
        expect(h.mock.count('svcA.undo')).toBe(cap);   // unchanged — no new RPC call past the cap
    });

    test('a compensation that succeeds on retry is not re-invoked on a later round for the SAME step', async () => {
        h.mock.on('user.permit.get', () => ({ allow_all: true }));
        h.mock.on('svcA.do', () => ({ ok: true }));
        h.mock.on('svcC.do', () => { throw new Error('svcC down'); });
        let undoCalls = 0;
        h.mock.on('svcA.undo', () => { undoCalls += 1; return { undone: true }; });   // succeeds immediately
        await h.seedWorkflow(WF);

        const cmd = { runId: 'run_durable_2', workflowId: 'wf_saga', input: {}, triggerSource: 'event' };
        await h.logic.worker.processOne(h.redis, JSON.stringify(cmd));

        let doc = await h.redis.json.get(runKey(cmd.runId));
        expect(doc.compensationProgress.stepA).toMatchObject({ status: 'success', attempts: 1 });
        expect(undoCalls).toBe(1);

        // Simulate a second round (e.g. an operator re-driving a run they THOUGHT was
        // stuck) — the already-successful compensation must not fire again.
        await simulateCrashToStalled(cmd.runId);
        const { cmd: requeued } = await h.logic.run.requeue({ id: cmd.runId });
        await h.logic.worker.processOne(h.redis, JSON.stringify(requeued));

        expect(undoCalls).toBe(1);   // unchanged
    });
});
