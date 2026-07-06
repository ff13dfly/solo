/**
 * WAL archiver (library/walarchiver.js) — stream ledger → on-disk file WAL.
 *
 * Covers the durability-critical behaviors:
 *   1. group created at '0' → entries written BEFORE the archiver boots are archived;
 *   2. archived file rows match the ledger (op/after/user/ref) and are acked
 *      (no pending left);
 *   3. at-least-once: entries stuck on a dead consumer are xAutoClaim-reclaimed;
 *   4. NOGROUP self-heal: stream deleted+recreated → archiver recreates the group
 *      instead of wedging (the orchestrator-matcher bug class);
 *   5. live loop: start() archives new mutations as they happen, stop() returns.
 *
 * Needs a real Redis on 6379. Per-process WAL_STREAM + LOG_DIR isolation.
 */
const os = require('os');
const path = require('path');

process.env.WAL_STREAM = `WALARCH:STREAM:${process.pid}`;
process.env.LOG_DIR = path.join(os.tmpdir(), `wal-archiver-test-${process.pid}`);

const { createClient } = require('redis');
const createEntity = require('../entity');
const { walContext } = require('../entity');
const { createWalArchiver } = require('../walarchiver');
const { WAL } = require('../constants');
const logger = require('../logger');

const STREAM = WAL.STREAM;
const SERVICE = 'WALARCH';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let redis;
let entity;

