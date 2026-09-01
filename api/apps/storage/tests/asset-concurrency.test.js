/**
 * storage.asset — concurrency invariants for the CAS plane.
 *
 * Three races, each pinned because it corrupted (or would corrupt) real state:
 *
 * 1. upload × upload, same content: both used to miss the sha256 dedup index
 *    (check and write were not serialized) and mint duplicate records. With the
 *    per-content lock, the loser dedup-hits and both callers get the SAME assetId.
 * 2. delete × delete, same id: both racers passed the read-then-act guard and each
 *    decremented the shared sha256 refcount — one removed record, two decrements,
 *    bytes purged while a sibling record still referenced them. DEL's return value
 *    now arbitrates: exactly one request owns the cleanup.
 * 3. upload × delete, same content: upload saw the bytes exist and skipped its put,
 *    delete of the last same-content record then purged them — a fresh record
 *    resolving to a 404 forever. The per-content lock serializes the two decisions.
 *
 * Same harness as asset-authz.test.js (in-memory redis + fake OSS + mocked worker).
 */
jest.mock('worker_threads', () => {
    const { EventEmitter } = require('events');
    const crypto = require('crypto');
    class FakeWorker extends EventEmitter {
        postMessage({ taskId, type, payload }) {
            if (type === 'HASH') {
                const sha256 = crypto.createHash('sha256').update(payload.buffer).digest('hex');
                setImmediate(() => this.emit('message', { taskId, type: 'HASH_RESULT', payload: { sha256 } }));
            } else {
                setImmediate(() => this.emit('message', { taskId, type: 'ERROR', payload: `unsupported ${type}` }));
            }
        }
    }
    return { Worker: FakeWorker };
});

const createAssetLogic = require('../logic/asset');
const { makeFakeRedis } = require('./utils/fake-redis');

function makeFakeStore() {
    const objects = new Map();
    return {
        async put(key, buf) { objects.set(key, buf); },
        async get(key) { return { content: objects.get(key) }; },
        async exists(key) { return objects.has(key); },
        async deleteMany(keys) { keys.forEach((k) => objects.delete(k)); },
        resolveUrl: (key) => `http://oss.local/${key}`,
        _objects: objects,
    };
}

const testConfig = {
    serviceName: 'storage-test',
    idLengths: { asset: 8 },
    redis: {
        assetPrefix: 'STORAGE:ASSET:',
        sha256Prefix: 'STORAGE:SHA256:',
        assetIdSortedSet: 'STORAGE:ASSETS:SORTED',
        assetByOwnerPrefix: 'STORAGE:ASSETS:BY_OWNER:',
        assetPublicSortedSet: 'STORAGE:ASSETS:PUBLIC',
        assetInternalSortedSet: 'STORAGE:ASSETS:INTERNAL',
        assetVisibilityIndexReadyKey: 'STORAGE:ASSETS:VISIBILITY_INDEX_READY',
        sha256RefcountPrefix: 'STORAGE:SHA256:REFCOUNT:',
        sha256LockPrefix: 'STORAGE:SHA256:LOCK:',
    },
    storage: { thumbnails: { mode: 'off' }, defaultVisibility: 'internal' },
    thumbnails: { sizes: {} },
};

const ALICE = { user: 'uid-alice', permit: 'user' };
const BOB   = { user: 'uid-bob',   permit: 'user' };
const ADMIN = { user: 'uid-root',  permit: 'admin' };

const CONTENT = Buffer.from('the-same-bytes-every-time').toString('base64');
const refcountOf = async (redis, sha256) =>
    Number(await redis.get(`${testConfig.redis.sha256RefcountPrefix}${sha256}`)) || 0;

