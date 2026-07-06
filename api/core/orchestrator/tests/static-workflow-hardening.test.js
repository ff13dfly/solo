/**
 * toFix §6（静态 workflow 上线档）— orchestrator 侧四件套的 hermetic 覆盖：
 *
 *   §6.3 input_schema 强制（fail-closed）+ result_schema（warning / strict_result 阻断）
 *   §6.1 失败语义：cleanup_manifest 披露、run.FAILED、ops 通知、STALLED 扫描
 *   §6.6 版本化：create/update/approve 版本单调递增 + 不可变快照 + expected_version 冲突
 *
 * 全部走 harness（MockRouter + fake redis）或 worker/run 直驱 — 无真 Redis、无 HTTP。
 * §6.2 的 matcher fired-guard 用例在 matcher.test.js（同包落地）。
 */
const { createHarness } = require('./utils/harness');
const { makeFakeRedis } = require('./utils/fake-redis');
const createWorker = require('../logic/worker');
const createRun = require('../logic/run');
const config = require('../config');

const VP = config.redis.workflowVersionPrefix;

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 input_schema — fail-closed before any downstream call
// ─────────────────────────────────────────────────────────────────────────────
describe('§6.3 input_schema enforcement', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(async () => { await h.stop(); });

    const wfDef = {
        id: 'wf_schema',
        name: 'schema test', desc: 'x', category: 'test',
        input_schema: [
            { name: 'uid', required: true, type: 'string', pattern: 'id' },
            { name: 'amount', type: 'number' },
        ],
        steps: [{ id: 's1', service: 'user', method: 'user.profile.get', params: { uid: '$input.uid' } }],
    };

    test('missing required field → INVALID_PARAMS, zero downstream calls', async () => {
        h.mock.onAny(() => ({}));
        await h.seedWorkflow(wfDef);
        await expect(h.run('wf_schema', {})).rejects.toMatchObject({ code: -32602 });
        expect(h.mock.count()).toBe(0);
    });

    test('type mismatch → INVALID_PARAMS, zero downstream calls', async () => {
        h.mock.onAny(() => ({}));
        await h.seedWorkflow(wfDef);
        await expect(h.run('wf_schema', { uid: 'u-1', amount: 'not-a-number' }))
            .rejects.toMatchObject({ code: -32602 });
        expect(h.mock.count()).toBe(0);
    });

    test('pattern violation (control/format) → INVALID_PARAMS', async () => {
        h.mock.onAny(() => ({}));
        await h.seedWorkflow(wfDef);
        await expect(h.run('wf_schema', { uid: 'has spaces!!' }))
            .rejects.toMatchObject({ code: -32602 });
    });

    test('valid input passes and the workflow completes', async () => {
        h.mock.on('user.profile.get', () => ({ ok: true }));
        await h.seedWorkflow(wfDef);
        const res = await h.run('wf_schema', { uid: 'u-1', amount: 42 });
        expect(res.status).toBe('completed');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3③ result_schema — warning tier by default, strict_result escalates
// ─────────────────────────────────────────────────────────────────────────────
describe('§6.3 result_schema', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(async () => { await h.stop(); });

    const stepWithResultSchema = {
        id: 's1', service: 'user', method: 'user.profile.get', params: {},
        result_schema: [{ name: 'email', required: true }],
    };

    test('violation without strict_result → run completes, violation recorded in trace', async () => {
        h.mock.on('user.profile.get', () => ({ name: 'no email here' }));
        await h.seedWorkflow({ id: 'wf_rs1', name: 'rs', desc: 'x', category: 'test', steps: [stepWithResultSchema] });

        const res = await h.run('wf_rs1', {});
        expect(res.status).toBe('completed');
        expect(res.trace[0].result_schema_violations).toEqual([`'email' is required`]);
    });

    test('violation with strict_result:true → step fails, run fails', async () => {
        h.mock.on('user.profile.get', () => ({ name: 'still no email' }));
        await h.seedWorkflow({ id: 'wf_rs2', name: 'rs', desc: 'x', category: 'test', strict_result: true, steps: [stepWithResultSchema] });

        const res = await h.run('wf_rs2', {});
        expect(res.status).toBe('failed');
        expect(res.failedStep).toBe('s1');
        expect(res.error).toMatch(/result_schema violation/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.1③ cleanup_manifest — committed side-effects disclosed on failure
// ─────────────────────────────────────────────────────────────────────────────
describe('§6.1 cleanup_manifest', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(async () => { await h.stop(); });

    test('failed run auto-runs compensation (reverse) and still lists committed steps in the manifest', async () => {
        h.mock.on('collection.payment.charge', () => ({ chargeId: 'ch_1', amount: 100 }));
        h.mock.on('collection.payment.refund', () => ({ refunded: true }));      // the compensation
        h.mock.on('market.shipment.create', () => { throw new Error('warehouse offline'); });

        await h.seedWorkflow({
            id: 'wf_manifest', name: 'm', desc: 'x', category: 'test', version: 7,
            steps: [
                { id: 'charge', service: 'collection', method: 'collection.payment.charge', params: {},
                  compensate: 'refund_charge' },                                  // step-id reference (README §7)
                { id: 'ship', service: 'market', method: 'market.shipment.create', params: {} },
                // compensation-only step: referenced by charge.compensate → never runs forward
                { id: 'refund_charge', service: 'collection', method: 'collection.payment.refund',
                  params: { chargeId: '$step.charge.result.chargeId' } },
            ],
        });

        const res = await h.run('wf_manifest', {});
        expect(res.status).toBe('failed');
        expect(res.failedStep).toBe('ship');
        expect(res.workflowVersion).toBe(7);

        // forward pass: charge committed, ship failed; refund_charge did NOT run forward
        expect(res.trace.map((t) => [t.id, t.status])).toEqual([['charge', 'success'], ['ship', 'failed']]);

        // compensation ran: charge's compensate executed against the committed result
        expect(res.compensation).toMatchObject({ ran: true, failed: false });
        expect(res.compensation.entries).toHaveLength(1);
        expect(res.compensation.entries[0]).toMatchObject({ forStep: 'charge', compensate: 'refund_charge', method: 'collection.payment.refund', status: 'success' });
        expect(h.mock.lastParams('collection.payment.refund')).toMatchObject({ chargeId: 'ch_1' });

        // cleanup_manifest still lists the committed step + its compensate id (disclosure tier)
        expect(res.cleanup_manifest).toHaveLength(1);
        expect(res.cleanup_manifest[0]).toMatchObject({ id: 'charge', method: 'collection.payment.charge', compensate: 'refund_charge' });
        expect(res.cleanup_manifest[0].result_summary).toContain('ch_1');

        // STATUS event carries committed count + compensation flags
        const statusEvents = h.events('EVENT:WORKFLOW:STATUS');
        expect(statusEvents).toHaveLength(1);
        expect(JSON.parse(statusEvents[0].fields.payload)).toMatchObject({ committed_steps: 1, compensated: true, compensation_failed: false });
    });

    test('a compensation that itself fails → compensation_failed + EVENT:WORKFLOW:DEAD_LETTER', async () => {
        h.mock.on('collection.payment.charge', () => ({ chargeId: 'ch_2' }));
        h.mock.on('collection.payment.refund', () => { throw new Error('refund gateway down'); });   // compensation fails
        h.mock.on('market.shipment.create', () => { throw new Error('warehouse offline'); });

        await h.seedWorkflow({
            id: 'wf_comp_err', name: 'm', desc: 'x', category: 'test',
            steps: [
                { id: 'charge', service: 'collection', method: 'collection.payment.charge', params: {}, compensate: 'refund_charge' },
                { id: 'ship', service: 'market', method: 'market.shipment.create', params: {} },
                { id: 'refund_charge', service: 'collection', method: 'collection.payment.refund', params: { chargeId: '$step.charge.result.chargeId' } },
            ],
        });

        const res = await h.run('wf_comp_err', {});
        expect(res.status).toBe('failed');
        expect(res.compensation).toMatchObject({ ran: true, failed: true });
        expect(res.compensation.entries[0]).toMatchObject({ forStep: 'charge', status: 'failed' });
        expect(res.compensation.entries[0].error).toMatch(/refund gateway down/);

        // a dead-letter event is emitted for human intervention (never silently swallowed, §7.2)
        const dl = h.events('EVENT:WORKFLOW:DEAD_LETTER');
        expect(dl).toHaveLength(1);
        expect(dl[0].fields.type).toBe('workflow.compensation.failed');
    });

    test('create() rejects an invalid compensate reference (README §7 validation)', async () => {
        const base = { name: 'm', desc: 'x', category: 'test' };
        // (a) points at a step that does not exist
        await expect(h.createWorkflow({ ...base, id: 'wf_badc1', steps: [
            { id: 's1', service: 'svc', method: 'svc.do', params: {}, compensate: 'nope' },
        ] })).rejects.toMatchObject({ code: -32602 });
        // (b) §7.3 — a compensation step cannot itself declare compensate (no chains)
        await expect(h.createWorkflow({ ...base, id: 'wf_badc2', steps: [
            { id: 's1', service: 'svc', method: 'svc.do', params: {}, compensate: 's2' },
            { id: 's2', service: 'svc', method: 'svc.undo', params: {}, compensate: 's1' },
        ] })).rejects.toMatchObject({ code: -32602 });
    });

    test('failure at the first step → empty manifest (nothing committed)', async () => {
        h.mock.on('collection.payment.charge', () => { throw new Error('declined'); });
        await h.seedWorkflow({
            id: 'wf_manifestB', name: 'm', desc: 'x', category: 'test',
            steps: [{ id: 'charge', service: 'collection', method: 'collection.payment.charge', params: {} }],
        });

        const res = await h.run('wf_manifestB', {});
        expect(res.status).toBe('failed');
        expect(res.cleanup_manifest).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.1①② worker — FAILED state + ops notification (mirror of NEEDS_GRANT seam)
// ─────────────────────────────────────────────────────────────────────────────
describe('§6.1 worker failure seam', () => {
    function makeWorkerFakeRedis() {
        // worker only touches lists/zsets here — reuse the lean fake from worker.test.js shape
        const lists = {};
        return {
            async lPush(key, val) { (lists[key] ||= []).unshift(val); return lists[key].length; },
            async zAdd() { return 1; }, async zRem() { return 0; }, async zRangeByScore() { return []; },
            _list(key) { return lists[key] || []; },
        };
    }

    test('failed result → run.fail (manifest + version) AND ops.run_failed notification', async () => {
        const redis = makeWorkerFakeRedis();
        const calls = [];
        const relay = { async getToken() { return 't'; }, async call(method, params) { calls.push({ method, params }); } };
        const recorded = {};
        const run = {
            create: async () => {}, getGrant: async () => null,
            done: async (id, extra) => { recorded.done = { id, ...extra }; },
            fail: async (id, d) => { recorded.fail = { id, ...d }; },
        };
        const manifest = [{ id: 's1', method: 'a.b.c', result_summary: '{}', compensate: null }];
        const worker = createWorker(redis, {
            relay,
            runner: { run: async () => ({ status: 'failed', failedStep: 's2', error: 'boom', cleanup_manifest: manifest, workflowVersion: 3 }) },
            run,
        });

        await worker.processOne(redis, JSON.stringify({ runId: 'run_f1', workflowId: 'wf1', triggerSource: 'event' }));

        expect(recorded.fail).toMatchObject({ id: 'run_f1', failedStep: 's2', error: 'boom', cleanupManifest: manifest, workflowVersion: 3 });
        expect(recorded.done).toBeUndefined();

        const notify = calls.find(c => c.method === 'notification.send');
        expect(notify).toBeTruthy();
        expect(notify.params.targetId).toBe(config.opsInbox);
        expect(notify.params.type).toBe('ops.run_failed');
        expect(notify.params.ref).toBe('run_failed:run_f1');
        expect(notify.params.payload.cleanupManifest).toEqual(manifest);
    });

    test('completed result → run.done carries workflowVersion; no failure notification', async () => {
        const redis = makeWorkerFakeRedis();
        const calls = [];
        const relay = { async getToken() { return 't'; }, async call(method, params) { calls.push({ method, params }); } };
        const recorded = {};
        const run = {
            create: async () => {}, getGrant: async () => null,
            done: async (id, extra) => { recorded.done = { id, ...extra }; },
            fail: async (id, d) => { recorded.fail = { id, ...d }; },
        };
        const worker = createWorker(redis, {
            relay, runner: { run: async () => ({ status: 'completed', workflowVersion: 5 }) }, run,
        });

        await worker.processOne(redis, JSON.stringify({ runId: 'run_f2', workflowId: 'wf2' }));

        expect(recorded.done).toMatchObject({ id: 'run_f2', workflowVersion: 5 });
        expect(recorded.fail).toBeUndefined();
        expect(calls.find(c => c.method === 'notification.send')).toBeUndefined();
    });

    test('notify failure is fail-soft — run.fail still recorded', async () => {
        const redis = makeWorkerFakeRedis();
        const relay = { async getToken() { return 't'; }, async call() { throw new Error('router down'); } };
        const recorded = {};
        const run = {
            create: async () => {}, getGrant: async () => null, done: async () => {},
            fail: async (id, d) => { recorded.fail = { id, ...d }; },
        };
        const worker = createWorker(redis, {
            relay, runner: { run: async () => ({ status: 'failed', failedStep: 's1', error: 'x' }) }, run,
        });

        await expect(worker.processOne(redis, JSON.stringify({ runId: 'run_f3', workflowId: 'wf3' })))
            .resolves.toBeUndefined();
        expect(recorded.fail).toBeTruthy();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.1④ stall scanner — orphaned RUNNING runs get flagged + alerted
// ─────────────────────────────────────────────────────────────────────────────
describe('§6.1 stall scanner', () => {
    test('old RUNNING run → STALLED + ops notification; fresh one untouched', async () => {
        const redis = makeFakeRedis();
        const run = createRun(redis);
        const calls = [];
        const relay = { async getToken() { return 't'; }, async call(method, params) { calls.push({ method, params }); } };
        const worker = createWorker(redis, { relay, runner: { run: async () => ({}) }, run });

        // Orphan: started way past the stall threshold. Fresh: just started.
        await run.create({ runId: 'run_old', workflowId: 'wf_o' });
        await run.create({ runId: 'run_new', workflowId: 'wf_n' });
        const oldDoc = await run.get('run_old');
        await redis.json.set(`${config.redis.runPrefix}run_old`, '$',
            { ...oldDoc, startedAt: Date.now() - (config.worker.stallMs + 60000) });

        const stalled = await worker.scanStalledRuns();

        expect(stalled.map(r => r.id)).toEqual(['run_old']);
        expect((await run.get('run_old')).status).toBe('STALLED');
        expect((await run.get('run_new')).status).toBe('RUNNING');

        const notify = calls.find(c => c.method === 'notification.send');
        expect(notify).toBeTruthy();
        expect(notify.params.type).toBe('ops.run_stalled');
        expect(notify.params.ref).toBe('run_stalled:run_old');

        // scan throttling: an immediate second sweep is a no-op
        expect(await worker.scanStalledRuns()).toEqual([]);
    });

    test('run.stall is a guarded transition — non-RUNNING and fresh runs return null', async () => {
        const redis = makeFakeRedis();
        const run = createRun(redis);

        await run.create({ runId: 'run_done', workflowId: 'wf' });
        await run.done('run_done');
        expect(await run.stall('run_done', { thresholdMs: 0 })).toBeNull();

        await run.create({ runId: 'run_fresh', workflowId: 'wf' });
        expect(await run.stall('run_fresh', { thresholdMs: 999999 })).toBeNull();
    });

    test('run.fail records FAILED + manifest and clears the grant', async () => {
        const redis = makeFakeRedis();
        const run = createRun(redis);
        await run.create({ runId: 'run_x', workflowId: 'wf' });

        const failed = await run.fail('run_x', {
            failedStep: 's3', error: 'boom',
            cleanupManifest: [{ id: 's1', method: 'a.b.c' }],
            workflowVersion: 2,
        });

        expect(failed.status).toBe('FAILED');
        expect(failed.failedStep).toBe('s3');
        expect(failed.cleanupManifest).toHaveLength(1);
        expect(failed.workflowVersion).toBe(2);
        expect((await run.list({ status: 'FAILED' })).map(r => r.id)).toEqual(['run_x']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.6 versioning — monotonic versions, immutable snapshots, expected_version
// ─────────────────────────────────────────────────────────────────────────────
describe('§6.6 workflow versioning', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(async () => { await h.stop(); });

    const minimal = (id) => ({
        id, category: 'test', name: 'v', desc: 'x',
        steps: [{ id: 's1', service: 'user', method: 'user.profile.get', params: {} }],
    });

    test('create → version 1 with an immutable v1 snapshot', async () => {
        const wf = await h.createWorkflow(minimal('wf_v1'));
        expect(wf.version).toBe(1);
        const snap = await h.redis.json.get(`${VP}wf_v1:1`);
        expect(snap).toMatchObject({ id: 'wf_v1', version: 1, status: 'PENDING_REVIEW' });
    });

    test('update bumps version and writes a new snapshot; old snapshot unchanged', async () => {
        await h.createWorkflow(minimal('wf_v2'));
        const updated = await h.logic.workflow.update({ id: 'wf_v2', desc: 'revised' });

        expect(updated.version).toBe(2);
        expect((await h.redis.json.get(`${VP}wf_v2:2`)).desc).toBe('revised');
        expect((await h.redis.json.get(`${VP}wf_v2:1`)).desc).toBe('x');   // v1 immutable
    });

    test('expected_version mismatch → version conflict, doc untouched', async () => {
        await h.createWorkflow(minimal('wf_v3'));
        await h.logic.workflow.update({ id: 'wf_v3', desc: 'second' });   // → version 2

        await expect(h.logic.workflow.update({ id: 'wf_v3', desc: 'stale edit', expected_version: 1 }))
            .rejects.toMatchObject({ code: -32005 });
        expect((await h.logic.workflow.get({ id: 'wf_v3' })).desc).toBe('second');
    });

    test('approve bumps version, snapshots the approved definition, run records it', async () => {
        await h.createWorkflow(minimal('wf_v4'));   // PENDING_REVIEW v1
        const { workflow } = await h.logic.workflow.approve({ id: 'wf_v4' }, 'approver-1');

        expect(workflow.status).toBe('ACTIVE');
        expect(workflow.version).toBe(2);
        expect((await h.redis.json.get(`${VP}wf_v4:2`)).status).toBe('ACTIVE');

        h.mock.on('user.profile.get', () => ({ ok: true }));
        const res = await h.run('wf_v4', {});
        expect(res.workflowVersion).toBe(2);
    });

    test('re-create over a DELETED id continues the version line (snapshots survive)', async () => {
        await h.createWorkflow(minimal('wf_v5'));                       // v1
        await h.logic.workflow.update({ id: 'wf_v5', desc: 'rev' });    // v2
        await h.logic.workflow.delete({ id: 'wf_v5' });

        const recreated = await h.createWorkflow(minimal('wf_v5'));
        expect(recreated.version).toBe(3);
        expect((await h.redis.json.get(`${VP}wf_v5:1`)).desc).toBe('x');   // history intact
    });

    test('concurrent-style sequential updates never lose a bump (CAS path)', async () => {
        await h.createWorkflow(minimal('wf_v6'));
        await h.logic.workflow.update({ id: 'wf_v6', name: 'a' });
        await h.logic.workflow.update({ id: 'wf_v6', desc: 'b' });
        const doc = await h.logic.workflow.get({ id: 'wf_v6' });
        expect(doc.version).toBe(3);
        expect(doc.name).toBe('a');   // first edit not clobbered by second
        expect(doc.desc).toBe('b');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// create/update accept event_subscriptions + input_schema (surfaced by the UI e2e:
// the approval review showed empty subscriptions because create silently dropped them)
// ─────────────────────────────────────────────────────────────────────────────
describe('submission surface — create/update store event_subscriptions + input_schema', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(async () => { await h.stop(); });

    test('create persists event_subscriptions, input_schema, strict_result (was injection-only)', async () => {
        const wf = await h.createWorkflow({
            id: 'wf_sub_create', category: 'test', name: 'sub', desc: 'x',
            steps: [{ id: 's1', service: 'gateway', method: 'gateway.email.send', params: {} }],
            event_subscriptions: [{ stream: 'EVENT:ORDER:PAID', filter: { type: 'order.paid' } }],
            input_schema: [{ name: 'orderId', required: true, type: 'string' }],
            strict_result: true,
        });
        expect(wf.event_subscriptions).toEqual([{ stream: 'EVENT:ORDER:PAID', filter: { type: 'order.paid' } }]);
        expect(wf.input_schema).toEqual([{ name: 'orderId', required: true, type: 'string' }]);
        expect(wf.strict_result).toBe(true);

        const got = await h.logic.workflow.get({ id: 'wf_sub_create' });
        expect(got.event_subscriptions[0].stream).toBe('EVENT:ORDER:PAID');
        expect(got.input_schema[0].name).toBe('orderId');
    });

    test('create rejects a malformed event_subscriptions', async () => {
        await expect(h.createWorkflow({
            id: 'wf_sub_bad', category: 'test', name: 'bad', desc: 'x',
            steps: [{ id: 's1', service: 'planner', method: 'planner.task.get', params: {} }],
            event_subscriptions: [{ filter: { type: 't' } }],   // missing stream
        })).rejects.toMatchObject({ code: -32602 });
    });

    test('update edits subscriptions/schema and invalidates an in-flight gate', async () => {
        await h.createWorkflow({
            id: 'wf_sub_upd', category: 'test', name: 'upd', desc: 'x',
            steps: [{ id: 's1', service: 'planner', method: 'planner.task.get', params: {} }],
        });
        // simulate an in-flight gate, then edit the subscriptions
        const key = `${h.config.redis.workflowPrefix}wf_sub_upd`;
        const doc = await h.redis.json.get(key);
        await h.redis.json.set(key, '$', { ...doc, gateId: 'gate-x', effective_at: Date.now() + 1000 });

        const updated = await h.logic.workflow.update({
            id: 'wf_sub_upd',
            event_subscriptions: [{ stream: 'EVENT:NEW:STREAM' }],
            input_schema: [{ name: 'x', required: false }],
        });
        expect(updated.event_subscriptions[0].stream).toBe('EVENT:NEW:STREAM');
        expect(updated.input_schema[0].name).toBe('x');
        expect(updated.gateId).toBeUndefined();        // gate invalidated (digest changed)
        expect(updated.effective_at).toBeUndefined();
    });

    test('create persists require_actor_permit; absent → false (C4 minimal)', async () => {
        const gated = await h.createWorkflow({
            id: 'wf_rap_on', category: 'test', name: 'rap', desc: 'x',
            steps: [{ id: 's1', service: 'planner', method: 'planner.task.get', params: {} }],
            require_actor_permit: true,
        });
        expect(gated.require_actor_permit).toBe(true);

        const open = await h.createWorkflow({
            id: 'wf_rap_off', category: 'test', name: 'rap2', desc: 'x',
            steps: [{ id: 's1', service: 'planner', method: 'planner.task.get', params: {} }],
        });
        expect(open.require_actor_permit).toBe(false);
    });

    test('update flips require_actor_permit pre-approval AND invalidates an in-flight gate', async () => {
        await h.createWorkflow({
            id: 'wf_rap_upd', category: 'test', name: 'rap3', desc: 'x',
            steps: [{ id: 's1', service: 'planner', method: 'planner.task.get', params: {} }],
        });
        const key = `${h.config.redis.workflowPrefix}wf_rap_upd`;
        const doc = await h.redis.json.get(key);
        await h.redis.json.set(key, '$', { ...doc, gateId: 'gate-y', effective_at: Date.now() + 1000 });

        const updated = await h.logic.workflow.update({ id: 'wf_rap_upd', require_actor_permit: true });
        expect(updated.require_actor_permit).toBe(true);
        // Not digest-bound, but it changes WHO may trigger the definition — collected
        // signatures must not survive a mid-review flip.
        expect(updated.gateId).toBeUndefined();
        expect(updated.effective_at).toBeUndefined();
    });

    test('require_actor_permit is FROZEN on ACTIVE workflows (like steps/resolvers)', async () => {
        await h.createWorkflow({
            id: 'wf_rap_frozen', category: 'test', name: 'rap4', desc: 'x',
            steps: [{ id: 's1', service: 'planner', method: 'planner.task.get', params: {} }],
            require_actor_permit: true,
        });
        await h.logic.workflow.approve({ id: 'wf_rap_frozen' }, 'approver-1');   // → ACTIVE

        // Flipping the actor gate off on a live workflow would silently widen who
        // can trigger it past what was approved — locked, needs re-review.
        await expect(h.logic.workflow.update({ id: 'wf_rap_frozen', require_actor_permit: false }))
            .rejects.toMatchObject({ code: -32005 });
    });
});