beforeAll(async () => {
    redis = createClient({ url: REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();
    entity = createEntity(redis, { serviceName: SERVICE, entityName: 'ITEM', idLength: 8 });
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

async function drainAll(archiver, client) {
    let total = 0;
    for (let i = 0; i < 20; i++) {
        const n = await archiver.drainOnce(client);
        total += n;
        if (n === 0) break;
    }
    return total;
}

describe('walarchiver — stream → file', () => {
    test('entries written before boot are archived, rows match, all acked', async () => {
        let a, b;
        await walContext.run({ uid: 'uid-arch' }, async () => {
            a = await entity.create({ name: 'pre-boot-1' });
            b = await entity.create({ name: 'pre-boot-2' });
        });

        const archiver = createWalArchiver(redis, { blockMs: 100, consumer: 'test:pre' });
        await archiver.ensureGroup(redis);
        const drained = await drainAll(archiver, redis);
        expect(drained).toBeGreaterThanOrEqual(2);

        for (const item of [a, b]) {
            const key = `${SERVICE}:ITEM:${item.id}`;
            const rows = logger.query(key);
            expect(rows).toHaveLength(1);
            expect(rows[0].op).toBe('create');
            expect(rows[0].after).toEqual(item);
            expect(rows[0].user).toBe('uid-arch');
            expect(rows[0].txn).toBeTruthy();
            // ref = stream entry id → duplicates from at-least-once re-delivery are detectable
            expect(rows[0].ref).toMatch(/^\d+-\d+$/);
        }

        const pend = await redis.xPending(STREAM, WAL.GROUP);
        expect(pend.pending).toBe(0);
    });

    test('at-least-once: entry stuck on a dead consumer is reclaimed and archived', async () => {
        const item = await entity.create({ name: 'orphaned' });
        const key = `${SERVICE}:ITEM:${item.id}`;

        // Simulate a consumer that read the entry and died before ack.
        const stolen = await redis.xReadGroup(WAL.GROUP, 'dead:1', [{ key: STREAM, id: '>' }], { COUNT: 10 });
        expect(stolen).not.toBeNull();
        expect(logger.query(key)).toHaveLength(0);

        // claimIdleMs=0 → immediately reclaimable.
        const archiver = createWalArchiver(redis, { blockMs: 100, consumer: 'test:claim', claimIdleMs: 0 });
        await drainAll(archiver, redis);

        const rows = logger.query(key);
        expect(rows).toHaveLength(1);
        expect(rows[0].after).toEqual(item);
        const pend = await redis.xPending(STREAM, WAL.GROUP);
        expect(pend.pending).toBe(0);
    });

    test('NOGROUP self-heal: stream deleted+recreated → group recreated, entry archived', async () => {
        // Deleting the stream key destroys its consumer groups too.
        await redis.del(STREAM);
        const item = await entity.create({ name: 'post-disaster' });
        const key = `${SERVICE}:ITEM:${item.id}`;

        const archiver = createWalArchiver(redis, { blockMs: 100, consumer: 'test:heal' });
        // First cycle hits NOGROUP and recreates the group at '0' (returns 0).
        const first = await archiver.drainOnce(redis);
        expect(first).toBe(0);
        // Second cycle reads from '0' and archives the entry written "before" the group existed.
        const second = await drainAll(archiver, redis);
        expect(second).toBeGreaterThanOrEqual(1);
        expect(logger.query(key)).toHaveLength(1);
    });

    test('live loop: start() archives new mutations, stop() returns promptly', async () => {
        const archiver = createWalArchiver(redis, { blockMs: 200, consumer: 'test:live' });
        archiver.start();
        await sleep(100); // let connect + group setup settle

        const item = await entity.create({ name: 'live-wire' });
        const key = `${SERVICE}:ITEM:${item.id}`;

        let rows = [];
        for (let i = 0; i < 30; i++) {
            rows = logger.query(key);
            if (rows.length > 0) break;
            await sleep(100);
        }
        expect(rows).toHaveLength(1);
        expect(rows[0].after).toEqual(item);

        const t0 = Date.now();
        await archiver.stop();
        expect(Date.now() - t0).toBeLessThan(2000);
    });
});

/**
 * Branch-coverage hardening — exercises every guard/error path in isolation with a
 * scripted fake redis client (no real Redis required for these), so the failure
 * branches (NOGROUP self-heal, non-NOGROUP propagation, malformed/sparse rows,
 * transient-error back-off, loop crash containment, error-event handler, stop
 * idempotency) are all asserted deterministically. drainOnce/ensureGroup take the
 * client as an argument, so most paths need no live connection.
 */
describe('walarchiver — branch & error-path coverage', () => {
    afterEach(() => jest.useRealTimers());

    const flush = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

    // Scripted fake client. xReadGroup defaults to "block until disconnect" (mirrors
    // a real BLOCKing xReadGroup) so a started loop parks instead of busy-spinning;
    // disconnect() releases that block by rejecting it, exactly like a real socket
    // close unblocking a pending command.
    function makeFakeRedis(opts = {}) {
        const client = {
            errHandler: null,
            gateReject: null,
            xAutoClaimCalls: 0,
            xGroupCreateCalls: 0,
            disconnectCalls: 0,
            on(evt, fn) { if (evt === 'error') client.errHandler = fn; return client; },
            async connect() {},
            async disconnect() {
                client.disconnectCalls++;
                if (client.gateReject) { const r = client.gateReject; client.gateReject = null; r(new Error('Connection closed')); }
                if (opts.disconnectRejects) throw new Error('disconnect-failed');
            },
            async xGroupCreate() { client.xGroupCreateCalls++; if (opts.xGroupCreate) return opts.xGroupCreate(); },
            async xAutoClaim() { client.xAutoClaimCalls++; return opts.xAutoClaim ? opts.xAutoClaim(client.xAutoClaimCalls) : { messages: [] }; },
            async xReadGroup() {
                if (opts.xReadGroup) return opts.xReadGroup(client);
                return new Promise((_resolve, reject) => { client.gateReject = reject; });
            },
            async xAck(stream, group, ids) { client.ackedIds = ids; return opts.xAck ? opts.xAck(ids) : ids.length; },
        };
        return { redis: { duplicate: () => client }, client };
    }

    test('constructs with all defaults; empty drain (null autoclaim/read) returns 0', async () => {
        // No options object at all → outer `= {}` default + every per-arg default.
        const archiver = createWalArchiver(redis);
        expect(typeof archiver.start).toBe('function');
        expect(typeof archiver.stop).toBe('function');
        expect(typeof archiver.drainOnce).toBe('function');
        expect(typeof archiver.ensureGroup).toBe('function');

        // xAutoClaim → null exercises the `(res && res.messages) ? … : []` else.
        const emptyFake = { async xAutoClaim() { return null; }, async xReadGroup() { return null; } };
        await expect(archiver.drainOnce(emptyFake)).resolves.toBe(0);
    });

    test('ensureGroup: BUSYGROUP swallowed, success ok, any other error rethrown', async () => {
        const archiver = createWalArchiver(redis, { consumer: 'eg' });

        const { client: okC } = makeFakeRedis({});
        await expect(archiver.ensureGroup(okC)).resolves.toBeUndefined();
        expect(okC.xGroupCreateCalls).toBe(1);

        const { client: busyC } = makeFakeRedis({ xGroupCreate: () => { throw new Error('BUSYGROUP Consumer Group name already exists'); } });
        await expect(archiver.ensureGroup(busyC)).resolves.toBeUndefined();

        const { client: badC } = makeFakeRedis({ xGroupCreate: () => { throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value'); } });
        await expect(archiver.ensureGroup(badC)).rejects.toThrow('WRONGTYPE');
    });

    test('drainOnce: archives valid rows, skips malformed, acks ALL ids, rebuilds row fields', async () => {
        const PFX = `FK${process.pid}`;
        const claimed = [
            { id: '1-0', message: null },                                       // !message → skip
            { id: '1-1', message: { op: 'noop' } },                             // !message.key → skip
            { id: '1-2', message: { op: 'create', key: `${PFX}:FULL`, before: '{"a":1}', after: '{"b":2}', user: 'u1', txn: 't1', trace: 'tr1', stamp: '123456' } },
            { id: '1-3', message: { key: `${PFX}:SPARSE` } },                   // every optional field defaults
            { id: '1-4', message: { key: `${PFX}:BAD`, before: '{not json', after: 'also-not', stamp: 'xx' } }, // JSON.parse → catch
        ];
        const fresh = [
            { id: '2-0', message: { op: 'update', key: `${PFX}:FRESH`, before: '{"x":1}', after: '{"y":2}', user: 'u2', txn: 't2', trace: 'tr2', stamp: '999' } },
        ];
        const { client } = makeFakeRedis({
            xAutoClaim: () => ({ messages: claimed }),
            xReadGroup: () => [{ name: 'S', messages: fresh }],
        });
        const archiver = createWalArchiver(redis, { consumer: 'd' });

        const n = await archiver.drainOnce(client);
        expect(n).toBe(4); // FULL, SPARSE, BAD, FRESH archived; null + keyless skipped
        // Every entry id is acked, including the two skipped ones (malformed but consumed).
        expect(client.ackedIds).toEqual(['1-0', '1-1', '1-2', '1-3', '1-4', '2-0']);

        const full = logger.query(`${PFX}:FULL`);
        expect(full).toHaveLength(1);
        expect(full[0]).toMatchObject({ op: 'create', key: `${PFX}:FULL`, before: { a: 1 }, after: { b: 2 }, user: 'u1', txn: 't1', trace: 'tr1', stamp: 123456, ref: '1-2' });

        const sparse = logger.query(`${PFX}:SPARSE`)[0];
        expect(sparse.op).toBeNull();
        expect(sparse.before).toBeNull();   // (undefined ?? 'null') → JSON.parse('null') → null
        expect(sparse.after).toBeNull();
        expect(sparse.user).toBeNull();
        expect(sparse.txn).toBeNull();
        expect(sparse.trace).toBeNull();
        expect(typeof sparse.stamp).toBe('number'); // parseInt(undefined) → NaN → Date.now()
        expect(sparse.stamp).toBeGreaterThan(0);
        expect(sparse.ref).toBe('1-3');

        const bad = logger.query(`${PFX}:BAD`)[0];
        expect(bad.before).toBe('{not json'); // unparseable → raw string preserved
        expect(bad.after).toBe('also-not');
        expect(bad.stamp).toBeGreaterThan(0); // 'xx' → NaN → Date.now()

        const fr = logger.query(`${PFX}:FRESH`)[0];
        expect(fr).toMatchObject({ op: 'update', before: { x: 1 }, after: { y: 2 }, user: 'u2', txn: 't2', ref: '2-0' });
    });

    test('drainOnce: NOGROUP from xAutoClaim → recreates group and returns 0', async () => {
        const { client } = makeFakeRedis({
            xAutoClaim: () => { throw new Error('NOGROUP No such key or consumer group'); },
        });
        const archiver = createWalArchiver(redis, { consumer: 'ng' });
        await expect(archiver.drainOnce(client)).resolves.toBe(0);
        expect(client.xGroupCreateCalls).toBe(1); // self-healed
    });

    test('drainOnce: a non-NOGROUP xAutoClaim error propagates to the caller', async () => {
        const { client } = makeFakeRedis({
            xAutoClaim: () => { throw new Error('WRONGTYPE not a stream'); },
        });
        const archiver = createWalArchiver(redis, { consumer: 'wt' });
        await expect(archiver.drainOnce(client)).rejects.toThrow('WRONGTYPE');
        expect(client.xGroupCreateCalls).toBe(0); // not treated as NOGROUP
    });

    test('loop: a transient drain error is logged + backed off (5s), then keeps draining; stop() returns', async () => {
        jest.useFakeTimers();
        const { redis: fakeRedis, client } = makeFakeRedis({
            // first cycle blows up (transient), later cycles are clean & block on xReadGroup
            xAutoClaim: (calls) => { if (calls === 1) throw new Error('transient-blip'); return { messages: [] }; },
        });
        const archiver = createWalArchiver(fakeRedis, { consumer: 'loop', blockMs: 5 });
        archiver.start();
        await flush();                       // start() + cycle 1 → parked on `await sleep(5000)`
        expect(client.xAutoClaimCalls).toBe(1);

        jest.advanceTimersByTime(5000);      // release the back-off timer
        await flush();                       // cycle 2 → clean, parks on xReadGroup
        expect(client.xAutoClaimCalls).toBeGreaterThanOrEqual(2);

        const stopP = archiver.stop();       // disconnect unblocks xReadGroup → loop breaks
        await flush();
        await expect(stopP).resolves.toBeUndefined();
        expect(client.disconnectCalls).toBe(1);
    });

    test('loop crash (drain rejects with no error object) is contained by start() and stop()', async () => {
        const { redis: fakeRedis, client } = makeFakeRedis({
            // reject with a non-Error → loop\'s `err.message` throws → loop() rejects
            xAutoClaim: (calls) => (calls === 1 ? Promise.reject(undefined) : { messages: [] }),
        });
        const archiver = createWalArchiver(fakeRedis, { consumer: 'crash' });
        const started = archiver.start();    // start() returns loopPromise.catch(crashed-handler)
        await expect(started).resolves.toBeUndefined(); // crash swallowed, not rethrown
        await expect(archiver.stop()).resolves.toBeUndefined(); // stop() also tolerates a rejected loop
    });

    test("client 'error' event is logged only while running, ignored after stop()", async () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { redis: fakeRedis, client } = makeFakeRedis({}); // loop parks on xReadGroup
            const archiver = createWalArchiver(fakeRedis, { consumer: 'errh' });
            archiver.start();
            await flush();
            expect(typeof client.errHandler).toBe('function');

            client.errHandler(new Error('redis blip'));
            const loggedWhileRunning = spy.mock.calls.filter(
                (c) => c.some((a) => typeof a === 'string' && a.includes('archiver.redis.error')),
            ).length;
            expect(loggedWhileRunning).toBe(1);

            await archiver.stop();
            const callsAfterStop = spy.mock.calls.length;
            client.errHandler(new Error('post-stop blip')); // stopRequested → silently ignored
            expect(spy.mock.calls.length).toBe(callsAfterStop);
        } finally {
            spy.mockRestore();
        }
    });

    test('stop() swallows a disconnect that throws', async () => {
        const { redis: fakeRedis, client } = makeFakeRedis({ disconnectRejects: true });
        const archiver = createWalArchiver(fakeRedis, { consumer: 'dr' });
        archiver.start();
        await flush();
        await expect(archiver.stop()).resolves.toBeUndefined(); // .catch on disconnect absorbs it
        expect(client.disconnectCalls).toBe(1);
    });

    test('stop() before start() is a no-op (no client / no loop)', async () => {
        const archiver = createWalArchiver(redis, { consumer: 'nostart' });
        await expect(archiver.stop()).resolves.toBeUndefined();
    });
});
