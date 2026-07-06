/**
 * Hermetic unit test for library/bootstrap.js — createBootstrap(config).
 *
 * Focus: ensureDefaultCategories must (a) seed the category DATA key when missing
 * and (b) ALWAYS add that key to {SERVICE}:CONFIG:CATEGORY_IDX via sAdd — including
 * the path where the data key already exists. That "always index" branch is a
 * recently-fixed regression (category.list() walks the IDX set; an unindexed data
 * key is invisible to the API). These tests lock it in.
 *
 * Fully hermetic: Map-backed fake redis (no real redis, no network, no sleeps).
 * No reliance on wall-clock values — we only assert that a numeric timestamp was
 * written, never a specific instant.
 */
const { createBootstrap } = require('../bootstrap');

// Map/Set-backed fake redis, modeled on core/user/tests/role.test.js. Only the
// surface ensureDefaultCategories touches: get/set/exists/sAdd/sMembers. We also
// count calls so we can assert the "set vs. no-set" branches precisely.
function fakeRedis(seed = {}) {
    const store = new Map(Object.entries(seed));
    const sets = new Map();
    const calls = { get: 0, set: 0, exists: 0, sAdd: 0, sMembers: 0 };
    const sOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
    return {
        store, sets, calls,
        async get(k) { calls.get++; return store.has(k) ? store.get(k) : null; },
        async set(k, v) { calls.set++; store.set(k, v); return 'OK'; },
        // node-redis exists() returns an integer count (0 = absent, 1 = present)
        async exists(k) { calls.exists++; return store.has(k) ? 1 : 0; },
        async sAdd(k, v) {
            calls.sAdd++;
            const s = sOf(k);
            const before = s.size;
            s.add(v);
            return s.size - before; // node-redis: number of NEW members added
        },
        async sMembers(k) { calls.sMembers++; return [...sOf(k)]; },
    };
}

const IDX = 'PLANNER:CONFIG:CATEGORY_IDX';
const DATA = (key) => `PLANNER:CONFIG:CATEGORY:${key}`;

function makeConfig(categories) {
    return {
        serviceName: 'planner',
        seeds: categories === undefined ? undefined : { categories },
    };
}

