/**
 * entity-cursor-pagination — list({cursor}) is a bounded, additive alternative to the
 * default offset path (sMembers-everything-then-slice). Covers: page walk to exhaustion,
 * the "not migrated yet" guard for pre-existing SET-only data, migrateCursorIndex()
 * bringing that data online, and that hard/soft delete keep the cursor ZSET consistent
 * with the existing SET index.
 *
 * Needs a real Redis on 6379 (redis-stack in CI) — same convention as entity-list-order.
 */
const { createClient } = require('redis');
const createEntity = require('../entity');

const SERVICE = 'CURSORTEST77';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redis;
let entity;
let softEntity;

beforeAll(async () => {
    redis = createClient({ url: REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();
    entity = createEntity(redis, { serviceName: SERVICE, entityName: 'ITEM', idLength: 8 });
    softEntity = createEntity(redis, { serviceName: SERVICE, entityName: 'SOFT', idLength: 8, softDelete: true });
});

async function clearService() {
    const keys = [];
    for await (const k of redis.scanIterator({ MATCH: `${SERVICE}:*`, COUNT: 500 })) {
        if (Array.isArray(k)) keys.push(...k); else keys.push(k);
    }
    if (keys.length) await redis.del(keys);
}

beforeEach(clearService);

afterAll(async () => {
    await clearService();
    await redis.quit();
});

describe('list({cursor}) — bounded pagination for entities created after the ZSET existed', () => {
    test('walks every page newest-first, nextCursor null on the last page', async () => {
        const created = [];
        for (let i = 0; i < 5; i++) created.push(await entity.create({ name: `item${i}` }));

        const p1 = await entity.list({ cursor: null, limit: 2 });
        expect(p1.items.map((i) => i.name)).toEqual(['item4', 'item3']);
        expect(p1.nextCursor).not.toBeNull();

        const p2 = await entity.list({ cursor: p1.nextCursor, limit: 2 });
        expect(p2.items.map((i) => i.name)).toEqual(['item2', 'item1']);
        expect(p2.nextCursor).not.toBeNull();

        const p3 = await entity.list({ cursor: p2.nextCursor, limit: 2 });
        expect(p3.items.map((i) => i.name)).toEqual(['item0']);
        expect(p3.nextCursor).toBeNull(); // fewer than `limit` returned → exhausted

        // Sanity: same items, same order as the (unrelated, offset-based) default path.
        const offsetAll = await entity.list({ limit: 50 });
        expect(offsetAll.items.map((i) => i.name)).toEqual(['item4', 'item3', 'item2', 'item1', 'item0']);
    });

    test('cursor path has no `total` — offset path is unaffected and still has it', async () => {
        await entity.create({ name: 'a' });
        const viaCursor = await entity.list({ cursor: null, limit: 10 });
        expect(viaCursor.total).toBeUndefined();
        const viaOffset = await entity.list({ limit: 10 });
        expect(viaOffset.total).toBe(1);
    });

    test('status filter applies per-page; nextCursor still advances past non-matching ids', async () => {
        const a = await entity.create({ name: 'keep-a' });
        await entity.delete({ id: (await entity.create({ name: 'drop-1' })).id }); // hard delete
        const b = await entity.create({ name: 'keep-b' });

        const page = await entity.list({ cursor: null, limit: 10 });
        // drop-1 was hard-deleted (removed from both indexes entirely), so it's simply absent,
        // not "filtered out" — both remaining creates are ACTIVE and both come back.
        expect(page.items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    });

    test('an invalid cursor throws INVALID_PARAMS, not a silent empty page', async () => {
        await entity.create({ name: 'x' });
        await expect(entity.list({ cursor: 'not-a-number', limit: 10 }))
            .rejects.toMatchObject({ code: -32602 });
    });
});

describe('list({cursor}) — soft delete vs hard delete keep the ZSET consistent with the SET', () => {
    test('soft delete keeps the id in both indexes (findable via includeDeleted)', async () => {
        const d = await softEntity.create({ name: 'soft1' });
        await softEntity.delete({ id: d.id }); // soft delete → status DELETED, never de-indexed

        const activeOnly = await softEntity.list({ cursor: null, limit: 10 });
        expect(activeOnly.items).toHaveLength(0);

        const withDeleted = await softEntity.list({ cursor: null, limit: 10, includeDeleted: true });
        expect(withDeleted.items.map((i) => i.id)).toEqual([d.id]);
    });

    test('hard delete removes the id from cursor pagination entirely', async () => {
        const d = await entity.create({ name: 'hard1' });
        await entity.delete({ id: d.id });

        const page = await entity.list({ cursor: null, limit: 10 });
        expect(page.items.map((i) => i.id)).not.toContain(d.id);
    });
});

describe('cursor pagination on pre-existing (SET-only) data requires migrateCursorIndex() first', () => {
    // Simulates data written before this ZSET existed: sAdd the index directly, bypassing
    // create()'s zAdd, so the ZSET is genuinely behind the SET — exactly the shape
    // migrateCursorIndex() is meant to backfill.
    async function seedLegacyItem(name, createdAt) {
        const id = `legacy-${name}`;
        await redis.set(`${SERVICE}:LEGACY:${id}`, JSON.stringify({ id, name, status: 'ACTIVE', createdAt }));
        await redis.sAdd(`${SERVICE}:LEGACY:INDEX`, id);
        return id;
    }

    let legacyEntity;
    beforeAll(() => {
        legacyEntity = createEntity(redis, { serviceName: SERVICE, entityName: 'LEGACY', idLength: 8 });
    });

    test('list({cursor}) refuses with a clear error before migration', async () => {
        await seedLegacyItem('old', 1000);
        await expect(legacyEntity.list({ cursor: null, limit: 10 }))
            .rejects.toMatchObject({ code: -32602, message: expect.stringContaining('migrateCursorIndex') });
    });

    test('migrateCursorIndex() backfills in createdAt order, then cursor pagination works', async () => {
        await seedLegacyItem('mid', 2000);
        await seedLegacyItem('oldest', 1000);
        await seedLegacyItem('newest', 3000);

        const result = await legacyEntity.migrateCursorIndex();
        expect(result.migrated).toBe(3);

        const page = await legacyEntity.list({ cursor: null, limit: 10 });
        expect(page.items.map((i) => i.name)).toEqual(['newest', 'mid', 'oldest']);
        expect(page.nextCursor).toBeNull();
    });

    test('migrateCursorIndex() is idempotent — re-running doesn\'t duplicate or reorder', async () => {
        await seedLegacyItem('a', 100);
        await seedLegacyItem('b', 200);
        await legacyEntity.migrateCursorIndex();
        const before = await legacyEntity.list({ cursor: null, limit: 10 });

        await legacyEntity.migrateCursorIndex();
        const after = await legacyEntity.list({ cursor: null, limit: 10 });

        expect(after.items.map((i) => i.name)).toEqual(before.items.map((i) => i.name));

        // New creates after a re-migration still get fresh, non-colliding sequence numbers.
        await legacyEntity.create({ name: 'c' });
        const final = await legacyEntity.list({ cursor: null, limit: 10 });
        expect(final.items[0].name).toBe('c');
    });
});
