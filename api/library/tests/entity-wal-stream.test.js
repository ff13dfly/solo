/**
 * Entity WAL → atomic Redis-stream ledger (entity.js walMulti / optimistic onMulti).
 *
 * Verifies the load-bearing low-level semantics:
 *   1. every mutation (create/update/delete/destroy) lands EXACTLY ONE ledger row,
 *      committed in the same MULTI as the data write;
 *   2. under concurrent CAS updates the ledger chain is strict:
 *      row[i].before === row[i-1].after — proving the xAdd rides the SAME
 *      transaction as the winning EXEC (a write-behind log could interleave);
 *   3. txn grouping: ops inside one walContext.run share a txn id;
 *   4. sensitive-field redaction and oversize-snapshot truncation;
 *   5. failed mutations write NO row;
 *   6. degraded clients (mocks without xAdd) keep the legacy direct-file WAL.
 *
 * Needs a real Redis on 6379 (streams are core commands — plain redis-server is
 * enough; the RedisJSON-dependent test self-skips when the module is absent).
 * Stream/log isolation: per-process WAL_STREAM + LOG_DIR, set before requires.
 */
const os = require('os');
const path = require('path');

process.env.WAL_STREAM = `WALTEST98:STREAM:${process.pid}`;
process.env.LOG_DIR = path.join(os.tmpdir(), `wal-entity-test-${process.pid}`);

const { createClient } = require('redis');
const createEntity = require('../entity');
const { walContext } = require('../entity');
const { WAL } = require('../constants');
const logger = require('../logger');

const STREAM = WAL.STREAM;
const SERVICE = 'WALTEST98';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redis;
let entity;
let hasJson = false;

