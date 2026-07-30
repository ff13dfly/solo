/**
 * Approval policy tier + record expiry — hermetic unit test (BACKLOG "approval 深挖":
 * the rules-engine minimal tier + the record lane's missing expiry).
 *
 * What was true before and is asserted as fixed:
 *   - requiredSigners/expiry lived in each caller's code — no auditable central place.
 *     Now: approval.policy.* binds subjectPattern → defaults; explicit params still win.
 *   - An INIT/DISPATCHED record hung forever — approvable months later. Now: optional
 *     expiresAt (explicit or policy-filled) lazily flips to EXPIRED, fail-closed.
 *
 * Clock frozen throughout (CLOCK_TEST_MODE) — expiry is asserted by fast-forwarding,
 * not by sleeping.
 */
process.env.CLOCK_TEST_MODE = 'true';

const clock = require('../../../library/clock');
const createPolicy = require('../logic/policy');
const createGate = require('../logic/gate');
const createRecord = require('../logic/record');
const { makeFakeRedis } = require('./utils/fake-redis');
const config = require('../config');

const DIGEST = 'deadbeef'.repeat(8);
const OPS = [{ op: 'UPDATE', field: 'price', oldValue: 1, newValue: 2 }];

// No signature paths in this suite → relay only needs to exist for gate construction.
const noRelay = { call: async () => { throw new Error('unexpected relay call'); } };

let redis;
let policy;
beforeEach(() => {
    clock.freeze('2026-07-30T12:00:00Z');
    redis = makeFakeRedis();
    policy = createPolicy(redis, { config });
});
afterEach(() => clock.reset());

// ─── policy CRUD + matching ───────────────────────────────────────────────────

describe('approval.policy — set/resolve/list/delete', () => {
    test('set validates pattern and bounds; upserts by pattern (idempotent)', async () => {
        const a = await policy.set({ subjectPattern: 'workflow:*', requiredSigners: 2, expiresInSec: 3600 });
        expect(a.requiredSigners).toBe(2);

        // Same pattern again → UPDATE of the same row, not a duplicate.
        const b = await policy.set({ subjectPattern: 'workflow:*', requiredSigners: 3 });
        expect(b.id).toBe(a.id);
        expect(b.requiredSigners).toBe(3);
        expect((await policy.list({})).total).toBe(1);

        await expect(policy.set({})).rejects.toMatchObject({ code: -32602 });
        await expect(policy.set({ subjectPattern: 'a*b' })).rejects.toMatchObject({ code: -32602, message: /trailing glob/ });
        await expect(policy.set({ subjectPattern: 'x', requiredSigners: 0 })).rejects.toMatchObject({ code: -32602 });
        await expect(policy.set({ subjectPattern: 'x', requiredSigners: 21 })).rejects.toMatchObject({ code: -32602 });
        await expect(policy.set({ subjectPattern: 'x', expiresInSec: 59 })).rejects.toMatchObject({ code: -32602 });
    });

    test('resolve: exact > longest trailing-glob > catch-all > none', async () => {
        await policy.set({ subjectPattern: '*', requiredSigners: 1 });
        await policy.set({ subjectPattern: 'workflow:*', requiredSigners: 2 });
        await policy.set({ subjectPattern: 'workflow:payments:*', requiredSigners: 3 });
        await policy.set({ subjectPattern: 'workflow:payments:wf9:v1', requiredSigners: 5 });

        expect((await policy.resolve({ subject: 'workflow:payments:wf9:v1' })).policy.requiredSigners).toBe(5);   // exact
        expect((await policy.resolve({ subject: 'workflow:payments:other' })).policy.requiredSigners).toBe(3);    // longest glob
        expect((await policy.resolve({ subject: 'workflow:misc' })).policy.requiredSigners).toBe(2);
        expect((await policy.resolve({ subject: 'collection:refund:1' })).policy.requiredSigners).toBe(1);        // catch-all

        const p2 = createPolicy(makeFakeRedis(), { config });
        expect(await p2.resolve({ subject: 'anything' })).toEqual({ matched: false, policy: null });
    });

    test('delete removes the policy from matching', async () => {
        const p = await policy.set({ subjectPattern: 'workflow:*', requiredSigners: 2 });
        await policy.delete({ id: p.id });
        expect((await policy.resolve({ subject: 'workflow:x' })).matched).toBe(false);
    });
});

// ─── gate ↔ policy precedence ─────────────────────────────────────────────────

