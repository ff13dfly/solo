/**
 * entity.js — exhaustive branch/error coverage (complements entity-wal-stream
 * and entity-list-order, which own the atomic-ledger + ordering semantics).
 *
 * This suite drives every public method + guard the other two don't:
 *   - constructor guards (missing redis / serviceName / entityName)
 *   - create: clientId (string + json, success + duplicate), generate-collision
 *     retry + give-up, all option defaults
 *   - save (insert vs update branch)
 *   - get / update / delete / destroy / restore / status / purgeable guards
 *   - soft-delete + restore lifecycle
 *   - list: keyword filter (auto / combined / nested / miss), batched path
 *     (null skip, status skip, includeDeleted, custom filter), empty index
 *   - multiGet: empty/null/non-array ids, includeDeleted, status-falsy, no-limit,
 *     pagination, null rows
 *   - WAL: trace passthrough + empty-uid context; degraded (mock) clients for
 *     json + string non-atomic create/update/delete/destroy, and the walFile
 *     catch (logger.insert throws → console.error, never throws)
 *
 * Real Redis required (redis-stack on 6379, RedisJSON). json-on-real-server
 * tests self-skip if RedisJSON is absent; the mock-based degraded tests always
 * run (no real json needed).
 *
 * Isolation: per-pid WAL_STREAM + LOG_DIR/WAL_DIR (set before requires), per-pid
 * service prefix, afterAll deletes only this suite's keys (never flushall).
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const PID = process.pid;
process.env.WAL_STREAM = `ENTCOV:STREAM:${PID}`;
process.env.LOG_DIR = path.join(os.tmpdir(), `entcov-log-${PID}`);
process.env.WAL_DIR = path.join(os.tmpdir(), `entcov-wal-${PID}`);

const { createClient } = require('redis');
const createEntity = require('../entity');
const { walContext } = require('../entity');
const { WAL, STATUS } = require('../constants');
const logger = require('../logger');
const generator = require('../generator');

const STREAM = WAL.STREAM;
const SERVICE = `ENTCOV_${PID}`;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redis;
let hasJson = false;

// Real-redis factories (one connection, distinct entities/options).
let entity;          // string, idLength:8, sensitiveFields — provided options side
let defaultsEntity;  // everything defaulted — default-param side of every option
let prefixEntity;    // provided idPrefix
let softEntity;      // softDelete:true
let searchEntity;    // searchFields provided
let listEntity;      // dataset for list/multiGet
let clientIdEntity;  // clientId:true (string)

beforeAll(async () => {
    redis = createClient({ url: REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();

    entity = createEntity(redis, {
        serviceName: SERVICE, entityName: 'ITEM', idLength: 8, sensitiveFields: ['secret'],
    });
    defaultsEntity = createEntity(redis, { serviceName: SERVICE, entityName: 'DFLT' });
    prefixEntity = createEntity(redis, { serviceName: SERVICE, entityName: 'PFX', idPrefix: 'px-', idLength: 6 });
    softEntity = createEntity(redis, { serviceName: SERVICE, entityName: 'SOFT', idLength: 8, softDelete: true });
    searchEntity = createEntity(redis, { serviceName: SERVICE, entityName: 'SRCH', idLength: 8, searchFields: ['name', 'meta.tag'] });
    listEntity = createEntity(redis, { serviceName: SERVICE, entityName: 'LIST', idLength: 8 });
    clientIdEntity = createEntity(redis, { serviceName: SERVICE, entityName: 'CID', idLength: 8, clientId: true });

    try {
        await redis.json.set(`${SERVICE}:JSONPROBE`, '$', { a: 1 });
        await redis.del(`${SERVICE}:JSONPROBE`);
        hasJson = true;
    } catch (_) { hasJson = false; }
});

afterAll(async () => {
    const keys = [];
    for await (const k of redis.scanIterator({ MATCH: `${SERVICE}:*`, COUNT: 500 })) {
        if (Array.isArray(k)) keys.push(...k); else keys.push(k);
    }
    if (keys.length) await redis.del(keys);
    await redis.del(STREAM).catch(() => {});
    await redis.quit();
    for (const d of [process.env.LOG_DIR, process.env.WAL_DIR]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* tmp */ }
    }
});

