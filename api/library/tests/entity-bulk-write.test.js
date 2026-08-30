/**
 * entity-bulk-write — createMany/deleteMany are the write-side counterpart to multiGet:
 * one MULTI per chunk instead of 3 round trips per row, with the IDENTICAL key structure
 * (data key + SET index + cursor ZSET + per-row WAL row). These tests pin the structural
 * equivalence with create()/delete(), not the speed — the 200k evaluation lives in
 * `api/bench/entity-bulk-write.bench.js`.
 *
 * Needs a real Redis on 6379 (redis-stack in CI) — same convention as entity-list-order.
 */
const { createClient } = require('redis');
const createEntity = require('../entity');
const { walContext } = require('../entity');

const SERVICE = 'BULKTEST88';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redis;
let entity;       // hard-delete (batch-replace semantics, the import case)
let softEntity;   // soft-delete
let keyedEntity;  // clientId opt-in

beforeAll(async () => {
    redis = createClient({ url: REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();
    entity = createEntity(redis, { serviceName: SERVICE, entityName: 'ROW', idLength: 8 });
    softEntity = createEntity(redis, { serviceName: SERVICE, entityName: 'SOFT', idLength: 8, softDelete: true });
    keyedEntity = createEntity(redis, { serviceName: SERVICE, entityName: 'KEYED', idLength: 8, clientId: true });
});

async function clearService() {
    const keys = [];
    for await (const k of redis.scanIterator({ MATCH: `${SERVICE}:*`, COUNT: 500 })) {
        if (Array.isArray(k)) keys.push(...k); else keys.push(k);
    }
    if (keys.length) await redis.del(keys);
}

beforeEach(clearService);
afterAll(async () => { await clearService(); await redis.quit(); });

const rows = (n, tag = 'r') => Array.from({ length: n }, (_, i) => ({ name: `${tag}${i}`, seq: i }));

describe('createMany — same key structure as create(), one MULTI per chunk', () => {
    test('writes every row and maintains BOTH indexes', async () => {
        const res = await entity.createMany(rows(250), { chunkSize: 100 });
        expect(res.total).toBe(250);
        expect(res.items).toHaveLength(250);

        expect(await redis.sCard(`${SERVICE}:ROW:INDEX`)).toBe(250);
        expect(await redis.zCard(`${SERVICE}:ROW:INDEX:CURSOR`)).toBe(250);

        // Data is really there and shaped like create()'s output.
        const one = res.items[0];
        const stored = JSON.parse(await redis.get(`${SERVICE}:ROW:${one.id}`));
        expect(stored).toMatchObject({ id: one.id, name: 'r0', status: 'ACTIVE' });
        expect(typeof stored.createdAt).toBe('number');
        expect(typeof stored.updatedAt).toBe('number');
    });

    test('ids are unique across chunks; input order is preserved in the result', async () => {
        const res = await entity.createMany(rows(300), { chunkSize: 50 });
        const ids = res.items.map((i) => i.id);
        expect(new Set(ids).size).toBe(300);
        expect(res.items.map((i) => i.name)).toEqual(rows(300).map((r) => r.name));
    });

    test('cursor order matches insertion order — pagination walks the batch newest-first', async () => {
        await entity.createMany(rows(5), { chunkSize: 2 });
        const page = await entity.list({ cursor: null, limit: 10 });
        expect(page.items.map((i) => i.name)).toEqual(['r4', 'r3', 'r2', 'r1', 'r0']);
    });

    test('listAll() sees exactly what createMany wrote (read/write paths agree)', async () => {
        await entity.createMany(rows(1200), { chunkSize: 500 });
        const all = await entity.listAll({ pageSize: 300 });
        expect(all.total).toBe(1200);
        expect(new Set(all.items.map((i) => i.name)).size).toBe(1200);
    });

    test('a row created by createMany is indistinguishable from one created by create()', async () => {
        const viaCreate = await entity.create({ name: 'solo' });
        const { items: [viaBulk] } = await entity.createMany([{ name: 'bulk' }]);
        expect(Object.keys(viaBulk).sort()).toEqual(Object.keys(viaCreate).sort());
    });

    test('empty input is a no-op; a non-array throws', async () => {
        expect(await entity.createMany([])).toEqual({ items: [], total: 0 });
        await expect(entity.createMany('nope')).rejects.toMatchObject({ code: -32602 });
    });

    test('client-supplied ids are honored, and colliding ones fail loudly', async () => {
        const res = await keyedEntity.createMany([{ id: 'alpha', v: 1 }, { id: 'beta', v: 2 }]);
        expect(res.items.map((i) => i.id)).toEqual(['alpha', 'beta']);

        await expect(keyedEntity.createMany([{ id: 'alpha', v: 9 }]))
            .rejects.toMatchObject({ code: -32602, message: expect.stringContaining('already exists') });
        await expect(keyedEntity.createMany([{ id: 'dup' }, { id: 'dup' }]))
            .rejects.toMatchObject({ code: -32602, message: expect.stringContaining('twice') });
    });

    test('WAL: one ledger row per entity, same as create()', async () => {
        // Assert on the stream's TAIL, not on an xLen delta: WAL:STREAM is a capped ring
        // buffer (MAXLEN ~10000), so once it saturates the delta is 0 and a length-based
        // assertion passes alone but fails in a full run.
        await entity.createMany(rows(20), { chunkSize: 7 });
        const tail = await redis.xRevRange('WAL:STREAM', '+', '-', { COUNT: 20 });
        expect(tail).toHaveLength(20);
        expect(tail.every((e) => e.message.op === 'create')).toBe(true);
        expect(tail.every((e) => e.message.key.startsWith(`${SERVICE}:ROW:`))).toBe(true);
    });

    test('row isolation: bulk rows are stamped with the session owner', async () => {
        await walContext.run({ uid: 'u1', owner: { field: 'ownerUid', value: 'alice' } }, async () => {
            await entity.createMany(rows(3, 'a'));
        });
        const asAlice = await walContext.run({ uid: 'u1', owner: { field: 'ownerUid', value: 'alice' } },
            () => entity.list({ limit: 50 }));
        const asBob = await walContext.run({ uid: 'u2', owner: { field: 'ownerUid', value: 'bob' } },
            () => entity.list({ limit: 50 }));
        expect(asAlice.total).toBe(3);
        expect(asBob.total).toBe(0);
    });
});

describe('deleteMany — mirrors delete(), re-runnable', () => {
    test('hard delete removes rows from data and BOTH indexes', async () => {
        const { items } = await entity.createMany(rows(120), { chunkSize: 50 });
        const ids = items.map((i) => i.id);

        const res = await entity.deleteMany(ids, { chunkSize: 50 });
        expect(res).toEqual({ deleted: 120, skipped: 0 });
        expect(await redis.sCard(`${SERVICE}:ROW:INDEX`)).toBe(0);
        expect(await redis.zCard(`${SERVICE}:ROW:INDEX:CURSOR`)).toBe(0);
        expect(await entity.listAll()).toMatchObject({ total: 0 });
    });

    test('re-running skips instead of throwing (retried imports stay idempotent)', async () => {
        const { items } = await entity.createMany(rows(10));
        const ids = items.map((i) => i.id);
        await entity.deleteMany(ids);
        expect(await entity.deleteMany(ids)).toEqual({ deleted: 0, skipped: 10 });
    });

    test('unknown ids are skipped, known ones still deleted', async () => {
        const { items } = await entity.createMany(rows(3));
        const res = await entity.deleteMany([...items.map((i) => i.id), 'ghost-1', 'ghost-2']);
        expect(res).toEqual({ deleted: 3, skipped: 2 });
    });

    test('soft-delete entities are marked DELETED and stay in the index (restorable)', async () => {
        const { items } = await softEntity.createMany(rows(4, 's'));
        const res = await softEntity.deleteMany(items.map((i) => i.id));
        expect(res.deleted).toBe(4);

        expect(await redis.sCard(`${SERVICE}:SOFT:INDEX`)).toBe(4); // never de-indexed
        expect((await softEntity.list({ limit: 50 })).total).toBe(0);
        const withDeleted = await softEntity.list({ limit: 50, includeDeleted: true });
        expect(withDeleted.total).toBe(4);
        // Still restorable — the soft-delete contract survives the bulk path.
        await softEntity.restore({ id: items[0].id });
        expect((await softEntity.list({ limit: 50 })).total).toBe(1);
    });

    test("another owner's rows are skipped, not deleted and not disclosed", async () => {
        const { items } = await walContext.run({ uid: 'u1', owner: { field: 'ownerUid', value: 'alice' } },
            () => entity.createMany(rows(3, 'a')));
        const ids = items.map((i) => i.id);

        const asBob = await walContext.run({ uid: 'u2', owner: { field: 'ownerUid', value: 'bob' } },
            () => entity.deleteMany(ids));
        expect(asBob).toEqual({ deleted: 0, skipped: 3 });   // same answer as "never existed"
        expect(await redis.sCard(`${SERVICE}:ROW:INDEX`)).toBe(3);
    });

    test('empty input is a no-op; a non-array throws', async () => {
        expect(await entity.deleteMany([])).toEqual({ deleted: 0, skipped: 0 });
        await expect(entity.deleteMany('nope')).rejects.toMatchObject({ code: -32602 });
    });

    test('WAL: one ledger row per deleted entity', async () => {
        const { items } = await entity.createMany(rows(6));
        await entity.deleteMany(items.map((i) => i.id));
        const tail = await redis.xRevRange('WAL:STREAM', '+', '-', { COUNT: 6 });
        expect(tail).toHaveLength(6);
        expect(tail.every((e) => e.message.op === 'delete')).toBe(true);
        expect(new Set(tail.map((e) => e.message.key)).size).toBe(6); // 6 distinct rows
    });
});

describe('destroy() also clears the cursor index (regression: ZSET orphans)', () => {
    test('purging a row leaves neither index entry behind', async () => {
        const row = await entity.create({ name: 'doomed' });
        await entity.destroy({ id: row.id });
        expect(await redis.sCard(`${SERVICE}:ROW:INDEX`)).toBe(0);
        expect(await redis.zCard(`${SERVICE}:ROW:INDEX:CURSOR`)).toBe(0);
    });
});
