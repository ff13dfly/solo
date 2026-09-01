/**
 * toFix §6.4 — per-asset authorization (owner + visibility) hermetic tests.
 *
 * Drives logic/asset.js directly with an in-memory redis fake and a fake OSS
 * provider. worker_threads is mocked (synchronous SHA256) so no thread pool
 * keeps the jest process alive.
 *
 * Covered:
 *   - upload records owner (from ctx) + visibility (param / default 'internal')
 *   - invalid visibility rejected
 *   - get/resolve: private → owner/admin only; internal → any authenticated;
 *     public → anyone; internal caller (no ctx) bypasses (perimeter binds)
 *   - delete: owner-or-admin only, visibility never grants delete
 *   - CAS dedup is owner-aware: same bytes, different owner → separate records
 *   - list filters to what the caller can read; admin sees all
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
        async deleteMany(keys) { keys.forEach(k => objects.delete(k)); },
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
    },
    storage: { thumbnails: { mode: 'off' }, defaultVisibility: 'internal' },
    thumbnails: { sizes: {} },
};

const ALICE = { user: 'uid-alice', permit: 'user' };
const BOB   = { user: 'uid-bob',   permit: 'user' };
const ADMIN = { user: 'uid-root',  permit: 'admin' };
const ANON  = { user: null,        permit: null };

const b64 = (s) => Buffer.from(s).toString('base64');

function makeLogic() {
    return createAssetLogic(makeFakeRedis(), testConfig, makeFakeStore());
}

describe('§6.4 upload — owner + visibility recorded', () => {
    test('owner from ctx; default visibility internal', async () => {
        const asset = makeLogic();
        const meta = await asset.upload({ file: b64('doc-1'), filename: 'a.txt' }, ALICE);
        expect(meta.owner).toBe('uid-alice');
        expect(meta.visibility).toBe('internal');
    });

    test('explicit visibility honored; invalid rejected', async () => {
        const asset = makeLogic();
        const meta = await asset.upload({ file: b64('doc-2'), visibility: 'private' }, ALICE);
        expect(meta.visibility).toBe('private');

        await expect(asset.upload({ file: b64('doc-3'), visibility: 'everyone' }, ALICE))
            .rejects.toMatchObject({ code: -32602 });
    });

    test('no ctx (internal caller) → unowned record', async () => {
        const asset = makeLogic();
        const meta = await asset.upload({ file: b64('doc-4') });
        expect(meta.owner).toBeNull();
    });
});

describe('§6.4 get/resolve — visibility gate', () => {
    test('private: owner and admin read; others forbidden', async () => {
        const asset = makeLogic();
        const { id } = await asset.upload({ file: b64('secret'), visibility: 'private' }, ALICE);

        await expect(asset.get({ id }, ALICE)).resolves.toMatchObject({ id });
        await expect(asset.get({ id }, ADMIN)).resolves.toMatchObject({ id });
        await expect(asset.get({ id }, BOB)).rejects.toMatchObject({ code: -32005 });
        await expect(asset.resolve({ id }, BOB)).rejects.toMatchObject({ code: -32005 });
        await expect(asset.get({ id }, ANON)).rejects.toMatchObject({ code: -32005 });
    });

    test('internal: any authenticated principal reads; anonymous forbidden', async () => {
        const asset = makeLogic();
        const { id } = await asset.upload({ file: b64('shared') }, ALICE);   // internal by default

        await expect(asset.get({ id }, BOB)).resolves.toMatchObject({ id });
        await expect(asset.get({ id }, ANON)).rejects.toMatchObject({ code: -32005 });
    });

    test('public: anonymous reads', async () => {
        const asset = makeLogic();
        const { id } = await asset.upload({ file: b64('open'), visibility: 'public' }, ALICE);
        await expect(asset.get({ id }, ANON)).resolves.toMatchObject({ id });
    });

    test('legacy asset without visibility behaves as internal (fail-closed for anon)', async () => {
        const redis = makeFakeRedis();
        const asset = createAssetLogic(redis, testConfig, makeFakeStore());
        await redis.set('STORAGE:ASSET:vintageAA', JSON.stringify({ id: 'vintageAA', sha256: 'x', key: 'k' }));

        await expect(asset.get({ id: 'vintageAA' }, BOB)).resolves.toMatchObject({ id: 'vintageAA' });
        await expect(asset.get({ id: 'vintageAA' }, ANON)).rejects.toMatchObject({ code: -32005 });
    });

    test('internal caller (ctx undefined) bypasses — enforcement binds at the RPC perimeter', async () => {
        const asset = makeLogic();
        const { id } = await asset.upload({ file: b64('route'), visibility: 'private' }, ALICE);
        await expect(asset.get({ id })).resolves.toMatchObject({ id });
    });
});

describe('§6.4 delete — owner-or-admin only', () => {
    test('non-owner cannot delete, even on public assets', async () => {
        const asset = makeLogic();
        const { id } = await asset.upload({ file: b64('pub'), visibility: 'public' }, ALICE);

        await expect(asset.delete({ id }, BOB)).rejects.toMatchObject({ code: -32005 });
        await expect(asset.delete({ id }, ANON)).rejects.toMatchObject({ code: -32005 });
        await expect(asset.delete({ id }, ALICE)).resolves.toMatchObject({ deleted: id });
    });

    test('admin can delete anything', async () => {
        const asset = makeLogic();
        const { id } = await asset.upload({ file: b64('adm') }, ALICE);
        await expect(asset.delete({ id }, ADMIN)).resolves.toMatchObject({ deleted: id });
    });
});

describe('§6.4 CAS dedup — owner-aware', () => {
    test('same bytes, same owner → same record; different owner → separate record over shared bytes', async () => {
        const asset = makeLogic();
        const a1 = await asset.upload({ file: b64('shared-bytes') }, ALICE);
        const a2 = await asset.upload({ file: b64('shared-bytes') }, ALICE);
        expect(a2.id).toBe(a1.id);   // same owner → dedup short-circuit

        const b1 = await asset.upload({ file: b64('shared-bytes'), visibility: 'private' }, BOB);
        expect(b1.id).not.toBe(a1.id);          // B gets their own record…
        expect(b1.sha256).toBe(a1.sha256);      // …over the same content-addressed bytes
        expect(b1.owner).toBe('uid-bob');
        expect(b1.visibility).toBe('private');
    });
});

describe('§6.4 list — filtered to readable rows', () => {
    test('non-admin sees own + internal + public, not others\' private; admin sees all', async () => {
        const asset = makeLogic();
        await asset.upload({ file: b64('a-private'), visibility: 'private' }, ALICE);
        await asset.upload({ file: b64('a-internal') }, ALICE);
        await asset.upload({ file: b64('a-public'), visibility: 'public' }, ALICE);
        await asset.upload({ file: b64('b-private'), visibility: 'private' }, BOB);

        const asBob = await asset.list({}, BOB);
        const bobVis = asBob.items.map(i => i.visibility).sort();
        expect(asBob.total).toBe(3);                          // internal + public + own private
        expect(bobVis).toEqual(['internal', 'private', 'public']);

        const asAnon = await asset.list({}, ANON);
        expect(asAnon.total).toBe(1);                         // public only
        expect(asAnon.items[0].visibility).toBe('public');

        const asAdmin = await asset.list({}, ADMIN);
        expect(asAdmin.total).toBe(4);
    });
});

// --- Similar-problem audit follow-up: bounded list()/delete() for large stores ---
// list() previously scanned every asset for non-admin/keyword calls (`zRange(key,0,-1)` +
// Promise.all-fetch-all); delete() scanned every asset for a matching sha256. Both are
// replaced by bounded indexes below, with a fallback to the exact old behavior when a
// deployment hasn't run deploy/migrate-storage-index.js yet (never wrong, just not fast).

describe('visibility index — fast path (migrated) returns the same rows as the fallback', () => {
    test('same total/visibility mix as the unmigrated "§6.4 list" case above', async () => {
        const redis = makeFakeRedis();
        const asset = createAssetLogic(redis, testConfig, makeFakeStore());
        await asset.upload({ file: b64('a-private'), visibility: 'private' }, ALICE);
        await asset.upload({ file: b64('a-internal') }, ALICE);
        await asset.upload({ file: b64('a-public'), visibility: 'public' }, ALICE);
        await asset.upload({ file: b64('b-private'), visibility: 'private' }, BOB);

        await redis.set(testConfig.redis.assetVisibilityIndexReadyKey, '1'); // flips to the fast path

        const asBob = await asset.list({}, BOB);
        expect(asBob.total).toBe(3);
        expect(asBob.items.map(i => i.visibility).sort()).toEqual(['internal', 'private', 'public']);

        const asAnon = await asset.list({}, ANON);
        expect(asAnon.total).toBe(1);
        expect(asAnon.items[0].visibility).toBe('public');

        const asAdmin = await asset.list({}, ADMIN);
        expect(asAdmin.total).toBe(4);
    });

    test('pagination: newest-first, no overlap between pages', async () => {
        const redis = makeFakeRedis();
        const asset = createAssetLogic(redis, testConfig, makeFakeStore());
        for (let i = 0; i < 5; i++) {
            await asset.upload({ file: b64(`pub-${i}`), visibility: 'public' }, ALICE);
        }
        await redis.set(testConfig.redis.assetVisibilityIndexReadyKey, '1');

        const p1 = await asset.list({ limit: 2, offset: 0 }, BOB);
        const p2 = await asset.list({ limit: 2, offset: 2 }, BOB);
        const p3 = await asset.list({ limit: 2, offset: 4 }, BOB);
        expect(p1.total).toBe(5);
        expect([p1, p2, p3].map(p => p.items.length)).toEqual([2, 2, 1]);
        const seen = new Set();
        for (const p of [p1, p2, p3]) for (const item of p.items) seen.add(item.id);
        expect(seen.size).toBe(5); // every page distinct, all 5 accounted for
    });

    test('keyword search finds matches regardless of migration state, any role', async () => {
        const asset = makeLogic();
        await asset.upload({ file: b64('findme'), filename: 'invoice-2026.pdf', visibility: 'public' }, ALICE);
        await asset.upload({ file: b64('other'), filename: 'photo.png', visibility: 'public' }, ALICE);

        const res = await asset.list({ keyword: 'invoice' }, BOB);
        expect(res.total).toBe(1);
        expect(res.items[0].originalName).toBe('invoice-2026.pdf');
    });
});

describe('sha256 refcount — delete() no longer scans every asset to decide byte purge', () => {
    test('shared bytes across two owners: deleting one keeps the other readable', async () => {
        const asset = makeLogic();
        const a = await asset.upload({ file: b64('shared-content') }, ALICE);
        const b = await asset.upload({ file: b64('shared-content'), visibility: 'private' }, BOB);
        expect(b.sha256).toBe(a.sha256); // same bytes, separate owner-aware records

        await expect(asset.delete({ id: a.id }, ALICE)).resolves.toEqual({ deleted: a.id });
        // Bob's record is untouched and still resolvable — the shared bytes must survive
        // Alice's delete because Bob's record still references them.
        await expect(asset.get({ id: b.id }, BOB)).resolves.toMatchObject({ id: b.id });
        await expect(asset.resolve({ id: b.id }, BOB)).resolves.toEqual({ url: expect.any(String) });

        await expect(asset.delete({ id: b.id }, BOB)).resolves.toEqual({ deleted: b.id });
    });

    test('content with no refcount key yet (pre-fix data) still deletes safely via the scan fallback', async () => {
        const redis = makeFakeRedis();
        const asset = createAssetLogic(redis, testConfig, makeFakeStore());
        const a = await asset.upload({ file: b64('legacy-content') }, ALICE);

        // Simulate data written before the refcount counter existed.
        await redis.del(`${testConfig.redis.sha256RefcountPrefix}${a.sha256}`);

        await expect(asset.delete({ id: a.id }, ALICE)).resolves.toEqual({ deleted: a.id });
    });
});
