/**
 * Companion coverage test for api/library/optimistic.js.
 *
 * The sibling optimistic.test.js exercises the core happy/retry/exhaustion paths
 * of optimisticUpdate (string variant). This file closes the remaining gaps so the
 * module reaches 100% in isolation:
 *
 *   - optimisticJsonUpdate (RedisJSON variant) — completely untested otherwise:
 *     degraded + transactional, missing-doc (null AND undefined), EXEC-null retry,
 *     WatchError / message-WATCH / generic / falsy-throw, exhaustion, onMulti hook
 *     (tx + degraded shim with chaining), unwatch/quit cleanup-rejection swallowing.
 *   - optimisticUpdate (string variant) leftovers: the on('error') handler, the
 *     unwatch()/quit() `.catch` arrows, the onMulti hook on the tx path, the
 *     `/WATCH/.test(message)` conflict branch, the empty-message `|| ''` branch,
 *     the missing-via-undefined branch, and the falsy-thrown-value guard.
 *
 * Hermetic: a controllable fake redis (no network, no RedisJSON). Math.random is
 * pinned to 0 so backoff sleeps are sleep(0) — deterministic, no wall-clock wait.
 */
const { optimisticUpdate, optimisticJsonUpdate } = require('../optimistic');

let randomSpy;
beforeAll(() => { randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0); });
afterAll(() => { randomSpy.mockRestore(); });

// Capture a rejection without relying on jest's .rejects matcher (which is awkward
// for falsy reasons like `null`).
async function captureReject(p) {
    try { const value = await p; return { threw: false, value }; }
    catch (err) { return { threw: true, err }; }
}

// Shared EXEC simulator. `execOutcomes` is consumed once per commit attempt:
//   'ok' (or empty)  → commit staged writes, return ['OK']
//   null             → EXEC aborted (WATCH conflict)  → retry
//   'watchError'     → throw a WatchError             → retry (name match)
//   'watchMsg'       → throw RedisError w/ "WATCH" in message → retry (regex match)
//   'boom'           → throw RedisError w/ message    → rethrow
//   'boomEmpty'      → throw RedisError w/ '' message → rethrow (covers message||'')
//   'throwNull'      → throw null                     → rethrow (covers `e &&` guard)
function runExec(execOutcomes, stats, pendingWrites, store) {
    stats.execAttempts++;
    const outcome = execOutcomes.length ? execOutcomes.shift() : 'ok';
    if (outcome === 'watchError') { const e = new Error('WATCH conflict'); e.name = 'WatchError'; throw e; }
    if (outcome === 'watchMsg') { const e = new Error('lock under WATCH expired'); e.name = 'RedisError'; throw e; }
    if (outcome === 'boom') { const e = new Error('connection reset'); e.name = 'RedisError'; throw e; }
    if (outcome === 'boomEmpty') { const e = new Error(''); e.name = 'RedisError'; throw e; }
    if (outcome === 'throwNull') { throw null; } // eslint-disable-line no-throw-literal
    if (outcome === null) return null;
    for (const w of pendingWrites) store.set(w[0], w[w.length - 1]); // last elem is the value
    stats.commits++;
    return ['OK'];
}

function newStats() {
    return { duplicates: 0, connects: 0, quits: 0, watches: [], unwatches: 0, execAttempts: 0, commits: 0, onErrorFired: 0 };
}

