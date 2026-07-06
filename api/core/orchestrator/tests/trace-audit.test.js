/**
 * Run execution trace persistence (toFix.md "执行轨迹持久化") — logic/trace-audit.js
 * directly, plus a wiring check that runner.js actually calls it on both the
 * completed and failed paths (mirrors ingress/logic/audit.js's own test coverage
 * shape: unit the log module, then prove the real caller uses it).
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-orchestrator-trace-audit-${process.pid}`);

const createTraceAudit = require('../logic/trace-audit');
const { createHarness } = require('./utils/harness');
const linearFlow = require('./cases/linear-flow.json');

describe('trace-audit — append/recent (file-backed JSONL, ingress/logic/audit.js pattern)', () => {
    test('append then recent round-trips a record', async () => {
        const audit = createTraceAudit();
        audit.append({ runId: 'run-1', workflowId: 'wf-1', status: 'completed', trace: [{ id: 's1', status: 'success' }] });

        const { items, total } = audit.recent({ days: 1 });
        expect(total).toBe(1);
        expect(items[0]).toMatchObject({ runId: 'run-1', workflowId: 'wf-1', status: 'completed' });
        expect(items[0].trace).toEqual([{ id: 's1', status: 'success' }]);
    });

    test('recent filters by runId and workflowId', async () => {
        const audit = createTraceAudit();
        audit.append({ runId: 'run-a', workflowId: 'wf-x', status: 'completed', trace: [] });
        audit.append({ runId: 'run-b', workflowId: 'wf-y', status: 'completed', trace: [] });

        expect((await audit.recent({ runId: 'run-a', days: 1 })).total).toBe(1);
        expect((await audit.recent({ workflowId: 'wf-y', days: 1 })).total).toBe(1);
        expect((await audit.recent({ runId: 'nope', days: 1 })).total).toBe(0);
    });

    test('newest-first ordering', async () => {
        const audit = createTraceAudit();
        audit.append({ runId: 'r1', workflowId: 'wf', status: 'completed', trace: [] });
        audit.append({ runId: 'r2', workflowId: 'wf', status: 'completed', trace: [] });
        const { items } = await audit.recent({ workflowId: 'wf', days: 1 });
        expect(items.map((i) => i.runId)).toEqual(['r2', 'r1']);
    });

    test('sensitive step params/results are redacted before hitting disk', async () => {
        const audit = createTraceAudit();
        audit.append({
            runId: 'run-secret', workflowId: 'wf-1', status: 'completed',
            trace: [{ id: 's1', params: { token: 'sk-abc123', uid: 'u1' }, result: { password: 'hunter2', ok: true } }],
        });
        const { items } = await audit.recent({ runId: 'run-secret', days: 1 });
        expect(items[0].trace[0].params).toEqual({ token: '***', uid: 'u1' });
        expect(items[0].trace[0].result).toEqual({ password: '***', ok: true });
    });

    test('a write failure is fail-soft — never throws', () => {
        const audit = createTraceAudit();
        expect(() => audit.append({ runId: 'r', workflowId: 'wf', trace: undefined })).not.toThrow();
    });
});

describe('trace-audit — wiring: runner.js logs through it on both outcomes (real logic/index.js)', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(async () => { await h.stop(); });

    test('completed run → a trace-audit record with the full step trace, joined by runId', async () => {
        h.mock.on('user.profile.get', () => ({ name: 'Alice', email: 'alice@example.com' }));
        h.mock.on('gateway.email.send', () => ({ delivered: true }));
        await h.seedWorkflow(linearFlow);

        await h.run(linearFlow.id, { customerId: 'c-1' }, {}, null, { runId: 'run-wire-1' });

        const { items } = await h.logic.traceAudit.recent({ runId: 'run-wire-1', days: 1 });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ runId: 'run-wire-1', workflowId: linearFlow.id, status: 'completed' });
        expect(items[0].trace.map((t) => [t.id, t.status])).toEqual([['s1', 'success'], ['s2', 'success']]);
    });

    test('failed run → a trace-audit record with status failed + failedStep', async () => {
        h.mock.on('user.profile.get', () => { throw new Error('downstream down'); });
        await h.seedWorkflow(linearFlow);

        const res = await h.run(linearFlow.id, { customerId: 'c-1' }, {}, null, { runId: 'run-wire-2' });
        expect(res.status).toBe('failed');

        const { items } = await h.logic.traceAudit.recent({ runId: 'run-wire-2', days: 1 });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ runId: 'run-wire-2', workflowId: linearFlow.id, status: 'failed', failedStep: 's1' });
    });
});
