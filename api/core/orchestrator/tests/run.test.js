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

    // 回归：list() 的 sScanIterator 曾经（在 hermetic mock 修好之前）从没被真实验证过
    // 会不会在多批次场景下丢数据——mock 一直是"单值 yield"的旧假设，跟生产代码共享
    // 同一个错误前提，测试再多轮都测不出问题，只有 e2e 数据量凑巧过 COUNT 阈值才会
    // 暴露。现在 mock 换成了真正按 COUNT 切块的 scanBatches（见
    // library/tests/utils/redis-scan-sim.js + 契约测试 library/tests/redis-scan-contract.
    // test.js），这条用例把"超过一页也不丢 run"钉死成确定性断言，不再指望运气。
    test('list()：run 数超过 sScanIterator 的 COUNT（200）时，一个都不丢（多批次 SCAN 回归）', async () => {
        const total = 205; // > COUNT:200，逼 fake redis 至少产生 2 个 SCAN 批次
        for (let i = 0; i < total; i++) {
            await run.create({ runId: `rScan${i}`, workflowId: 'wf-scan-batch', triggerId: 't' });
        }

        const runs = await run.list();

        expect(runs.length).toBe(total);
        expect(new Set(runs.map((r) => r.id)).size).toBe(total); // 无重复
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// revive + defer — docs/feedback/done/event-triggered-workflow-lifecycle-drops-events.md
//
// Reported: run.list({status:'DEADLETTER'}) could SHOW exactly which business actions
// never happened, and nothing could make them happen — requeue() hard-rejects anything
// that is not STALLED. A dead-lettered gate rejection is thrown BEFORE any side effect,
// so the whole run-command is intact on the doc and replaying it is safe.
// ─────────────────────────────────────────────────────────────────────────────
describe('run entity — revive (overturn a DEADLETTER) ', () => {
    let redis, run;
    beforeEach(() => { redis = makeFakeRedis(); run = createRun(redis); });

    async function deadRun(id = 'rDead1') {
        await run.create({
            runId: id, workflowId: 'wf_x', input: { n: 1 },
            triggerSource: 'event:EVENT:D', triggerId: '1-1',
            actor: 'uid-cause', actorSource: 'system.ingress', trace: 'tr-1',
        });
        await run.deadletter(id, { error: 'Workflow in cooling period until …' });
        return id;
    }

    test('rebuilds the command with triggerId + actor intact (idempotency & actor pre-check)', async () => {
        const id = await deadRun();
        const { run: updated, cmd } = await run.revive({ id, byUid: 'uid-ops' });

        expect(updated.status).toBe('RESUMING');
        expect(updated.revives).toBe(1);
        expect(updated.revivedBy).toBe('uid-ops');
        // These two are what make a replay safe rather than a double-fire:
        // triggerId keeps downstream idempotency keys identical, actor keeps the
        // require_actor_permit pre-check evaluating the same principal.
        expect(cmd).toMatchObject({
            runId: id, workflowId: 'wf_x', input: { n: 1 },
            triggerSource: 'event:EVENT:D', triggerId: '1-1',
            actor: 'uid-cause', actorSource: 'system.ingress', trace: 'tr-1',
        });
    });

    test('refuses a run that is not DEADLETTER, and points at the right verb', async () => {
        await run.create({ runId: 'rRun1', workflowId: 'wf', triggerId: 't' });
        await expect(run.revive({ id: 'rRun1' })).rejects.toMatchObject({
            code: -32005, message: expect.stringMatching(/Only DEADLETTER runs can be revived/),
        });

        await run.stall('rRun1', { thresholdMs: -1 });
        await expect(run.revive({ id: 'rRun1' })).rejects.toMatchObject({
            code: -32005, message: expect.stringMatching(/run\.retry/),
        });
    });

    test('requeue still refuses a DEADLETTER run, and points at revive', async () => {
        const id = await deadRun('rDead2');
        await expect(run.requeue({ id })).rejects.toMatchObject({
            code: -32005, message: expect.stringMatching(/Only STALLED runs can be requeued/),
        });
        await expect(run.requeue({ id })).rejects.toMatchObject({
            code: -32005, message: expect.stringMatching(/run\.revive/),
        });
    });

    test('bounded: a broken run cannot be looped through the queue forever', async () => {
        const id = await deadRun('rDead3');
        for (let i = 0; i < 2; i++) {
            await run.revive({ id, maxRevives: 2 });
            await run.deadletter(id, { error: 'still rejected' });
        }
        await expect(run.revive({ id, maxRevives: 2 })).rejects.toMatchObject({
            code: -32005, message: expect.stringMatching(/already revived 2 time\(s\)/),
        });
    });

    test('missing / unknown id', async () => {
        await expect(run.revive({})).rejects.toMatchObject({ code: -32602 });          // MISSING_PARAM
        await expect(run.revive({ id: 'nope' })).rejects.toMatchObject({ code: -32002 }); // NOT_FOUND
    });
});

describe('run entity — defer (cooling)', () => {
    let redis, run;
    beforeEach(() => { redis = makeFakeRedis(); run = createRun(redis); });

    test('DEFERRED_COOLING is invisible to the stall scanner, and resumes via create()', async () => {
        await run.create({ runId: 'rDef1', workflowId: 'wf', triggerId: 't' });
        const until = Date.now() + 60_000;

        const deferred = await run.defer('rDef1', { until, reason: 'cooling' });
        expect(deferred.status).toBe('DEFERRED_COOLING');
        expect(deferred.deferredUntil).toBe(until);
        expect(deferred.deferCount).toBe(1);

        // The stall scanner lists status:'RUNNING' — a deferred run must not be in it, or
        // it gets flagged STALLED in 10 minutes and pages ops with a false crash story.
        expect((await run.list({ status: 'RUNNING' })).map(r => r.id)).not.toContain('rDef1');
        expect(await run.stall('rDef1', { thresholdMs: -1 })).toBeNull();

        // When the retry queue fires, create() upserts it back to RUNNING.
        expect((await run.create({ runId: 'rDef1', workflowId: 'wf' })).status).toBe('RUNNING');
    });

    test('unknown id is a no-op (never throws inside the worker error path)', async () => {
        expect(await run.defer('nope', { until: Date.now() })).toBeNull();
    });
});
