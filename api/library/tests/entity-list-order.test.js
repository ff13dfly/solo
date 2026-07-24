/**
 * entity-list-order — list() defaults to newest-first (createdAt desc).
 *
 * The id index is a Redis SET (sMembers is unordered), so before this list() came
 * back in arbitrary order. entity.js now sorts by createdAt desc BEFORE pagination,
 * so newest-first holds across pages — not just within a page. createdAt is passed
 * explicitly here so the ordering assertions are deterministic.
 *
 * Needs a real Redis on 6379 (redis-stack in CI).
 */
const { createClient } = require('redis');
const createEntity = require('../entity');

const SERVICE = 'ORDERTEST98';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redis;
let entity;

beforeAll(async () => {
    redis = createClient({ url: REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();
    entity = createEntity(redis, { serviceName: SERVICE, entityName: 'ITEM', idLength: 8 });
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

describe('entity list — newest-first default ordering', () => {
    test('list() returns items by createdAt desc regardless of insertion order', async () => {
        // Insert out of chronological order on purpose.
        const mid = await entity.create({ name: 'mid', createdAt: 2000 });
        const oldest = await entity.create({ name: 'oldest', createdAt: 1000 });
        const newest = await entity.create({ name: 'newest', createdAt: 3000 });

        const { items, total } = await entity.list();
        expect(total).toBe(3);
        expect(items.map((i) => i.name)).toEqual(['newest', 'mid', 'oldest']);
        expect(items.map((i) => i.id)).toEqual([newest.id, mid.id, oldest.id]);
    });

    test('pagination keeps newest-first across pages (page 1 = newest)', async () => {
        for (const ts of [30, 10, 50, 20, 40]) {
            await entity.create({ name: `t${ts}`, createdAt: ts });
        }
        const p1 = await entity.list({ limit: 2, offset: 0 });
        const p2 = await entity.list({ limit: 2, offset: 2 });
        const p3 = await entity.list({ limit: 2, offset: 4 });

        expect(p1.total).toBe(5);
        expect(p1.items.map((i) => i.createdAt)).toEqual([50, 40]);
        expect(p2.items.map((i) => i.createdAt)).toEqual([30, 20]);
        expect(p3.items.map((i) => i.createdAt)).toEqual([10]);
    });
});

// The factory standard is epoch ms, but some services (storage assets, user
// passport/bot) store createdAt as an ISO-8601 string. A raw numeric subtract on a
// string yields NaN → the comparator no-ops → newest-first silently degrades to the
// unordered Redis-SET order. toSortableMs() coerces both shapes so ordering holds.
describe('entity list — createdAt sort robust to ISO strings and mixed types', () => {
    test('ISO-8601 string createdAt still yields newest-first', async () => {
        await entity.create({ name: 'mid', createdAt: '2026-06-01T00:00:00Z' });
        await entity.create({ name: 'oldest', createdAt: '2026-01-01T00:00:00Z' });
        await entity.create({ name: 'newest', createdAt: '2026-12-01T00:00:00Z' });

        const { items, total } = await entity.list();
        expect(total).toBe(3);
        expect(items.map((i) => i.name)).toEqual(['newest', 'mid', 'oldest']);
    });

    test('a collection mixing epoch-ms and ISO createdAt orders globally by real time', async () => {
        const isoMid = '2026-06-01T00:00:00Z';
        const msMid = Date.parse(isoMid);
        await entity.create({ name: 'iso-mid', createdAt: isoMid });
        await entity.create({ name: 'ms-older', createdAt: msMid - 86_400_000 }); // -1 day (number)
        await entity.create({ name: 'ms-newer', createdAt: msMid + 86_400_000 }); // +1 day (number)

        const { items } = await entity.list();
        expect(items.map((i) => i.name)).toEqual(['ms-newer', 'iso-mid', 'ms-older']);
    });

    test('missing/garbage createdAt sorts last, never NaN-breaks the order', async () => {
        await entity.create({ name: 'real', createdAt: 5000 });
        await entity.create({ name: 'garbage', createdAt: 'not-a-date' });
        await entity.create({ name: 'absent' }); // no createdAt passed → factory stamps ms now()

        const { items, total } = await entity.list();
        expect(total).toBe(3);
        // 'absent' is factory-stamped with a large ms now() → newest; 'garbage' → 0 → last.
        expect(items[items.length - 1].name).toBe('garbage');
        expect(items.map((i) => i.name)).toContain('real');
    });
});