describe('library/bootstrap — createBootstrap', () => {
    test('exposes initializeRedis and ensureDefaultCategories', () => {
        const b = createBootstrap(makeConfig([]));
        expect(typeof b.initializeRedis).toBe('function');
        expect(typeof b.ensureDefaultCategories).toBe('function');
    });

    describe('ensureDefaultCategories — no-op guards', () => {
        test('returns early (no redis calls) when config.seeds is absent', async () => {
            const redis = fakeRedis();
            const { ensureDefaultCategories } = createBootstrap(makeConfig(undefined));
            await expect(ensureDefaultCategories(redis, 'planner')).resolves.toBeUndefined();
            expect(redis.calls).toEqual({ get: 0, set: 0, exists: 0, sAdd: 0, sMembers: 0 });
        });

        test('returns early when config.seeds.categories is missing', async () => {
            const redis = fakeRedis();
            // seeds present but no `categories` array → guard `config.seeds?.categories` is falsy
            const { ensureDefaultCategories } = createBootstrap({ serviceName: 'planner', seeds: {} });
            await ensureDefaultCategories(redis, 'planner');
            expect(redis.calls.exists).toBe(0);
            expect(redis.calls.sAdd).toBe(0);
        });

        test('empty categories array touches nothing but does not throw', async () => {
            const redis = fakeRedis();
            const { ensureDefaultCategories } = createBootstrap(makeConfig([]));
            await ensureDefaultCategories(redis, 'planner');
            expect(redis.calls.exists).toBe(0);
            expect(redis.calls.sAdd).toBe(0);
            expect(redis.store.size).toBe(0);
        });
    });

    describe('ensureDefaultCategories — seeding (data key missing)', () => {
        test('writes the data key AND indexes it', async () => {
            const redis = fakeRedis();
            const cat = {
                key: 'priority', type: 'LIST', scope: 'LOCAL', desc: 'task priority',
                items: [{ id: 'p1', label: 'High', desc: 'urgent', parentId: 'root' }],
            };
            const { ensureDefaultCategories } = createBootstrap(makeConfig([cat]));

            await ensureDefaultCategories(redis, 'planner');

            // data key created
            expect(redis.calls.set).toBe(1);
            const doc = JSON.parse(redis.store.get(DATA('priority')));
            expect(doc).toMatchObject({
                key: 'priority', type: 'LIST', scope: 'LOCAL',
                desc: 'task priority', status: 'ACTIVE',
            });
            // item normalized through the seed mapper
            expect(doc.items).toEqual([
                { id: 'p1', label: 'High', desc: 'urgent', parentId: 'root', createdAt: expect.any(Number) },
            ]);
            // timestamps are numeric (no assertion on the exact instant → deterministic)
            expect(typeof doc.createdAt).toBe('number');
            expect(typeof doc.updatedAt).toBe('number');

            // indexed into the IDX set under the *data* key, not the bare cat.key
            expect([...redis.sets.get(IDX)]).toEqual([DATA('priority')]);
        });

        test('applies defaults for omitted optional fields (type/scope/desc/status/items)', async () => {
            const redis = fakeRedis();
            const { ensureDefaultCategories } = createBootstrap(makeConfig([{ key: 'bare' }]));

            await ensureDefaultCategories(redis, 'planner');

            const doc = JSON.parse(redis.store.get(DATA('bare')));
            expect(doc.type).toBe('LIST');
            expect(doc.scope).toBe('LOCAL');
            expect(doc.desc).toBe('');
            expect(doc.status).toBe('ACTIVE');
            expect(doc.items).toEqual([]); // missing items → empty array, not undefined
            expect([...redis.sets.get(IDX)]).toEqual([DATA('bare')]);
        });

        test('item defaults: desc → "" and parentId → null when omitted', async () => {
            const redis = fakeRedis();
            const { ensureDefaultCategories } = createBootstrap(
                makeConfig([{ key: 'k', items: [{ id: 'i1', label: 'L' }] }])
            );

            await ensureDefaultCategories(redis, 'planner');

            const doc = JSON.parse(redis.store.get(DATA('k')));
            expect(doc.items[0]).toEqual({
                id: 'i1', label: 'L', desc: '', parentId: null, createdAt: expect.any(Number),
            });
        });

        test('seeds and indexes every category when multiple are configured', async () => {
            const redis = fakeRedis();
            const { ensureDefaultCategories } = createBootstrap(
                makeConfig([{ key: 'a' }, { key: 'b' }, { key: 'c' }])
            );

            await ensureDefaultCategories(redis, 'planner');

            expect(redis.calls.set).toBe(3);
            expect(redis.store.has(DATA('a'))).toBe(true);
            expect(redis.store.has(DATA('b'))).toBe(true);
            expect(redis.store.has(DATA('c'))).toBe(true);
            expect([...redis.sets.get(IDX)].sort()).toEqual(
                [DATA('a'), DATA('b'), DATA('c')].sort()
            );
        });
    });

    describe('ensureDefaultCategories — REGRESSION: index even when data key already exists', () => {
        test('does NOT rewrite an existing data key but STILL indexes it', async () => {
            // Pre-seed the data key (as if it was created before the index line existed)
            // but leave the IDX set empty — the self-heal path.
            const existing = JSON.stringify({ key: 'power', type: 'LIST', items: [], sentinel: 'PRESERVE_ME' });
            const redis = fakeRedis({ [DATA('power')]: existing });
            const { ensureDefaultCategories } = createBootstrap(makeConfig([{ key: 'power' }]));

            await ensureDefaultCategories(redis, 'planner');

            // existing data key untouched (no set call) ...
            expect(redis.calls.set).toBe(0);
            expect(redis.store.get(DATA('power'))).toBe(existing);
            // ... but the index WAS populated (the regression fix)
            expect(redis.calls.sAdd).toBe(1);
            expect([...redis.sets.get(IDX)]).toEqual([DATA('power')]);
        });

        test('sAdd runs unconditionally — both for missing and existing data keys in one pass', async () => {
            const redis = fakeRedis({ [DATA('exists')]: JSON.stringify({ key: 'exists', items: [] }) });
            const { ensureDefaultCategories } = createBootstrap(
                makeConfig([{ key: 'exists' }, { key: 'fresh' }])
            );

            await ensureDefaultCategories(redis, 'planner');

            // only the missing one is written...
            expect(redis.calls.set).toBe(1);
            expect(redis.store.has(DATA('fresh'))).toBe(true);
            // ...but BOTH are indexed
            expect(redis.calls.sAdd).toBe(2);
            expect([...redis.sets.get(IDX)].sort()).toEqual([DATA('exists'), DATA('fresh')].sort());
        });
    });

    describe('ensureDefaultCategories — idempotency', () => {
        test('running twice does not duplicate index members or rewrite data', async () => {
            const redis = fakeRedis();
            const { ensureDefaultCategories } = createBootstrap(makeConfig([{ key: 'priority' }]));

            await ensureDefaultCategories(redis, 'planner');
            const setsAfterFirst = redis.calls.set; // 1 (data key was missing)

            await ensureDefaultCategories(redis, 'planner');

            // second pass: data key now exists → no new set, but sAdd still fires
            expect(redis.calls.set).toBe(setsAfterFirst);
            expect(redis.calls.sAdd).toBe(2); // once per pass
            // IDX set holds exactly one member (Set semantics → idempotent)
            expect([...redis.sets.get(IDX)]).toEqual([DATA('priority')]);
        });
    });

    describe('ensureDefaultCategories — key construction', () => {
        test('serviceName is uppercased for both data and index keys', async () => {
            const redis = fakeRedis();
            const { ensureDefaultCategories } = createBootstrap(makeConfig([{ key: 'x' }]));

            // pass a lowercase service name explicitly
            await ensureDefaultCategories(redis, 'planner');

            expect(redis.store.has('PLANNER:CONFIG:CATEGORY:x')).toBe(true);
            expect(redis.sets.has('PLANNER:CONFIG:CATEGORY_IDX')).toBe(true);
        });

        test('mixed-case serviceName argument is normalized to upper-case keys', async () => {
            const redis = fakeRedis();
            const { ensureDefaultCategories } = createBootstrap(makeConfig([{ key: 'x' }]));

            await ensureDefaultCategories(redis, 'PlAnNeR');

            expect(redis.store.has('PLANNER:CONFIG:CATEGORY:x')).toBe(true);
            expect(redis.sets.has('PLANNER:CONFIG:CATEGORY_IDX')).toBe(true);
        });
    });

    describe('ensureDefaultCategories — error propagation', () => {
        test('rejects if redis.exists throws (errors are not swallowed)', async () => {
            const redis = fakeRedis();
            redis.exists = async () => { throw new Error('boom-exists'); };
            const { ensureDefaultCategories } = createBootstrap(makeConfig([{ key: 'x' }]));
            await expect(ensureDefaultCategories(redis, 'planner')).rejects.toThrow('boom-exists');
        });

        test('rejects if redis.sAdd throws on the always-index step', async () => {
            const redis = fakeRedis();
            redis.sAdd = async () => { throw new Error('boom-sadd'); };
            const { ensureDefaultCategories } = createBootstrap(makeConfig([{ key: 'x' }]));
            await expect(ensureDefaultCategories(redis, 'planner')).rejects.toThrow('boom-sadd');
            // the data key was still written before sAdd blew up
            expect(redis.store.has(DATA('x'))).toBe(true);
        });
    });

    describe('initializeRedis — config guard (no real connection)', () => {
        test('throws a FATAL error when redisUrl is not configured', async () => {
            const { initializeRedis } = createBootstrap({ serviceName: 'planner' });
            await expect(initializeRedis('planner')).rejects.toThrow(/FATAL: Redis URL not configured/);
        });
    });
});
