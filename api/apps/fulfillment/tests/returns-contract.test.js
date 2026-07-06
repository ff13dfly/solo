/**
 * returns-contract.test.js — proves fulfillment.{instance,profile}.* ACTUAL handler output
 * satisfies the declared return contract (introspection `returns_schema`). Hermetic: real
 * logic (custom instance state machine + real Entity Factory for profiles) over an injected
 * Map-backed fake Redis. No stack, no live Redis. Modeled on apps/collection's variant.
 *
 * Why this matters: the fulfillment profile linter resolves a meta_field source.pick against
 * the TARGET method's returns_schema, and orchestration/AI bind to these output shapes. The
 * declared schema MUST match what the handler really returns — this test is the proof.
 *
 * The fake Redis exposes only the string-path commands the instance logic + Entity Factory
 * need (get/set/del/mGet/sAdd/sMembers/sRem + a MULTI without xAdd → Entity Factory takes its
 * non-atomic walFile branch). relay is passed null → no outbound RPC; _tasks are still built
 * locally from the profile's actions.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-fulfillment-contract-${process.pid}`);

const createLogic = require('../logic');
const introspection = require('../handlers/introspection');
const config = require('../config');
const { checkReturn } = require('../../../library/contract');

// fake redis — string path only (instance logic uses raw set/get/JSON.parse; the Entity
// Factory profile uses the string storage path). No xAdd → canAtomicWal=false → walFile.
function makeFakeRedis() {
    const kv = new Map();
    const sets = new Map();
    const getSet = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));
    const apply = {
        set: (k, v, opts) => { if (opts && opts.NX && kv.has(k)) return null; kv.set(k, v); return 'OK'; },
        sAdd: (k, m) => { const s = getSet(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        del: (k) => { const had = kv.delete(k); sets.delete(k); return had ? 1 : 0; },
        sRem: (k, m) => { const s = sets.get(k); return s && s.delete(m) ? 1 : 0; },
    };
    return {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v, opts) { return apply.set(k, v, opts); },
        async del(k) { return apply.del(k); },
        async mGet(keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
        async sAdd(k, m) { return apply.sAdd(k, m); },
        async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
        async sRem(k, m) { return apply.sRem(k, m); },
        async sIsMember(k, m) { return sets.has(k) && sets.get(k).has(m) ? 1 : 0; },
        multi() {
            const ops = [];
            const chain = {
                set(k, v, opts) { ops.push(['set', k, v, opts]); return chain; },
                sAdd(k, m) { ops.push(['sAdd', k, m]); return chain; },
                del(k) { ops.push(['del', k]); return chain; },
                sRem(k, m) { ops.push(['sRem', k, m]); return chain; },
                async exec() { return ops.map(([op, ...args]) => apply[op](...args)); },
            };
            return chain;
        },
    };
}

const byName = Object.fromEntries(introspection.map((m) => [m.name, m]));
const method = (n) => byName[n];

// A profile whose transitions exercise every instance op: start (DRAFT→PROCESSING) with a
// downstream action so transition() builds a real _task; hold/cancel/confirm from PROCESSING.
const SM_ID = 'sm-contract';
const SM_PROFILE = {
    id: SM_ID,
    name: 'contract state machine',
    status: 'ACTIVE',
    transitions: [
        { event: 'start',            from: 'DRAFT',      to: 'PROCESSING', condition: null,
          actions: [{ service: 'notification', method: 'notification.send', params: { to: 'ops' } }] },
        { event: 'hold_requested',   from: 'PROCESSING', to: 'ON_HOLD',    condition: null, actions: [] },
        { event: 'cancel_requested', from: 'PROCESSING', to: 'CANCELLED',  condition: null, actions: [] },
        { event: 'confirm',          from: 'PROCESSING', to: 'CONFIRMED',  condition: null, actions: [] },
    ],
};
const REQ = { user: 'uid-tester', permit: 'user', constraints: null };
const ADMIN_REQ = { user: 'uid-admin', permit: 'admin', constraints: null };

describe('fulfillment.* — actual return satisfies declared returns_schema', () => {
    let redis;
    let logic;

    beforeEach(async () => {
        redis = makeFakeRedis();
        logic = createLogic(redis, config, { relay: null });
        // seed the state-machine profile directly (instance logic reads it raw from Redis)
        await redis.set(`${config.redis.profilePrefix}${SM_ID}`, JSON.stringify(SM_PROFILE));
    });

    // ── INSTANCE ──────────────────────────────────────────────────────────────

    test('instance.create → DRAFT instance matches contract; no _tasks key', async () => {
        const inst = await logic.instance.create({ sourceId: 'ORD-1', profileId: SM_ID }, REQ);
        expect(checkReturn(method('fulfillment.instance.create'), inst)).toEqual([]);
        expect(inst.state).toBe('DRAFT');
        expect(inst.status).toBeUndefined();   // lifecycle is `state`, NOT `status`
        expect(inst._tasks).toBeUndefined();   // create does not emit _tasks
    });

    test('instance.get → stored instance matches contract', async () => {
        const created = await logic.instance.create({ sourceId: 'ORD-2', profileId: SM_ID }, REQ);
        const got = await logic.instance.get({ id: created.id });
        expect(checkReturn(method('fulfillment.instance.get'), got)).toEqual([]);
        expect(got.id).toBe(created.id);
    });

    test('instance.list → { items, total }; empty and populated both match', async () => {
        const empty = await logic.instance.list({});
        expect(checkReturn(method('fulfillment.instance.list'), empty)).toEqual([]);
        expect(empty).toEqual({ items: [], total: 0 });

        await logic.instance.create({ sourceId: 'ORD-3', profileId: SM_ID }, REQ);
        await logic.instance.create({ sourceId: 'ORD-4', profileId: SM_ID }, REQ);
        const res = await logic.instance.list({});
        expect(checkReturn(method('fulfillment.instance.list'), res)).toEqual([]);
        expect(typeof res.total).toBe('number');
        // each listed item is a full instance → must satisfy the instance.get shape
        for (const item of res.items) {
            expect(checkReturn(method('fulfillment.instance.get'), item)).toEqual([]);
        }
    });

    test('instance.transition → { ...instance, _tasks } matches contract; _tasks present (with an action)', async () => {
        const created = await logic.instance.create({ sourceId: 'ORD-5', profileId: SM_ID }, REQ);
        const out = await logic.instance.transition({ id: created.id, event: 'start' }, REQ);
        expect(checkReturn(method('fulfillment.instance.transition'), out)).toEqual([]);
        expect(out.state).toBe('PROCESSING');
        expect(Array.isArray(out._tasks)).toBe(true);
        expect(out._tasks.length).toBe(1);     // the `start` rule has one non-workflow action
        expect(out.prevState).toBe('DRAFT');
    });

    test('instance.transition with no actions → still { ...instance, _tasks:[] } on contract', async () => {
        const created = await logic.instance.create({ sourceId: 'ORD-6', profileId: SM_ID }, REQ);
        await logic.instance.transition({ id: created.id, event: 'start' }, REQ);   // → PROCESSING
        const out = await logic.instance.transition({ id: created.id, event: 'confirm' }, REQ); // no actions
        expect(checkReturn(method('fulfillment.instance.transition'), out)).toEqual([]);
        expect(out._tasks).toEqual([]);
    });

    test('instance.cancel → advance() shape with _tasks matches contract', async () => {
        const created = await logic.instance.create({ sourceId: 'ORD-7', profileId: SM_ID }, REQ);
        await logic.instance.transition({ id: created.id, event: 'start' }, REQ);   // → PROCESSING
        const out = await logic.instance.cancel({ id: created.id, reason: 'customer withdrew' }, REQ);
        expect(checkReturn(method('fulfillment.instance.cancel'), out)).toEqual([]);
        expect(out.state).toBe('CANCELLED');
        expect(Array.isArray(out._tasks)).toBe(true);
        expect(out.meta.cancel_reason).toBe('customer withdrew');
    });

    test('instance.hold → advance() shape with _tasks matches contract', async () => {
        const created = await logic.instance.create({ sourceId: 'ORD-8', profileId: SM_ID }, REQ);
        await logic.instance.transition({ id: created.id, event: 'start' }, REQ);   // → PROCESSING
        const out = await logic.instance.hold({ id: created.id, reason: 'stock check' }, REQ);
        expect(checkReturn(method('fulfillment.instance.hold'), out)).toEqual([]);
        expect(out.state).toBe('ON_HOLD');
        expect(Array.isArray(out._tasks)).toBe(true);
    });

    test('instance.resume → bare instance (NO _tasks) matches its contract', async () => {
        const created = await logic.instance.create({ sourceId: 'ORD-9', profileId: SM_ID }, REQ);
        await logic.instance.transition({ id: created.id, event: 'start' }, REQ);   // → PROCESSING
        await logic.instance.hold({ id: created.id, reason: 'stock check' }, REQ);  // → ON_HOLD (prevState=PROCESSING)
        const out = await logic.instance.resume({ id: created.id }, REQ);
        expect(checkReturn(method('fulfillment.instance.resume'), out)).toEqual([]);
        expect(out.state).toBe('PROCESSING');
        expect(out._tasks).toBeUndefined();    // ⚠ resume is the non-uniform sibling: no _tasks
    });

    test('instance.override → admin force-advance, advance() shape with _tasks', async () => {
        const created = await logic.instance.create({ sourceId: 'ORD-10', profileId: SM_ID }, ADMIN_REQ);
        const out = await logic.instance.override({ id: created.id, event: 'start', reason: 'manual push' }, ADMIN_REQ);
        expect(checkReturn(method('fulfillment.instance.override'), out)).toEqual([]);
        expect(out.state).toBe('PROCESSING');
        expect(Array.isArray(out._tasks)).toBe(true);
        // forced marker on the new history entry (not a top-level return key)
        expect(out.history[out.history.length - 1].forced).toBe(true);
    });

    test('instance.update → bare instance + updatedAt (NO _tasks) matches contract', async () => {
        const created = await logic.instance.create({ sourceId: 'ORD-11', profileId: SM_ID }, REQ);
        const out = await logic.instance.update({ id: created.id, meta: { paidAmount: 99 } }, REQ);
        expect(checkReturn(method('fulfillment.instance.update'), out)).toEqual([]);
        expect(typeof out.updatedAt).toBe('number');
        expect(out.meta.paidAmount).toBe(99);
        expect(out._tasks).toBeUndefined();
    });

    // ── PROFILE (Entity Factory) ────────────────────────────────────────────────

    test('profile.create → entity record matches contract; lifecycle is `status` not `state`', async () => {
        const p = await logic.profile.create({ id: 'std_trade', name: 'Standard Trade', transitions: [] });
        expect(checkReturn(method('fulfillment.profile.create'), p)).toEqual([]);
        expect(p.status).toBe('ACTIVE');
        expect(p.state).toBeUndefined();       // a profile has NO business `state`
        expect(typeof p.createdAt).toBe('number');
        expect(typeof p.updatedAt).toBe('number');
    });

    test('profile.get → stored entity record matches contract', async () => {
        await logic.profile.create({ id: 'p_get', name: 'Get Me', transitions: [] });
        const got = await logic.profile.get({ id: 'p_get' });
        expect(checkReturn(method('fulfillment.profile.get'), got)).toEqual([]);
        expect(got.id).toBe('p_get');
    });

    test('profile.list → { items, total }; each item is a profile record', async () => {
        await logic.profile.create({ id: 'p_a', name: 'A', transitions: [] });
        await logic.profile.create({ id: 'p_b', name: 'B', transitions: [] });
        const res = await logic.profile.list({});
        expect(checkReturn(method('fulfillment.profile.list'), res)).toEqual([]);
        expect(typeof res.total).toBe('number');
        for (const item of res.items) {
            expect(checkReturn(method('fulfillment.profile.get'), item)).toEqual([]);
        }
    });

    test('profile.update → merged record matches contract', async () => {
        await logic.profile.create({ id: 'p_upd', name: 'Before', transitions: [] });
        const upd = await logic.profile.update({ id: 'p_upd', name: 'After' });
        expect(checkReturn(method('fulfillment.profile.update'), upd)).toEqual([]);
        expect(upd.name).toBe('After');
        expect(upd.status).toBe('ACTIVE');
    });

    test('profile.delete (softDelete) → full entity record status=DELETED, NOT { success }', async () => {
        await logic.profile.create({ id: 'p_drop', name: 'Delete Me', transitions: [] });
        const del = await logic.profile.delete({ id: 'p_drop' });
        expect(checkReturn(method('fulfillment.profile.delete'), del)).toEqual([]);
        expect(del.status).toBe('DELETED');
        expect(del.id).toBe('p_drop');          // it is the record, not { success: true }
        expect(del.success).toBeUndefined();
    });

    test('profile.restore → record back to ACTIVE matches contract', async () => {
        await logic.profile.create({ id: 'p_res', name: 'Restore Me', transitions: [] });
        await logic.profile.delete({ id: 'p_res' });
        const res = await logic.profile.restore({ id: 'p_res' });
        expect(checkReturn(method('fulfillment.profile.restore'), res)).toEqual([]);
        expect(res.status).toBe('ACTIVE');
    });

    test('profile.restore on a non-deleted record → returns existing verbatim, still on contract', async () => {
        await logic.profile.create({ id: 'p_res2', name: 'Already Active', transitions: [] });
        const res = await logic.profile.restore({ id: 'p_res2' });   // not DELETED → early-return existing
        expect(checkReturn(method('fulfillment.profile.restore'), res)).toEqual([]);
        expect(res.status).toBe('ACTIVE');
    });

    test('profile.destroy → { success: true } matches contract', async () => {
        await logic.profile.create({ id: 'p_dst', name: 'Destroy Me', transitions: [] });
        const out = await logic.profile.destroy({ id: 'p_dst' });
        expect(checkReturn(method('fulfillment.profile.destroy'), out)).toEqual([]);
        expect(out.success).toBe(true);
    });
});
