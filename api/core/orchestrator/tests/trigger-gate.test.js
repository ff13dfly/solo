/**
 * Trigger foundation — allowed_triggers gate + $context.* provenance
 *
 * event.md §7 (allowed_triggers gate) + §6 ($context variables).
 *
 * - create() defaults allowed_triggers to ['sync']; validates the field
 * - runner rejects a trigger source not in allowed_triggers (zero side effects)
 * - $context.actor / $context.trigger_id resolve into step params
 *
 * All via harness (real logic + MockRouter + fakeRedis). No real services.
 */
const { createHarness } = require('./utils/harness');

const SUBMITTER = 'uid-submitter';

function baseDef(overrides = {}) {
    return {
        id: 'wf_trig_' + Math.random().toString(36).slice(2),
        category: 'test',
        name: 'trigger test',
        desc: 'trigger test wf',
        required_inputs: [],
        steps: [
            { id: 's1', service: 'svc', method: 'svc.thing.do', params: {} },
        ],
        ...overrides,
    };
}

describe('allowed_triggers — create() field handling', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(() => h.stop());

    test('defaults to ["sync"] when unset', async () => {
        const wf = await h.logic.workflow.create(baseDef(), SUBMITTER);
        expect(wf.allowed_triggers).toEqual(['sync']);
    });

    test('accepts an explicit valid list (deduped)', async () => {
        const wf = await h.logic.workflow.create(baseDef({ allowed_triggers: ['sync', 'event', 'event'] }), SUBMITTER);
        expect(wf.allowed_triggers).toEqual(['sync', 'event']);
    });

    test('empty array falls back to ["sync"]', async () => {
        const wf = await h.logic.workflow.create(baseDef({ allowed_triggers: [] }), SUBMITTER);
        expect(wf.allowed_triggers).toEqual(['sync']);
    });

    test('rejects an invalid trigger value', async () => {
        await expect(h.logic.workflow.create(baseDef({ allowed_triggers: ['sync', 'telepathy'] }), SUBMITTER))
            .rejects.toMatchObject({ code: -32602 });
    });

    test('rejects a non-array', async () => {
        await expect(h.logic.workflow.create(baseDef({ allowed_triggers: 'sync' }), SUBMITTER))
            .rejects.toMatchObject({ code: -32602 });
    });
});

describe('allowed_triggers — runner gate', () => {
    let h;
    beforeEach(async () => {
        h = await createHarness();
        h.mock.onAny(() => ({ ok: true }));
    });
    afterEach(() => h.stop());

    test('sync run on a sync-only (default) workflow → runs', async () => {
        await h.seedWorkflow(baseDef({ id: 'wf_sync', status: 'ACTIVE' }));
        const res = await h.run('wf_sync', {}, {}, null, { triggerSource: 'sync' });
        expect(res.status).toBe('completed');
    });

    test('event trigger on a sync-only workflow → FORBIDDEN, zero downstream', async () => {
        await h.seedWorkflow(baseDef({ id: 'wf_sync2', status: 'ACTIVE', allowed_triggers: ['sync'] }));
        await expect(h.run('wf_sync2', {}, {}, null, { triggerSource: 'event:EVENT:X' }))
            .rejects.toMatchObject({ code: -32005 });
        expect(h.mock.count()).toBe(0);
    });

    test('event trigger on an event-allowed workflow → runs', async () => {
        await h.seedWorkflow(baseDef({ id: 'wf_evt', status: 'ACTIVE', allowed_triggers: ['sync', 'event'] }));
        const res = await h.run('wf_evt', {}, {}, null, { triggerSource: 'event:EVENT:ORDER' });
        expect(res.status).toBe('completed');
    });

    test('cron trigger blocked when only event allowed', async () => {
        await h.seedWorkflow(baseDef({ id: 'wf_evt2', status: 'ACTIVE', allowed_triggers: ['event'] }));
        await expect(h.run('wf_evt2', {}, {}, null, { triggerSource: 'cron:nightly' }))
            .rejects.toMatchObject({ code: -32005 });
    });

    test('missing trigger kind defaults to sync (back-compat)', async () => {
        await h.seedWorkflow(baseDef({ id: 'wf_def', status: 'ACTIVE' }));
        // no opts → triggerSource defaults to 'sync'
        const res = await h.run('wf_def');
        expect(res.status).toBe('completed');
    });
});

