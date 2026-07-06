/**
 * Hermetic unit test for api/library/optimistic.js — atomic read-modify-write
 * via Redis WATCH/MULTI optimistic CAS.
 *
 * No real redis, no network, no sleeps that matter, no wall-clock / randomness
 * dependence. Two client shapes are exercised:
 *
 *   1. "degraded" client (no .duplicate / .watch)        → plain read-modify-write
 *   2. "transactional" client (has .duplicate + .watch)  → WATCH/MULTI/EXEC + retry
 *
 * Backoff inside the module calls sleep(Math.floor(Math.random()*6)). We pin
 * Math.random to 0 so every backoff is sleep(0) — deterministic, resolves on the
 * next microtask tick, no real wall-time wait of any consequence.
 */
const { optimisticUpdate } = require('../optimistic');

// ---- pin randomness so retry backoff is deterministic (sleep(0)) ----------
let randomSpy;
beforeAll(() => { randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0); });
afterAll(() => { randomSpy.mockRestore(); });

// ---------------------------------------------------------------------------
// Fake #1: degraded client — only get/set. Triggers the no-transaction branch
// (typeof redis.duplicate !== 'function').
// ---------------------------------------------------------------------------
function fakeRedisPlain(seed = {}) {
    const store = new Map(Object.entries(seed));
    return {
        store,
        async get(k) { return store.has(k) ? store.get(k) : null; },
        async set(k, v) { store.set(k, v); return 'OK'; },
    };
}

// ---------------------------------------------------------------------------
// Fake #2: transactional client modeled on node-redis v5 surface used by the
// module: duplicate() → an isolated connection exposing connect/watch/get/
// unwatch/multi/quit. The duplicated connection's .multi().set().exec() is what
// commits; we can make exec() return null (EXEC aborted) or throw a WatchError
// to drive the retry path deterministically.
//
// `execOutcomes` is a queue consumed once per commit attempt:
//   - 'ok'         → exec succeeds (returns ['OK']) and the write is applied
//   - null         → exec returns null (WATCH conflict / EXEC aborted) → retry
//   - 'watchError' → exec throws a WatchError                          → retry
//   - 'boom'       → exec throws a generic error                       → rethrow
// Default (queue empty) is 'ok'.
// ---------------------------------------------------------------------------
function fakeRedisTx(seed = {}, opts = {}) {
    const store = new Map(Object.entries(seed));
    const execOutcomes = [...(opts.execOutcomes || [])];
    const stats = {
        duplicates: 0,
        connects: 0,
        quits: 0,
        watches: [],
        unwatches: 0,
        execAttempts: 0,
        mutateApplied: 0,
        // simulate a concurrent writer that mutates the key between watch and exec
    };

    function makeConn() {
        let watched = null;
        let pendingWrite = null; // [key, value] staged by multi().set()
        const conn = {
            on() { return conn; },
            async connect() { stats.connects++; },
            async watch(k) { watched = k; stats.watches.push(k); },
            async get(k) { return store.has(k) ? store.get(k) : null; },
            async unwatch() { stats.unwatches++; watched = null; },
            multi() {
                pendingWrite = null;
                const tx = {
                    set(k, v) { pendingWrite = [k, v]; return tx; },
                    async exec() {
                        stats.execAttempts++;
                        const outcome = execOutcomes.length ? execOutcomes.shift() : 'ok';
                        if (outcome === 'watchError') {
                            const e = new Error('WATCH conflict'); e.name = 'WatchError'; throw e;
                        }
                        if (outcome === 'boom') {
                            const e = new Error('connection reset'); e.name = 'RedisError'; throw e;
                        }
                        if (outcome === null) {
                            // EXEC aborted: write NOT applied, returns null.
                            return null;
                        }
                        // 'ok' → apply staged write, return redis-style reply.
                        if (pendingWrite) { store.set(pendingWrite[0], pendingWrite[1]); stats.mutateApplied++; }
                        return ['OK'];
                    },
                };
                return tx;
            },
            async quit() { stats.quits++; },
        };
        return conn;
    }

    const redis = {
        store,
        stats,
        // base-connection methods (presence of .watch gates the branch too)
        async get(k) { return store.has(k) ? store.get(k) : null; },
        async set(k, v) { store.set(k, v); return 'OK'; },
        async watch() { /* base watch only needs to EXIST for the branch check */ },
        duplicate() { stats.duplicates++; return makeConn(); },
    };
    return redis;
}