// --- transactional STRING fake (node-redis v5 surface: get/set + WATCH/MULTI) ---
function fakeStringTx(seed = {}, opts = {}) {
    const store = new Map(Object.entries(seed));
    const execOutcomes = [...(opts.execOutcomes || [])];
    const stats = newStats();
    function makeConn() {
        let pendingWrites = [];
        const conn = {
            on(event, cb) { if (event === 'error') { stats.onErrorFired++; cb(new Error('late conn error (swallowed)')); } return conn; },
            async connect() { stats.connects++; },
            async watch(k) { stats.watches.push(k); },
            async get(k) { return store.has(k) ? store.get(k) : (opts.getUndefined ? undefined : null); },
            async unwatch() { stats.unwatches++; if (opts.unwatchReject) throw new Error('unwatch failed'); },
            multi() {
                pendingWrites = [];
                const tx = {
                    set(k, v) { pendingWrites.push([k, v]); return tx; },
                    exec: async () => runExec(execOutcomes, stats, pendingWrites, store),
                };
                return tx;
            },
            async quit() { stats.quits++; if (opts.quitReject) throw new Error('quit failed'); },
        };
        return conn;
    }
    return {
        store, stats,
        async get(k) { return store.has(k) ? store.get(k) : null; },
        async set(k, v) { store.set(k, v); return 'OK'; },
        async watch() { /* presence gates the tx branch */ },
        duplicate() { stats.duplicates++; return makeConn(); },
    };
}

// --- transactional JSON fake (json.get/json.set + WATCH/MULTI.json.set) ---
function fakeJsonTx(seed = {}, opts = {}) {
    const store = new Map(Object.entries(seed));
    const execOutcomes = [...(opts.execOutcomes || [])];
    const stats = newStats();
    function makeConn() {
        let pendingWrites = [];
        const conn = {
            on(event, cb) { if (event === 'error') { stats.onErrorFired++; cb(new Error('late conn error (swallowed)')); } return conn; },
            async connect() { stats.connects++; },
            async watch(k) { stats.watches.push(k); },
            json: { get: async (k) => (store.has(k) ? store.get(k) : (opts.getUndefined ? undefined : null)) },
            async unwatch() { stats.unwatches++; if (opts.unwatchReject) throw new Error('unwatch failed'); },
            multi() {
                pendingWrites = [];
                const tx = {
                    json: { set: (k, p, v) => { pendingWrites.push([k, p, v]); return tx; } },
                    exec: async () => runExec(execOutcomes, stats, pendingWrites, store),
                };
                return tx;
            },
            async quit() { stats.quits++; if (opts.quitReject) throw new Error('quit failed'); },
        };
        return conn;
    }
    return {
        store, stats,
        json: {
            get: async (k) => (store.has(k) ? store.get(k) : null),
            set: async (k, p, v) => { store.set(k, v); return 'OK'; },
        },
        async watch() { /* presence gates the tx branch */ },
        duplicate() { stats.duplicates++; return makeConn(); },
    };
}

// --- degraded JSON fake (only json.get/json.set; no duplicate/watch by default) ---
function fakeJsonPlain(seed = {}, opts = {}) {
    const store = new Map(Object.entries(seed));
    const redis = {
        store,
        json: {
            get: async (k) => (store.has(k) ? store.get(k) : (opts.getUndefined ? undefined : null)),
            set: async (k, p, v) => { store.set(k, v); return 'OK'; },
        },
    };
    // duplicate present but watch ABSENT → still degraded (right side of the OR).
    if (opts.withDuplicate) redis.duplicate = () => { throw new Error('duplicate must not be reached when watch absent'); };
    return redis;
}

