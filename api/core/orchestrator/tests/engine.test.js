/**
 * Orchestrator execution engine — fixture-driven tests.
 *
 * Each test: stub the downstream methods on the MockRouter, load a workflow
 * JSON fixture, run it, then assert on (a) the returned trace and (b) the
 * params the orchestrator actually sent downstream. No real services, no Redis.
 *
 * See ./README.md for the full guide and how to add new cases.
 */
const { createHarness } = require('./utils/harness');

const linearFlow = require('./cases/linear-flow.json');
const branchingFlow = require('./cases/branching-flow.json');

describe('orchestrator engine (fixture-driven, MockRouter)', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(async () => { await h.stop(); });

    test('linear flow: steps run in order, $input / $step variables resolve', async () => {
        h.mock.on('user.profile.get', ({ uid }) => ({ uid, name: 'Alice', email: 'alice@example.com' }));
        h.mock.on('gateway.email.send', () => ({ delivered: true }));

        await h.seedWorkflow(linearFlow);   // seed as ACTIVE — engine tests bypass the approval gate
        const res = await h.run(linearFlow.id, { customerId: 'c-1' });

        expect(res.status).toBe('completed');
        expect(res.trace.map(t => [t.id, t.status])).toEqual([['s1', 'success'], ['s2', 'success']]);

        // variable resolution: assert what the orchestrator actually sent downstream.
        // The engine also injects a stable idempotency_key per (run, step) — see the
        // dedicated idempotency test below; here we just tolerate it.
        expect(h.mock.lastParams('user.profile.get')).toEqual({ uid: 'c-1', idempotency_key: expect.any(String) });
        expect(h.mock.lastParams('gateway.email.send')).toEqual({
            to: 'alice@example.com',
            name: 'Alice',
            customerId: 'c-1',
            idempotency_key: expect.any(String),
        });

        // a completion event is emitted to the stream
        expect(h.events('EVENT:WORKFLOW:RESULT')).toHaveLength(1);
    });

    test('missing required input → rejected before any downstream call', async () => {
        h.mock.onAny(() => ({}));
        await h.seedWorkflow(linearFlow);   // seed as ACTIVE

        await expect(h.run(linearFlow.id, {})).rejects.toMatchObject({ code: -32602 });
        expect(h.mock.count()).toBe(0);
    });

    test('branching: step is skipped when its condition is false', async () => {
        h.mock.on('user.profile.get', () => ({ phone: '555-0100', tier: 'silver' }));
        h.mock.on('gateway.sms.send', () => ({ sent: true }));

        await h.seedWorkflow(branchingFlow);
        const res = await h.run(branchingFlow.id, { customerId: 'c-2' });

        expect(res.trace.find(t => t.id === 's2').status).toBe('skipped');
        expect(h.mock.count('gateway.sms.send')).toBe(0);
    });

    test('branching: step runs when its condition is true', async () => {
        h.mock.on('user.profile.get', () => ({ phone: '555-0100', tier: 'gold' }));
        h.mock.on('gateway.sms.send', () => ({ sent: true }));

        await h.seedWorkflow(branchingFlow);
        const res = await h.run(branchingFlow.id, { customerId: 'c-3' });

        expect(res.trace.find(t => t.id === 's2').status).toBe('success');
        expect(h.mock.lastParams('gateway.sms.send')).toEqual({ to: '555-0100', idempotency_key: expect.any(String) });
    });

    test('step failure without ignore_error → workflow failed, later steps not called', async () => {
        h.mock.on('user.profile.get', () => { throw new Error('user service down'); });
        h.mock.on('gateway.email.send', () => ({ delivered: true }));

        await h.seedWorkflow(linearFlow);
        const res = await h.run(linearFlow.id, { customerId: 'c-4' });

        expect(res.status).toBe('failed');
        expect(res.failedStep).toBe('s1');
        // the real downstream error must survive (regression guard for the
        // previously-missing jsonrpc import that masked it as "jsonrpc is not defined")
        expect(res.trace.find(t => t.id === 's1').error).toMatch(/user service down/);
        expect(h.mock.count('gateway.email.send')).toBe(0); // s2 never reached
        expect(h.events('EVENT:WORKFLOW:STATUS')).toHaveLength(1); // failure event
    });

    // ─── Gate boundary template ────────────────────────────────────────────
    // Pattern for FUTURE gate tests (C1 status machine, H6 footprint pre-flight):
    // a gate must reject BEFORE any step executes, so assert the MockRouter saw
    // ZERO downstream calls (fail-fast / all-or-nothing, no side effects).
    test('boundary: a non-runnable (DELETED) workflow is rejected with no side effects', async () => {
        h.mock.onAny(() => ({}));
        await h.seedWorkflow({ ...linearFlow, id: 'wf_dead', status: 'DELETED' });

        await expect(h.run('wf_dead', { customerId: 'c-5' })).rejects.toMatchObject({ code: -32005 });
        expect(h.mock.count()).toBe(0);
    });
});