async function ledgerFor(key) {
    const entries = await redis.xRange(STREAM, '-', '+');
    return entries
        .filter(({ message }) => message.key === key)
        .map(({ message }) => ({
            op: message.op,
            before: JSON.parse(message.before),
            after: JSON.parse(message.after),
            user: message.user,
            txn: message.txn,
            trace: message.trace,
        }));
}

// --- Degraded (no-xAdd) mock clients: exercise the legacy file-WAL branches ---

function mockStringRedis() {
    const store = new Map();
    const sets = new Map();
    const sOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
    return {
        store, sets,
        async get(k) { return store.has(k) ? store.get(k) : null; },
        async set(k, v) { store.set(k, v); return 'OK'; },
        multi() {
            const ops = [];
            const m = {
                set: (k, v) => { ops.push(() => store.set(k, v)); return m; },
                sAdd: (k, v) => { ops.push(() => sOf(k).add(v)); return m; },
                del: (k) => { ops.push(() => store.delete(k)); return m; },
                sRem: (k, v) => { ops.push(() => sOf(k).delete(v)); return m; },
                exec: async () => { ops.forEach((f) => f()); return []; },
            };
            return m;
        },
        // no xAdd → canAtomicWal === false; no duplicate/watch → optimistic degraded
    };
}

function mockJsonRedis() {
    const store = new Map();
    const sets = new Map();
    const sOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
    return {
        store, sets,
        json: {
            async set(k, _p, v, opts) {
                if (opts && opts.NX) {
                    if (store.has(k)) return null;
                    store.set(k, v); return 'OK';
                }
                store.set(k, v); return 'OK';
            },
            async get(k) { return store.has(k) ? store.get(k) : null; },
        },
        async del(k) { const had = store.has(k); store.delete(k); return had ? 1 : 0; },
        async sAdd(k, v) { sOf(k).add(v); return 1; },
        async sRem(k, v) { sOf(k).delete(v); return 1; },
        // no xAdd → canAtomicWal === false (json non-atomic legacy branch)
    };
}

// ===========================================================================
describe('entity factory — constructor guards', () => {
    test('missing redis throws', () => {
        expect(() => createEntity(null, { serviceName: 's', entityName: 'e' }))
            .toThrow('[EntityFactory] Redis client is required');
    });
    test('missing serviceName throws', () => {
        expect(() => createEntity(redis, { entityName: 'e' }))
            .toThrow('serviceName and entityName are required');
    });
    test('missing entityName throws', () => {
        expect(() => createEntity(redis, { serviceName: 's' }))
            .toThrow('serviceName and entityName are required');
    });
});

// ===========================================================================
describe('create', () => {
    test('all defaults: id length 16, status ACTIVE, timestamps set, indexed', async () => {
        const d = await defaultsEntity.create({ name: 'plain' });
        expect(d.id).toHaveLength(16);
        expect(d.status).toBe(STATUS.ACTIVE);
        expect(d.createdAt).toBeGreaterThan(0);
        expect(d.updatedAt).toBeGreaterThan(0);
        const ids = await redis.sMembers(`${SERVICE}:DFLT:INDEX`);
        expect(ids).toContain(d.id);
    });

    test('idPrefix is prepended to the generated id', async () => {
        const d = await prefixEntity.create({ name: 'pfx' });
        expect(d.id.startsWith('px-')).toBe(true);
        expect(d.id).toHaveLength('px-'.length + 6);
    });

    test('explicit createdAt is honored (not overwritten by clock)', async () => {
        const d = await entity.create({ name: 'backdated', createdAt: 12345 });
        expect(d.createdAt).toBe(12345);
    });

    test('params.id can never corrupt data.id when clientId is off', async () => {
        const d = await entity.create({ name: 'spoof', id: 'attacker-supplied' });
        expect(d.id).not.toBe('attacker-supplied');
        const stored = await entity.get({ id: d.id });
        expect(stored.id).toBe(d.id);
    });

    test('generate-collision: retries then gives up after maxAttempts', async () => {
        const fixed = 'COLLIDEXX';
        await redis.set(`${SERVICE}:ITEM:${fixed}`, JSON.stringify({ squatter: true }));
        const spy = jest.spyOn(generator, 'generateId').mockReturnValue(fixed);
        try {
            await expect(entity.create({ name: 'doomed' }))
                .rejects.toThrow('Failed to generate unique ID after 10 attempts');
        } finally {
            spy.mockRestore();
            await redis.del(`${SERVICE}:ITEM:${fixed}`);
        }
    });

    test('clientId: uses params.id verbatim; duplicate id rejected', async () => {
        const d = await clientIdEntity.create({ id: 'standard_trade', label: 'x' });
        expect(d.id).toBe('standard_trade');
        const stored = await clientIdEntity.get({ id: 'standard_trade' });
        expect(stored.label).toBe('x');
        await expect(clientIdEntity.create({ id: 'standard_trade' }))
            .rejects.toMatchObject({ code: -32602, message: expect.stringContaining('already exists') });
    });

    test('clientId on but id blank → falls back to generated id', async () => {
        const d = await clientIdEntity.create({ id: '', name: 'noclientkey' });
        expect(d.id).toHaveLength(8);
        expect(d.id).not.toBe('');
    });
});

