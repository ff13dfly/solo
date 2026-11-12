/**
 * Fulfillment Service — Unit Tests (hermetic, mock Redis).
 */
process.env.CLOCK_TEST_MODE = 'true';

const clock          = require('../../../library/clock');
const createLogic    = require('../logic');
const introspection  = require('../handlers/introspection');
const entities       = require('../handlers/entities');
const config         = require('../config');
const { PROFILE_ID, MOCK_PROFILE, MOCK_REQ } = require('./utils/mock_data');

// --- Mock Redis ---

function createMockRedis() {
    const store = {};
    const sets  = {};
    const zsets = {};
    const counters = {};
    return {
        async set(key, val, opts) {
            if (opts && opts.NX && store[key] !== undefined) return null;
            store[key] = val;
            return 'OK';
        },
        async get(key)            { return store[key] || null; },
        async sAdd(key, val)      { if (!sets[key]) sets[key] = new Set(); sets[key].add(val); },
        async sMembers(key)       { return sets[key] ? [...sets[key]] : []; },
        async sCard(key)          { return sets[key] ? sets[key].size : 0; },
        async mGet(keys)          { return keys.map(k => store[k] || null); },
        async exists(key)         { return store[key] ? 1 : 0; },
        async del(key)            { delete store[key]; },
        async sRem(key, val)      { if (sets[key]) sets[key].delete(val); },
        async incr(key)           { counters[key] = (counters[key] || 0) + 1; return counters[key]; },
        async zAdd(key, { score, value }) { if (!zsets[key]) zsets[key] = new Map(); zsets[key].set(value, score); return 1; },
        async zRem(key, val)      { if (zsets[key]) zsets[key].delete(val); },
        async zCard(key)          { return zsets[key] ? zsets[key].size : 0; },
        async watch()             { return 'OK'; },
        async unwatch()           { return 'OK'; },
        multi() {
            const ops = [];
            const pipeline = {
                set(key, val)    { ops.push(() => { store[key] = val; }); return pipeline; },
                sAdd(key, val)   { ops.push(() => { if (!sets[key]) sets[key] = new Set(); sets[key].add(val); }); return pipeline; },
                sRem(key, val)   { ops.push(() => { if (sets[key]) sets[key].delete(val); }); return pipeline; },
                zAdd(key, { score, value }) { ops.push(() => { if (!zsets[key]) zsets[key] = new Map(); zsets[key].set(value, score); }); return pipeline; },
                zRem(key, val)   { ops.push(() => { if (zsets[key]) zsets[key].delete(val); }); return pipeline; },
                del(key)         { ops.push(() => { delete store[key]; }); return pipeline; },
                async exec()     { ops.forEach(op => op()); return []; }
            };
            return pipeline;
        }
    };
}

// A minimal state-machine profile for the transition/専用-op tests.
const SM_ID = 'sm-test';
const SM_PROFILE = {
    id: SM_ID,
    name: 'state machine test',
    status: 'ACTIVE',
    transitions: [
        { event: 'start',            from: 'DRAFT',      to: 'PROCESSING', condition: null, actions: [] },
        { event: 'hold_requested',   from: 'PROCESSING', to: 'ON_HOLD',    condition: null, actions: [] },
        { event: 'cancel_requested', from: 'PROCESSING', to: 'CANCELLED',  condition: null, actions: [] },
        { event: 'confirm',          from: 'PROCESSING', to: 'CONFIRMED',
          condition: { '==': [{ var: 'instance.meta.approved' }, true] }, actions: [] },
        // 数值闸门：两个字段都从 meta 取。docs/feedback/fulfillment-condition-fail-open.md
        { event: 'release',          from: 'PROCESSING', to: 'RELEASED',
          condition: { '>=': [{ var: 'instance.meta.balance' }, { var: 'instance.meta.threshold' }] }, actions: [] },
    ],
};

const ADMIN_REQ = { user: 'admin-tester', permit: 'admin', constraints: null };

// --- Test Setup ---

let redis;
let logic;

beforeEach(() => {
    redis = createMockRedis();
    logic = createLogic(redis, config);
});

// ============================================================
// INSTANCE — lifecycle + transition state machine
// ============================================================

