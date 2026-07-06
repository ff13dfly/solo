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