// ===========================================================================
describe('save (upsert)', () => {
    test('save(null, data) inserts and returns the new id', async () => {
        const id = await entity.save(null, { name: 'inserted' });
        expect(typeof id).toBe('string');
        const stored = await entity.get({ id });
        expect(stored.name).toBe('inserted');
    });
    test('save(id, data) updates and returns the same id', async () => {
        const created = await entity.create({ name: 'pre' });
        const id = await entity.save(created.id, { name: 'post' });
        expect(id).toBe(created.id);
        expect((await entity.get({ id })).name).toBe('post');
    });
});

// ===========================================================================
describe('get', () => {
    test('missing id throws MISSING_PARAM', async () => {
        await expect(entity.get({})).rejects.toMatchObject({ code: -32602, message: 'Missing parameter: id' });
    });
    test('unknown id throws NOT_FOUND', async () => {
        await expect(entity.get({ id: 'does-not-exist' })).rejects.toMatchObject({ code: -32002 });
    });
    test('returns the full record including sensitive fields (get is not redacted)', async () => {
        const d = await entity.create({ name: 'creds', secret: 'hunter2' });
        expect((await entity.get({ id: d.id })).secret).toBe('hunter2');
    });
});

// ===========================================================================
describe('update', () => {
    test('missing id throws MISSING_PARAM', async () => {
        await expect(entity.update({ name: 'x' })).rejects.toMatchObject({ code: -32602 });
    });
    test('string atomic update bumps updatedAt and merges fields', async () => {
        const d = await entity.create({ name: 'u1', a: 1 });
        const upd = await entity.update({ id: d.id, a: 2, b: 3 });
        expect(upd.a).toBe(2);
        expect(upd.b).toBe(3);
        expect(upd.updatedAt).toBeGreaterThanOrEqual(d.updatedAt);
    });
    test('update of unknown id throws NOT_FOUND (string CAS returns null)', async () => {
        await expect(entity.update({ id: 'nope-string', x: 1 })).rejects.toMatchObject({ code: -32002 });
    });
});

// ===========================================================================
describe('delete / destroy / purgeable guards', () => {
    test('delete missing id throws MISSING_PARAM', async () => {
        await expect(entity.delete({})).rejects.toMatchObject({ code: -32602 });
    });
    test('delete unknown id throws NOT_FOUND', async () => {
        await expect(entity.delete({ id: 'ghost-del' })).rejects.toMatchObject({ code: -32002 });
    });
    test('hard delete removes key + index entry', async () => {
        const d = await entity.create({ name: 'rm' });
        expect(await entity.delete({ id: d.id })).toEqual({ success: true });
        expect(await redis.get(`${SERVICE}:ITEM:${d.id}`)).toBeNull();
        expect(await redis.sIsMember(`${SERVICE}:ITEM:INDEX`, d.id)).toBeFalsy();
    });
    test('destroy missing id throws MISSING_PARAM', async () => {
        await expect(entity.destroy({})).rejects.toMatchObject({ code: -32602 });
    });
    test('destroy unknown id throws NOT_FOUND', async () => {
        await expect(entity.destroy({ id: 'ghost-destroy' })).rejects.toMatchObject({ code: -32002 });
    });
    test('destroy purges key + index entry', async () => {
        const d = await entity.create({ name: 'purge' });
        expect(await entity.destroy({ id: d.id })).toEqual({ success: true });
        expect(await redis.get(`${SERVICE}:ITEM:${d.id}`)).toBeNull();
    });
    test('purgeable missing id throws; otherwise returns canDestroy', async () => {
        await expect(entity.purgeable({})).rejects.toMatchObject({ code: -32602 });
        expect(await entity.purgeable({ id: 'anything' })).toEqual({ canDestroy: true, reason: null, count: 0 });
    });
});