describe('fulfillment.instance', () => {

    beforeEach(async () => {
        await redis.set(`${config.redis.profilePrefix}${PROFILE_ID}`, JSON.stringify({ ...MOCK_PROFILE, status: 'ACTIVE' }));
        await redis.set(`${config.redis.profilePrefix}${SM_ID}`, JSON.stringify(SM_PROFILE));
    });

    test('create — returns instance in DRAFT state', async () => {
        const result = await logic.instance.create({ sourceId: 'ORD-001', profileId: PROFILE_ID }, MOCK_REQ);
        expect(result.state).toBe('DRAFT');
        expect(result.id).toMatch(/^FL-/);
        expect(result.sourceId).toBe('ORD-001');
        expect(result.history).toHaveLength(1);
    });

    test('create — throws on missing sourceId / profileId', async () => {
        await expect(logic.instance.create({ profileId: PROFILE_ID }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });
        await expect(logic.instance.create({ sourceId: 'ORD-001' }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });
    });

    test('get — retrieves a created instance; NOT_FOUND otherwise', async () => {
        const created = await logic.instance.create({ sourceId: 'ORD-002', profileId: PROFILE_ID }, MOCK_REQ);
        expect((await logic.instance.get({ id: created.id })).id).toBe(created.id);
        await expect(logic.instance.get({ id: 'FL-ABSENT-9999' })).rejects.toMatchObject({ code: -32002 });
    });

    test('list — returns + filters by state', async () => {
        await logic.instance.create({ sourceId: 'ORD-003', profileId: PROFILE_ID }, MOCK_REQ);
        await logic.instance.create({ sourceId: 'ORD-004', profileId: PROFILE_ID }, MOCK_REQ);
        const all = await logic.instance.list();
        expect(all.total).toBe(2);
        expect((await logic.instance.list({ state: 'DRAFT' })).items.every(i => i.state === 'DRAFT')).toBe(true);
    });

    test('transition — event DRAFT → DEPOSIT_PENDING records prevState + history', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-006', profileId: PROFILE_ID }, MOCK_REQ);
        const result = await logic.instance.transition({ id: inst.id, event: 'order_submitted' }, MOCK_REQ);
        expect(result.state).toBe('DEPOSIT_PENDING');
        expect(result.prevState).toBe('DRAFT');
        expect(result.history).toHaveLength(2);
        expect(result.history[1].event).toBe('order_submitted');
        expect(result.history[1].transition_id).toBeTruthy();
    });

    test('transition — emits idempotency-keyed _tasks from the matched rule actions', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-007', profileId: PROFILE_ID }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'order_submitted' }, MOCK_REQ);
        const result = await logic.instance.transition({ id: inst.id, event: 'payment_received' }, MOCK_REQ);
        expect(result.state).toBe('DEPOSIT_CONFIRMED');
        expect(result._tasks).toHaveLength(1);
        expect(result._tasks[0].method).toBe('erp.order.sync');
        expect(result._tasks[0].service).toBe('erp');   // derived from the method namespace
        expect(result._tasks[0].params.sourceId).toBe('ORD-007');
        expect(result._tasks[0].params.idempotency_key).toMatch(/-T\d+:A0$/);
        expect(result._tasks[0].transition_id).toBe(result._tasks[0].params.idempotency_key.split(':')[0]);
    });

    test('transition — rejects an event not defined from the current state', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-008', profileId: PROFILE_ID }, MOCK_REQ);
        await expect(logic.instance.transition({ id: inst.id, event: 'nonexistent' }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });
    });

    test('transition — rejected when the JsonLogic condition is not met', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-009', profileId: SM_ID }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);   // → PROCESSING
        // confirm requires meta.approved === true (not set) → rejected, state unchanged
        await expect(logic.instance.transition({ id: inst.id, event: 'confirm' }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });
        expect((await logic.instance.get({ id: inst.id })).state).toBe('PROCESSING');
    });

    // 数值比较缺字段必须拦住（fail-closed）。此前 `null >= null` 求值为 true，
    // 「余额 ≥ 阈值才放行」在没喂数据时无条件放行。docs/feedback/fulfillment-condition-fail-open.md §一
    test('transition — numeric condition with BOTH operands missing is rejected (fail-closed, was fail-open)', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-FC1', profileId: SM_ID }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);
        await expect(logic.instance.transition({ id: inst.id, event: 'release' }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });
        expect((await logic.instance.get({ id: inst.id })).state).toBe('PROCESSING');
    });

    test('transition — numeric condition with ONE operand missing is rejected', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-FC2', profileId: SM_ID, meta: { balance: 100 } }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);
        await expect(logic.instance.transition({ id: inst.id, event: 'release' }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });
    });

    test('transition — numeric condition passes once both fields are supplied (0 counts as present)', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-FC3', profileId: SM_ID }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);
        // threshold 0 is a real value, not "missing" — 5 >= 0 → RELEASED
        const ok = await logic.instance.transition({ id: inst.id, event: 'release', metaUpdate: { balance: 5, threshold: 0 } }, MOCK_REQ);
        expect(ok.state).toBe('RELEASED');
    });

    test('transition — numeric condition still rejects when supplied values genuinely fail', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-FC4', profileId: SM_ID, meta: { balance: 1, threshold: 10 } }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);
        await expect(logic.instance.transition({ id: inst.id, event: 'release' }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });
    });

    test('transition — metaUpdate is merged BEFORE the condition is evaluated', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-010', profileId: SM_ID, meta: { approved: false } }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);
        const ok = await logic.instance.transition({ id: inst.id, event: 'confirm', metaUpdate: { approved: true } }, MOCK_REQ);
        expect(ok.state).toBe('CONFIRMED');
        expect(ok.meta.approved).toBe(true);
    });

    // create/update take `meta`, so callers write `meta` on transition too — and it used
    // to vanish without a word (undeclared params are neither rejected nor logged), taking
    // the attached data with it. `meta` is now an accepted alias.
    // docs/feedback/done/fulfillment-transition-metaupdate-naming-trap.md
    test('transition — `meta` works as an alias for metaUpdate (same merge semantics)', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-010b', profileId: SM_ID, meta: { approved: false, keep: 'me' } }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);
        const ok = await logic.instance.transition({ id: inst.id, event: 'confirm', meta: { approved: true } }, MOCK_REQ);
        expect(ok.state).toBe('CONFIRMED');          // gate saw the aliased value BEFORE evaluating
        expect(ok.meta).toMatchObject({ approved: true, keep: 'me' });   // merged, not replaced
    });

    test('transition — metaUpdate wins when both names are supplied', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-010c', profileId: SM_ID, meta: { approved: false } }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);
        const ok = await logic.instance.transition(
            { id: inst.id, event: 'confirm', metaUpdate: { approved: true, via: 'canonical' }, meta: { via: 'alias' } }, MOCK_REQ);
        expect(ok.meta.via).toBe('canonical');
    });

    test('update — merges meta without dropping existing keys', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-011', profileId: PROFILE_ID, meta: { a: 1 } }, MOCK_REQ);
        const updated = await logic.instance.update({ id: inst.id, meta: { b: 2 } });
        expect(updated.meta).toEqual({ a: 1, b: 2 });
    });

    // instance.meta is an overwriting merge with no history — without meta_update on the
    // history entry, "what did the guard read when it branched HERE" is unanswerable as soon
    // as a later hop rewrites the key (feedback/done/fulfillment-meta-write-leaves-no-trace.md).
    test('transition — history entry carries the metaUpdate the guard evaluated', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-011b', profileId: PROFILE_ID }, MOCK_REQ);
        const result = await logic.instance.transition(
            { id: inst.id, event: 'order_submitted', metaUpdate: { confidence: 0.55 } }, MOCK_REQ);
        expect(result.history[1].meta_update).toEqual({ confidence: 0.55 });
        // the later value overwrites instance.meta, but the earlier hop keeps its own copy
        expect(result.history[0].meta_update).toBeUndefined();   // no payload → key omitted
    });

    test('update — stamps updatedBy from req and refuses a caller-supplied one', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-011c', profileId: PROFILE_ID }, MOCK_REQ);
        const updated = await logic.instance.update({ id: inst.id, meta: { b: 2 }, updatedBy: 'uid-forged' }, MOCK_REQ);
        expect(updated.updatedBy).toBe(MOCK_REQ.user);
        expect(updated.updatedAt).toBeTruthy();
        // un-authenticated path stays legal (null, not a throw) — probes may call without req
        const anon = await logic.instance.update({ id: inst.id, meta: { c: 3 } });
        expect(anon.updatedBy).toBeNull();
    });

    test('list — filters by profileId and stateChangedBefore', async () => {
        const inst1 = await logic.instance.create({ sourceId: 'ORD-L1', profileId: PROFILE_ID }, MOCK_REQ);
        const inst2 = await logic.instance.create({ sourceId: 'ORD-L2', profileId: SM_ID }, MOCK_REQ);

        // Manually backdate inst1.stateChangedAt to simulate a stale instance
        const staleTs = Date.now() - 600_000;
        const stored1 = JSON.parse(await redis.get(`${config.redis.instancePrefix}${inst1.id}`));
        stored1.stateChangedAt = staleTs;
        await redis.set(`${config.redis.instancePrefix}${inst1.id}`, JSON.stringify(stored1));

        const byProfile = await logic.instance.list({ profileId: SM_ID });
        expect(byProfile.total).toBe(1);
        expect(byProfile.items[0].id).toBe(inst2.id);

        const staleOnly = await logic.instance.list({ stateChangedBefore: staleTs + 1000 });
        expect(staleOnly.total).toBe(1);
        expect(staleOnly.items[0].id).toBe(inst1.id);
    });

    test('transition & update — expectedTransitionId prevents ABA stale callback races in self-healing loops', async () => {
        const loopProfile = {
            id: 'loop-test',
            name: 'Self-healing loop test',
            status: 'ACTIVE',
            transitions: [
                { event: 'start_task',      from: 'DRAFT',          to: 'EXECUTING_TASK', condition: null, actions: [] },
                { event: 'task_failed',     from: 'EXECUTING_TASK', to: 'needs_assist',   condition: null, actions: [] },
                { event: 'assist_resolved', from: 'needs_assist',   to: 'EXECUTING_TASK', condition: null, actions: [] },
                { event: 'task_done',       from: 'EXECUTING_TASK', to: 'COMPLETED',      condition: null, actions: [] },
            ],
        };
        await redis.set(`${config.redis.profilePrefix}loop-test`, JSON.stringify(loopProfile));

        const inst = await logic.instance.create({ sourceId: 'ORD-ABA', profileId: 'loop-test' }, MOCK_REQ);
        // Round 1: DRAFT → EXECUTING_TASK (T2)
        const r1 = await logic.instance.transition({ id: inst.id, event: 'start_task' }, MOCK_REQ);
        const round1Tid = r1.history.at(-1).transition_id;
        expect(round1Tid).toBe(`${inst.id}-T2`);

        // Sentinel moves it to needs_assist (T3) and resolves back to EXECUTING_TASK (T4)
        await logic.instance.transition({ id: inst.id, event: 'task_failed', expectedTransitionId: round1Tid }, MOCK_REQ);
        const r2 = await logic.instance.transition({ id: inst.id, event: 'assist_resolved' }, MOCK_REQ);
        const round2Tid = r2.history.at(-1).transition_id;
        expect(r2.state).toBe('EXECUTING_TASK');
        expect(round2Tid).toBe(`${inst.id}-T4`);

        // Late callback from Round 1 tries to transition or update using stale round1Tid → REJECTED
        await expect(
            logic.instance.transition({
                id: inst.id,
                event: 'task_failed',
                metaUpdate: { error: 'Job-A late timeout' },
                expectedTransitionId: round1Tid,
            }, MOCK_REQ)
        ).rejects.toMatchObject({ code: -32602 });

        await expect(
            logic.instance.update({
                id: inst.id,
                meta: { dirty: 'from-round-1' },
                expectedTransitionId: round1Tid,
            }, MOCK_REQ)
        ).rejects.toMatchObject({ code: -32602 });

        // Instance remains untouched in Round 2's EXECUTING_TASK state
        const current = await logic.instance.get({ id: inst.id });
        expect(current.state).toBe('EXECUTING_TASK');
        expect(current.meta.error).toBeUndefined();
        expect(current.meta.dirty).toBeUndefined();

        // Round 2 callback with matching round2Tid succeeds
        const updatedR2 = await logic.instance.update({
            id: inst.id,
            meta: { attempt: 2 },
            expectedTransitionId: round2Tid,
        }, MOCK_REQ);
        expect(updatedR2.meta.attempt).toBe(2);

        const done = await logic.instance.transition({
            id: inst.id,
            event: 'task_done',
            expectedTransitionId: round2Tid,
        }, MOCK_REQ);
        expect(done.state).toBe('COMPLETED');
    });
});

