/**
 * storage.asset.external — placeholder assets for files this storage does NOT hold.
 *
 * @why Large files can't go through storage.asset.upload (base64 over JSON-RPC, ~3.7MB
 *      cap, 10s Router forward timeout). Chunked/resumable upload is deliberately not in
 *      the frame; instead the box serves its own bytes and registers a pointer here so the
 *      file still has an assetId and business entities keep referencing files uniformly.
 *
 * These tests pin the things that are easy to get wrong, all of which were real risks in
 * the design review: the CAS dedup index must not swallow placeholders, delete must not
 * touch a refcount that doesn't exist, and no derived artifacts may be promised.
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
    maxCacheSize: 100,
    redis: {
        assetPrefix: 'STORAGE:ASSET:',
        sha256Prefix: 'STORAGE:SHA256:',
        assetIdSortedSet: 'STORAGE:ASSETS:SORTED',
        assetByOwnerPrefix: 'STORAGE:ASSETS:BY_OWNER:',
        assetPublicSortedSet: 'STORAGE:ASSETS:PUBLIC',
        assetInternalSortedSet: 'STORAGE:ASSETS:INTERNAL',
        assetVisibilityIndexReadyKey: 'STORAGE:ASSETS:VISIBILITY_INDEX_READY',
        sha256RefcountPrefix: 'STORAGE:SHA256:REFCOUNT:',
    },
    storage: { thumbnails: { mode: 'off' }, defaultVisibility: 'internal' },
    thumbnails: { sizes: {} },
};

const ALICE = { user: 'uid-alice', permit: 'user' };
const BOB   = { user: 'uid-bob',   permit: 'user' };
const ADMIN = { user: 'uid-root',  permit: 'admin' };
const ANON  = { user: null,        permit: null };

const makeLogic = () => createAssetLogic(makeFakeRedis(), testConfig, makeFakeStore());
const BIG = 'https://files.box.example/video/abc.mp4';

describe('external — registration and resolution', () => {
    test('registers a placeholder that resolves to the downstream URL, not to object storage', async () => {
        const asset = makeLogic();
        const meta = await asset.external({ url: BIG, filename: 'talk.mp4', mimeType: 'video/mp4', size: 812_000_000 }, ALICE);

        expect(meta.kind).toBe('external');
        expect(meta.externalUrl).toBe(BIG);
        expect(meta.url).toBe(BIG);                    // resolution === the pointer
        expect(meta.owner).toBe('uid-alice');
        expect(meta.visibility).toBe('internal');      // same default as upload

        const resolved = await asset.resolve({ id: meta.id }, ALICE);
        expect(resolved.url).toBe(BIG);                // never an oss.local URL
    });

    test('storage stores no bytes for it', async () => {
        const store = makeFakeStore();
        const asset = createAssetLogic(makeFakeRedis(), testConfig, store);
        await asset.external({ url: BIG }, ALICE);
        expect(store._objects.size).toBe(0);
    });

    test('size is carried as declared and flagged unverified', async () => {
        const asset = makeLogic();
        const meta = await asset.external({ url: BIG, size: 812_000_000 }, ALICE);
        expect(meta.size).toBe(812_000_000);
        expect(meta.sizeVerified).toBe(false);

        const noSize = await asset.external({ url: BIG + '?v=2' }, ALICE);
        expect(noSize.size).toBeNull();
        expect(noSize.sizeVerified).toBe(false);
    });

    test('only http(s) pointers are accepted', async () => {
        const asset = makeLogic();
        for (const bad of ['file:///etc/passwd', 'ftp://x/y', 'not-a-url', '']) {
            await expect(asset.external({ url: bad }, ALICE)).rejects.toMatchObject({ code: -32602 });
        }
    });

    test('invalid visibility rejected, same as upload', async () => {
        const asset = makeLogic();
        await expect(asset.external({ url: BIG, visibility: 'everyone' }, ALICE))
            .rejects.toMatchObject({ code: -32602 });
    });
});

describe('external — must not disturb the CAS invariants', () => {
    test('two placeholders are two assets (no sha256 ⇒ no dedup collision)', async () => {
        // The failure this pins: encoding a marker into the byte content would give every
        // placeholder the same sha256, and upload's dedup index would hand the second
        // registration the FIRST one's assetId — two unrelated files, one record.
        const asset = makeLogic();
        const a = await asset.external({ url: 'https://files.box.example/a.mp4' }, ALICE);
        const b = await asset.external({ url: 'https://files.box.example/b.mp4' }, ALICE);

        expect(a.id).not.toBe(b.id);
        expect(a.sha256).toBeNull();
        expect(b.sha256).toBeNull();
    });

    test('a real upload afterwards still dedups normally', async () => {
        const asset = makeLogic();
        await asset.external({ url: BIG }, ALICE);
        const f1 = await asset.upload({ file: Buffer.from('same-bytes').toString('base64') }, ALICE);
        const f2 = await asset.upload({ file: Buffer.from('same-bytes').toString('base64') }, ALICE);
        expect(f2.id).toBe(f1.id);          // CAS dedup untouched by the placeholder
    });

    test('deleting a placeholder purges no object and touches no refcount', async () => {
        const store = makeFakeStore();
        const redis = makeFakeRedis();
        const asset = createAssetLogic(redis, testConfig, store);

        const real = await asset.upload({ file: Buffer.from('keep-me').toString('base64') }, ALICE);
        const ext = await asset.external({ url: BIG }, ALICE);

        await asset.delete({ id: ext.id }, ALICE);

        // The real asset's bytes and its record survive — the placeholder's delete must not
        // have wandered into the shared `...REFCOUNT:null` bucket or the full-scan fallback.
        expect(store._objects.size).toBe(1);
        expect((await asset.get({ id: real.id }, ALICE)).id).toBe(real.id);
        await expect(asset.get({ id: ext.id }, ALICE)).rejects.toBeDefined();
    });

    test('no thumbnails are promised for a placeholder', async () => {
        const asset = makeLogic();
        const meta = await asset.external({ url: 'https://files.box.example/pic.jpg', mimeType: 'image/jpeg' }, ALICE);
        expect(meta.thumbnails).toBeUndefined();
        const got = await asset.get({ id: meta.id }, ALICE);
        expect(got.thumbnails).toBeUndefined();
    });
});

describe('external — access control gates the POINTER, not the payload', () => {
    test('visibility still governs who may resolve it', async () => {
        const asset = makeLogic();
        const priv = await asset.external({ url: BIG, visibility: 'private' }, ALICE);

        expect((await asset.resolve({ id: priv.id }, ALICE)).url).toBe(BIG);
        expect((await asset.resolve({ id: priv.id }, ADMIN)).url).toBe(BIG);
        await expect(asset.resolve({ id: priv.id }, BOB)).rejects.toBeDefined();
        await expect(asset.resolve({ id: priv.id }, ANON)).rejects.toBeDefined();
    });

    test('appears in list() under the same read rules as any asset', async () => {
        const asset = makeLogic();
        await asset.external({ url: BIG, visibility: 'private' }, ALICE);
        const alice = await asset.list({}, ALICE);
        const bob = await asset.list({}, BOB);
        expect(alice.items.some((i) => i.kind === 'external')).toBe(true);
        expect(bob.items.some((i) => i.kind === 'external')).toBe(false);
    });

    test('delete stays owner-or-admin', async () => {
        const asset = makeLogic();
        const ext = await asset.external({ url: BIG }, ALICE);
        await expect(asset.delete({ id: ext.id }, BOB)).rejects.toBeDefined();
        await expect(asset.delete({ id: ext.id }, ADMIN)).resolves.toMatchObject({ deleted: ext.id });
    });
});