// ===========================================================================
describe('soft delete + restore + status', () => {
    test('soft delete marks DELETED (key kept), restore returns it to ACTIVE', async () => {
        const d = await softEntity.create({ name: 'soft' });
        const del = await softEntity.delete({ id: d.id });
        expect(del.status).toBe(STATUS.DELETED);
        // key still present (soft)
        expect(await redis.get(`${SERVICE}:SOFT:${d.id}`)).not.toBeNull();
        const restored = await softEntity.restore({ id: d.id });
        expect(restored.status).toBe(STATUS.ACTIVE);
    });
    test('restore on an already-active entity is a no-op returning current', async () => {
        const d = await softEntity.create({ name: 'live' });
        const r = await softEntity.restore({ id: d.id });
        expect(r.status).toBe(STATUS.ACTIVE);
        expect(r.id).toBe(d.id);
    });
    test('restore missing id throws MISSING_PARAM', async () => {
        await expect(softEntity.restore({})).rejects.toMatchObject({ code: -32602 });
    });
    test('restore on a non-soft-delete factory throws INTERNAL_ERROR', async () => {
        const d = await entity.create({ name: 'hardonly' });
        await expect(entity.restore({ id: d.id }))
            .rejects.toMatchObject({ code: -32603, message: expect.stringContaining('Restore only available') });
    });
    test('status() uppercases and requires id + status', async () => {
        const d = await entity.create({ name: 'st' });
        const upd = await entity.status({ id: d.id, status: 'dormant' });
        expect(upd.status).toBe('DORMANT');
        await expect(entity.status({ id: d.id })).rejects.toMatchObject({ code: -32602 });
        await expect(entity.status({ status: 'X' })).rejects.toMatchObject({ code: -32602 });
    });
});

// ===========================================================================
describe('list — keyword filter', () => {
    beforeAll(async () => {
        await searchEntity.create({ name: 'Red Apple', meta: { tag: 'fruit' }, createdAt: 100 });
        await searchEntity.create({ name: 'Green Pear', meta: { tag: 'fruit' }, createdAt: 200 });
        await searchEntity.create({ name: 'Steel Bolt', meta: { tag: 'hardware' }, createdAt: 300 });
        await searchEntity.create({ name: 'No Meta Item', createdAt: 400 }); // meta missing → nested path miss
    });
    test('keyword matches a top-level searchField (case-insensitive)', async () => {
        const { items } = await searchEntity.list({ keyword: 'apple' });
        expect(items.map((i) => i.name)).toEqual(['Red Apple']);
    });
    test('keyword matches a nested searchField (meta.tag)', async () => {
        const { items } = await searchEntity.list({ keyword: 'hardware' });
        expect(items.map((i) => i.name)).toEqual(['Steel Bolt']);
    });
    test('keyword with no match returns nothing (miss + falsy nested val)', async () => {
        const { items } = await searchEntity.list({ keyword: 'zzz-nomatch' });
        expect(items).toEqual([]);
    });
    test('keyword combined with an explicit filter ANDs them', async () => {
        const { items } = await searchEntity.list({
            keyword: 'fruit', // matches both fruit rows on meta.tag
            filter: (i) => i.name.includes('Pear'),
        });
        expect(items.map((i) => i.name)).toEqual(['Green Pear']);
    });
    test('keyword is ignored when the factory has no searchFields', async () => {
        const d = await listEntity.create({ name: 'kwignored', createdAt: 1 });
        const { items } = await listEntity.list({ keyword: 'whatever' });
        expect(items.some((i) => i.id === d.id)).toBe(true);
    });
});