// ============================================================
// INSTANCE — dedicated operations (cancel / hold / resume / override)
// ============================================================

describe('fulfillment.instance — dedicated operations', () => {

    beforeEach(async () => {
        await redis.set(`${config.redis.profilePrefix}${SM_ID}`, JSON.stringify(SM_PROFILE));
    });

    const newProcessing = async (sourceId) => {
        const inst = await logic.instance.create({ sourceId, profileId: SM_ID }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);
        return inst.id;
    };

    test('cancel — writes the reason to meta and fires cancel_requested', async () => {
        const id = await newProcessing('ORD-C1');
        const res = await logic.instance.cancel({ id, reason: 'customer changed mind' }, MOCK_REQ);
        expect(res.state).toBe('CANCELLED');
        expect(res.meta.cancel_reason).toBe('customer changed mind');
        await expect(logic.instance.cancel({ id, reason: '' }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });
    });

    test('hold → resume — pause to ON_HOLD then restore prevState, emitting EVENT:FULFILLMENT:TRANSITIONED and recording trace', async () => {
        const emitted = [];
        const mockRelay = {
            call: jest.fn(async (method, payload) => {
                emitted.push({ method, payload });
                return { ok: true };
            }),
        };
        const logicWithRelay = createLogic(redis, config, { relay: mockRelay });
        const { walContext } = require('../../../library/entity');

        const inst = await logicWithRelay.instance.create({ sourceId: 'ORD-H1', profileId: SM_ID }, MOCK_REQ);
        await logicWithRelay.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);
        const id = inst.id;

        const held = await logicWithRelay.instance.hold({ id, reason: 'supplier delay', expectedResume: '2026-07-01' }, MOCK_REQ);
        expect(held.state).toBe('ON_HOLD');
        expect(held.prevState).toBe('PROCESSING');
        expect(held.meta.hold_reason).toBe('supplier delay');

        emitted.length = 0;
        const resumed = await walContext.run({ trace: 'trace-resume-001' }, () =>
            logicWithRelay.instance.resume({ id }, MOCK_REQ)
        );
        expect(resumed.state).toBe('PROCESSING');
        const lastEntry = resumed.history[resumed.history.length - 1];
        expect(lastEntry.event).toBe('resume');
        expect(lastEntry.trace).toBe('trace-resume-001');

        expect(emitted).toHaveLength(1);
        expect(emitted[0].method).toBe('event.emit');
        expect(emitted[0].payload).toMatchObject({
            stream: 'EVENT:FULFILLMENT:TRANSITIONED',
            type:   'instance.transitioned',
            actor:  `fulfillment:${id}`,
            payload: {
                instanceId:   id,
                profileId:    SM_ID,
                sourceId:     'ORD-H1',
                fromState:    'ON_HOLD',
                toState:      'PROCESSING',
                event:        'resume',
                transitionId: lastEntry.transition_id,
                user:         MOCK_REQ.user,
            },
        });
    });

    test('override — admin force-advances past a failing condition; non-admin is forbidden', async () => {
        const id = await newProcessing('ORD-O1');
        // condition (approved===true) fails for a normal transition
        await expect(logic.instance.transition({ id, event: 'confirm' }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });
        // non-admin override is forbidden
        await expect(logic.instance.override({ id, event: 'confirm', reason: 'x' }, MOCK_REQ)).rejects.toMatchObject({ code: -32005 });
        // admin override skips the condition and marks the history entry forced
        const forced = await logic.instance.override({ id, event: 'confirm', reason: 'manual sign-off' }, ADMIN_REQ);
        expect(forced.state).toBe('CONFIRMED');
        const last = forced.history[forced.history.length - 1];
        expect(last.forced).toBe(true);
        expect(last.reason).toBe('manual sign-off');
    });

    test('resume enforces profile activation gate when profile is PENDING_REVIEW or REJECTED', async () => {
        const id = await newProcessing('ORD-R-GATE');
        await logic.instance.hold({ id, reason: 'pause' }, MOCK_REQ);
        await redis.set(`${config.redis.profilePrefix}${SM_ID}`, JSON.stringify({ ...SM_PROFILE, reviewState: 'PENDING_REVIEW' }));
        await expect(logic.instance.resume({ id }, MOCK_REQ)).rejects.toMatchObject({ code: -32005 });
    });

    test('resume — rejects non-held instances, prevents double-resume oscillation, and enforces expectedTransitionId', async () => {
        const id = await newProcessing('ORD-R-STRICT');
        // Not held (last event is 'start', not 'hold_requested') → rejected
        await expect(logic.instance.resume({ id }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });

        // Cancelled terminal state → rejected
        const cancelId = await newProcessing('ORD-R-CANCEL');
        await logic.instance.cancel({ id: cancelId, reason: 'cancelled' }, MOCK_REQ);
        await expect(logic.instance.resume({ id: cancelId }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });

        // Hold → resume with stale expectedTransitionId rejected; matching expectedTransitionId succeeds; second consecutive resume rejected
        const held = await logic.instance.hold({ id, reason: 'pause' }, MOCK_REQ);
        const holdTid = held.history.at(-1).transition_id;
        await expect(logic.instance.resume({ id, expectedTransitionId: 'stale-tid' }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });

        const resumed = await logic.instance.resume({ id, expectedTransitionId: holdTid }, MOCK_REQ);
        expect(resumed.state).toBe('PROCESSING');
        await expect(logic.instance.resume({ id }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });
    });

    test('concurrent transitions with the same expectedTransitionId are serialized so only one succeeds (no TOCTOU lost update)', async () => {
        const id = await newProcessing('ORD-TOCTOU');
        const current = await logic.instance.get({ id }, MOCK_REQ);
        const expectedTid = current.history.at(-1).transition_id;

        const results = await Promise.allSettled([
            logic.instance.transition({ id, event: 'confirm', metaUpdate: { approved: true, winner: 'A' }, expectedTransitionId: expectedTid }, MOCK_REQ),
            logic.instance.transition({ id, event: 'cancel_requested', metaUpdate: { cancel_reason: 'B' }, expectedTransitionId: expectedTid }, MOCK_REQ),
        ]);

        const fulfilled = results.filter(r => r.status === 'fulfilled');
        const rejected  = results.filter(r => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason.code).toBe(-32602);
    });

    test('soft-deleted profile (status: DELETED) cannot be used to create, transition, or resume instances', async () => {
        const softProfile = await logic.profile.create({
            id: 'soft_del_prof',
            name: 'Soft Delete Test',
            transitions: [
                { event: 'start', from: 'DRAFT', to: 'PROCESSING', condition: null, actions: [] },
                { event: 'hold_requested', from: 'PROCESSING', to: 'ON_HOLD', condition: null, actions: [] },
            ],
        });
        const inst = await logic.instance.create({ sourceId: 'ORD-SD-1', profileId: softProfile.id }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);
        await logic.instance.hold({ id: inst.id, reason: 'pause before profile delete' }, MOCK_REQ);

        await logic.profile.delete({ id: softProfile.id });

        await expect(logic.instance.create({ sourceId: 'ORD-SD-2', profileId: softProfile.id }, MOCK_REQ)).rejects.toMatchObject({ code: -32002 });
        await expect(logic.instance.resume({ id: inst.id }, MOCK_REQ)).rejects.toMatchObject({ code: -32002 });

        await logic.profile.restore({ id: softProfile.id });
        const resumed = await logic.instance.resume({ id: inst.id }, MOCK_REQ);
        expect(resumed.state).toBe('PROCESSING');
    });

    test('instance key validation rejects colons, whitespace, and control characters; update ignores non-meta top-level fields; $owner scope isolates instances', async () => {
        await expect(logic.instance.get({ id: 'bad:key' }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });
        await expect(logic.instance.get({ id: 'bad key' }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });

        const ownerA = { user: 'u-a', permit: 'user', constraints: { $owner: { field: 'createdBy', value: 'u-a' } } };
        const ownerB = { user: 'u-b', permit: 'user', constraints: { $owner: { field: 'createdBy', value: 'u-b' } } };

        const instA = await logic.instance.create({ sourceId: 'ORD-OWN-A', profileId: SM_ID, meta: { k: 1 } }, ownerA);
        await expect(logic.instance.get({ id: instA.id }, ownerB)).rejects.toMatchObject({ code: -32002 });
        const listB = await logic.instance.list({}, ownerB);
        expect(listB.items.find(i => i.id === instA.id)).toBeUndefined();

        const updated = await logic.instance.update({
            id: instA.id,
            meta: { k: 2 },
            sourceId: 'FORGED',
            profileId: 'FORGED_PROF',
            createdBy: 'u-b',
            pending_callbacks: ['evil'],
        }, ownerA);
        expect(updated.sourceId).toBe('ORD-OWN-A');
        expect(updated.profileId).toBe(SM_ID);
        expect(updated.createdBy).toBe('u-a');
        expect(updated.pending_callbacks).toEqual([]);
        expect(updated.meta).toEqual({ k: 2 });
    });

    // ── 5 RPA × Fulfillment Convergence Primitives (2026-11-07) ─────────────

    test('create({ idempotent: true }) deduplicates by (profileId, sourceId) within $owner scope', async () => {
        const ownerA = { user: 'u-a', permit: 'user', constraints: { $owner: { field: 'ownerId', value: 'tenant-A' } } };
        const ownerB = { user: 'u-b', permit: 'user', constraints: { $owner: { field: 'ownerId', value: 'tenant-B' } } };

        const first = await logic.instance.create({ sourceId: 'ERP-SYNC-20261107', profileId: SM_ID, idempotent: true }, ownerA);
        expect(first.deduplicated).toBeUndefined();

        const replay = await logic.instance.create({ sourceId: 'ERP-SYNC-20261107', profileId: SM_ID, idempotent: true }, ownerA);
        expect(replay.id).toBe(first.id);
        expect(replay.deduplicated).toBe(true);

        // Different $owner tenant with same sourceId gets its own isolated instance!
        const otherTenant = await logic.instance.create({ sourceId: 'ERP-SYNC-20261107', profileId: SM_ID, idempotent: true }, ownerB);
        expect(otherTenant.id).not.toBe(first.id);
        expect(otherTenant.deduplicated).toBeUndefined();
    });

    test('suspend & resume — enters ASSIST_REQUIRED from any state with checkpoint stack and restores blockedState with resolution + metaUpdate', async () => {
        const created = await logic.instance.create({ sourceId: 'INV-SUSP-1', profileId: SM_ID }, MOCK_REQ);
        const started = await logic.instance.transition({ id: created.id, event: 'start' }, MOCK_REQ);
        expect(started.state).toBe('PROCESSING');

        // Notice SM_PROFILE has NO transition to ASSIST_REQUIRED — suspend works orthogonal to transitions!
        const suspended = await logic.instance.suspend({
            id: created.id,
            reason: '税务局人脸扫码验证拦截',
            reasonCode: 'OTP_REQUIRED',
            checkpoint: { step: 'baiwang_login', pageUrl: 'https://dppt.jiangsu.chinatax.gov.cn' },
            aiSuggestion: '请开票员扫码完成后点击恢复',
            metaUpdate: { screenshotId: 'ast_01' },
            expectedTransitionId: started.history.at(-1).transition_id,
        }, MOCK_REQ);

        expect(suspended.state).toBe('ASSIST_REQUIRED');
        expect(suspended.suspension).toMatchObject({
            blockedState: 'PROCESSING',
            suspendState: 'ASSIST_REQUIRED',
            reasonCode: 'OTP_REQUIRED',
            reason: '税务局人脸扫码验证拦截',
            checkpoint: { step: 'baiwang_login', pageUrl: 'https://dppt.jiangsu.chinatax.gov.cn' },
            aiSuggestion: '请开票员扫码完成后点击恢复',
        });
        expect(suspended.meta.screenshotId).toBe('ast_01');

        // Double suspend rejected
        await expect(logic.instance.suspend({ id: created.id, reason: 'again' }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });

        // Resume with resolution + metaUpdate restores PROCESSING and clears suspension
        const resumed = await logic.instance.resume({
            id: created.id,
            resolution: '开票员已完成扫码登录',
            metaUpdate: { approved: true, authSessionReady: true },
            expectedTransitionId: suspended.history.at(-1).transition_id,
        }, MOCK_REQ);

        expect(resumed.state).toBe('PROCESSING');
        expect(resumed.suspension).toBeNull();
        expect(resumed.meta).toMatchObject({ screenshotId: 'ast_01', approved: true, authSessionReady: true, last_assist_resolution: '开票员已完成扫码登录' });
        expect(resumed.history.at(-1)).toMatchObject({ state: 'PROCESSING', event: 'resume', resolution: '开票员已完成扫码登录' });

        // Can immediately continue normal profile transitions from restored state!
        const confirmed = await logic.instance.transition({ id: created.id, event: 'confirm' }, MOCK_REQ);
        expect(confirmed.state).toBe('CONFIRMED');
    });

    test('stateTtls & instance.reap — automatically transitions expired instances and emits _tasks', async () => {
        const ttlProfileId = 'rpa-ttl-prof';
        await redis.set(`${config.redis.profilePrefix}${ttlProfileId}`, JSON.stringify({
            id: ttlProfileId,
            name: 'RPA TTL Profile',
            status: 'ACTIVE',
            stateTtls: {
                PROCESSING: { ttlMs: 1800000, event: 'timeout_exceeded', reason: 'RPA job stuck > 30m' },
            },
            transitions: [
                { event: 'start', from: 'DRAFT', to: 'PROCESSING', condition: null, actions: [] },
                {
                    event: 'timeout_exceeded',
                    from: 'PROCESSING',
                    to: 'TIMED_OUT',
                    condition: null,
                    actions: [{ service: 'notification', method: 'notification.send', params: { targetId: 'ops', type: 'rpa.timeout' } }],
                },
            ],
        }));

        const t0 = 1_760_000_000_000;
        clock.freeze(t0);
        try {
            const stale = await logic.instance.create({ sourceId: 'JOB-STALE', profileId: ttlProfileId }, MOCK_REQ);
            await logic.instance.transition({ id: stale.id, event: 'start' }, MOCK_REQ);

            clock.freeze(t0 + 600_000); // +10m: fresh instance
            const fresh = await logic.instance.create({ sourceId: 'JOB-FRESH', profileId: ttlProfileId }, MOCK_REQ);
            await logic.instance.transition({ id: fresh.id, event: 'start' }, MOCK_REQ);

            clock.freeze(t0 + 1_800_001); // +30m+1ms: stale is expired, fresh is at 20m

            // Dry run reports without mutating
            const preview = await logic.instance.reap({ profileId: ttlProfileId, dryRun: true }, ADMIN_REQ);
            expect(preview).toMatchObject({ scanned: 2, expired: 1, dryRun: true });
            expect((await logic.instance.get({ id: stale.id })).state).toBe('PROCESSING');

            // Real reap transitions stale → TIMED_OUT and returns _tasks
            const reaped = await logic.instance.reap({ profileId: ttlProfileId }, ADMIN_REQ);
            expect(reaped.expired).toBe(1);
            expect(reaped.reaped).toHaveLength(1);
            expect(reaped.reaped[0]).toMatchObject({ id: stale.id, fromState: 'PROCESSING', toState: 'TIMED_OUT', event: 'timeout_exceeded' });
            expect(reaped._tasks).toHaveLength(1);
            expect((await logic.instance.get({ id: stale.id })).state).toBe('TIMED_OUT');
            expect((await logic.instance.get({ id: fresh.id })).state).toBe('PROCESSING');
        } finally {
            clock.reset();
        }
    });

    test('transition.evidence quality gate — blocks masked values (•••••• / ****), loopback URLs, and low row counts', async () => {
        const evProfileId = 'rpa-evidence-prof';
        await redis.set(`${config.redis.profilePrefix}${evProfileId}`, JSON.stringify({
            id: evProfileId,
            name: 'Evidence Gate Profile',
            status: 'ACTIVE',
            transitions: [
                {
                    event: 'complete',
                    from: 'DRAFT',
                    to: 'COMPLETED',
                    condition: null,
                    evidence: {
                        requiredFields: ['taxId', 'artifactUrl'],
                        rejectMasked: true,
                        rejectLoopbackUrls: true,
                        minRows: 1,
                    },
                    actions: [],
                },
            ],
        }));

        const inst = await logic.instance.create({ sourceId: 'CAT-1688-01', profileId: evProfileId }, MOCK_REQ);

        // 1. Missing requiredFields
        await expect(logic.instance.transition({
            id: inst.id,
            event: 'complete',
            metaUpdate: { taxId: '91320214MA1X', rowCount: 5 },
        }, MOCK_REQ)).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/artifactUrl.*required/i) });

        // 2. Masked value (•••••• or ****)
        await expect(logic.instance.transition({
            id: inst.id,
            event: 'complete',
            metaUpdate: { taxId: '••••••', artifactUrl: 'https://oss.w3os.net/a/1.pdf', rowCount: 5 },
        }, MOCK_REQ)).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/masked/i) });

        await expect(logic.instance.transition({
            id: inst.id,
            event: 'complete',
            metaUpdate: { taxId: '9132****MA1X', artifactUrl: 'https://oss.w3os.net/a/1.pdf', rowCount: 5 },
        }, MOCK_REQ)).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/masked/i) });

        // 3. Loopback URL (127.0.0.1 / localhost)
        await expect(logic.instance.transition({
            id: inst.id,
            event: 'complete',
            metaUpdate: { taxId: '91320214MA1X', artifactUrl: 'http://127.0.0.1:8124/a/1.pdf', rowCount: 5 },
        }, MOCK_REQ)).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/loopback/i) });

        // 4. Zero rows
        await expect(logic.instance.transition({
            id: inst.id,
            event: 'complete',
            metaUpdate: { taxId: '91320214MA1X', artifactUrl: 'https://oss.w3os.net/a/1.pdf', rowCount: 0 },
        }, MOCK_REQ)).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/row count/i) });

        // 5. Genuine unmasked evidence + public URL + rows >= 1 succeeds!
        const ok = await logic.instance.transition({
            id: inst.id,
            event: 'complete',
            metaUpdate: { taxId: '91320214MA1X', artifactUrl: 'https://oss.w3os.net/a/1.pdf', rowCount: 12 },
        }, MOCK_REQ);
        expect(ok.state).toBe('COMPLETED');
    });

    test('token.issue & callback — single-use capability token enforces allowedEvents, atomic consumption, and ABA expectedTransitionId', async () => {
        const inst = await logic.instance.create({ sourceId: 'RPA-CB-01', profileId: SM_ID }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);

        const issued = await logic.instance.token.issue({
            id: inst.id,
            allowedEvents: ['confirm'],
            ttlMs: 60000,
        }, MOCK_REQ);
        expect(issued.callbackToken).toMatch(/^flcb_[0-9a-f]{48}$/);
        expect((await logic.instance.get({ id: inst.id }, MOCK_REQ)).pending_callbacks).toHaveLength(1);

        // Disallowed event rejected with 403 FORBIDDEN without burning the token
        await expect(logic.instance.callback(
            { event: 'cancel_requested', metaUpdate: { cancel_reason: 'hack' } },
            { callbackToken: issued.callbackToken }
        )).rejects.toMatchObject({ code: -32005 });

        // Concurrent valid callbacks: exactly ONE wins, second gets 401 UNAUTHORIZED!
        const race = await Promise.allSettled([
            logic.instance.callback({ event: 'confirm', metaUpdate: { approved: true } }, { callbackToken: issued.callbackToken }),
            logic.instance.callback({ event: 'confirm', metaUpdate: { approved: true } }, { callbackToken: issued.callbackToken }),
        ]);
        const winners = race.filter((r) => r.status === 'fulfilled');
        const losers = race.filter((r) => r.status === 'rejected');
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect(losers[0].reason.code).toBe(-32003);

        const after = await logic.instance.get({ id: inst.id }, MOCK_REQ);
        expect(after.state).toBe('CONFIRMED');
        expect(after.pending_callbacks).toEqual([]);
    });

    test('security run-3: suspend rejects business-state spoofing, terminal states, and held instances; transition is blocked while suspended', async () => {
        const inst = await logic.instance.create({ sourceId: 'sec-susp-1', profileId: SM_ID }, MOCK_REQ);

        // P0-1: cannot jump into a declared business state (e.g. PROCESSING or CONFIRMED) via suspendState
        await expect(logic.instance.suspend({
            id: inst.id,
            reason: 'spoof state',
            suspendState: 'CONFIRMED',
        }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });

        // Suspend into legitimate ASSIST_REQUIRED
        const suspended = await logic.instance.suspend({
            id: inst.id,
            reason: 'captcha',
        }, MOCK_REQ);
        expect(suspended.state).toBe('ASSIST_REQUIRED');

        // P1-1: cannot suspend an ON_HOLD instance (would overwrite prevState and brick resume)
        await logic.instance.resume({ id: inst.id }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);
        await logic.instance.hold({ id: inst.id, reason: 'waiting' }, MOCK_REQ);
        await expect(logic.instance.suspend({
            id: inst.id,
            reason: 'double pause',
        }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });
        await logic.instance.resume({ id: inst.id }, MOCK_REQ);

        // P1-1: terminal instance (CONFIRMED in sm-test has no outgoing transitions) cannot be suspended
        const termInst = await logic.instance.create({ sourceId: 'sec-term-1', profileId: SM_ID }, MOCK_REQ);
        await logic.instance.transition({ id: termInst.id, event: 'start' }, MOCK_REQ);
        await logic.instance.transition({ id: termInst.id, event: 'confirm', metaUpdate: { approved: true } }, MOCK_REQ);
        expect((await logic.instance.get({ id: termInst.id }, MOCK_REQ)).state).toBe('CONFIRMED');
        await expect(logic.instance.suspend({
            id: termInst.id,
            reason: 'reopen terminal',
        }, MOCK_REQ)).rejects.toMatchObject({ code: -32602 });
    });

    test('security run-3: callback preserves single-use token when evidence/condition gate rejects, so caller can fix payload and retry', async () => {
        await logic.profile.create({
            id: 'cb-ev-prof',
            name: 'Callback Evidence Profile',
            transitions: [
                {
                    event: 'finish',
                    from: 'DRAFT',
                    to: 'COMPLETED',
                    evidence: {
                        requiredFields: ['taxId', 'proofUrl'],
                        rejectMasked: true,
                        rejectLoopbackUrls: true,
                    },
                },
            ],
        });
        const inst = await logic.instance.create({ sourceId: 'sec-cb-1', profileId: 'cb-ev-prof' }, MOCK_REQ);
        const issued = await logic.instance.token.issue({
            id: inst.id,
            allowedEvents: ['finish'],
            ttlMs: 60000,
        }, MOCK_REQ);

        // Attempt 1: masked value & IPv6-mapped loopback URL → rejected by evidence gate
        await expect(logic.instance.callback({
            event: 'finish',
            metaUpdate: { taxId: '9132****MA1X', proofUrl: 'http://[::ffff:127.0.0.1]:8124/a.pdf' },
        }, { callbackToken: issued.callbackToken })).rejects.toMatchObject({ code: -32602 });

        // Attempt 2: empty object must NOT bypass requiredFields, and token was NOT burned by Attempt 1!
        await expect(logic.instance.callback({
            event: 'finish',
            metaUpdate: { taxId: {}, proofUrl: 'https://oss.example.com/a.pdf' },
        }, { callbackToken: issued.callbackToken })).rejects.toMatchObject({ code: -32602 });

        // Attempt 3: fixed payload with the SAME token now succeeds and consumes the token!
        const ok = await logic.instance.callback({
            event: 'finish',
            metaUpdate: { taxId: '91320100MA1X999999', proofUrl: 'https://oss.example.com/a.pdf' },
        }, { callbackToken: issued.callbackToken });
        expect(ok.state).toBe('COMPLETED');

        // Attempt 4: token is now consumed → 401 UNAUTHORIZED
        await expect(logic.instance.callback({
            event: 'finish',
            metaUpdate: { taxId: '91320100MA1X999999', proofUrl: 'https://oss.example.com/a.pdf' },
        }, { callbackToken: issued.callbackToken })).rejects.toMatchObject({ code: -32003 });
    });

    test('security run-3: idempotent create does not collide across colon-containing owner/sourceId', async () => {
        const first = await logic.instance.create({
            profileId: SM_ID,
            sourceId: 'c',
            idempotent: true,
        }, { user: 'u1', constraints: { $owner: { field: 'tenantId', value: `t1:${SM_ID}` } } });
        const second = await logic.instance.create({
            profileId: SM_ID,
            sourceId: `${SM_ID}:c`,
            idempotent: true,
        }, { user: 'u2', constraints: { $owner: { field: 'tenantId', value: 't1' } } });
        expect(second.id).not.toBe(first.id);
        expect(second.deduplicated).toBeUndefined();
    });
});