// ===========================================================================
describe('optimisticUpdate — string variant: remaining branches/handlers', () => {
    test('tx onMulti appends to the SAME multi and commits atomically; on(error) handler is wired', async () => {
        const redis = fakeStringTx({ k: JSON.stringify({ n: 1 }) });
        let hookArgs;
        const next = await optimisticUpdate(redis, 'k', (c) => ({ n: c.n + 1 }), {
            onMulti: (multi, ctx) => { hookArgs = ctx; multi.set('audit:k', JSON.stringify({ from: ctx.before.n, to: ctx.next.n })); },
        });
        expect(next).toEqual({ n: 2 });
        expect(hookArgs).toEqual({ before: { n: 1 }, next: { n: 2 } });
        expect(JSON.parse(redis.store.get('k'))).toEqual({ n: 2 });
        expect(JSON.parse(redis.store.get('audit:k'))).toEqual({ from: 1, to: 2 }); // rode the same EXEC
        expect(redis.stats.onErrorFired).toBe(1); // c.on('error', ...) registered + invoked
    });

    test('tx missing key via undefined get → null; unwatch() rejection is swallowed', async () => {
        const redis = fakeStringTx({}, { getUndefined: true, unwatchReject: true });
        const mutate = jest.fn();
        const res = await optimisticUpdate(redis, 'gone', mutate);
        expect(res).toBeNull();
        expect(mutate).not.toHaveBeenCalled();
        expect(redis.stats.unwatches).toBe(1);
        expect(redis.stats.quits).toBe(1);
    });

    test('tx quit() rejection during cleanup is swallowed; result still returned', async () => {
        const redis = fakeStringTx({ k: JSON.stringify({ n: 0 }) }, { quitReject: true });
        const next = await optimisticUpdate(redis, 'k', (c) => ({ n: c.n + 1 }));
        expect(next).toEqual({ n: 1 });
        expect(redis.stats.quits).toBe(1);
    });

    test('non-WatchError whose MESSAGE matches /WATCH/ is treated as a conflict → retry then commit', async () => {
        const redis = fakeStringTx({ k: JSON.stringify({ n: 0 }) }, { execOutcomes: ['watchMsg', 'ok'] });
        const next = await optimisticUpdate(redis, 'k', (c) => ({ n: c.n + 1 }));
        expect(next).toEqual({ n: 1 });
        expect(redis.stats.execAttempts).toBe(2);
    });

    test('error with empty message + non-WATCH name → rethrown (covers `e.message || ""`)', async () => {
        const redis = fakeStringTx({ k: JSON.stringify({ n: 0 }) }, { execOutcomes: ['boomEmpty'] });
        const { threw, err } = await captureReject(optimisticUpdate(redis, 'k', (c) => ({ n: c.n + 1 })));
        expect(threw).toBe(true);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('');
        expect(redis.stats.quits).toBe(1);
    });

    test('a falsy thrown value (null) bypasses the conflict guard and is rethrown', async () => {
        const redis = fakeStringTx({ k: JSON.stringify({ n: 0 }) }, { execOutcomes: ['throwNull'] });
        const { threw, err } = await captureReject(optimisticUpdate(redis, 'k', (c) => ({ n: c.n + 1 })));
        expect(threw).toBe(true);
        expect(err).toBeNull();
        expect(redis.stats.quits).toBe(1);
    });
});

// ===========================================================================
describe('optimisticJsonUpdate — degraded client (no transactions)', () => {
    test('happy path: json.get → mutate → json.set, returns next, no onMulti', async () => {
        const redis = fakeJsonPlain({ k: { id: 'k', n: 1 } });
        let seen;
        const next = await optimisticJsonUpdate(redis, 'k', (doc) => { seen = doc; return { ...doc, n: doc.n + 1 }; });
        expect(seen).toEqual({ id: 'k', n: 1 });
        expect(next).toEqual({ id: 'k', n: 2 });
        expect(redis.store.get('k')).toEqual({ id: 'k', n: 2 });
    });

    test('missing doc (json.get → null) → null, mutate never called', async () => {
        const redis = fakeJsonPlain();
        const mutate = jest.fn();
        await expect(optimisticJsonUpdate(redis, 'absent', mutate)).resolves.toBeNull();
        expect(mutate).not.toHaveBeenCalled();
    });

    test('missing doc (json.get → undefined) → null', async () => {
        const redis = fakeJsonPlain({}, { getUndefined: true });
        const mutate = jest.fn();
        await expect(optimisticJsonUpdate(redis, 'absent', mutate)).resolves.toBeNull();
        expect(mutate).not.toHaveBeenCalled();
    });

    test('onMulti shim runs json.set side-writes (await Promise.all) and supports chaining', async () => {
        const redis = fakeJsonPlain({ k: { n: 1 } });
        let hookArgs;
        const next = await optimisticJsonUpdate(redis, 'k', (d) => ({ n: d.n + 1 }), {
            onMulti: (shim, ctx) => {
                hookArgs = ctx;
                const ret = shim.json.set('snap:k', '$', { v: ctx.next.n }).json.set('snap:k2', '$', { v: ctx.before.n });
                expect(ret).toBe(shim); // shim.json.set returns the shim (chainable)
            },
        });
        expect(next).toEqual({ n: 2 });
        expect(hookArgs).toEqual({ before: { n: 1 }, next: { n: 2 } });
        expect(redis.store.get('k')).toEqual({ n: 2 });
        expect(redis.store.get('snap:k')).toEqual({ v: 2 });   // side-write flushed
        expect(redis.store.get('snap:k2')).toEqual({ v: 1 });  // chained side-write flushed
    });

    test('client with duplicate() but no watch still uses the degraded branch (OR right side)', async () => {
        const redis = fakeJsonPlain({ k: { v: 0 } }, { withDuplicate: true });
        const next = await optimisticJsonUpdate(redis, 'k', (d) => ({ v: d.v + 1 }));
        expect(next).toEqual({ v: 1 });
        expect(redis.store.get('k')).toEqual({ v: 1 });
    });
});