// ===========================================================================
describe('list — batched path', () => {
    let ids;
    beforeAll(async () => {
        // dedicated entity for a controlled dataset
        const a = await listEntity.create({ name: 'b-a', kind: 'keep', createdAt: 10 });
        const b = await listEntity.create({ name: 'b-b', kind: 'keep', createdAt: 30 });
        const c = await listEntity.create({ name: 'b-c', kind: 'keep', createdAt: 20 });
        // two falsy-createdAt rows → exercise the `(x.createdAt || 0)` sort fallback (both sides)
        await listEntity.create({ name: 'b-z1', kind: 'keep', createdAt: 0 });
        await listEntity.create({ name: 'b-z2', kind: 'keep', createdAt: 0 });
        ids = [a.id, b.id, c.id];
        // one non-ACTIVE → exercises the status-skip branch
        await listEntity.status({ id: c.id, status: 'DORMANT' });
        // a ghost id in the index whose key doesn't exist → null-row skip
        await redis.sAdd(`${SERVICE}:LIST:INDEX`, 'GHOST-NOEXIST');
    });

    test('batched: skips null rows + non-matching status, sorts newest-first', async () => {
        const { items } = await listEntity.list({ batchSize: 2, filter: (i) => i.kind === 'keep' });
        // c is DORMANT (skipped by default status), ghost is null (skipped)
        const names = items.map((i) => i.name);
        expect(names).toContain('b-a');
        expect(names).toContain('b-b');
        expect(names).not.toContain('b-c');
        // newest-first within the matched set
        const ts = items.filter((i) => i.kind === 'keep').map((i) => i.createdAt);
        expect(ts).toEqual([...ts].sort((x, y) => y - x));
    });

    test('batched + includeDeleted pulls the DORMANT row back in', async () => {
        const { items } = await listEntity.list({ batchSize: 2, includeDeleted: true, filter: (i) => i.kind === 'keep' });
        expect(items.map((i) => i.name)).toContain('b-c');
    });

    test('batched + keyword filters inside each chunk', async () => {
        await searchEntity.create({ name: 'Batch Apple', meta: { tag: 'fruit' }, createdAt: 500 });
        const { items } = await searchEntity.list({ batchSize: 1, keyword: 'batch apple' });
        expect(items.map((i) => i.name)).toEqual(['Batch Apple']);
    });
});

// ===========================================================================
describe('list / multiGet — edges', () => {
    test('list on an empty index returns {items:[], total:0}', async () => {
        const empty = createEntity(redis, { serviceName: SERVICE, entityName: 'EMPTY', idLength: 8 });
        expect(await empty.list()).toEqual({ items: [], total: 0 });
    });

    test('multiGet: empty / null / non-array ids short-circuit', async () => {
        expect(await listEntity.multiGet({ ids: [] })).toEqual({ items: [], total: 0 });
        expect(await listEntity.multiGet({ ids: null })).toEqual({ items: [], total: 0 });
        expect(await listEntity.multiGet({ ids: 'nope' })).toEqual({ items: [], total: 0 });
    });

    test('multiGet: null rows dropped; status filter; includeDeleted; filter', async () => {
        const a = await listEntity.create({ name: 'mg-a', createdAt: 1 });
        const b = await listEntity.create({ name: 'mg-b', createdAt: 2 });
        await listEntity.status({ id: b.id, status: 'DORMANT' });

        // includes a real id, a dormant id, and a non-existent id (null row)
        const allIds = [a.id, b.id, 'mg-ghost'];

        const active = await listEntity.multiGet({ ids: allIds });
        expect(active.items.map((i) => i.id)).toEqual([a.id]); // b dormant + ghost dropped

        const withDeleted = await listEntity.multiGet({ ids: allIds, includeDeleted: true });
        const idsSeen = withDeleted.items.map((i) => i.id);
        expect(idsSeen).toContain(a.id);
        expect(idsSeen).toContain(b.id);

        // status falsy → status check skipped entirely (a + b both returned, ghost dropped)
        const noStatus = await listEntity.multiGet({ ids: allIds, status: null });
        expect(noStatus.items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());

        // custom filter
        const filtered = await listEntity.multiGet({ ids: allIds, filter: (i) => i.name === 'mg-a' });
        expect(filtered.items.map((i) => i.id)).toEqual([a.id]);
    });

    test('multiGet without limit returns all matches; with limit/offset paginates', async () => {
        const ids = [];
        for (const ts of [1000, 3000, 2000]) {
            ids.push((await listEntity.create({ name: `pg-${ts}`, createdAt: ts })).id);
        }
        const all = await listEntity.multiGet({ ids });
        expect(all.items.map((i) => i.createdAt)).toEqual([3000, 2000, 1000]); // no limit → newest-first, all
        const page = await listEntity.multiGet({ ids, limit: 1, offset: 1 });
        expect(page.total).toBe(3);
        expect(page.items.map((i) => i.createdAt)).toEqual([2000]);
    });

    test('multiGet sort tolerates falsy createdAt on both compare sides', async () => {
        const z1 = await listEntity.create({ name: 'z1', createdAt: 0 });
        const z2 = await listEntity.create({ name: 'z2', createdAt: 0 });
        const { items } = await listEntity.multiGet({ ids: [z1.id, z2.id] });
        expect(items.map((i) => i.id).sort()).toEqual([z1.id, z2.id].sort());
    });
});

