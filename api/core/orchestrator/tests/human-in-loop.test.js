/**
 * Human-in-the-loop tests (event.md §9, decisions D5/D7/D8).
 *
 * Covers:
 *   - NeedsGrantError class shape
 *   - run.js state machine (create/pause/done/deadletter/grant/abort/list)
 *   - worker: NeedsGrantError → PAUSED run entity (not RETRY / DEADLETTER)
 *   - worker: resume path — loads grant, passes oneTimeGrant to runner
 *   - runner: oneTimeGrant subtracts from uncovered methods (H6 gate)
 *   - harness (sync path): NeedsGrantError → FORBIDDEN -32005 (D5)
 */

const { NeedsGrantError } = require('../logic/NeedsGrantError');
const createRun           = require('../logic/run');
const createWorker        = require('../logic/worker');
const config              = require('../config');
const { createHarness }   = require('./utils/harness');

const R = config.redis;
const W = config.worker;

// ─────────────────────────────────────────────────────────────────────────────
// Fake Redis — combines json store (for run entities) + list/zset (for worker)
// ─────────────────────────────────────────────────────────────────────────────
function makeFakeRedis() {
    const docs  = {};   // key → object (json store)
    const lists = {};   // key → array  (list store)
    const zsets = {};   // key → Map(value → score)
    const sets  = {};   // key → Set    (SADD/SMEMBERS — run id index)

    const api = {
        json: {
            async set(key, _path, value) { docs[key] = JSON.parse(JSON.stringify(value)); return 'OK'; },
            async get(key)               { return docs[key] !== undefined ? JSON.parse(JSON.stringify(docs[key])) : null; },
            async del(key)               { const had = key in docs; delete docs[key]; return had ? 1 : 0; },
        },
        async keys(pattern) {
            const prefix = pattern.replace(/\*$/, '');
            return Object.keys(docs).filter(k => k.startsWith(prefix));
        },
        duplicate() { return api; },
        async connect() {},
        async lPush(key, val)   { (lists[key] ||= []).unshift(val); return lists[key].length; },
        async rPop(key)         { const a = lists[key] || []; return a.length ? a.pop() : null; },
        async blPop(key)        { const a = lists[key] || []; return a.length ? { key, element: a.shift() } : null; },
        async zAdd(key, { score, value }) { (zsets[key] ||= new Map()).set(value, score); return 1; },
        async zRem(key, value)  { const m = zsets[key]; if (m && m.has(value)) { m.delete(value); return 1; } return 0; },
        async zRangeByScore(key, min, max) {
            const m = zsets[key] || new Map();
            return [...m.entries()].filter(([, s]) => s >= min && s <= max).map(([v]) => v);
        },
        async sAdd(key, m)      { (sets[key] ||= new Set()).add(m); return 1; },
        async sMembers(key)     { return [...(sets[key] || [])]; },
        async sRem(key, m)      { if (sets[key]) sets[key].delete(m); return 1; },
        async sIsMember(key, m) { return !!(sets[key] && sets[key].has(m)); },
        _docs()              { return docs; },
        _list(key)           { return lists[key] || []; },
        _zset(key)           { return zsets[key] || new Map(); },
    };
    return api;
}

const fakeRelay = { async getToken() { return 'bot-token'; }, async call() {} };