// ===========================================================================
describe('optimisticUpdate — degraded client (no transactions)', () => {
    test('happy path: reads, applies mutate, writes JSON back, returns next', async () => {
        const redis = fakeRedisPlain({ k: JSON.stringify({ id: 'k', n: 1 }) });
        let seenArg;
        const next = await optimisticUpdate(redis, 'k', (cur) => {
            seenArg = cur;
            return { ...cur, n: cur.n + 1 };
        });
        expect(seenArg).toEqual({ id: 'k', n: 1 });           // mutate got the parsed existing
        expect(next).toEqual({ id: 'k', n: 2 });              // returns the new object
        expect(JSON.parse(redis.store.get('k'))).toEqual({ id: 'k', n: 2 }); // persisted as JSON
    });

    test('missing key → returns null and mutate is never called', async () => {
        const redis = fakeRedisPlain();
        const mutate = jest.fn(() => ({ should: 'not happen' }));
        const res = await optimisticUpdate(redis, 'absent', mutate);
        expect(res).toBeNull();
        expect(mutate).not.toHaveBeenCalled();
        expect(redis.store.has('absent')).toBe(false);        // nothing written
    });

    test('mutate can return a wholly new shape; it is what gets stored', async () => {
        const redis = fakeRedisPlain({ k: JSON.stringify({ a: 1 }) });
        const next = await optimisticUpdate(redis, 'k', () => ({ replaced: true, list: [1, 2] }));
        expect(next).toEqual({ replaced: true, list: [1, 2] });
        expect(JSON.parse(redis.store.get('k'))).toEqual({ replaced: true, list: [1, 2] });
    });

    test('value undefined (get resolves undefined) is treated as missing → null', async () => {
        const redis = {
            store: new Map(),
            async get() { return undefined; },
            async set() { throw new Error('set must not be called'); },
        };
        const mutate = jest.fn();
        await expect(optimisticUpdate(redis, 'k', mutate)).resolves.toBeNull();
        expect(mutate).not.toHaveBeenCalled();
    });

    test('client with get/set but no .watch still uses the degraded branch', async () => {
        // has duplicate but NO watch → branch condition is OR, so still degraded.
        const redis = fakeRedisPlain({ k: JSON.stringify({ v: 0 }) });
        redis.duplicate = () => { throw new Error('duplicate must not be reached when watch absent'); };
        const next = await optimisticUpdate(redis, 'k', (c) => ({ v: c.v + 1 }));
        expect(next).toEqual({ v: 1 });
        expect(JSON.parse(redis.store.get('k'))).toEqual({ v: 1 });
    });
});