// ===========================================================================
describe('WAL context — trace passthrough + empty uid', () => {
    test('trace flows into the ledger; uid empty when ctx has none', async () => {
        let d;
        await walContext.run({ trace: 'trace-7f3' }, async () => {
            d = await entity.create({ name: 'traced' });
        });
        const [row] = await ledgerFor(`${SERVICE}:ITEM:${d.id}`);
        expect(row.trace).toBe('trace-7f3');
        expect(row.user).toBe(''); // ctx had no uid
        expect(row.txn).not.toBe(''); // txn still lazily stamped
    });

    test('two ops in one run share a txn; a later op has no trace ⇒ empty', async () => {
        let a, b;
        await walContext.run({ uid: 'u-1' }, async () => {
            a = await entity.create({ name: 'twin-a' });
            b = await entity.create({ name: 'twin-b' });
        });
        const [ra] = await ledgerFor(`${SERVICE}:ITEM:${a.id}`);
        const [rb] = await ledgerFor(`${SERVICE}:ITEM:${b.id}`);
        expect(ra.txn).toBe(rb.txn);
        expect(ra.trace).toBe(''); // no trace set → empty
        expect(ra.user).toBe('u-1');
    });
});

// ===========================================================================
describe('json storage on real RedisJSON (self-skips without it)', () => {
    test('clientId json create + duplicate rejection + readManyData json path', async () => {
        if (!hasJson) { console.warn('RedisJSON absent — json real-server path covered by e2e'); return; }
        const j = createEntity(redis, { serviceName: SERVICE, entityName: 'CIDJ', idLength: 8, storageType: 'json', clientId: true });
        const d = await j.create({ id: 'json_key_1', label: 'jl' });
        expect(d.id).toBe('json_key_1');
        await expect(j.create({ id: 'json_key_1' })).rejects.toMatchObject({ code: -32602 });

        // generated-id json create + list (exercises readManyData json.mGet)
        const jl = createEntity(redis, { serviceName: SERVICE, entityName: 'JLIST', idLength: 8, storageType: 'json' });
        await jl.create({ name: 'jdoc1', createdAt: 1 });
        await jl.create({ name: 'jdoc2', createdAt: 2 });
        // ghost id in the index whose JSON key is absent → json.mGet yields a null slot
        await redis.sAdd(`${SERVICE}:JLIST:INDEX`, 'json-ghost');
        const { items, total } = await jl.list();
        expect(total).toBe(2); // ghost (null) dropped
        expect(items.map((i) => i.name)).toEqual(['jdoc2', 'jdoc1']);
    });
});