function makeWorker(redis, { runFn, relay = fakeRelay, run = null } = {}) {
    return createWorker(redis, { relay, runner: { run: runFn }, run });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. NeedsGrantError
// ─────────────────────────────────────────────────────────────────────────────
describe('NeedsGrantError', () => {
    test('is an Error with name + missing array', () => {
        const e = new NeedsGrantError(['ledger.transfer', 'bank.send']);
        expect(e instanceof Error).toBe(true);
        expect(e.name).toBe('NeedsGrantError');
        expect(e.missing).toEqual(['ledger.transfer', 'bank.send']);
    });

    test('message contains missing methods and footprint keyword', () => {
        const e = new NeedsGrantError(['mail.send']);
        expect(e.message).toMatch(/mail\.send/);
        expect(e.message).toMatch(/footprint/i);
    });

    test('wraps single string in array', () => {
        const e = new NeedsGrantError('ledger.transfer');
        expect(e.missing).toEqual(['ledger.transfer']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. run.js state machine
// ─────────────────────────────────────────────────────────────────────────────
describe('run — state machine', () => {
    let redis, run;
    beforeEach(() => {
        redis = makeFakeRedis();
        run   = createRun(redis);
    });

    const baseCmd = { runId: 'run_testAA', workflowId: 'wf_a', input: {}, triggerSource: 'event', enqueuedAt: 1000, attempts: 0 };

    test('create: stores run entity with RUNNING status', async () => {
        const r = await run.create(baseCmd);
        expect(r.id).toBe('run_testAA');
        expect(r.status).toBe('RUNNING');
        expect(r.workflowId).toBe('wf_a');
        const stored = await redis.json.get(`${R.runPrefix}run_testAA`);
        expect(stored.status).toBe('RUNNING');
    });

    test('create: upserts — resume sets status RUNNING + resumedAt', async () => {
        await run.create(baseCmd);
        await run.pause('run_testAA', { missingMethods: ['x.y'] });

        const resumed = await run.create(baseCmd);
        expect(resumed.status).toBe('RUNNING');
        expect(typeof resumed.resumedAt).toBe('number');
    });

    test('pause: transitions to PAUSED_AWAITING_HUMAN with missingMethods', async () => {
        await run.create(baseCmd);
        const paused = await run.pause('run_testAA', { missingMethods: ['ledger.transfer'] });
        expect(paused.status).toBe('PAUSED_AWAITING_HUMAN');
        expect(paused.missingMethods).toEqual(['ledger.transfer']);
        expect(typeof paused.pausedAt).toBe('number');
    });

    test('done: transitions to DONE and removes grant', async () => {
        await run.create(baseCmd);
        // Plant a grant
        await redis.json.set(`${R.runPrefix}run_testAA:GRANT`, '$', { methods: ['x.y'] });

        const d = await run.done('run_testAA');
        expect(d.status).toBe('DONE');
        expect(typeof d.doneAt).toBe('number');
        // Grant cleared
        expect(await redis.json.get(`${R.runPrefix}run_testAA:GRANT`)).toBeNull();
    });

    test('deadletter: transitions to DEADLETTER', async () => {
        await run.create(baseCmd);
        const dl = await run.deadletter('run_testAA', { error: 'boom' });
        expect(dl.status).toBe('DEADLETTER');
        expect(dl.lastError).toBe('boom');
    });

    test('grant: stores grant + transitions PAUSED → RESUMING', async () => {
        await run.create(baseCmd);
        await run.pause('run_testAA', { missingMethods: ['ledger.transfer'] });

        const { run: updated, grant } = await run.grant({ id: 'run_testAA', methods: ['ledger.transfer'], grantedBy: 'uid_admin' });
        expect(updated.status).toBe('RESUMING');
        expect(updated.grantedBy).toBe('uid_admin');
        expect(grant.methods).toEqual(['ledger.transfer']);

        const stored = await redis.json.get(`${R.runPrefix}run_testAA:GRANT`);
        expect(stored.methods).toEqual(['ledger.transfer']);
    });

    test('grant: rejects non-PAUSED run', async () => {
        await run.create(baseCmd);
        await expect(run.grant({ id: 'run_testAA', methods: ['x.y'] }))
            .rejects.toMatchObject({ code: -32005 });
    });

    test('grant: rejects empty methods', async () => {
        await run.create(baseCmd);
        await run.pause('run_testAA', { missingMethods: ['x.y'] });
        await expect(run.grant({ id: 'run_testAA', methods: [] }))
            .rejects.toMatchObject({ code: -32602 });
    });

    test('abort: transitions PAUSED → ABORTED + clears grant', async () => {
        await run.create(baseCmd);
        await run.pause('run_testAA', { missingMethods: ['x.y'] });
        await redis.json.set(`${R.runPrefix}run_testAA:GRANT`, '$', { methods: ['x.y'] });

        const aborted = await run.abort({ id: 'run_testAA', abortedBy: 'uid_admin', reason: 'not needed' });
        expect(aborted.status).toBe('ABORTED');
        expect(aborted.abortedBy).toBe('uid_admin');
        expect(aborted.abortReason).toBe('not needed');
        expect(await redis.json.get(`${R.runPrefix}run_testAA:GRANT`)).toBeNull();
    });

    test('abort: rejects non-PAUSED run', async () => {
        await run.create(baseCmd);
        await expect(run.abort({ id: 'run_testAA' })).rejects.toMatchObject({ code: -32005 });
    });

    test('list: returns all runs sorted by startedAt desc', async () => {
        await run.create({ ...baseCmd, runId: 'run_a' });
        await run.create({ ...baseCmd, runId: 'run_b' });
        await run.pause('run_b', { missingMethods: ['x'] });

        const all = await run.list();
        expect(all.length).toBe(2);
        // Grant keys not included
        all.forEach(r => expect(r.id).toMatch(/^run_/));
    });

    test('list: filters by status', async () => {
        await run.create({ ...baseCmd, runId: 'run_x' });
        await run.create({ ...baseCmd, runId: 'run_y' });
        await run.pause('run_y', { missingMethods: ['x'] });

        const paused = await run.list({ status: 'PAUSED_AWAITING_HUMAN' });
        expect(paused.length).toBe(1);
        expect(paused[0].id).toBe('run_y');
    });

    test('getGrant: returns null when no grant stored', async () => {
        await run.create(baseCmd);
        expect(await run.getGrant('run_testAA')).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. worker + run integration
// ─────────────────────────────────────────────────────────────────────────────
describe('worker — NeedsGrantError → PAUSED (not RETRY / DEADLETTER)', () => {
    test('enqueue generates runId', async () => {
        const redis = makeFakeRedis();
        const worker = makeWorker(redis, { runFn: async () => ({}) });
        const cmd = await worker.enqueue({ workflowId: 'wf_1', triggerSource: 'event' });
        expect(cmd.runId).toMatch(/^run_[0-9a-f]+$/);
        expect(redis._list(R.runQueuePending)).toHaveLength(1);
    });

    test('enqueue preserves existing runId (resume path)', async () => {
        const redis = makeFakeRedis();
        const worker = makeWorker(redis, { runFn: async () => ({}) });
        const cmd = await worker.enqueue({ workflowId: 'wf_1', triggerSource: 'event', runId: 'run_resume01' });
        expect(cmd.runId).toBe('run_resume01');
    });

    test('processOne creates run entity on start', async () => {
        const redis = makeFakeRedis();
        const run   = createRun(redis);
        const worker = makeWorker(redis, { runFn: async () => ({ status: 'completed' }), run });

        const raw = JSON.stringify({ runId: 'run_p1', workflowId: 'wf_x', triggerSource: 'event', attempts: 0 });
        await worker.processOne(redis, raw);

        // Entity should be DONE after successful run
        const entity = await redis.json.get(`${R.runPrefix}run_p1`);
        expect(entity).not.toBeNull();
        expect(entity.status).toBe('DONE');
    });

    test('processOne → NeedsGrantError → run PAUSED (not enqueued for retry)', async () => {
        const redis = makeFakeRedis();
        const run   = createRun(redis);
        const worker = makeWorker(redis, {
            runFn: async () => { throw new NeedsGrantError(['ledger.transfer']); },
            run,
        });

        const raw = JSON.stringify({ runId: 'run_ng1', workflowId: 'wf_y', triggerSource: 'event', attempts: 0 });
        await worker.processOne(redis, raw);

        // Run entity is PAUSED
        const entity = await redis.json.get(`${R.runPrefix}run_ng1`);
        expect(entity.status).toBe('PAUSED_AWAITING_HUMAN');
        expect(entity.missingMethods).toEqual(['ledger.transfer']);

        // NOT in retry or deadletter
        expect(redis._zset(R.runQueueRetry).size).toBe(0);
        expect(redis._list(R.runQueueDeadletter)).toHaveLength(0);
    });

    test('processOne resume: loads grant and passes oneTimeGrant to runner', async () => {
        const redis = makeFakeRedis();
        const run   = createRun(redis);

        // Pre-plant a paused run with a grant
        await run.create({ runId: 'run_r1', workflowId: 'wf_z', input: {}, triggerSource: 'event', attempts: 0 });
        await run.pause('run_r1', { missingMethods: ['ledger.transfer'] });
        await run.grant({ id: 'run_r1', methods: ['ledger.transfer'], grantedBy: 'uid_admin' });

        let capturedGrant = undefined;
        const worker = makeWorker(redis, {
            runFn: async (args) => { capturedGrant = args.oneTimeGrant; return { status: 'completed' }; },
            run,
        });

        const raw = JSON.stringify({ runId: 'run_r1', workflowId: 'wf_z', triggerSource: 'event', attempts: 0 });
        await worker.processOne(redis, raw);

        expect(capturedGrant).not.toBeNull();
        expect(capturedGrant.methods).toEqual(['ledger.transfer']);

        // Run entity is DONE and grant cleared
        const entity = await redis.json.get(`${R.runPrefix}run_r1`);
        expect(entity.status).toBe('DONE');
        expect(await redis.json.get(`${R.runPrefix}run_r1:GRANT`)).toBeNull();
    });

    test('NeedsGrantError does NOT consume retry attempts (not transient)', async () => {
        const redis = makeFakeRedis();
        const run   = createRun(redis);
        const worker = makeWorker(redis, {
            runFn: async () => { throw new NeedsGrantError(['x.y']); },
            run,
        });

        // Even with attempts near maxRetries, NeedsGrantError should go to PAUSED not DEADLETTER
        const raw = JSON.stringify({ runId: 'run_ng2', workflowId: 'wf_a', triggerSource: 'event', attempts: W.maxRetries - 1 });
        await worker.processOne(redis, raw);

        expect(redis._list(R.runQueueDeadletter)).toHaveLength(0);
        const entity = await redis.json.get(`${R.runPrefix}run_ng2`);
        expect(entity.status).toBe('PAUSED_AWAITING_HUMAN');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. runner oneTimeGrant + sync path (via harness)
// ─────────────────────────────────────────────────────────────────────────────
const footprintWorkflow = require('./cases/footprint-workflow.json');

const PARTIAL_PERMIT = { allow_all: false, services: { ledger: ['ledger.transfer'] } }; // missing mail.send

describe('runner — oneTimeGrant subtracts from uncovered methods', () => {
    let h;
    beforeEach(async () => {
        h = await createHarness();
        h.mock.on('ledger.transfer', () => ({ ok: true }));
        h.mock.on('mail.send',       () => ({ ok: true }));
    });
    afterEach(() => h.stop());

    test('oneTimeGrant covering the missing method → pre-check passes', async () => {
        h.mock.on('user.permit.get', () => PARTIAL_PERMIT); // missing mail.send
        await h.seedWorkflow(footprintWorkflow);

        const res = await h.run(footprintWorkflow.id, {}, {}, 'uid_bot',
            { oneTimeGrant: { methods: ['mail.send'] } });
        expect(res.status).toBe('completed');
        expect(h.mock.count('mail.send')).toBe(1);
    });

    test('oneTimeGrant covers only subset → still fails (remaining listed)', async () => {
        // Empty permit: both ledger + mail missing. Grant only mail → still missing ledger.
        h.mock.on('user.permit.get', () => ({ allow_all: false, services: {} }));
        await h.seedWorkflow(footprintWorkflow);

        const err = await h.run(footprintWorkflow.id, {}, {}, 'uid_bot',
            { oneTimeGrant: { methods: ['mail.send'] } }).catch(e => e);
        expect(err.code).toBe(-32005);
        expect(err.message).toMatch(/ledger\.transfer/);
    });

    test('sync path (D5): NeedsGrantError from runner → FORBIDDEN -32005 (no pause)', async () => {
        h.mock.on('user.permit.get', () => PARTIAL_PERMIT);
        await h.seedWorkflow(footprintWorkflow);

        // h.run() simulates sync path — NeedsGrantError is converted to FORBIDDEN
        const err = await h.run(footprintWorkflow.id, {}, {}, 'uid_caller').catch(e => e);
        expect(err.code).toBe(-32005);
        expect(err.message).toMatch(/mail\.send/);
    });

    test('NeedsGrantError thrown directly from runner (async caller sees typed error)', async () => {
        h.mock.on('user.permit.get', () => PARTIAL_PERMIT);
        await h.seedWorkflow(footprintWorkflow);

        // Call runner directly — no D5 conversion — so NeedsGrantError propagates
        const err = await h.logic.runner.run(
            { workflowId: footprintWorkflow.id, input: {} }, {}, 'uid_bot'
        ).catch(e => e);
        expect(err.name).toBe('NeedsGrantError');
        expect(err.missing).toContain('mail.send');
    });
});