// ===========================================================================
describe('optimisticUpdate — transactional client (WATCH/MULTI/EXEC)', () => {
    test('happy path: duplicates an isolated conn, watches, commits, quits', async () => {
        const redis = fakeRedisTx({ k: JSON.stringify({ id: 'k', n: 5 }) });
        const next = await optimisticUpdate(redis, 'k', (c) => ({ ...c, n: c.n + 1 }));
        expect(next).toEqual({ id: 'k', n: 6 });
        expect(JSON.parse(redis.store.get('k'))).toEqual({ id: 'k', n: 6 });

        expect(redis.stats.duplicates).toBe(1);   // one isolated connection
        expect(redis.stats.connects).toBe(1);
        expect(redis.stats.watches).toEqual(['k']); // watched exactly the target key
        expect(redis.stats.execAttempts).toBe(1);   // one successful commit
        expect(redis.stats.quits).toBe(1);          // connection closed (no leak)
    });

    test('missing key on tx path → null, unwatches, never commits, still quits', async () => {
        const redis = fakeRedisTx(); // empty store
        const mutate = jest.fn();
        const res = await optimisticUpdate(redis, 'absent', mutate);
        expect(res).toBeNull();
        expect(mutate).not.toHaveBeenCalled();
        expect(redis.stats.watches).toEqual(['absent']);
        expect(redis.stats.unwatches).toBe(1);   // released the watch
        expect(redis.stats.execAttempts).toBe(0); // never tried to commit
        expect(redis.stats.quits).toBe(1);        // connection still closed
    });

    test('EXEC returns null (concurrent write) → retries, then commits; mutate re-run', async () => {
        // First commit attempt aborts (exec→null), second succeeds.
        const redis = fakeRedisTx(
            { k: JSON.stringify({ n: 0 }) },
            { execOutcomes: [null, 'ok'] },
        );
        const mutate = jest.fn((c) => ({ n: c.n + 1 }));
        const next = await optimisticUpdate(redis, 'k', mutate);

        expect(next).toEqual({ n: 1 });
        expect(redis.stats.execAttempts).toBe(2);   // one aborted + one committed
        expect(mutate).toHaveBeenCalledTimes(2);     // pure fn re-run on retry
        expect(redis.stats.watches).toEqual(['k', 'k']); // re-watched each attempt
        expect(redis.stats.duplicates).toBe(1);      // single connection reused across retries
        expect(redis.stats.quits).toBe(1);
        expect(JSON.parse(redis.store.get('k'))).toEqual({ n: 1 });
    });

    test('exec throws WatchError → treated as conflict, retries and succeeds', async () => {
        const redis = fakeRedisTx(
            { k: JSON.stringify({ n: 10 }) },
            { execOutcomes: ['watchError', 'ok'] },
        );
        const next = await optimisticUpdate(redis, 'k', (c) => ({ n: c.n + 1 }));
        expect(next).toEqual({ n: 11 });
        expect(redis.stats.execAttempts).toBe(2);
        expect(redis.stats.quits).toBe(1);
    });

    test('exec throws a non-WATCH error → rethrown, no swallow, conn still quit', async () => {
        const redis = fakeRedisTx(
            { k: JSON.stringify({ n: 1 }) },
            { execOutcomes: ['boom'] },
        );
        await expect(
            optimisticUpdate(redis, 'k', (c) => ({ n: c.n + 1 })),
        ).rejects.toThrow('connection reset');
        expect(redis.stats.quits).toBe(1);          // finally still closes the connection
        expect(JSON.parse(redis.store.get('k'))).toEqual({ n: 1 }); // unchanged
    });

    test('exceeds maxRetries (all attempts abort) → throws with key + count, conn quit', async () => {
        // Every exec aborts. With maxRetries:3 we expect 3 attempts then a throw.
        const redis = fakeRedisTx(
            { k: JSON.stringify({ n: 0 }) },
            { execOutcomes: [null, null, null, null, null] },
        );
        await expect(
            optimisticUpdate(redis, 'k', (c) => ({ n: c.n + 1 }), { maxRetries: 3 }),
        ).rejects.toThrow('optimisticUpdate: exceeded 3 retries for k');
        expect(redis.stats.execAttempts).toBe(3);   // bounded by maxRetries
        expect(redis.stats.quits).toBe(1);
        expect(JSON.parse(redis.store.get('k'))).toEqual({ n: 0 }); // never committed
    });

    test('maxRetries default (50) is used when options omitted; succeeds within it', async () => {
        // 49 aborts then a success — proves the default ceiling is comfortably > a handful.
        const outcomes = Array(49).fill(null).concat(['ok']);
        const redis = fakeRedisTx({ k: JSON.stringify({ n: 0 }) }, { execOutcomes: outcomes });
        const next = await optimisticUpdate(redis, 'k', (c) => ({ n: c.n + 1 }));
        expect(next).toEqual({ n: 1 });
        expect(redis.stats.execAttempts).toBe(50);
    });

    test('maxRetries: 1 with an immediate success commits on the only attempt', async () => {
        const redis = fakeRedisTx({ k: JSON.stringify({ n: 7 }) }, { execOutcomes: ['ok'] });
        const next = await optimisticUpdate(redis, 'k', (c) => ({ n: c.n + 1 }), { maxRetries: 1 });
        expect(next).toEqual({ n: 8 });
        expect(redis.stats.execAttempts).toBe(1);
    });

    test('maxRetries: 1 that aborts → immediately throws (loop runs exactly once)', async () => {
        const redis = fakeRedisTx({ k: JSON.stringify({ n: 0 }) }, { execOutcomes: [null] });
        await expect(
            optimisticUpdate(redis, 'k', (c) => ({ n: c.n + 1 }), { maxRetries: 1 }),
        ).rejects.toThrow('exceeded 1 retries');
        expect(redis.stats.execAttempts).toBe(1);
    });
});