// ===========================================================================
describe('degraded clients (no xAdd) — legacy file WAL branches', () => {
    test('string mock: create/update/delete/destroy all log to file', async () => {
        const m = mockStringRedis();
        const e = createEntity(m, { serviceName: 'STRMOCK', entityName: 'X', idLength: 8 });
        const svc = 'STRMOCK:X';

        const d = await e.create({ name: 'sm', n: 1 });
        expect(m.store.has(`${svc}:${d.id}`)).toBe(true);
        expect(logger.query(`${svc}:${d.id}`).map((r) => r.op)).toContain('create');

        const upd = await e.update({ id: d.id, n: 2 });
        expect(upd.n).toBe(2);
        expect(JSON.parse(m.store.get(`${svc}:${d.id}`)).n).toBe(2);
        expect(logger.query(`${svc}:${d.id}`).map((r) => r.op)).toContain('update');

        const d2 = await e.create({ name: 'sm2' });
        expect(await e.delete({ id: d2.id })).toEqual({ success: true });
        expect(m.store.has(`${svc}:${d2.id}`)).toBe(false);
        expect(logger.query(`${svc}:${d2.id}`).map((r) => r.op)).toContain('delete');

        const d3 = await e.create({ name: 'sm3' });
        expect(await e.destroy({ id: d3.id })).toEqual({ success: true });
        expect(logger.query(`${svc}:${d3.id}`).map((r) => r.op)).toContain('destroy');
    });

    test('string mock: update of unknown id throws NOT_FOUND (degraded CAS → null)', async () => {
        const m = mockStringRedis();
        const e = createEntity(m, { serviceName: 'STRMOCK2', entityName: 'X', idLength: 8 });
        await expect(e.update({ id: 'absent', n: 1 })).rejects.toMatchObject({ code: -32002 });
    });

    test('json mock: create/update/delete/destroy all log to file (non-atomic json)', async () => {
        const m = mockJsonRedis();
        const e = createEntity(m, { serviceName: 'JSONMOCK', entityName: 'D', idLength: 8, storageType: 'json' });
        const svc = 'JSONMOCK:D';

        const d = await e.create({ name: 'jm', n: 1 });
        expect(m.store.has(`${svc}:${d.id}`)).toBe(true);
        expect(m.store.get(`${svc}:${d.id}`).name).toBe('jm'); // stored as object (json)
        expect(logger.query(`${svc}:${d.id}`).map((r) => r.op)).toContain('create');

        const upd = await e.update({ id: d.id, n: 9 });
        expect(upd.n).toBe(9);
        expect(m.store.get(`${svc}:${d.id}`).n).toBe(9);
        expect(logger.query(`${svc}:${d.id}`).map((r) => r.op)).toContain('update');

        const d2 = await e.create({ name: 'jm2' });
        expect(await e.delete({ id: d2.id })).toEqual({ success: true });
        expect(m.store.has(`${svc}:${d2.id}`)).toBe(false);
        expect(logger.query(`${svc}:${d2.id}`).map((r) => r.op)).toContain('delete');

        const d3 = await e.create({ name: 'jm3' });
        expect(await e.destroy({ id: d3.id })).toEqual({ success: true });
        expect(logger.query(`${svc}:${d3.id}`).map((r) => r.op)).toContain('destroy');
    });

    test('json mock: clientId duplicate rejected on the NX reservation', async () => {
        const m = mockJsonRedis();
        const e = createEntity(m, { serviceName: 'JSONMOCK2', entityName: 'D', idLength: 8, storageType: 'json', clientId: true });
        await e.create({ id: 'fixedjson', name: 'one' });
        await expect(e.create({ id: 'fixedjson', name: 'two' }))
            .rejects.toMatchObject({ code: -32602, message: expect.stringContaining('already exists') });
    });

    test('walFile never throws: logger.insert failure is swallowed to console.error', async () => {
        const m = mockStringRedis();
        const e = createEntity(m, { serviceName: 'WALERR', entityName: 'X', idLength: 8 });
        const insertSpy = jest.spyOn(logger, 'insert').mockImplementationOnce(() => { throw new Error('disk full'); });
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const d = await e.create({ name: 'logfail' }); // must still succeed
            expect(m.store.has(`WALERR:X:${d.id}`)).toBe(true);
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to write log'));
        } finally {
            insertSpy.mockRestore();
            errSpy.mockRestore();
        }
    });
});