describe('upload × upload — dedup holds under concurrency', () => {
    test('two same-content same-owner uploads racing return ONE record, refcount 1', async () => {
        const redis = makeFakeRedis();
        const store = makeFakeStore();
        const asset = createAssetLogic(redis, testConfig, store);

        // The fake stack is all-microtask, so two "concurrent" uploads would serialize
        // by accident and never reach the race. Yielding one macrotask at the
        // byte-existence check forces the sibling upload's dedup read to run before
        // this one's index write — the exact interleaving that used to mint duplicate
        // records (both misses) pre-fix. Post-fix the sibling waits on the content
        // lock instead and dedup-hits.
        const origExists = store.exists.bind(store);
        store.exists = async (key) => {
            await new Promise((r) => setImmediate(r));
            return origExists(key);
        };

        const [a, b] = await Promise.all([
            asset.upload({ file: CONTENT, filename: 'x.bin' }, ALICE),
            asset.upload({ file: CONTENT, filename: 'x.bin' }, ALICE),
        ]);

        expect(a.id).toBe(b.id);                       // the loser dedup-hit, no duplicate record
        expect(await redis.zCard(testConfig.redis.assetIdSortedSet)).toBe(1);
        expect(await refcountOf(redis, a.sha256)).toBe(1);
        expect(store._objects.size).toBe(1);
    });
});

describe('delete × delete — DEL arbitration protects the shared refcount', () => {
    test('double-delete of one record decrements the shared sha256 exactly once', async () => {
        const redis = makeFakeRedis();
        const store = makeFakeStore();
        const asset = createAssetLogic(redis, testConfig, store);

        // Two records over the same bytes (owner-aware dedup mints a fresh record
        // for a different owner) — refcount 2.
        const mine   = await asset.upload({ file: CONTENT, filename: 'x.bin' }, ALICE);
        const theirs = await asset.upload({ file: CONTENT, filename: 'x.bin' }, BOB);
        expect(theirs.id).not.toBe(mine.id);
        expect(await refcountOf(redis, mine.sha256)).toBe(2);

        const results = await Promise.allSettled([
            asset.delete({ id: mine.id }, ALICE),
            asset.delete({ id: mine.id }, ALICE),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected  = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);             // exactly one racer owned the cleanup
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toMatchObject({ code: -32002 });

        // The invariant the old code broke: refcount 2 − (one removed record) = 1,
        // NOT 0 — so the bytes BOB's record references were not purged.
        expect(await refcountOf(redis, mine.sha256)).toBe(1);
        expect(store._objects.has(theirs.key)).toBe(true);
        await expect(asset.resolve({ id: theirs.id }, BOB)).resolves.toBeDefined();

        // And the counting stays exact: deleting the true last record purges.
        await asset.delete({ id: theirs.id }, BOB);
        expect(store._objects.size).toBe(0);
    });
});

describe('upload × delete — a fresh record never dangles over purged bytes', () => {
    test('delete of the last same-content record, fired mid-upload, cannot orphan the new record', async () => {
        const redis = makeFakeRedis();
        const store = makeFakeStore();
        const asset = createAssetLogic(redis, testConfig, store);

        const first = await asset.upload({ file: CONTENT, filename: 'x.bin' }, ALICE);
        expect(await refcountOf(redis, first.sha256)).toBe(1);

        // Interpose at upload's most dangerous instant — AFTER the byte-existence check
        // answered "they exist" (so the upload will skip its put), fire the delete of
        // the ONLY record for these bytes and give it a full macrotask window to run.
        // Pre-fix the delete ran to completion right here — refcount 1 → 0, bytes
        // purged — and the upload then committed a record over deleted bytes. Post-fix
        // the delete blocks on the content lock until the upload's record + refcount
        // are committed, so its decr sees 2 → 1 and never purges.
        let deletePromise = null;
        const origExists = store.exists.bind(store);
        store.exists = async (key) => {
            const result = await origExists(key);
            if (!deletePromise) {
                deletePromise = asset.delete({ id: first.id }, ALICE);
                await new Promise((r) => setTimeout(r, 5));
            }
            return result;
        };

        const second = await asset.upload({ file: CONTENT, filename: 'y.bin' }, BOB);
        await deletePromise;

        // ALICE's record is gone; BOB's record exists AND its bytes survived.
        await expect(asset.get({ id: first.id }, ADMIN)).rejects.toMatchObject({ code: -32002 });
        await expect(asset.get({ id: second.id }, ADMIN)).resolves.toMatchObject({ sha256: second.sha256 });
        expect(store._objects.has(second.key)).toBe(true);
        expect(await refcountOf(redis, second.sha256)).toBe(1);
    });
});
