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

    // ── 声明面对称性 ────────────────────────────────────────────────────────
    // 2026-09-05 — docs/feedback/…/event-triggered-workflow-lifecycle-drops-events.md §5.2.
    //
    // Solo 有两个给人写的声明面（fulfillment profile 的 action.params、workflow 的 step.params）。
    // v1.2.13 只给 fulfillment 补了 `now` 与 `cat`，于是缺口从"两边一样缺"变成"两边不一样"
    // ——更坏：作者把在 profile 里刚学会的写法搬进 step，对象原样当字面量发下去，不报错。
    // 这组用例钉住"两个面认同一套算子"。
    describe('declarative parity with fulfillment: now / cat / +', () => {
        const wfWith = (params) => ({
            id: 'wf_parity_' + Math.random().toString(36).slice(2),
            category: 'test', name: 'parity', desc: 'x', required_inputs: [],
            steps: [{ id: 's1', service: 'data', method: 'data.action', params }],
        });

        async function sent(params, input = {}) {
            h.mock.on('data.action', () => ({ ok: true }));
            const wf = wfWith(params);
            await h.seedWorkflow(wf);
            const res = await h.run(wf.id, input);
            expect(res.status).toBe('completed');
            return h.mock.lastParams('data.action');
        }

        test('$now resolves in params (this face\'s own idiom)', async () => {
            const before = Date.now();
            const p = await sent({ at: '$now' });
            expect(typeof p.at).toBe('number');
            expect(p.at).toBeGreaterThanOrEqual(before - 1000);
        });

        test('{"var":"now"} resolves in a step CONDITION (same spelling fulfillment uses)', async () => {
            h.mock.on('data.get', () => ({}));
            h.mock.on('data.action', () => ({ ok: true }));
            const wf = {
                id: 'wf_parity_cond', category: 'test', name: 'parity-cond', desc: 'x', required_inputs: [],
                steps: [
                    { id: 's1', service: 'data', method: 'data.get', params: {} },
                    { id: 's2', service: 'data', method: 'data.action', params: {},
                      condition: { '>': [{ var: 'now' }, 0] } },
                ],
            };
            await h.seedWorkflow(wf);
            const res = await h.run(wf.id);
            expect(res.trace.find(t => t.id === 's2').status).toBe('success');
        });

        test('cat builds a per-run string — $-syntax alone cannot concatenate', async () => {
            const p = await sent({ requestId: { cat: ['fx-', { var: 'input.orderId' }, '-publish'] } },
                { orderId: 'o-7' });
            expect(p.requestId).toBe('fx-o-7-publish');
        });

        test('+ expresses a RELATIVE deadline (the point of adding it)', async () => {
            // Without `+` an author can only bake an absolute instant at authoring time,
            // which expires the same day on a machine meant to run for weeks.
            const before = Date.now();
            const p = await sent({ expireAt: { '+': [{ var: 'now' }, 7200000] } });
            expect(p.expireAt).toBeGreaterThanOrEqual(before + 7200000 - 1000);
        });

        test('a literal field merely NAMED like an operator is left alone', async () => {
            // Narrowing that keeps this additive: only a SOLE-key operator object evaluates.
            const p = await sent({ payload: { cat: ['a', 'b'], note: 'n' } });
            expect(p.payload).toEqual({ cat: ['a', 'b'], note: 'n' });
        });

        test('operators outside RESOLVE_OPS still pass through as literals', async () => {
            const p = await sent({ policy: { if: [true, 'a', 'b'] } });
            expect(p.policy).toEqual({ if: [true, 'a', 'b'] });
        });
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
