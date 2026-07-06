/**
 * returns-contract.test.js — proves nexus.* ACTUAL handler output satisfies the declared
 * return contract (introspection `returns_schema`). Hermetic: real logic over an injected
 * Map/object-backed fake Redis (the sentinel.test.js / collection contract pattern). No
 * stack, no live Redis, no RedisJSON.
 *
 * Why this matters: orchestration / fulfillment / AI bind to these shapes via the
 * returns_schema. The schema MUST mirror what the handler actually returns today — so this
 * asserts checkReturn(method, actualResult) === [] for every hermetically-callable method.
 *
 * Methods that need an LLM / outbound RPC / real RedisJSON / multi-service seeding are not
 * forced in here — they're listed in the task's `unverified` and their schema is
 * static-derived from reading the handler.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-nexus-contract-${process.pid}`);

const createSentinel = require('../logic/sentinel');
const createSchedule = require('../logic/schedule');
const createControl  = require('../logic/control');
const createDlq      = require('../logic/dlq');
const createEvents   = require('../logic/events');
const createIdentity = require('../logic/identity');
const config = require('../config');
const { checkReturn } = require('../../../library/contract');
const introspection = require('../handlers/introspection');

const byName = Object.fromEntries(introspection.map((m) => [m.name, m]));
const method = (n) => byName[n];

// --- fake redis — covers the string/set/stream/zset/scan/RedisJSON surface the nexus
//     logic modules touch. Backed by plain Maps; RedisJSON modeled as plain JSON in kv. ---
function makeFakeRedis() {
    const kv = new Map();      // string keys (incl. RedisJSON docs, stored as live objects)
    const sets = new Map();
    const hashes = new Map();
    const streams = new Map(); // key -> [{ id, message }]
    const groups = [];
    let seq = 0;
    const getSet = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));
    const getStream = (k) => (streams.has(k) ? streams.get(k) : streams.set(k, []).get(k));
    const apply = {
        set: (k, v, o) => { if (o && o.NX && kv.has(k)) return null; kv.set(k, v); return 'OK'; },
        del: (k) => { const had = kv.has(k); kv.delete(k); sets.delete(k); hashes.delete(k); return had ? 1 : 0; },
        sAdd: (k, m) => { const s = getSet(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        sRem: (k, m) => { const s = sets.get(k); return s && s.delete(m) ? 1 : 0; },
    };
    return {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v, o) { return apply.set(k, v, o); },
        async del(k) { return apply.del(k); },
        async exists(k) { return kv.has(k) || sets.has(k) || hashes.has(k) ? 1 : 0; },
        async mGet(keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
        async sAdd(k, m) { return apply.sAdd(k, m); },
        async sRem(k, m) { return apply.sRem(k, m); },
        async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
        async hGetAll(k) { return hashes.has(k) ? { ...hashes.get(k) } : {}; },
        async xGroupCreate(stream) { groups.push(stream); return 'OK'; },
        async zAdd() { return 1; },
        async zRem() { return 1; },
        async keys(pattern) {
            // only the `${prefix}*` form is used (schedule.list)
            const star = pattern.indexOf('*');
            const prefix = star >= 0 ? pattern.slice(0, star) : pattern;
            return [...kv.keys()].filter((k) => k.startsWith(prefix));
        },
        json: {
            async get(k) { return kv.has(k) ? kv.get(k) : null; },
            async set(k, _pathExpr, v) { kv.set(k, v); return 'OK'; },
            async del(k) { return apply.del(k); },
        },
        async xAdd(stream, _star, fields) { const id = `${Date.now()}-${seq++}`; getStream(stream).push({ id, message: { ...fields } }); return id; },
        async xDel(stream, id) { const s = getStream(stream); const i = s.findIndex((e) => e.id === id); if (i >= 0) { s.splice(i, 1); return 1; } return 0; },
        async xRange(stream, start, end) {
            const s = streams.get(stream) || [];
            if (start === '-' && end === '+') return s.map((e) => ({ ...e }));
            return s.filter((e) => e.id === start).map((e) => ({ ...e })); // id..id single-entry lookup
        },
        async xLen(stream) { return (streams.get(stream) || []).length; },
        async xRevRange(stream, _plus, _minus, { COUNT } = {}) {
            const s = (streams.get(stream) || []).slice().reverse();
            return (COUNT ? s.slice(0, COUNT) : s).map((e) => ({ ...e }));
        },
        async *scanIterator({ MATCH }) {
            const star = MATCH.indexOf('*');
            const prefix = star >= 0 ? MATCH.slice(0, star) : MATCH;
            for (const k of streams.keys()) if (k.startsWith(prefix)) yield k;
        },
        multi() {
            const ops = [];
            const chain = {
                set(k, v, o) { ops.push(['set', k, v, o]); return chain; },
                del(k) { ops.push(['del', k]); return chain; },
                sAdd(k, m) { ops.push(['sAdd', k, m]); return chain; },
                sRem(k, m) { ops.push(['sRem', k, m]); return chain; },
                async exec() { return ops.map(([op, ...args]) => apply[op](...args)); },
            };
            return chain;
        },
        _hashes: hashes,
        _streams: streams,
    };
}

// A stub relay sufficient for sentinel.broadcast's polling path (no .call invoked there)
// and for token-store assertions below.
const stubRelay = { async call() { return {}; }, async callAs() { return {}; } };

describe('nexus.* — actual return satisfies declared returns_schema', () => {
    let redis, sentinel, schedule, control, dlq, events, identity;
    beforeEach(() => {
        redis    = makeFakeRedis();
        identity = createIdentity(redis, config, { relay: stubRelay });
        sentinel = createSentinel(redis, config, { relay: stubRelay, identity });
        schedule = createSchedule(redis, { config });
        control  = createControl(redis, config);
        dlq      = createDlq(redis, config);
        events   = createEvents(redis, { config });
    });

    // ---- sentinel ----
    test('sentinel.create → contract', async () => {
        const r = await sentinel.create({ name: 's1', authorityRole: 'role:a', eventSubscriptions: ['EVENT:A'] });
        expect(checkReturn(method('nexus.sentinel.create'), r)).toEqual([]);
        expect(r.status).toBe('ACTIVE');
    });

    test('sentinel.get → contract (full profile + online/identity/activity)', async () => {
        const c = await sentinel.create({ name: 's2', authorityRole: 'role:b' });
        const g = await sentinel.get({ id: c.id });
        expect(checkReturn(method('nexus.sentinel.get'), g)).toEqual([]);
        expect(typeof g.online).toBe('boolean');
        expect(typeof g.identity).toBe('object');
    });

    test('sentinel.list → {items,total} contract', async () => {
        await sentinel.create({ name: 's3', authorityRole: 'r' });
        const res = await sentinel.list({});
        expect(checkReturn(method('nexus.sentinel.list'), res)).toEqual([]);
        expect(Array.isArray(res.items)).toBe(true);
        expect(typeof res.total).toBe('number');
    });

    test('sentinel.update → full-profile contract', async () => {
        const c = await sentinel.create({ name: 's4', authorityRole: 'r', eventSubscriptions: ['EVENT:OLD'] });
        const u = await sentinel.update({ id: c.id, name: 's4b', eventSubscriptions: ['EVENT:NEW'] });
        expect(checkReturn(method('nexus.sentinel.update'), u)).toEqual([]);
        expect(u.name).toBe('s4b');
        expect(typeof u.updatedAt).toBe('number');
    });

    test('sentinel.disable / enable → {id,status} contract (both paths)', async () => {
        const c = await sentinel.create({ name: 's5', authorityRole: 'r', eventSubscriptions: ['EVENT:X'] });
        const d = await sentinel.disable({ id: c.id });
        expect(checkReturn(method('nexus.sentinel.disable'), d)).toEqual([]);
        expect(d.status).toBe('DISABLED');
        // idempotent already-DISABLED path
        const d2 = await sentinel.disable({ id: c.id });
        expect(checkReturn(method('nexus.sentinel.disable'), d2)).toEqual([]);

        const e = await sentinel.enable({ id: c.id });
        expect(checkReturn(method('nexus.sentinel.enable'), e)).toEqual([]);
        expect(e.status).toBe('ACTIVE');
        const e2 = await sentinel.enable({ id: c.id }); // idempotent already-ACTIVE
        expect(checkReturn(method('nexus.sentinel.enable'), e2)).toEqual([]);
    });

    test('sentinel.delete → {id,deleted} contract', async () => {
        const c = await sentinel.create({ name: 's6', authorityRole: 'r' });
        const r = await sentinel.remove({ id: c.id });
        expect(checkReturn(method('nexus.sentinel.delete'), r)).toEqual([]);
        expect(r.deleted).toBe(true);
    });

    test('sentinel.heartbeat → {sentinelId,expiresInSeconds} contract', async () => {
        const c = await sentinel.create({ name: 's7', authorityRole: 'r' });
        const h = await sentinel.heartbeat({ sentinelId: c.id });
        expect(checkReturn(method('nexus.sentinel.heartbeat'), h)).toEqual([]);
        expect(typeof h.expiresInSeconds).toBe('number');
    });

    test('sentinel.resolve → {sentinels} contract', async () => {
        await sentinel.create({ name: 's8', authorityRole: 'r', eventSubscriptions: ['EVENT:R'] });
        const r = await sentinel.resolve({ event: 'EVENT:R' });
        expect(checkReturn(method('nexus.sentinel.resolve'), r)).toEqual([]);
        expect(Array.isArray(r.sentinels)).toBe(true);
    });

    test('sentinel.broadcast → {id,broadcasted,reason} contract (no-config polling path)', async () => {
        const c = await sentinel.create({ name: 's9', authorityRole: 'r', reachability: 'polling' });
        const b = await sentinel.broadcast({ id: c.id });
        expect(checkReturn(method('nexus.sentinel.broadcast'), b)).toEqual([]);
        expect(b.broadcasted).toBe(false);
    });

    // ---- identity (nexus.sentinel.token.set) ----
    test('sentinel.token.set → {ok} contract', async () => {
        const r = await identity.setToken({ authorityRole: 'system.foo', token: 'tok', expiresAt: Date.now() + 1e6 });
        expect(checkReturn(method('nexus.sentinel.token.set'), r)).toEqual([]);
        expect(r.ok).toBe(true);
    });

    // ---- token relay wrappers (index.js returns literal {ok:true}) ----
    test('token.set / token.clear → {ok} contract (index.js literal wrap)', () => {
        // index.js: nexus.token.set → `{ ok: true }`; nexus.token.clear → `{ ok: true }`
        expect(checkReturn(method('nexus.token.set'), { ok: true })).toEqual([]);
        expect(checkReturn(method('nexus.token.clear'), { ok: true })).toEqual([]);
    });

    test('token.status → no-token path is {hasToken:false} (conditional-key honesty)', () => {
        // relay.status() returns ONLY { hasToken:false } when no token is set — only
        // hasToken is required by the contract, so this minimal shape must pass.
        expect(checkReturn(method('nexus.token.status'), { hasToken: false })).toEqual([]);
        // token-present shape also satisfies it.
        expect(checkReturn(method('nexus.token.status'), {
            hasToken: true, sub: 'system.nexus', expiresAt: 1, ttlMs: 1, lastRefreshAt: 0, needsRotation: false, expired: false,
        })).toEqual([]);
    });

    // ---- control ----
    test('control.pause/resume/status → {paused} contract', async () => {
        expect(checkReturn(method('nexus.control.pause'),  await control.pause())).toEqual([]);
        expect(checkReturn(method('nexus.control.status'), await control.status())).toEqual([]);
        expect(checkReturn(method('nexus.control.resume'), await control.resume())).toEqual([]);
    });

    // ---- schedule ----
    test('schedule.create/get/update/delete → contract; list is a bare array (no object-key contract)', async () => {
        const action = { kind: 'emit_event', stream: 'EVENT:T', type: 'TICK' };
        const c = await schedule.create({ schedule_id: 'sch-1', fire_at: Date.now() + 1000, action });
        expect(checkReturn(method('nexus.schedule.create'), c)).toEqual([]);

        const g = await schedule.get('sch-1');
        expect(checkReturn(method('nexus.schedule.get'), g)).toEqual([]);

        const u = await schedule.update('sch-1', { enabled: false });
        expect(checkReturn(method('nexus.schedule.update'), u)).toEqual([]);
        expect(u.enabled).toBe(false);

        // list returns a BARE ARRAY → declared via bareArrayMethods (no returns_schema).
        const lst = await schedule.list();
        expect(Array.isArray(lst)).toBe(true);

        const d = await schedule.delete('sch-1');
        expect(checkReturn(method('nexus.schedule.delete'), d)).toEqual([]);
        expect(d.ok).toBe(true);
    });

    // ---- dlq ----
    test('dlq.list → {items,total}; dlq.retry → {retried,sourceStream,newId}', async () => {
        const empty = await dlq.list({});
        expect(checkReturn(method('nexus.dlq.list'), empty)).toEqual([]);

        // Seed one DLQ entry directly into the stream, then retry it.
        const id = await redis.xAdd(config.redis.dlqStream, '*', {
            sourceStream: 'EVENT:SRC', sourceId: '1-0', attempts: '3', failedAt: String(Date.now()),
            event: JSON.stringify({ type: 'X', foo: 'bar' }),
        });
        const listed = await dlq.list({});
        expect(checkReturn(method('nexus.dlq.list'), listed)).toEqual([]);
        expect(listed.total).toBe(1);

        const r = await dlq.retry({ id });
        expect(checkReturn(method('nexus.dlq.retry'), r)).toEqual([]);
        expect(r.retried).toBe(true);
        expect(r.sourceStream).toBe('EVENT:SRC');
    });

    // ---- events (read-only bus observability) ----
    test('event.streams → {items,truncated}; event.recent → {stream,entries}', async () => {
        await redis.xAdd('EVENT:DEMO', '*', { type: 'HELLO', payload: JSON.stringify({ a: 1 }) });

        const s = await events.streams();
        expect(checkReturn(method('nexus.event.streams'), s)).toEqual([]);
        expect(Array.isArray(s.items)).toBe(true);
        expect(typeof s.truncated).toBe('boolean');

        const rec = await events.recent({ stream: 'EVENT:DEMO' });
        expect(checkReturn(method('nexus.event.recent'), rec)).toEqual([]);
        expect(rec.stream).toBe('EVENT:DEMO');
        expect(Array.isArray(rec.entries)).toBe(true);
    });
});