// ============================================================
// PROFILE — CRUD + client-supplied key (id/key bug fix)
// ============================================================

describe('fulfillment.profile', () => {

    test('create with an explicit id — created.id is the usable key (get/update/delete round-trip)', async () => {
        const created = await logic.profile.create({ id: 'standard_trade', name: 'Standard Trade', transitions: [] });
        expect(created.id).toBe('standard_trade');            // ← the bug: used to return a usable id ≠ key
        expect(created.status).toBe('ACTIVE');

        const got = await logic.profile.get({ id: created.id });
        expect(got.name).toBe('Standard Trade');
        const renamed = await logic.profile.update({ id: created.id, name: 'Renamed' });
        expect(renamed.name).toBe('Renamed');
        // duplicate id rejected
        await expect(logic.profile.create({ id: 'standard_trade', name: 'dup', transitions: [] })).rejects.toMatchObject({ code: -32602 });
    });

    test('create without id — factory generates a usable key', async () => {
        const created = await logic.profile.create({ name: 'Auto Key', transitions: [] });
        expect(created.id).toBeTruthy();
        expect((await logic.profile.get({ id: created.id })).name).toBe('Auto Key');
    });

    test('list / delete (soft) / restore / destroy lifecycle', async () => {
        const created = await logic.profile.create({ name: 'Lifecycle', transitions: [] });
        expect((await logic.profile.list()).total).toBeGreaterThanOrEqual(1);

        expect((await logic.profile.delete({ id: created.id })).status).toBe('DELETED');
        expect((await logic.profile.restore({ id: created.id })).status).toBe('ACTIVE');

        expect((await logic.profile.destroy({ id: created.id })).success).toBe(true);
        await expect(logic.profile.get({ id: created.id })).rejects.toBeDefined();
    });

    test('submit / update / approve — cumulative contributors prevent original submitter from approving after a second editor modifies the profile', async () => {
        const cleanTransitions = [{ event: 'go', from: 'DRAFT', to: 'DONE' }];
        const submitted = await logic.profile.submit(
            { id: 'sod_prof', name: 'SoD Profile', transitions: cleanTransitions, contributors: ['forged'] },
            { user: 'author-1' }
        );
        expect(submitted.ok).toBe(true);

        const edited = await logic.profile.update(
            {
                id: 'sod_prof',
                transitions: [
                    { event: 'go', from: 'DRAFT', to: 'STEP2' },
                    { event: 'finish', from: 'STEP2', to: 'DONE' },
                ],
                contributors: ['forged'],
            },
            { user: 'editor-2' }
        );
        expect(edited.submittedBy).toBe('editor-2');
        expect(edited.contributors).toEqual(expect.arrayContaining(['author-1', 'editor-2']));

        // Neither editor-2 nor original submitter author-1 can approve
        await expect(logic.profile.approve({ id: 'sod_prof' }, { user: 'editor-2' })).rejects.toMatchObject({ code: -32005 });
        await expect(logic.profile.approve({ id: 'sod_prof' }, { user: 'author-1' })).rejects.toMatchObject({ code: -32005 });

        // Independent admin-3 can approve
        const approved = await logic.profile.approve({ id: 'sod_prof' }, { user: 'admin-3' });
        expect(approved.reviewState).toBe('APPROVED');
    });
});