beforeAll(async () => {
    redis = createClient({ url: REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();
    entity = createEntity(redis, {
        serviceName: SERVICE, entityName: 'ITEM', idLength: 8,
        sensitiveFields: ['secret'],
    });
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
});

// All ledger rows for one data key, parsed, in stream (= commit) order.
async function ledgerFor(key) {
    const entries = await redis.xRange(STREAM, '-', '+');
    return entries
        .filter(({ message }) => message.key === key)
        .map(({ id, message }) => ({
            sid: id,
            op: message.op,
            key: message.key,
            before: JSON.parse(message.before),
            after: JSON.parse(message.after),
            user: message.user,
            txn: message.txn,
            stamp: parseInt(message.stamp, 10),
        }));
}

describe('entity WAL — atomic stream ledger', () => {
    test('create → exactly one row: op/before/after/user/txn', async () => {
        let item;
        await walContext.run({ uid: 'uid-alpha' }, async () => {
            item = await entity.create({ name: 'first', value: 1 });
        });
        const key = `${SERVICE}:ITEM:${item.id}`;
        const rows = await ledgerFor(key);

        expect(rows).toHaveLength(1);
        expect(rows[0].op).toBe('create');
        expect(rows[0].before).toBeNull();
        expect(rows[0].after).toEqual(item);
        expect(rows[0].user).toBe('uid-alpha');
        expect(rows[0].txn).not.toBe('');
        expect(rows[0].stamp).toBeGreaterThan(0);
    });

    test('20 concurrent CAS updates → 20 rows forming a strict before/after chain', async () => {
        const item = await entity.create({ name: 'chain', counter: 0 });
        const key = `${SERVICE}:ITEM:${item.id}`;

        await Promise.all(
            Array.from({ length: 20 }, (_, i) => entity.update({ id: item.id, [`f${i}`]: i }))
        );

        const rows = await ledgerFor(key);
        const updates = rows.filter((r) => r.op === 'update');
        expect(updates).toHaveLength(20);

        // The chain property is the whole point of binding xAdd into the CAS MULTI:
        // each row's before-snapshot must be EXACTLY the previous row's after-snapshot.
        // A write-behind log breaks this under concurrency (stale before / reordering).
        expect(updates[0].before).toEqual(rows[0].after);
        for (let i = 1; i < updates.length; i++) {
            expect(updates[i].before).toEqual(updates[i - 1].after);
        }

        // Final ledger after-state matches what's actually in Redis.
        const final = await entity.get({ id: item.id });
        expect(updates[updates.length - 1].after).toEqual(final);
    });

    test('ops in one walContext.run share a txn id; separate runs differ', async () => {
        let a, b, c;
        await walContext.run({ uid: 'uid-tx' }, async () => {
            a = await entity.create({ name: 'tx-a' });
            b = await entity.create({ name: 'tx-b' });
        });
        await walContext.run({ uid: 'uid-tx' }, async () => {
            c = await entity.create({ name: 'tx-c' });
        });

        const [ra] = await ledgerFor(`${SERVICE}:ITEM:${a.id}`);
        const [rb] = await ledgerFor(`${SERVICE}:ITEM:${b.id}`);
        const [rc] = await ledgerFor(`${SERVICE}:ITEM:${c.id}`);

        expect(ra.txn).not.toBe('');
        expect(ra.txn).toBe(rb.txn);
        expect(rc.txn).not.toBe(ra.txn);
    });

    test('hard delete → row with before snapshot and null after; data gone', async () => {
        const item = await entity.create({ name: 'doomed' });
        const key = `${SERVICE}:ITEM:${item.id}`;
        await entity.delete({ id: item.id });

        const rows = await ledgerFor(key);
        const del = rows.find((r) => r.op === 'delete');
        expect(del).toBeDefined();
        expect(del.before).toEqual(item);
        expect(del.after).toBeNull();
        expect(await redis.get(key)).toBeNull();
    });

    test('destroy → row recorded', async () => {
        const item = await entity.create({ name: 'purge-me' });
        await entity.destroy({ id: item.id });
        const rows = await ledgerFor(`${SERVICE}:ITEM:${item.id}`);
        expect(rows.map((r) => r.op)).toEqual(['create', 'destroy']);
    });

    test('sensitive fields are redacted in the ledger but intact in Redis', async () => {
        const item = await entity.create({ name: 'covert', secret: 'p@ssw0rd' });
        const [row] = await ledgerFor(`${SERVICE}:ITEM:${item.id}`);
        expect(row.after.secret).toBe('[REDACTED]');
        const stored = await entity.get({ id: item.id });
        expect(stored.secret).toBe('p@ssw0rd');
    });

    test('oversize snapshot → truncation marker row, data intact', async () => {
        const big = 'x'.repeat(WAL.MAX_SNAPSHOT + 1024);
        const item = await entity.create({ name: 'jumbo', blob: big });
        const [row] = await ledgerFor(`${SERVICE}:ITEM:${item.id}`);
        expect(row.after.__truncated).toBe(true);
        expect(row.after.id).toBe(item.id);
        expect(row.after.size).toBeGreaterThan(WAL.MAX_SNAPSHOT);
        const stored = await entity.get({ id: item.id });
        expect(stored.blob).toHaveLength(big.length);
    });

    test('failed mutation writes NO ledger row', async () => {
        const before = (await redis.xLen(STREAM).catch(() => 0)) || 0;
        await expect(entity.update({ id: 'no-such-id', name: 'nope' })).rejects.toMatchObject({ code: expect.anything() });
        const after = (await redis.xLen(STREAM).catch(() => 0)) || 0;
        expect(after).toBe(before);
    });

    test('json storage: write + ledger in one MULTI (self-skips without RedisJSON)', async () => {
        if (!hasJson) { console.warn('RedisJSON absent on test server — json atomicity covered by e2e'); return; }
        const jentity = createEntity(redis, {
            serviceName: SERVICE, entityName: 'JDOC', idLength: 8, storageType: 'json',
        });
        const doc = await jentity.create({ name: 'jdoc' });
        const key = `${SERVICE}:JDOC:${doc.id}`;
        const updated = await jentity.update({ id: doc.id, name: 'jdoc2' });
        const rows = await ledgerFor(key);
        expect(rows.map((r) => r.op)).toEqual(['create', 'update']);
        expect(rows[1].before).toEqual(doc);
        expect(rows[1].after).toEqual(updated);
    });
});

describe('entity WAL — degraded client keeps legacy file WAL', () => {
    function mockRedis() {
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
        };
    }

    test('mock without xAdd → mutation works, WAL row goes straight to file', async () => {
        const mock = mockRedis();
        const ment = createEntity(mock, { serviceName: 'WALMOCK', entityName: 'ITEM', idLength: 8 });
        let item;
        await walContext.run({ uid: 'uid-mock' }, async () => {
            item = await ment.create({ name: 'offline' });
        });
        expect(mock.store.has(`WALMOCK:ITEM:${item.id}`)).toBe(true);

        const rows = logger.query(`WALMOCK:ITEM:${item.id}`);
        expect(rows).toHaveLength(1);
        expect(rows[0].op).toBe('create');
        expect(rows[0].after.name).toBe('offline');
        expect(rows[0].user).toBe('uid-mock');
    });
});
