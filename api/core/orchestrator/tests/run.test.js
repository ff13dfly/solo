/**
 * Run entity — crash-recovery follow-up (checkpoint + requeue).
 *
 * Drives logic/run.js directly with the JSON-capable fake redis. Covers:
 *   - checkpoint records committed steps (deduped) + refreshes lastActivity; RUNNING-only
 *   - a progressing (recently-checkpointed) run is NOT false-flagged as stalled
 *   - requeue is STALLED-only and PRESERVES triggerId (so re-run idempotency keys match)
 */
const createRun = require('../logic/run');
const { makeFakeRedis } = require('./utils/fake-redis');

describe('run entity — checkpoint + requeue', () => {
    let redis, run;
    beforeEach(() => { redis = makeFakeRedis(); run = createRun(redis); });

    test('checkpoint records committed steps (deduped) + lastActivity; RUNNING-only', async () => {
        await run.create({ runId: 'rChk1', workflowId: 'wf1', triggerId: 't1' });

        const c1 = await run.checkpoint('rChk1', 'sA');
        expect(c1.committedSteps).toEqual(['sA']);
        expect(c1.lastActivity).toBeGreaterThan(0);

        const c2 = await run.checkpoint('rChk1', 'sB');
        expect(c2.committedSteps).toEqual(['sA', 'sB']);

        // same step is not duplicated
        const c3 = await run.checkpoint('rChk1', 'sB');
        expect(c3.committedSteps).toEqual(['sA', 'sB']);

        // a terminal run is never checkpointed
        await run.done('rChk1');
        expect(await run.checkpoint('rChk1', 'sC')).toBeNull();
    });

    test('a recently-checkpointed (progressing) run is NOT stalled', async () => {
        await run.create({ runId: 'rChk2', workflowId: 'wf', triggerId: 't' });
        await run.checkpoint('rChk2', 'sA');                         // fresh activity
        const flipped = await run.stall('rChk2', { thresholdMs: 60_000 });
        expect(flipped).toBeNull();                                  // lastActivity is fresh → not stalled
        expect((await run.get('rChk2')).status).toBe('RUNNING');
    });

    test('compensationCheckpoint persists progress + attempts, resets lastActivity; RUNNING-only (P2, 2026-07-03)', async () => {
        await run.create({ runId: 'rComp1', workflowId: 'wf', triggerId: 't' });

        const c1 = await run.compensationCheckpoint('rComp1', { forStep: 'stepA', compensate: 'undoA', status: 'attempting', attempts: 1 });
        expect(c1.compensationProgress.stepA).toMatchObject({ compensate: 'undoA', status: 'attempting', attempts: 1 });
        expect(c1.lastActivity).toBeGreaterThan(0);

        // second call for the SAME step overwrites its entry (final outcome), doesn't duplicate
        const c2 = await run.compensationCheckpoint('rComp1', { forStep: 'stepA', compensate: 'undoA', status: 'failed', attempts: 1, error: 'boom' });
        expect(Object.keys(c2.compensationProgress)).toEqual(['stepA']);
        expect(c2.compensationProgress.stepA).toMatchObject({ status: 'failed', attempts: 1, lastError: 'boom' });

        // a second, independent step gets its own entry
        const c3 = await run.compensationCheckpoint('rComp1', { forStep: 'stepB', compensate: 'undoB', status: 'success', attempts: 1 });
        expect(Object.keys(c3.compensationProgress).sort()).toEqual(['stepA', 'stepB']);
        expect(c3.compensationProgress.stepA).toMatchObject({ status: 'failed' });   // untouched by stepB's checkpoint

        // a terminal run is never checkpointed
        await run.done('rComp1');
        expect(await run.compensationCheckpoint('rComp1', { forStep: 'stepC', status: 'success', attempts: 1 })).toBeNull();
    });

    test('compensationCheckpoint survives a create() resume (requeue path) — the cursor carries forward', async () => {
        await run.create({ runId: 'rComp2', workflowId: 'wf', triggerId: 't' });
        await run.compensationCheckpoint('rComp2', { forStep: 'stepA', compensate: 'undoA', status: 'success', attempts: 1 });

        await run.stall('rComp2', { thresholdMs: -1 });                 // simulate a crash → STALLED
        await run.requeue({ id: 'rComp2' });                            // → RESUMING
        const resumed = await run.create({ runId: 'rComp2', workflowId: 'wf', triggerId: 't' });   // worker's resume call

        expect(resumed.status).toBe('RUNNING');
        expect(resumed.compensationProgress.stepA).toMatchObject({ status: 'success', attempts: 1 });
    });

    test('stall flips a run whose activity predates the threshold', async () => {
        await run.create({ runId: 'rChk3', workflowId: 'wf', triggerId: 't' });
        // negative threshold ⇒ "any elapsed time counts as stale" — exercises the comparison
        const flipped = await run.stall('rChk3', { thresholdMs: -1 });
        expect(flipped.status).toBe('STALLED');
    });

    test('requeue: STALLED-only, preserves triggerId, returns the re-enqueue cmd', async () => {
        await run.create({ runId: 'rRq1', workflowId: 'wf4', input: { a: 1 }, triggerSource: 'event', triggerId: 'evt-42' });

        // a RUNNING run cannot be requeued (FORBIDDEN)
        await expect(run.requeue({ id: 'rRq1' })).rejects.toMatchObject({ code: -32005 });

        await run.stall('rRq1', { thresholdMs: -1 });                // → STALLED
        const { run: updated, cmd } = await run.requeue({ id: 'rRq1', byUid: 'admin' });
        expect(updated.status).toBe('RESUMING');
        // SAME runId + triggerId so the re-run's idempotency keys match → committed steps dedup
        expect(cmd).toMatchObject({ runId: 'rRq1', workflowId: 'wf4', triggerId: 'evt-42', triggerSource: 'event' });
        expect(cmd.input).toEqual({ a: 1 });
    });

    test('requeue rejects a non-existent or non-STALLED run', async () => {
        await expect(run.requeue({ id: 'ghost' })).rejects.toMatchObject({ code: -32002 });  // NOT_FOUND
        await run.create({ runId: 'rRq2', workflowId: 'wf' });
        await run.done('rRq2');
        await expect(run.requeue({ id: 'rRq2' })).rejects.toMatchObject({ code: -32005 });    // FORBIDDEN (DONE)
    });

    test('actor-claim audit: create persists actor/actorSource; requeue cmd preserves them', async () => {
        await run.create({
            runId: 'rAc1', workflowId: 'wf5', triggerSource: 'event:EVENT:X', triggerId: 'e-1',
            actor: 'uid-cause-1', actorSource: 'system.fulfillment',
        });
        const doc = await run.get('rAc1');
        expect(doc.actor).toBe('uid-cause-1');
        expect(doc.actorSource).toBe('system.fulfillment');

        await run.stall('rAc1', { thresholdMs: -1 });
        const { cmd } = await run.requeue({ id: 'rAc1', byUid: 'admin' });
        // PRESERVED → the re-driven run faces the SAME actor pre-check as the original
        expect(cmd.actor).toBe('uid-cause-1');
        expect(cmd.actorSource).toBe('system.fulfillment');
    });

    test('actor-claim absent → nulls on the doc (legacy commands unchanged)', async () => {
        await run.create({ runId: 'rAc2', workflowId: 'wf6', triggerSource: 'event' });
        const doc = await run.get('rAc2');
        expect(doc.actor).toBeNull();
        expect(doc.actorSource).toBeNull();
    });
});
