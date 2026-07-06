/**
 * returns-contract.test.js — proves approval.record.* and approval.gate.* ACTUAL handler
 * output satisfies the declared return contract (introspection `returns_schema`). Hermetic:
 * real logic + real Entity Factory over an injected Map-backed fake Redis (the
 * sample/item.test.js / collection pattern). No stack, no live Redis.
 *
 * Why this service: orchestration / AI binds to approval's gate + record output shapes
 * (the §3.1 multi-sig lane stores the returned gate id on the workflow; the SAP record
 * lifecycle is read back by `state`). Those returns_schema MUST match reality.
 *
 * Not covered here (LLM/outbound-RPC dependent — see `unverified` in the task report):
 *   - approval.gate.sign      → relays to user.key.public + verifies an Ed25519 signature
 *   - approval.token.set/status/clear → wrap library/relay; static-derived shapes
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-approval-contract-${process.pid}`);

const createRecordLogic = require('../logic/record');
const createGateLogic = require('../logic/gate');
const introspection = require('../handlers/introspection');
const config = require('../config');
const { checkReturn } = require('../../../library/contract');

// fake redis — only the Entity-Factory (string path) commands, per collection's pattern.
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

// gate.open/reject/get/list never touch relay; sign does (excluded from this suite).
const stubRelay = { call: async () => { throw new Error('relay.call must not be reached in this suite'); } };

const byName = Object.fromEntries(introspection.map((m) => [m.name, m]));
const method = (n) => byName[n];

const OP = [{ op: 'UPDATE', field: 'status', oldValue: 'A', newValue: 'B' }];

describe('approval.record.* — actual return satisfies declared returns_schema', () => {
    let record;
    beforeEach(() => { record = createRecordLogic(makeFakeRedis(), { config }); });

    test('request → INIT record matches contract', async () => {
        const rec = await record.request({ target: 'svc-ent-id', payload: OP }, { actor: 'uid-applicant' });
        expect(checkReturn(method('approval.record.request'), rec)).toEqual([]);
        expect(rec.state).toBe('INIT');
        expect(Array.isArray(rec.evidence)).toBe(true);
    });

    test('verify → DISPATCHED record matches contract (different actor than applicant)', async () => {
        const rec = await record.request({ target: 'svc-ent-v', payload: OP }, { actor: 'uid-applicant' });
        const verified = await record.verify({ id: rec.id }, { actor: 'uid-verifier' });
        expect(checkReturn(method('approval.record.verify'), verified)).toEqual([]);
        expect(verified.state).toBe('DISPATCHED');
    });

    test('confirm → DONE record matches contract; confirmedAt is numeric', async () => {
        const rec = await record.request({ target: 'svc-ent-c', payload: OP }, { actor: 'uid-applicant' });
        await record.verify({ id: rec.id }, { actor: 'uid-verifier' });
        const confirmed = await record.confirm({ id: rec.id }, { actor: 'uid-confirmer' });
        expect(checkReturn(method('approval.record.confirm'), confirmed)).toEqual([]);
        expect(confirmed.state).toBe('DONE');
        expect(typeof confirmed.confirmedAt).toBe('number');
    });

    test('reject → REJECTED record matches contract', async () => {
        const rec = await record.request({ target: 'svc-ent-r', payload: OP }, { actor: 'uid-applicant' });
        const rejected = await record.reject({ id: rec.id, reason: 'nope' }, { actor: 'uid-verifier' });
        expect(checkReturn(method('approval.record.reject'), rejected)).toEqual([]);
        expect(rejected.state).toBe('REJECTED');
    });

    test('get → full record matches contract', async () => {
        const rec = await record.request({ target: 'svc-ent-g', payload: OP }, { actor: 'uid-applicant' });
        const got = await record.get({ id: rec.id });
        expect(checkReturn(method('approval.record.get'), got)).toEqual([]);
        expect(got.target).toBe('svc-ent-g');
    });

    test('list → matches {items, total} contract', async () => {
        await record.request({ target: 'svc-ent-l1', payload: OP }, { actor: 'uid-a' });
        await record.request({ target: 'svc-ent-l2', payload: OP }, { actor: 'uid-a' });
        const res = await record.list({});
        expect(checkReturn(method('approval.record.list'), res)).toEqual([]);
        expect(Array.isArray(res.items)).toBe(true);
        expect(typeof res.total).toBe('number');
    });
});

describe('approval.gate.* — actual return satisfies declared returns_schema', () => {
    let gate;
    const DIGEST = 'a'.repeat(64); // 64-hex passes open()'s /^[0-9a-f]{16,128}$/i guard
    beforeEach(() => { gate = createGateLogic(makeFakeRedis(), { config, relay: stubRelay }); });

    test('open → OPEN gate matches contract', async () => {
        const g = await gate.open({ subject: 'workflow:wf-1:v1', digest: DIGEST, requiredSigners: 2, submitterUid: 'uid-sub' });
        expect(checkReturn(method('approval.gate.open'), g)).toEqual([]);
        expect(g.state).toBe('OPEN');
        expect(g.requiredSigners).toBe(2);
        expect(Array.isArray(g.signers)).toBe(true);
        expect(g.approvedAt).toBeNull();
    });

    test('open with default requiredSigners (null submitterUid) still matches contract', async () => {
        const g = await gate.open({ subject: 'workflow:wf-2:v1', digest: DIGEST });
        expect(checkReturn(method('approval.gate.open'), g)).toEqual([]);
        expect(g.requiredSigners).toBe(1);
        expect(g.submitterUid).toBeNull(); // nullable field — contract must not require it
    });

    test('reject → REJECTED gate matches contract', async () => {
        const g = await gate.open({ subject: 'workflow:wf-3:v1', digest: DIGEST });
        const rejected = await gate.reject({ id: g.id, reason: 'risky', byUid: 'uid-admin' });
        expect(checkReturn(method('approval.gate.reject'), rejected)).toEqual([]);
        expect(rejected.state).toBe('REJECTED');
    });

    test('get → full gate matches contract', async () => {
        const g = await gate.open({ subject: 'workflow:wf-4:v1', digest: DIGEST });
        const got = await gate.get({ id: g.id });
        expect(checkReturn(method('approval.gate.get'), got)).toEqual([]);
        expect(got.subject).toBe('workflow:wf-4:v1');
    });

    test('list → matches {items, total} contract', async () => {
        await gate.open({ subject: 'workflow:wf-5:v1', digest: DIGEST });
        await gate.open({ subject: 'workflow:wf-6:v1', digest: DIGEST });
        const res = await gate.list({});
        expect(checkReturn(method('approval.gate.list'), res)).toEqual([]);
        expect(Array.isArray(res.items)).toBe(true);
        expect(typeof res.total).toBe('number');
    });
});