// ===========================================================================
describe('optimisticJsonUpdate — transactional client (WATCH/MULTI.json.set/EXEC)', () => {
    test('happy path: duplicates an isolated conn, watches, commits via json.set, quits', async () => {
        const redis = fakeJsonTx({ k: { id: 'k', n: 5 } });
        const next = await optimisticJsonUpdate(redis, 'k', (d) => ({ ...d, n: d.n + 1 }));
        expect(next).toEqual({ id: 'k', n: 6 });
        expect(redis.store.get('k')).toEqual({ id: 'k', n: 6 });
        expect(redis.stats.duplicates).toBe(1);
        expect(redis.stats.connects).toBe(1);
        expect(redis.stats.watches).toEqual(['k']);
        expect(redis.stats.execAttempts).toBe(1);
        expect(redis.stats.quits).toBe(1);
        expect(redis.stats.onErrorFired).toBe(1); // on('error') handler wired
    });

    test('missing doc (null) → unwatch + null; unwatch rejection swallowed; conn still quit', async () => {
        const redis = fakeJsonTx({}, { unwatchReject: true });
        const mutate = jest.fn();
        const res = await optimisticJsonUpdate(redis, 'absent', mutate);
        expect(res).toBeNull();
        expect(mutate).not.toHaveBeenCalled();
        expect(redis.stats.watches).toEqual(['absent']);
        expect(redis.stats.unwatches).toBe(1);
        expect(redis.stats.execAttempts).toBe(0);
        expect(redis.stats.quits).toBe(1);
    });

    test('missing doc (undefined) → null', async () => {
        const redis = fakeJsonTx({}, { getUndefined: true });
        await expect(optimisticJsonUpdate(redis, 'absent', () => ({}))).resolves.toBeNull();
        expect(redis.stats.unwatches).toBe(1);
    });

    test('EXEC returns null (conflict) → retries, then commits; mutate re-run, conn reused', async () => {
        const redis = fakeJsonTx({ k: { n: 0 } }, { execOutcomes: [null, 'ok'] });
        const mutate = jest.fn((d) => ({ n: d.n + 1 }));
        const next = await optimisticJsonUpdate(redis, 'k', mutate);
        expect(next).toEqual({ n: 1 });
        expect(redis.stats.execAttempts).toBe(2);
        expect(mutate).toHaveBeenCalledTimes(2);
        expect(redis.stats.watches).toEqual(['k', 'k']);
        expect(redis.stats.duplicates).toBe(1);
        expect(redis.store.get('k')).toEqual({ n: 1 });
    });

    test('exec throws WatchError → conflict → retries and succeeds', async () => {
        const redis = fakeJsonTx({ k: { n: 10 } }, { execOutcomes: ['watchError', 'ok'] });
        const next = await optimisticJsonUpdate(redis, 'k', (d) => ({ n: d.n + 1 }));
        expect(next).toEqual({ n: 11 });
        expect(redis.stats.execAttempts).toBe(2);
    });

    test('non-WatchError whose MESSAGE matches /WATCH/ → retries and succeeds', async () => {
        const redis = fakeJsonTx({ k: { n: 0 } }, { execOutcomes: ['watchMsg', 'ok'] });
        const next = await optimisticJsonUpdate(redis, 'k', (d) => ({ n: d.n + 1 }));
        expect(next).toEqual({ n: 1 });
        expect(redis.stats.execAttempts).toBe(2);
    });

    test('generic error (non-WATCH, with message) → rethrown; conn still quit; doc unchanged', async () => {
        const redis = fakeJsonTx({ k: { n: 1 } }, { execOutcomes: ['boom'] });
        const { threw, err } = await captureReject(optimisticJsonUpdate(redis, 'k', (d) => ({ n: d.n + 1 })));
        expect(threw).toBe(true);
        expect(err.message).toBe('connection reset');
        expect(redis.stats.quits).toBe(1);
        expect(redis.store.get('k')).toEqual({ n: 1 });
    });

    test('error with empty message + non-WATCH name → rethrown (covers `e.message || ""`)', async () => {
        const redis = fakeJsonTx({ k: { n: 0 } }, { execOutcomes: ['boomEmpty'] });
        const { threw, err } = await captureReject(optimisticJsonUpdate(redis, 'k', (d) => ({ n: d.n + 1 })));
        expect(threw).toBe(true);
        expect(err.message).toBe('');
        expect(redis.stats.quits).toBe(1);
    });

    test('a falsy thrown value (null) bypasses the conflict guard → rethrown', async () => {
        const redis = fakeJsonTx({ k: { n: 0 } }, { execOutcomes: ['throwNull'] });
        const { threw, err } = await captureReject(optimisticJsonUpdate(redis, 'k', (d) => ({ n: d.n + 1 })));
        expect(threw).toBe(true);
        expect(err).toBeNull();
        expect(redis.stats.quits).toBe(1);
    });

    test('exceeds maxRetries (all attempts abort) → throws with key + count, conn quit, never committed', async () => {
        const redis = fakeJsonTx({ k: { n: 0 } }, { execOutcomes: [null, null, null] });
        await expect(
            optimisticJsonUpdate(redis, 'k', (d) => ({ n: d.n + 1 }), { maxRetries: 3 }),
        ).rejects.toThrow('optimisticJsonUpdate: exceeded 3 retries for k');
        expect(redis.stats.execAttempts).toBe(3);
        expect(redis.stats.quits).toBe(1);
        expect(redis.store.get('k')).toEqual({ n: 0 });
    });

    test('onMulti appends json.set to the SAME multi; version snapshot commits atomically', async () => {
        const redis = fakeJsonTx({ k: { n: 1 } });
        let hookArgs;
        const next = await optimisticJsonUpdate(redis, 'k', (d) => ({ n: d.n + 1 }), {
            onMulti: (multi, ctx) => { hookArgs = ctx; multi.json.set('ver:k', '$', { from: ctx.before.n, to: ctx.next.n }); },
        });
        expect(next).toEqual({ n: 2 });
        expect(hookArgs).toEqual({ before: { n: 1 }, next: { n: 2 } });
        expect(redis.store.get('k')).toEqual({ n: 2 });
        expect(redis.store.get('ver:k')).toEqual({ from: 1, to: 2 });
    });

    test('quit() rejection during cleanup is swallowed; result still returned', async () => {
        const redis = fakeJsonTx({ k: { n: 0 } }, { quitReject: true });
        const next = await optimisticJsonUpdate(redis, 'k', (d) => ({ n: d.n + 1 }));
        expect(next).toEqual({ n: 1 });
        expect(redis.stats.quits).toBe(1);
    });

    test('default maxRetries (50) tolerates many conflicts before success', async () => {
        const outcomes = Array(49).fill(null).concat(['ok']);
        const redis = fakeJsonTx({ k: { n: 0 } }, { execOutcomes: outcomes });
        const next = await optimisticJsonUpdate(redis, 'k', (d) => ({ n: d.n + 1 }));
        expect(next).toEqual({ n: 1 });
        expect(redis.stats.execAttempts).toBe(50);
    });
});
