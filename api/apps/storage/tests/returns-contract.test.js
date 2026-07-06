/**
 * returns-contract.test.js — proves storage.asset.* ACTUAL handler output satisfies the
 * declared return contract (introspection `returns_schema`). Hermetic: real logic/asset.js
 * driven directly over an in-memory Map-backed fake Redis + fake OSS store, with
 * worker_threads mocked to a synchronous SHA256 (the asset-authz.test.js pattern). No
 * stack, no live Redis, no thread pool, no sharp.
 *
 * Why this matters: orchestration/AI binds to storage output shapes via returns_schema.
 * storage.asset.get/upload feed asset URLs/metadata into downstream picks, so the schema
 * MUST match what logic/asset.js actually returns today — the handler is the source of truth.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-storage-contract-${process.pid}`);

// Mock worker_threads → synchronous SHA256 so the HASH offload resolves in-process and no
// thread pool keeps jest alive (mirrors apps/storage/tests/asset-authz.test.js).
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
const introspection = require('../handlers/introspection');
const { checkReturn } = require('../../../library/contract');

// fake redis — the string + sorted-set commands logic/asset.js exercises (asset-authz pattern).
function makeFakeRedis() {
    const kv = new Map();
    const zsets = new Map();
    return {
        async get(key) { return kv.has(key) ? kv.get(key) : null; },
        async set(key, val, opts = {}) {
            if (opts.NX && kv.has(key)) return null;
            kv.set(key, val);
            return 'OK';
        },
        async del(key) { return kv.delete(key) ? 1 : 0; },
        async zAdd(key, { score, value }) {
            let m = zsets.get(key); if (!m) { m = new Map(); zsets.set(key, m); }
            m.set(value, score); return 1;
        },
        async zRem(key, value) { const m = zsets.get(key); return m && m.delete(value) ? 1 : 0; },
        async zCard(key) { return (zsets.get(key) || new Map()).size; },
        async zRange(key, start, stop, opts = {}) {
            const m = zsets.get(key) || new Map();
            let entries = [...m.entries()].sort((a, b) => a[1] - b[1]).map(([v]) => v);
            if (opts.REV) entries = entries.reverse();
            const end = stop === -1 ? entries.length - 1 : stop;
            return entries.slice(start, end + 1);
        },
    };
}

function makeFakeStore() {
    const objects = new Map();
    return {
        async put(key, buf) { objects.set(key, buf); },
        async get(key) { return { content: objects.get(key) }; },
        async exists(key) { return objects.has(key); },
        async deleteMany(keys) { keys.forEach(k => objects.delete(k)); },
        resolveUrl: (key) => `http://oss.local/${key}`,
        _objects: objects,
    };
}

const testConfig = {
    serviceName: 'storage-test',
    idLengths: { asset: 8 },
    maxCacheSize: 100,
    redis: {
        assetPrefix: 'STORAGE:ASSET:',
        sha256Prefix: 'STORAGE:SHA256:',
        assetIdSortedSet: 'STORAGE:ASSETS:SORTED',
    },
    storage: { thumbnails: { mode: 'off' }, defaultVisibility: 'internal' },
    thumbnails: { sizes: {} },
};

const ALICE = { user: 'uid-alice', permit: 'user' };
const ADMIN = { user: 'uid-root', permit: 'admin' };

const b64 = (s) => Buffer.from(s).toString('base64');

const byName = Object.fromEntries(introspection.map((m) => [m.name, m]));
const method = (n) => byName[n];

function makeLogic() {
    return createAssetLogic(makeFakeRedis(), testConfig, makeFakeStore());
}

describe('storage.asset.* — actual return satisfies declared returns_schema', () => {
    let asset;
    beforeEach(() => { asset = makeLogic(); });

    test('upload → matches ASSET_UPLOAD contract (id/sha256/size/url present)', async () => {
        const res = await asset.upload({ file: b64('hello-world'), filename: 'a.txt' }, ALICE);
        expect(checkReturn(method('storage.asset.upload'), res)).toEqual([]);
        expect(typeof res.id).toBe('string');
        expect(typeof res.sha256).toBe('string');
        expect(typeof res.size).toBe('number');
        expect(typeof res.url).toBe('string');
        // owner is a UID string here; createdAt is an ISO string (declared 'string', not number)
        expect(typeof res.owner).toBe('string');
        expect(typeof res.createdAt).toBe('string');
        // thumbnails is undefined under mode='off' — declared non-required, so contract still holds
        expect(res.thumbnails).toBeUndefined();
    });

    test('upload (no ctx) → owner is null but contract still holds (owner not required)', async () => {
        const res = await asset.upload({ file: b64('unowned-bytes') });
        expect(checkReturn(method('storage.asset.upload'), res)).toEqual([]);
        expect(res.owner).toBeNull();
    });

    test('upload dedup short-circuit (same owner, same bytes) → same shape', async () => {
        const a1 = await asset.upload({ file: b64('dup-bytes'), filename: 'd.bin' }, ALICE);
        const a2 = await asset.upload({ file: b64('dup-bytes'), filename: 'd.bin' }, ALICE);
        expect(a2.id).toBe(a1.id); // hit the dedup early-return (line ~243)
        expect(checkReturn(method('storage.asset.upload'), a2)).toEqual([]);
    });

    test('get → matches ASSET_META contract (id/sha256 required)', async () => {
        const up = await asset.upload({ file: b64('get-me'), filename: 'g.txt' }, ALICE);
        const got = await asset.get({ id: up.id }, ALICE);
        expect(checkReturn(method('storage.asset.get'), got)).toEqual([]);
        expect(got.id).toBe(up.id);
        expect(typeof got.sha256).toBe('string');
        // get does NOT decorate with url/thumbnails — the raw stored metadata
        expect(got.url).toBeUndefined();
    });

    test('get on a thin legacy record (only id/sha256/key) → still on contract', async () => {
        const redis = makeFakeRedis();
        const a = createAssetLogic(redis, testConfig, makeFakeStore());
        await redis.set('STORAGE:ASSET:vintageAA', JSON.stringify({ id: 'vintageAA', sha256: 'abc', key: 'k' }));
        const got = await a.get({ id: 'vintageAA' }, ADMIN);
        expect(checkReturn(method('storage.asset.get'), got)).toEqual([]);
    });

    test('resolve → matches { url } contract', async () => {
        const up = await asset.upload({ file: b64('resolve-me') }, ALICE);
        const res = await asset.resolve({ id: up.id }, ALICE);
        expect(checkReturn(method('storage.asset.resolve'), res)).toEqual([]);
        expect(typeof res.url).toBe('string');
    });

    test('delete → matches { deleted } contract (deleted is the id string)', async () => {
        const up = await asset.upload({ file: b64('delete-me') }, ALICE);
        const res = await asset.delete({ id: up.id }, ALICE);
        expect(checkReturn(method('storage.asset.delete'), res)).toEqual([]);
        expect(res.deleted).toBe(up.id);
    });

    test('list → matches { items, total }; each item is also a valid get-shape', async () => {
        await asset.upload({ file: b64('list-1'), filename: 'l1.txt' }, ALICE);
        await asset.upload({ file: b64('list-2'), filename: 'l2.txt' }, ALICE);
        const res = await asset.list({}, ADMIN);
        expect(checkReturn(method('storage.asset.list'), res)).toEqual([]);
        expect(Array.isArray(res.items)).toBe(true);
        expect(typeof res.total).toBe('number');
        for (const item of res.items) {
            // list items ARE decorated (carry url/thumbnails) but still satisfy the get/meta shape
            expect(checkReturn(method('storage.asset.get'), item)).toEqual([]);
        }
    });

    test('list with keyword (applySearch path) → still matches { items, total }', async () => {
        await asset.upload({ file: b64('kw-needle'), filename: 'needle.txt' }, ALICE);
        await asset.upload({ file: b64('kw-other'), filename: 'other.txt' }, ALICE);
        const res = await asset.list({ keyword: 'needle' }, ADMIN);
        expect(checkReturn(method('storage.asset.list'), res)).toEqual([]);
        expect(typeof res.total).toBe('number');
    });

    test('list empty → { items: [], total: 0 } is valid', async () => {
        const res = await asset.list({}, ADMIN);
        expect(checkReturn(method('storage.asset.list'), res)).toEqual([]);
        expect(res.items).toEqual([]);
        expect(res.total).toBe(0);
    });

    test('multi (multiResolve) → matches { items } contract; mixed hit/miss', async () => {
        const up = await asset.upload({ file: b64('multi-1') }, ALICE);
        const res = await asset.multiResolve({ ids: [up.id, 'ghostAsset'] }, ALICE);
        expect(checkReturn(method('storage.asset.multi'), res)).toEqual([]);
        expect(Array.isArray(res.items)).toBe(true);
        expect(res.items[0]).toMatchObject({ id: up.id });
        expect(typeof res.items[0].url).toBe('string');
        expect(res.items[1]).toMatchObject({ id: 'ghostAsset', url: null }); // miss path
    });
});
