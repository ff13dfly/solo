/**
 * returns-contract.test.js — proves orchestrator's ACTUAL handler output satisfies the
 * declared return contract (introspection `returns_schema`). Hermetic: real logic modules
 * over an injected fake Redis (the human-in-loop.test.js / sample item.test.js pattern).
 * No live Redis, no Router, no LLM.
 *
 * Why this matters: orchestration / AI bind to these return shapes (a fulfillment profile
 * picks meta_fields off a step result; the snapshot consumer reads workflow docs). The
 * returns_schema MUST match what the handler really produces, branch by branch.
 *
 * Coverage strategy: every method that is callable without a Router RPC / LLM / RedisJSON
 * module is invoked and its result asserted with checkReturn(method, result) === []. The
 * index.js wrapper shapes (run.grant → { ok, runId, status }) are reproduced here because
 * THAT is the wire contract, not the bare logic return. Router-dependent methods
 * (category.create/delete, workflow.run with steps) are listed in the task's `unverified`.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-orchestrator-contract-${process.pid}`);

const createWorkflow = require('../logic/workflow');
const createRun = require('../logic/run');
const createRunner = require('../logic/runner');
const createWorker = require('../logic/worker');
const createControl = require('../logic/control');
const createCategory = require('../../../library/category');
const introspection = require('../handlers/introspection');
const config = require('../config');
const { checkReturn } = require('../../../library/contract');

const R = config.redis;

// ─────────────────────────────────────────────────────────────────────────────
// Fake Redis — json store (workflow + run docs), string store (snapshot + category),
// sets (id indexes / category index), lists+zsets (run queue), incr/expire (quota),
// xAdd (runner event emit). duplicate() WITHOUT watch() → optimisticJsonUpdate takes
// its non-transactional degraded path. json.set ignores the { NX } option (fresh ids
// never collide in these tests).
// ─────────────────────────────────────────────────────────────────────────────
function makeFakeRedis() {
    const docs = {};   // json store
    const kv = {};     // string store
    const sets = {};   // SADD/SMEMBERS
    const lists = {};
    const zsets = {};
    const counters = {};

    const api = {
        json: {
            async set(key, _path, value) { docs[key] = JSON.parse(JSON.stringify(value)); return 'OK'; },
            async get(key) { return docs[key] !== undefined ? JSON.parse(JSON.stringify(docs[key])) : null; },
            async del(key) { const had = key in docs; delete docs[key]; return had ? 1 : 0; },
        },
        async get(key) { return key in kv ? kv[key] : null; },
        async set(key, val) { kv[key] = val; return 'OK'; },
        async del(key) { let had = (key in kv) || (key in docs); delete kv[key]; delete docs[key]; return had ? 1 : 0; },
        async mGet(keys) { return keys.map((k) => (k in kv ? kv[k] : null)); },
        async incr(key) { counters[key] = (counters[key] || 0) + 1; return counters[key]; },
        async expire() { return 1; },
        async keys(pattern) {
            const prefix = pattern.replace(/\*$/, '');
            return [...new Set([...Object.keys(docs), ...Object.keys(kv)])].filter((k) => k.startsWith(prefix));
        },
        async sAdd(key, m) { const s = (sets[key] ||= new Set()); const arr = Array.isArray(m) ? m : [m]; let n = 0; for (const x of arr) { if (!s.has(x)) { s.add(x); n++; } } return n; },
        async sMembers(key) { return [...(sets[key] || [])]; },
        async sRem(key, m) { if (sets[key]) sets[key].delete(m); return 1; },
        async sIsMember(key, m) { return !!(sets[key] && sets[key].has(m)); },
        async lPush(key, val) { (lists[key] ||= []).unshift(val); return lists[key].length; },
        async blPop(key) { const a = lists[key] || []; return a.length ? { key, element: a.shift() } : null; },
        async zAdd(key, { score, value }) { (zsets[key] ||= new Map()).set(value, score); return 1; },
        async zRem(key, value) { const m = zsets[key]; if (m && m.has(value)) { m.delete(value); return 1; } return 0; },
        async zRangeByScore(key, min, max) { const m = zsets[key] || new Map(); return [...m.entries()].filter(([, s]) => s >= min && s <= max).map(([v]) => v); },
        async xAdd() { return '0-1'; },     // runner emits EVENT:WORKFLOW:* — accept + drop
        duplicate() { return api; },        // no watch() → optimistic CAS degrades cleanly
        async connect() {},
    };
    return api;
}

const byName = Object.fromEntries(introspection.map((m) => [m.name, m]));
const method = (n) => byName[n];

// A valid workflow.create payload (no steps that call out → run() can complete hermetically).
function wfPayload(overrides = {}) {
    return {
        category: { type: 'process' },
        name: 'Contract WF',
        desc: 'a workflow for the return-contract test',
        steps: [],
        ...overrides,
    };
}

describe('orchestrator — handler returns satisfy declared returns_schema', () => {
    let redis, workflow, run, runner, worker, control, category;
    beforeEach(() => {
        redis = makeFakeRedis();
        workflow = createWorkflow(redis, { serviceName: 'orchestrator' });
        run = createRun(redis);
        runner = createRunner(redis, { serviceName: 'orchestrator', routerUrl: 'http://router.invalid/jsonrpc' });
        worker = createWorker(redis, { relay: { async getToken() { return 't'; }, async call() {} }, runner, run });
        control = createControl(redis);
        category = createCategory(redis, { serviceName: 'orchestrator', routerUrl: 'http://router.invalid/jsonrpc' });
    });

    // ── workflow.* ────────────────────────────────────────────────────────────
    test('workflow.create → WORKFLOW_DOC (PENDING_REVIEW, risk classified)', async () => {
        const wf = await workflow.create(wfPayload(), 'uid-admin', { isAdmin: true });
        expect(checkReturn(method('orchestrator.workflow.create'), wf)).toEqual([]);
        expect(wf.status).toBe('PENDING_REVIEW');
        expect(wf.version).toBe(1);
        expect(typeof wf.risk_level).toBe('string');
    });

    test('workflow.get → WORKFLOW_DOC', async () => {
        const created = await workflow.create(wfPayload(), 'uid-admin', { isAdmin: true });
        const got = await workflow.get({ id: created.id });
        expect(checkReturn(method('orchestrator.workflow.get'), got)).toEqual([]);
    });

    test('workflow.list → { items, total, limit, offset }', async () => {
        await workflow.create(wfPayload(), 'uid-admin', { isAdmin: true });
        const res = await workflow.list({});
        expect(checkReturn(method('orchestrator.workflow.list'), res)).toEqual([]);
        expect(Array.isArray(res.items)).toBe(true);
    });

    test('workflow.update → WORKFLOW_DOC (version bumped)', async () => {
        const created = await workflow.create(wfPayload(), 'uid-admin', { isAdmin: true });
        const updated = await workflow.update({ id: created.id, name: 'renamed' });
        expect(checkReturn(method('orchestrator.workflow.update'), updated)).toEqual([]);
        expect(updated.version).toBe(created.version + 1);
    });

    test('workflow.delete → { success } (soft-delete path) AND { success, message } (idempotent path)', async () => {
        const created = await workflow.create(wfPayload(), 'uid-admin', { isAdmin: true });
        const del1 = await workflow.delete({ id: created.id });
        expect(checkReturn(method('orchestrator.workflow.delete'), del1)).toEqual([]);
        const del2 = await workflow.delete({ id: created.id });        // already-deleted early-return
        expect(checkReturn(method('orchestrator.workflow.delete'), del2)).toEqual([]);
        expect(del2.message).toBeDefined();
    });

    test('workflow.restore → { success, workflow } (restore path) AND { success, message } (idempotent)', async () => {
        const created = await workflow.create(wfPayload(), 'uid-admin', { isAdmin: true });
        await workflow.delete({ id: created.id });
        const restored = await workflow.restore({ id: created.id });
        expect(checkReturn(method('orchestrator.workflow.restore'), restored)).toEqual([]);
        expect(restored.workflow.status).toBe('PENDING_REVIEW');
        const again = await workflow.restore({ id: created.id });      // already PENDING_REVIEW
        expect(checkReturn(method('orchestrator.workflow.restore'), again)).toEqual([]);
        expect(again.message).toBeDefined();
    });

    test('workflow.deny → { success, workflow } (REJECTED)', async () => {
        const created = await workflow.create(wfPayload(), 'uid-sub', { isAdmin: true });
        const denied = await workflow.deny({ id: created.id, reason: 'no' }, 'uid-reviewer');
        expect(checkReturn(method('orchestrator.workflow.deny'), denied)).toEqual([]);
        expect(denied.workflow.status).toBe('REJECTED');
    });

    test('workflow.approve → { success, lane:C1, workflow } (LOW-risk fast lane)', async () => {
        // empty footprint ⇒ LOW risk ⇒ no relay/approval service needed.
        const created = await workflow.create(wfPayload(), 'uid-submitter', { isAdmin: true });
        const approved = await workflow.approve({ id: created.id }, 'uid-approver');
        expect(checkReturn(method('orchestrator.workflow.approve'), approved)).toEqual([]);
        expect(approved.success).toBe(true);
        expect(approved.lane).toBe('C1');
        expect(approved.workflow.status).toBe('ACTIVE');
    });

    test('workflow.build → { success, count, key, timestamp }', async () => {
        await workflow.create(wfPayload(), 'uid-admin', { isAdmin: true });
        const built = await workflow.build();
        expect(checkReturn(method('orchestrator.workflow.build'), built)).toEqual([]);
    });

    test('workflow.snapshot → { items, timestamp } (empty + populated)', async () => {
        const empty = await workflow.getSnapshot({});
        expect(checkReturn(method('orchestrator.workflow.snapshot'), empty)).toEqual([]);
        await workflow.create(wfPayload(), 'uid-admin', { isAdmin: true });
        await workflow.build();
        const populated = await workflow.getSnapshot({});
        expect(checkReturn(method('orchestrator.workflow.snapshot'), populated)).toEqual([]);
    });

    test('workflow.version → { id, currentVersion } (no arg) AND WORKFLOW_DOC snapshot (with arg)', async () => {
        const created = await workflow.create(wfPayload(), 'uid-admin', { isAdmin: true });
        const cur = await workflow.getVersion({ id: created.id });
        expect(checkReturn(method('orchestrator.workflow.version'), cur)).toEqual([]);
        expect(cur.currentVersion).toBe(1);
        const snap = await workflow.getVersion({ id: created.id, version: 1 });
        expect(checkReturn(method('orchestrator.workflow.version'), snap)).toEqual([]);
    });

    test('workflow.categories → BARE ARRAY (no object-key contract declared)', async () => {
        await workflow.create(wfPayload(), 'uid-admin', { isAdmin: true });
        const cats = await workflow.categories();
        expect(Array.isArray(cats)).toBe(true);
        // No returns_schema/returns → checkReturn has nothing to assert (must NOT false-fail).
        expect(checkReturn(method('orchestrator.workflow.categories'), cats)).toEqual([]);
    });

    // ── workflow.run / orchestrator.run (zero-step ACTIVE workflow, no caller → no RPC) ──
    test('workflow.run → completed terminal shape (zero steps, no footprint)', async () => {
        const created = await workflow.create(wfPayload({ steps: [] }), 'uid-sub', { isAdmin: true });
        await workflow.approve({ id: created.id }, 'uid-approver');   // → ACTIVE
        const res = await runner.run({ workflowId: created.id, input: {} }, {}, null);
        expect(res.status).toBe('completed');
        expect(checkReturn(method('orchestrator.workflow.run'), res)).toEqual([]);
        expect(checkReturn(method('orchestrator.run'), res)).toEqual([]);   // alias
    });

    // ── run.* ───────────────────────────────────────────────────────────────────
    test('run.enqueue → run-command shape', async () => {
        const cmd = await worker.enqueue({ workflowId: 'wf_x', triggerSource: 'event' });
        expect(checkReturn(method('orchestrator.run.enqueue'), cmd)).toEqual([]);
    });

    test('run.get → RUN_DOC', async () => {
        await run.create({ runId: 'run_g1', workflowId: 'wf_x', triggerSource: 'event' });
        const got = await run.get('run_g1');
        expect(checkReturn(method('orchestrator.run.get'), got)).toEqual([]);
    });

    test('run.list → BARE ARRAY (no object-key contract declared)', async () => {
        await run.create({ runId: 'run_l1', workflowId: 'wf_x', triggerSource: 'event' });
        const list = await run.list({});
        expect(Array.isArray(list)).toBe(true);
        expect(checkReturn(method('orchestrator.run.list'), list)).toEqual([]);
    });

    test('run.abort → RUN_DOC (ABORTED)', async () => {
        await run.create({ runId: 'run_a1', workflowId: 'wf_x', triggerSource: 'event' });
        await run.pause('run_a1', { missingMethods: ['x.y'] });
        const aborted = await run.abort({ id: 'run_a1', abortedBy: 'uid-admin', reason: 'no' });
        expect(checkReturn(method('orchestrator.run.abort'), aborted)).toEqual([]);
        expect(aborted.status).toBe('ABORTED');
    });

    test('run.grant → index.js wrapper { ok, runId, status } (NOT the bare run doc)', async () => {
        await run.create({ runId: 'run_gr1', workflowId: 'wf_x', triggerSource: 'event' });
        await run.pause('run_gr1', { missingMethods: ['x.y'] });
        const { run: updated } = await run.grant({ id: 'run_gr1', methods: ['x.y'], grantedBy: 'uid-admin' });
        // Reproduce the index.js handler wrapper — THAT is the wire contract for run.grant.
        const wire = { ok: true, runId: updated.id, status: updated.status };
        expect(checkReturn(method('orchestrator.run.grant'), wire)).toEqual([]);
        expect(wire.status).toBe('RESUMING');
    });

    // ── control.* ────────────────────────────────────────────────────────────────
    test('control.pause / resume / status → { paused }', async () => {
        const paused = await control.pause();
        expect(checkReturn(method('orchestrator.control.pause'), paused)).toEqual([]);
        expect(paused.paused).toBe(true);
        const resumed = await control.resume();
        expect(checkReturn(method('orchestrator.control.resume'), resumed)).toEqual([]);
        expect(resumed.paused).toBe(false);
        const status = await control.status();
        expect(checkReturn(method('orchestrator.control.status'), status)).toEqual([]);
    });

    // ── category.* (seed the doc directly — create/delete need a Router RPC) ───────
    test('category.get → CATEGORY_DOC', async () => {
        await seedCategory(redis, 'TYPE');
        const got = await category.get({ key: 'TYPE' });
        expect(checkReturn(method('orchestrator.category.get'), got)).toEqual([]);
    });

    test('category.update → CATEGORY_DOC', async () => {
        await seedCategory(redis, 'TYPE');
        const updated = await category.update({ key: 'TYPE', desc: 'new desc' });
        expect(checkReturn(method('orchestrator.category.update'), updated)).toEqual([]);
    });

    test('category.list → BARE ARRAY (no object-key contract declared)', async () => {
        await seedCategory(redis, 'TYPE');
        const list = await category.list({});
        expect(Array.isArray(list)).toBe(true);
        expect(checkReturn(method('orchestrator.category.list'), list)).toEqual([]);
    });

    test('category.item.add → CATEGORY_ITEM, item.get → CATEGORY_ITEM, then item.update → CATEGORY_ITEM, then item.remove → { success }', async () => {
        await seedCategory(redis, 'TYPE');
        const added = await category.addItem({ key: 'TYPE', id: 'foo', label: { en: 'Foo' }, desc: 'd' });
        expect(checkReturn(method('orchestrator.category.item.add'), added)).toEqual([]);
        const got = await category.getItem({ key: 'TYPE', id: 'foo' });
        expect(checkReturn(method('orchestrator.category.item.get'), got)).toEqual([]);
        const upd = await category.updateItem({ key: 'TYPE', id: 'foo', desc: 'd2' });
        expect(checkReturn(method('orchestrator.category.item.update'), upd)).toEqual([]);
        const rem = await category.removeItem({ key: 'TYPE', id: 'foo' });
        expect(checkReturn(method('orchestrator.category.item.remove'), rem)).toEqual([]);
    });
});

// Seed a category doc the way library/category.create would persist it, but WITHOUT the
// Router reservation RPC (so the test stays hermetic). Mirrors the create() doc shape.
async function seedCategory(redis, key) {
    const SERVICE_UPPER = 'ORCHESTRATOR';
    const now = Date.now();
    const data = { key, type: 'LIST', scope: 'LOCAL', desc: 'seed', meta: {}, items: [], status: 'ACTIVE', createdAt: now, updatedAt: now };
    await redis.set(`${SERVICE_UPPER}:CONFIG:CATEGORY:${key}`, JSON.stringify(data));
    await redis.sAdd(`${SERVICE_UPPER}:CONFIG:CATEGORY_IDX`, `${SERVICE_UPPER}:CONFIG:CATEGORY:${key}`);
}