describe('gate.open consumes policy (explicit > policy > config default)', () => {
    test('policy fills requiredSigners + expiry when the caller omits them', async () => {
        await policy.set({ subjectPattern: 'workflow:*', requiredSigners: 3, expiresInSec: 600 });
        const gate = createGate(redis, { config, relay: noRelay, policy });

        const g = await gate.open({ subject: 'workflow:wf1:v1', digest: DIGEST, submitterUid: 'uid-sub' });
        expect(g.requiredSigners).toBe(3);
        expect(g.expiresAt).toBe(clock.now() + 600 * 1000);
    });

    test('explicit caller params beat the policy', async () => {
        await policy.set({ subjectPattern: 'workflow:*', requiredSigners: 3, expiresInSec: 600 });
        const gate = createGate(redis, { config, relay: noRelay, policy });

        const g = await gate.open({ subject: 'workflow:wf1:v1', digest: DIGEST, requiredSigners: 1, expiresInSec: 120 });
        expect(g.requiredSigners).toBe(1);
        expect(g.expiresAt).toBe(clock.now() + 120 * 1000);
    });

    test('no policy match → config defaults (pre-policy behavior, byte-for-byte)', async () => {
        const gate = createGate(redis, { config, relay: noRelay, policy });
        const g = await gate.open({ subject: 'unmatched:thing', digest: DIGEST });
        expect(g.requiredSigners).toBe((config.gate && config.gate.defaultRequiredSigners) || 1);
        expect(g.expiresAt).toBe(clock.now() + ((config.gate.defaultExpirySec) || 259200) * 1000);
    });

    test('no policy service injected at all (legacy construction) still works', async () => {
        const gate = createGate(redis, { config, relay: noRelay });
        const g = await gate.open({ subject: 's', digest: DIGEST, requiredSigners: 2 });
        expect(g.requiredSigners).toBe(2);
    });
});

// ─── record expiry ────────────────────────────────────────────────────────────

describe('record expiry (INIT/DISPATCHED past deadline → EXPIRED, fail-closed)', () => {
    test('no expiresInSec + no policy → never expires (pre-expiry behavior)', async () => {
        const record = createRecord(redis, { config, relay: noRelay, policy });
        const r = await record.request({ target: 'coll:item:1', payload: OPS }, { actor: 'uid-a' });
        expect(r.expiresAt).toBeUndefined();

        clock.fastForward(365 * 24 * 3600 * 1000);   // a year later
        const verified = await record.verify({ id: r.id }, { actor: 'uid-b' });
        expect(verified.state).toBe('DISPATCHED');   // still actionable — no deadline was set
    });

    test('explicit expiresInSec: verify/confirm past deadline fail closed, state = EXPIRED', async () => {
        const record = createRecord(redis, { config, relay: noRelay, policy });
        const r = await record.request({ target: 'coll:item:2', payload: OPS, expiresInSec: 600 }, { actor: 'uid-a' });
        expect(r.expiresAt).toBe(clock.now() + 600 * 1000);

        clock.fastForward(601 * 1000);
        await expect(record.verify({ id: r.id }, { actor: 'uid-b' }))
            .rejects.toMatchObject({ code: -32005, message: /state EXPIRED/ });
        expect((await record.get({ id: r.id })).state).toBe('EXPIRED');

        // Terminal: reject can't touch it either.
        await expect(record.reject({ id: r.id }, { actor: 'uid-b' }))
            .rejects.toMatchObject({ code: -32005 });
    });

    test('a DISPATCHED record also expires (deadline covers the whole in-flight window)', async () => {
        const record = createRecord(redis, { config, relay: noRelay, policy });
        const r = await record.request({ target: 'coll:item:3', payload: OPS, expiresInSec: 600 }, { actor: 'uid-a' });
        await record.verify({ id: r.id }, { actor: 'uid-b' });

        clock.fastForward(601 * 1000);
        await expect(record.confirm({ id: r.id }, { actor: 'uid-c' }))
            .rejects.toMatchObject({ code: -32005, message: /state EXPIRED/ });
        expect((await record.get({ id: r.id })).state).toBe('EXPIRED');
    });

    test('policy fills record expiry by target pattern; inside the window everything works', async () => {
        await policy.set({ subjectPattern: 'coll:*', expiresInSec: 3600 });
        const record = createRecord(redis, { config, relay: noRelay, policy });

        const r = await record.request({ target: 'coll:item:4', payload: OPS }, { actor: 'uid-a' });
        expect(r.expiresAt).toBe(clock.now() + 3600 * 1000);

        clock.fastForward(1800 * 1000);   // half the window — still live
        await record.verify({ id: r.id }, { actor: 'uid-b' });
        const done = await record.confirm({ id: r.id }, { actor: 'uid-c' });
        expect(done.state).toBe('DONE');

        // A DONE record does not expire retroactively.
        clock.fastForward(7200 * 1000);
        expect((await record.get({ id: r.id })).state).toBe('DONE');
    });

    test('expiresInSec is validated (≥60, integer)', async () => {
        const record = createRecord(redis, { config, relay: noRelay, policy });
        await expect(record.request({ target: 't', payload: OPS, expiresInSec: 10 }, {}))
            .rejects.toMatchObject({ code: -32602 });
    });
});

// ─── gate expiry uses the frozen clock (regression for the Date.now → clock swap) ──

describe('gate expiry under a frozen clock', () => {
    test('OPEN gate flips EXPIRED exactly past the deadline; sign fails closed', async () => {
        const gate = createGate(redis, { config, relay: noRelay, policy });
        const g = await gate.open({ subject: 's', digest: DIGEST, expiresInSec: 300 });

        clock.fastForward(299 * 1000);
        expect((await gate.get({ id: g.id })).state).toBe('OPEN');

        clock.fastForward(2 * 1000);
        expect((await gate.get({ id: g.id })).state).toBe('EXPIRED');
        await expect(gate.sign({ id: g.id, approverUid: 'u', signature: 'x' }))
            .rejects.toMatchObject({ code: -32005, message: /expired/i });
    });
});