// ============================================================
// INTROSPECTION & ENTITY SCHEMA COMPLIANCE
// ============================================================

describe('introspection compliance', () => {

    test('all methods have name and description', () => {
        for (const m of introspection) {
            expect(typeof m.name).toBe('string');
            expect(typeof m.description).toBe('string');
        }
    });

    test('all config.description methods are in introspection', () => {
        const names = new Set(introspection.map(m => m.name));
        for (const name of Object.keys(config.description.zh.methods)) {
            expect(names.has(name)).toBe(true);
        }
    });

    test('the dedicated-operation methods are declared', () => {
        const names = new Set(introspection.map(m => m.name));
        for (const m of ['cancel', 'hold', 'suspend', 'resume', 'override', 'reap', 'token.issue', 'callback']) {
            expect(names.has(`fulfillment.instance.${m}`)).toBe(true);
        }
    });

    test('entity schemas are defined for instance and profile', () => {
        expect(entities.instance).toBeDefined();
        expect(entities.profile).toBeDefined();
        expect(entities.profile.softDelete).toBe(true);
        expect(entities.instance.softDelete).toBe(false);
    });
});

// ============================================================
// PEER_RPC_WITH_CALLBACK & FAN-IN BARRIER (v1.3.4+)
// ============================================================

describe('peer_rpc_with_callback & fulfillment.barrier', () => {
    test('transition with kind=peer_rpc_with_callback mints bound flcb_ token and dispatches via peerRelayFactory', async () => {
        const peerCalls = [];
        const customLogic = createLogic(redis, {
            ...config,
            peers: {
                steward: {
                    endpoint: 'https://rpa-api.w3os.net/rpc',
                    user: 'svc_bot',
                    password: 'secret',
                },
            },
            peerRelayFactory(peerOpts) {
                return {
                    async call(method, params) {
                        peerCalls.push({ peerOpts, method, params });
                        return { jobId: 'HJ-1001', status: 'PENDING' };
                    },
                };
            },
        });

        await customLogic.profile.create({
            id: 'rpa-dispatch-prof',
            name: 'RPA Dispatch Profile',
            transitions: [
                {
                    event: 'dispatch_requested',
                    from: 'DRAFT',
                    to: 'EXECUTING',
                    actions: [
                        {
                            kind: 'peer_rpc_with_callback',
                            peer: 'steward',
                            method: 'steward.bridge.dispatch',
                            callback: {
                                allowedEvents: ['rpa_succeeded', 'rpa_failed', 'assist_required'],
                                ttlMs: 1800000,
                            },
                            paramsFromMeta: 'rpaDispatch',
                        },
                    ],
                },
                { event: 'rpa_succeeded', from: 'EXECUTING', to: 'COMPLETED' },
                { event: 'rpa_failed', from: 'EXECUTING', to: 'FAILED' },
                { event: 'assist_required', from: 'EXECUTING', to: 'ASSIST_REQUIRED' },
            ],
        });

        const inst = await customLogic.instance.create({
            sourceId: 'INV-2026-01',
            profileId: 'rpa-dispatch-prof',
            meta: {
                rpaDispatch: {
                    storeId: 'store-hz-01',
                    slug: 'chinatax.blue.issue',
                    inputs: { amount: 12800 },
                },
            },
        }, MOCK_REQ);

        const out = await customLogic.instance.transition({
            id: inst.id,
            event: 'dispatch_requested',
        }, MOCK_REQ);

        expect(out.state).toBe('EXECUTING');
        expect(out._tasks).toEqual([]); // peer_rpc_with_callback does not leak into local Router _tasks

        expect(peerCalls).toHaveLength(1);
        expect(peerCalls[0].method).toBe('steward.bridge.dispatch');
        expect(peerCalls[0].params.storeId).toBe('store-hz-01');
        expect(peerCalls[0].params.upstream.instanceId).toBe(inst.id);
        expect(peerCalls[0].params.upstream.expectedTransitionId).toBe(`${inst.id}-T2`);
        expect(peerCalls[0].params.upstream.callbackToken).toMatch(/^flcb_/);

        // Verify the auto-issued flcb_ token works for fulfillment.instance.callback
        const cbOut = await customLogic.instance.callback({
            event: 'rpa_succeeded',
            metaUpdate: { invoiceNo: '26332000000012345678' },
        }, { callbackToken: peerCalls[0].params.upstream.callbackToken });
        expect(cbOut.state).toBe('COMPLETED');
        expect(cbOut.meta.invoiceNo).toBe('26332000000012345678');
    });

    test('fulfillment.barrier — idempotent fan-in settles exactly once at expectedCount and advances target instance', async () => {
        await redis.set(`${config.redis.profilePrefix}${SM_ID}`, JSON.stringify(SM_PROFILE));
        const inst = await logic.instance.create({ sourceId: 'PULSE-2026-11-12', profileId: SM_ID }, MOCK_REQ);

        const bar = await logic.barrier.create({
            barrierKey: 'erp-harvest-2026-11-12',
            expectedCount: 3,
            ttlMs: 600000,
            onSettled: {
                target: 'fulfillment',
                instanceId: inst.id,
                event: 'start',
            },
        }, MOCK_REQ);
        expect(bar.status).toBe('PENDING');
        expect(bar.expectedCount).toBe(3);

        // Item 1 check-in + duplicate check-in
        const c1 = await logic.barrier.checkin({
            barrierKey: 'erp-harvest-2026-11-12',
            itemId: 'jky-sales',
            outcome: 'DONE',
            result: { file: 'jky-sales.xlsx', rows: 512 },
        }, MOCK_REQ);
        expect(c1.completedCount).toBe(1);
        expect(c1.justSettled).toBe(false);

        const c1Dup = await logic.barrier.checkin({
            barrierKey: 'erp-harvest-2026-11-12',
            itemId: 'jky-sales',
            outcome: 'DONE',
            result: { file: 'jky-sales.xlsx', rows: 512 },
        }, MOCK_REQ);
        expect(c1Dup.completedCount).toBe(1);
        expect(c1Dup.justSettled).toBe(false);

        // Item 2 check-in (SKIPPED)
        const c2 = await logic.barrier.checkin({
            barrierKey: 'erp-harvest-2026-11-12',
            itemId: 'jst-aftersale',
            outcome: 'SKIPPED',
            result: { reason: 'empty window' },
        }, MOCK_REQ);
        expect(c2.completedCount).toBe(2);
        expect(c2.justSettled).toBe(false);

        // Item 3 check-in (DONE) → hits expectedCount=3 → settles barrier and transitions instance!
        const c3 = await logic.barrier.checkin({
            barrierKey: 'erp-harvest-2026-11-12',
            itemId: 'jst-stock',
            outcome: 'DONE',
            result: { file: 'jst-stock.xlsx', rows: 1200 },
        }, MOCK_REQ);
        expect(c3.completedCount).toBe(3);
        expect(c3.justSettled).toBe(true);
        expect(c3.status).toBe('SETTLED');
        expect(c3.succeeded).toBe(2);
        expect(c3.skipped).toBe(1);
        expect(c3.failed).toBe(0);

        const updatedInst = await logic.instance.get({ id: inst.id }, MOCK_REQ);
        expect(updatedInst.state).toBe('PROCESSING');
        expect(updatedInst.meta.barrier).toMatchObject({
            barrierKey: 'erp-harvest-2026-11-12',
            status: 'SETTLED',
            timedOut: false,
            expectedCount: 3,
            completedCount: 3,
            succeeded: 2,
            skipped: 1,
            failed: 0,
        });
    });

    test('fulfillment.barrier.reap — settles expired barriers past ttlMs with EXPIRED status', async () => {
        await redis.set(`${config.redis.profilePrefix}${SM_ID}`, JSON.stringify(SM_PROFILE));
        const inst = await logic.instance.create({ sourceId: 'PULSE-TIMEOUT', profileId: SM_ID }, MOCK_REQ);

        await logic.barrier.create({
            barrierKey: 'erp-timeout-round',
            expectedCount: 2,
            ttlMs: 1000,
            onSettled: {
                target: 'fulfillment',
                instanceId: inst.id,
                event: 'start',
                timeoutEvent: 'start',
            },
        }, MOCK_REQ);

        await logic.barrier.checkin({
            barrierKey: 'erp-timeout-round',
            itemId: 'only-one',
            outcome: 'DONE',
            result: { ok: true },
        }, MOCK_REQ);

        // Backdate expiresAt in Redis to simulate expiration
        const key = `${config.redis.barrierPrefix}erp-timeout-round`;
        const raw = JSON.parse(await redis.get(key));
        raw.expiresAt = clock.now() - 5000;
        await redis.set(key, JSON.stringify(raw));

        const reaped = await logic.barrier.reap({}, ADMIN_REQ);
        expect(reaped.expired).toBe(1);
        expect(reaped.reaped[0]).toMatchObject({
            barrierKey: 'erp-timeout-round',
            status: 'EXPIRED',
            completedCount: 1,
            expectedCount: 2,
        });

        const afterInst = await logic.instance.get({ id: inst.id }, MOCK_REQ);
        expect(afterInst.state).toBe('PROCESSING');
        expect(afterInst.meta.barrier.status).toBe('EXPIRED');
        expect(afterInst.meta.barrier.timedOut).toBe(true);
    });
});
