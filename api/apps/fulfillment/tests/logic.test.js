/**
 * Fulfillment Service — Unit Tests (hermetic, mock Redis).
 */

const createLogic    = require('../logic');
const introspection  = require('../handlers/introspection');
const entities       = require('../handlers/entities');
const config         = require('../config');
const { PROFILE_ID, MOCK_PROFILE, MOCK_REQ } = require('./utils/mock_data');

// --- Mock Redis ---

function createMockRedis() {
    const store = {};
    const sets  = {};
    return {
        async set(key, val, opts) {
            if (opts && opts.NX && store[key] !== undefined) return null;
            store[key] = val;
            return 'OK';
        },
        async get(key)            { return store[key] || null; },
        async sAdd(key, val)      { if (!sets[key]) sets[key] = new Set(); sets[key].add(val); },
        async sMembers(key)       { return sets[key] ? [...sets[key]] : []; },
        async mGet(keys)          { return keys.map(k => store[k] || null); },
        async exists(key)         { return store[key] ? 1 : 0; },
        async del(key)            { delete store[key]; },
        async sRem(key, val)      { if (sets[key]) sets[key].delete(val); },
        async watch()             { return 'OK'; },
        async unwatch()           { return 'OK'; },
        multi() {
            const ops = [];
            const pipeline = {
                set(key, val)    { ops.push(() => { store[key] = val; }); return pipeline; },
                sAdd(key, val)   { ops.push(() => { if (!sets[key]) sets[key] = new Set(); sets[key].add(val); }); return pipeline; },
                sRem(key, val)   { ops.push(() => { if (sets[key]) sets[key].delete(val); }); return pipeline; },
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

    test('transition — metaUpdate is merged BEFORE the condition is evaluated', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-010', profileId: SM_ID, meta: { approved: false } }, MOCK_REQ);
        await logic.instance.transition({ id: inst.id, event: 'start' }, MOCK_REQ);
        const ok = await logic.instance.transition({ id: inst.id, event: 'confirm', metaUpdate: { approved: true } }, MOCK_REQ);
        expect(ok.state).toBe('CONFIRMED');
        expect(ok.meta.approved).toBe(true);
    });

    test('update — merges meta without dropping existing keys', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-011', profileId: PROFILE_ID, meta: { a: 1 } }, MOCK_REQ);
        const updated = await logic.instance.update({ id: inst.id, meta: { b: 2 } });
        expect(updated.meta).toEqual({ a: 1, b: 2 });
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

    test('hold → resume — pause to ON_HOLD then restore prevState', async () => {
        const id = await newProcessing('ORD-H1');
        const held = await logic.instance.hold({ id, reason: 'supplier delay', expectedResume: '2026-07-01' }, MOCK_REQ);
        expect(held.state).toBe('ON_HOLD');
        expect(held.prevState).toBe('PROCESSING');
        expect(held.meta.hold_reason).toBe('supplier delay');

        const resumed = await logic.instance.resume({ id }, MOCK_REQ);
        expect(resumed.state).toBe('PROCESSING');
        expect(resumed.history[resumed.history.length - 1].event).toBe('resume');
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
        for (const m of ['cancel', 'hold', 'resume', 'override']) {
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