describe('$context.* provenance resolves into step params', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(() => h.stop());

    test('$context.trigger_id and $context.actor inject into a step', async () => {
        h.mock.on('svc.thing.do', () => ({ ok: true }));
        // callerUid set → H6 footprint pre-check runs; grant a covering permit
        h.mock.on('user.permit.get', () => ({ allow_all: true, services: {} }));
        await h.seedWorkflow(baseDef({
            id: 'wf_ctx',
            status: 'ACTIVE',
            allowed_triggers: ['sync', 'cron'],
            steps: [
                {
                    id: 's1',
                    service: 'svc',
                    method: 'svc.thing.do',
                    params: { trig: '$context.trigger_id', who: '$context.actor' },
                },
            ],
        }));

        await h.run('wf_ctx', {}, {}, 'uid-caller', { triggerSource: 'cron:sweep', triggerId: 'sweep:123' });

        expect(h.mock.lastParams('svc.thing.do')).toEqual({ trig: 'sweep:123', who: 'uid-caller', idempotency_key: expect.any(String) });
    });

    test('undefined $context fields are pruned from params', async () => {
        h.mock.on('svc.thing.do', () => ({ ok: true }));
        await h.seedWorkflow(baseDef({
            id: 'wf_ctx2',
            status: 'ACTIVE',
            steps: [
                { id: 's1', service: 'svc', method: 'svc.thing.do', params: { trig: '$context.trigger_id', keep: 'x' } },
            ],
        }));

        // sync run with no triggerId → trigger_id is null → JSON null injected
        await h.run('wf_ctx2', {}, {}, null, { triggerSource: 'sync' });
        const p = h.mock.lastParams('svc.thing.do');
        expect(p.keep).toBe('x');
        expect(p.trig).toBeNull();
    });
});

// toFix §6.2 / event.md at-least-once: the engine injects a stable idempotency_key per
// (run, step) so an in-step retry or a re-delivered trigger dedups downstream instead of
// double-committing. callerUid is null here, so the H6 footprint pre-check is skipped.
describe('idempotency_key wiring — at-least-once safety', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(() => h.stop());

    test('default key is injected and REUSED across an in-step retry (no double-commit)', async () => {
        let n = 0;
        h.mock.on('svc.charge', () => { if (n++ === 0) throw new Error('transient'); return { ok: true }; });
        await h.seedWorkflow(baseDef({
            id: 'wf_idem', status: 'ACTIVE', allowed_triggers: ['cron'],
            steps: [{ id: 'charge', service: 'svc', method: 'svc.charge', params: { amt: 100 }, retry: 1 }],
        }));

        await h.run('wf_idem', {}, {}, null, { triggerSource: 'cron:x', triggerId: 'trig-1' });

        const calls = h.mock.calls('svc.charge');
        expect(calls).toHaveLength(2);                                       // failed once → retried
        expect(calls[0].idempotency_key).toBe('wf:wf_idem:trig-1:charge');   // stable per (trigger, step)
        expect(calls[1].idempotency_key).toBe(calls[0].idempotency_key);     // SAME on the retry
    });

    test('same trigger_id (re-delivery) → same key; a different trigger → different key', async () => {
        h.mock.on('svc.charge', () => ({ ok: true }));
        await h.seedWorkflow(baseDef({
            id: 'wf_idem2', status: 'ACTIVE', allowed_triggers: ['cron'],
            steps: [{ id: 'charge', service: 'svc', method: 'svc.charge', params: {} }],
        }));

        await h.run('wf_idem2', {}, {}, null, { triggerSource: 'cron:x', triggerId: 'evt-A' });
        await h.run('wf_idem2', {}, {}, null, { triggerSource: 'cron:x', triggerId: 'evt-A' });   // redelivery
        await h.run('wf_idem2', {}, {}, null, { triggerSource: 'cron:x', triggerId: 'evt-B' });   // new trigger

        const keys = h.mock.calls('svc.charge').map(p => p.idempotency_key);
        expect(keys[0]).toBe(keys[1]);          // dedupable across re-delivery
        expect(keys[2]).not.toBe(keys[0]);      // distinct logical trigger
    });

    test("author's step.idempotency_key overrides the default and interpolates $-tokens", async () => {
        h.mock.on('svc.charge', () => ({ ok: true }));
        await h.seedWorkflow(baseDef({
            id: 'wf_idem3', status: 'ACTIVE', allowed_triggers: ['cron'],
            steps: [{ id: 'charge', service: 'svc', method: 'svc.charge', params: {}, idempotency_key: 'comp-$context.trigger_id-charge' }],
        }));

        await h.run('wf_idem3', {}, {}, null, { triggerSource: 'cron:x', triggerId: 'T9' });

        expect(h.mock.lastParams('svc.charge').idempotency_key).toBe('comp-T9-charge');
    });

    test('an explicit idempotency_key already in params is never overwritten', async () => {
        h.mock.on('svc.charge', () => ({ ok: true }));
        await h.seedWorkflow(baseDef({
            id: 'wf_idem4', status: 'ACTIVE', allowed_triggers: ['cron'],
            steps: [{ id: 'charge', service: 'svc', method: 'svc.charge', params: { idempotency_key: 'hand-written' } }],
        }));

        await h.run('wf_idem4', {}, {}, null, { triggerSource: 'cron:x', triggerId: 'T1' });

        expect(h.mock.lastParams('svc.charge').idempotency_key).toBe('hand-written');
    });
});
