/**
 * category.test.js — rigorous, hermetic unit test for library/category.js
 * (the "Local Ownership, Global Discovery" Federated Category logic).
 *
 * Strategy:
 *   - Map-backed fake Redis (string + set commands the module actually uses:
 *     get/set/sAdd/sMembers/mGet), mirroring makeFakeRedis in
 *     core/user/tests/returns-contract.test.js.
 *   - A REAL local http.createServer on 127.0.0.1:<ephemeral> plays the Router
 *     so the genuine makeRpcCall request/response/timeout code runs (no http mock).
 *     Per-test behaviour is steered via the mutable `respond` hook; the last RPC
 *     body is captured in `lastBody` for assertions.
 *   - The HTTPS-branch selection is covered by spying https.request → http.request
 *     against the same local server (no real TLS needed).
 *   - The RPC timeout branch re-requires the module under a low
 *     CATEGORY_RPC_TIMEOUT_MS via jest.isolateModules, pointed at a hanging server.
 *
 * The sibling returns-contract suites cover get/update/addItem/getItem/updateItem/
 * removeItem/list by seeding Redis; here we drive EVERY path (create/delete/
 * syncItems/makeRpcCall + the local CRUD guards) so category.js hits 100%.
 *
 * Errors are asserted by their JSON-RPC shape (.code/.message) — see library/jsonrpc.js.
 */
const http = require('http');
const https = require('https');

const createCategory = require('../category');
const { STATUS } = require('../constants');

const SVC = 'svc';
const SUP = 'SVC'; // serviceName.toUpperCase()
const IDX = `${SUP}:CONFIG:CATEGORY_IDX`;
const keyOf = (k) => `${SUP}:CONFIG:CATEGORY:${k.toUpperCase()}`;

// ── Map-backed fake Redis (only the commands category.js touches) ────────────
function makeFakeRedis() {
    const kv = new Map();
    const sets = new Map();
    const sOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
    return {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v) { kv.set(k, v); return 'OK'; },
        async sAdd(k, m) { const s = sOf(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
        async mGet(keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
        _kv: kv,
        _sets: sets,
    };
}

async function seedCategory(redis, key, overrides = {}) {
    const k = key.toUpperCase();
    const doc = {
        key: k, type: 'LIST', scope: 'LOCAL', desc: '', meta: {},
        items: [], status: STATUS.ACTIVE, createdAt: 1, updatedAt: 1, ...overrides,
    };
    await redis.set(keyOf(k), JSON.stringify(doc));
    await redis.sAdd(IDX, keyOf(k));
    return doc;
}

const readDoc = async (redis, key) => JSON.parse(await redis.get(keyOf(key)));

// ── Shared local "Router" http server ────────────────────────────────────────
let server;
let routerUrl;
let respond;      // (req, res, body) => void  — per-test behaviour
let lastBody;     // raw last request body string

const sendJson = (res, obj, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
};
const okReserve = (res) => sendJson(res, { jsonrpc: '2.0', id: 1, result: { reserved: true } });

beforeAll(async () => {
    server = await new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => { lastBody = body; respond(req, res, body); });
        });
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address();
    routerUrl = `http://127.0.0.1:${port}/`;
});

afterAll(() => new Promise((r) => server.close(r)));

let warnSpy, errorSpy;
beforeEach(() => {
    lastBody = undefined;
    respond = (_req, res) => okReserve(res); // default: successful reservation/delete
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
});

// a URL where nothing listens → makeRpcCall request 'error' (ECONNREFUSED)
async function deadUrl() {
    const s = await new Promise((r) => {
        const srv = http.createServer();
        srv.listen(0, '127.0.0.1', () => r(srv));
    });
    const { port } = s.address();
    await new Promise((r) => s.close(r));
    return `http://127.0.0.1:${port}/`;
}

function mk(opts = {}) {
    const redis = makeFakeRedis();
    const cat = createCategory(redis, { serviceName: SVC, routerUrl, ...opts });
    return { redis, cat };
}

// ─────────────────────────────────────────────────────────────────────────────
// create()
// ─────────────────────────────────────────────────────────────────────────────
describe('create()', () => {
    test('missing key → MISSING_PARAM', async () => {
        const { cat } = mk();
        await expect(cat.create({})).rejects.toMatchObject({
            code: -32602, message: 'Missing parameter: key',
        });
    });

    test('no routerUrl and no ROUTER_URL env → INTERNAL_ERROR(ROUTER_URL_NOT_CONFIGURED)', async () => {
        const prev = process.env.ROUTER_URL;
        delete process.env.ROUTER_URL;
        try {
            const redis = makeFakeRedis();
            const cat = createCategory(redis, { serviceName: SVC }); // no routerUrl
            await expect(cat.create({ key: 'x' })).rejects.toMatchObject({
                code: -32603, message: 'ROUTER_URL_NOT_CONFIGURED',
            });
        } finally {
            if (prev !== undefined) process.env.ROUTER_URL = prev;
        }
    });

    test('full happy path: key uppercased, custom type/scope/desc/meta/items, persists + indexes', async () => {
        const { redis, cat } = mk();
        const data = await cat.create({
            key: 'fruit', type: 'TREE', scope: 'GLOBAL', desc: 'dd',
            items: [{ id: 'x' }], meta: { a: 1 },
        });
        // returned shape
        expect(data).toMatchObject({
            key: 'FRUIT', type: 'TREE', scope: 'GLOBAL', desc: 'dd',
            meta: { a: 1 }, items: [{ id: 'x' }], status: STATUS.ACTIVE,
        });
        expect(typeof data.createdAt).toBe('number');
        expect(data.updatedAt).toBe(data.createdAt);
        // reservation params (uppercased key + passthrough)
        const sent = JSON.parse(lastBody);
        expect(sent.method).toBe('system.category.reserve');
        expect(sent.params).toMatchObject({
            key: 'FRUIT', service: SVC, scope: 'GLOBAL', type: 'TREE', desc: 'dd', meta: { a: 1 },
        });
        // persisted locally + indexed
        expect(await readDoc(redis, 'FRUIT')).toMatchObject({ key: 'FRUIT', type: 'TREE' });
        expect(await redis.sMembers(IDX)).toContain(keyOf('FRUIT'));
    });

    test('minimal create applies defaults (LIST/LOCAL/empty desc/meta/items) locally and in reservation', async () => {
        const { redis, cat } = mk();
        const data = await cat.create({ key: 'min' });
        expect(data).toMatchObject({
            key: 'MIN', type: 'LIST', scope: 'LOCAL', desc: '', meta: {}, items: [], status: STATUS.ACTIVE,
        });
        const sent = JSON.parse(lastBody);
        expect(sent.params).toMatchObject({ key: 'MIN', scope: 'LOCAL', type: 'LIST', desc: '', meta: {} });
        expect(await readDoc(redis, 'MIN')).toMatchObject({ type: 'LIST', scope: 'LOCAL' });
    });

    test('uses process.env.ROUTER_URL when routerUrl arg is absent', async () => {
        const prev = process.env.ROUTER_URL;
        process.env.ROUTER_URL = routerUrl;
        try {
            const redis = makeFakeRedis();
            const cat = createCategory(redis, { serviceName: SVC }); // no routerUrl arg
            const data = await cat.create({ key: 'envkey' });
            expect(data.key).toBe('ENVKEY');
            expect(JSON.parse(lastBody).method).toBe('system.category.reserve');
        } finally {
            if (prev === undefined) delete process.env.ROUTER_URL; else process.env.ROUTER_URL = prev;
        }
    });

    test('reservation response carrying {error} → INTERNAL_ERROR with router message (+ rethrow logged)', async () => {
        respond = (_req, res) => sendJson(res, { error: { code: -32000, message: 'router says no' } });
        const { cat } = mk();
        await expect(cat.create({ key: 'k' })).rejects.toMatchObject({
            code: -32603, message: 'router says no',
        });
        expect(errorSpy).toHaveBeenCalled(); // catch-block console.error
    });

    test('reservation {error} without message → fallback ROUTER_RESERVATION_FAILED', async () => {
        respond = (_req, res) => sendJson(res, { error: { code: -32000 } });
        const { cat } = mk();
        await expect(cat.create({ key: 'k' })).rejects.toMatchObject({
            code: -32603, message: 'ROUTER_RESERVATION_FAILED',
        });
    });

    test('makeRpcCall network error during reservation → thrown (caught + rethrown)', async () => {
        const { cat } = mk({ routerUrl: await deadUrl() });
        await expect(cat.create({ key: 'k' })).rejects.toThrow(/ECONN|connect|socket/i);
        expect(errorSpy).toHaveBeenCalled();
    });

    test('overwriting a locally-ACTIVE category after a successful reservation → console.warn', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'dup', { status: STATUS.ACTIVE, desc: 'old' });
        const data = await cat.create({ key: 'dup', desc: 'new' });
        expect(data.desc).toBe('new');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`Overwriting locally ${STATUS.ACTIVE} category DUP`));
    });

    test('overwriting a locally NON-active category → no warn', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'gone', { status: STATUS.DELETED });
        const data = await cat.create({ key: 'gone' });
        expect(data.status).toBe(STATUS.ACTIVE);
        expect(warnSpy).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// delete()
// ─────────────────────────────────────────────────────────────────────────────
describe('delete()', () => {
    test('missing key → MISSING_PARAM', async () => {
        const { cat } = mk();
        await expect(cat.delete({})).rejects.toMatchObject({ code: -32602, message: 'Missing parameter: key' });
    });

    test('no routerUrl and no ROUTER_URL env → INTERNAL_ERROR(ROUTER_URL_NOT_CONFIGURED)', async () => {
        const prev = process.env.ROUTER_URL;
        delete process.env.ROUTER_URL;
        try {
            const redis = makeFakeRedis();
            const cat = createCategory(redis, { serviceName: SVC });
            await expect(cat.delete({ key: 'x' })).rejects.toMatchObject({
                code: -32603, message: 'ROUTER_URL_NOT_CONFIGURED',
            });
        } finally {
            if (prev !== undefined) process.env.ROUTER_URL = prev;
        }
    });

    test('router result.error code -32012 → ROUTER_PERMISSION_DENIED (thrown, local delete skipped)', async () => {
        respond = (_req, res) => sendJson(res, { error: { code: -32012, message: 'forbidden' } });
        const { redis, cat } = mk();
        await seedCategory(redis, 'p', { status: STATUS.ACTIVE });
        await expect(cat.delete({ key: 'p' })).rejects.toMatchObject({
            code: -32603, message: 'ROUTER_PERMISSION_DENIED',
        });
        // local delete was skipped → still ACTIVE
        expect((await readDoc(redis, 'p')).status).toBe(STATUS.ACTIVE);
    });

    test('other router result.error → console.warn + continue to local delete', async () => {
        respond = (_req, res) => sendJson(res, { error: { code: -32000, message: 'warnme' } });
        const { redis, cat } = mk();
        await seedCategory(redis, 'w', { status: STATUS.ACTIVE });
        const r = await cat.delete({ key: 'w' });
        expect(r).toEqual({ success: true });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Router delete warning:'), 'warnme');
        expect((await readDoc(redis, 'w')).status).toBe(STATUS.DELETED);
    });

    test('makeRpcCall throws (non-permission network error) → caught (console.error) + continue', async () => {
        const { redis, cat } = mk({ routerUrl: await deadUrl() });
        await seedCategory(redis, 'n', { status: STATUS.ACTIVE });
        const r = await cat.delete({ key: 'n' });
        expect(r).toEqual({ success: true });
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Router delete failed:'), expect.any(String));
        expect((await readDoc(redis, 'n')).status).toBe(STATUS.DELETED);
    });

    test('router ok but category missing locally → NOT_FOUND', async () => {
        const { cat } = mk(); // default respond = success
        await expect(cat.delete({ key: 'ghost' })).rejects.toMatchObject({
            code: -32002, message: 'Category not found',
        });
    });

    test('happy path: router ok + local present → marks DELETED, returns {success:true}', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'ok', { status: STATUS.ACTIVE });
        const r = await cat.delete({ key: 'ok' });
        expect(r).toEqual({ success: true });
        const sent = JSON.parse(lastBody);
        expect(sent.method).toBe('system.category.delete');
        expect(sent.params).toEqual({ key: 'OK', service: SVC });
        const doc = await readDoc(redis, 'ok');
        expect(doc.status).toBe(STATUS.DELETED);
        expect(doc.updatedAt).toBeGreaterThan(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// syncItems()
// ─────────────────────────────────────────────────────────────────────────────
describe('syncItems()', () => {
    test('missing key → MISSING_PARAM', async () => {
        const { cat } = mk();
        await expect(cat.syncItems({})).rejects.toMatchObject({ code: -32602, message: 'Missing parameter: key' });
    });

    test('category missing → NOT_FOUND', async () => {
        const { cat } = mk();
        await expect(cat.syncItems({ key: 'nope', items: [{ id: 'a' }] })).rejects.toMatchObject({
            code: -32002, message: 'Category not found',
        });
    });

    test('default items=[] → {added:0, updated:0, total:0}', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'empty');
        expect(await cat.syncItems({ key: 'empty' })).toEqual({ added: 0, updated: 0, total: 0 });
    });

    test('adds new (full + minimal), updates existing (full + minimal), skips id-less, counts correctly', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 's', { items: [{ id: 'a', label: { en: 'old' } }, { id: 'e', desc: 'keep' }] });

        const r = await cat.syncItems({
            key: 's',
            items: [
                { id: 'a', label: { en: 'A' }, desc: 'da', parentId: 'pa', meta: { x: 1 } }, // update — all fields set
                { id: 'e' },                                                                  // update — all fields undefined
                { id: 'b', label: { zh: 'B' }, desc: 'db', parentId: 'pb', meta: { y: 1 } },  // new — truthy values
                { id: 'c' },                                                                  // new — falsy → defaults
                { label: { zh: 'no-id' } },                                                   // skipped (no id)
            ],
        });
        expect(r).toEqual({ added: 2, updated: 2, total: 5 });

        const doc = await readDoc(redis, 's');
        const byId = Object.fromEntries(doc.items.map((i) => [i.id, i]));
        expect(byId.a).toMatchObject({ label: { en: 'A' }, desc: 'da', parentId: 'pa', meta: { x: 1 } });
        expect(byId.a.updatedAt).toBeDefined();
        // minimal update leaves prior fields untouched, stamps updatedAt
        expect(byId.e).toMatchObject({ desc: 'keep' });
        expect(byId.e.updatedAt).toBeDefined();
        // new full
        expect(byId.b).toMatchObject({ label: { zh: 'B' }, desc: 'db', parentId: 'pb', meta: { y: 1 } });
        expect(byId.b.createdAt).toBeDefined();
        // new minimal → defaults
        expect(byId.c).toMatchObject({ label: {}, desc: '', parentId: null, meta: null });
        // id-less item never landed
        expect(doc.items.find((i) => i.label && i.label.zh === 'no-id')).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// get()
// ─────────────────────────────────────────────────────────────────────────────
describe('get()', () => {
    test('missing key → MISSING_PARAM', async () => {
        const { cat } = mk();
        await expect(cat.get({})).rejects.toMatchObject({ code: -32602, message: 'Missing parameter: key' });
    });
    test('not found → NOT_FOUND', async () => {
        const { cat } = mk();
        await expect(cat.get({ key: 'x' })).rejects.toMatchObject({ code: -32002, message: 'Category not found' });
    });
    test('found → parsed doc (key uppercased)', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'g', { desc: 'hi' });
        expect(await cat.get({ key: 'g' })).toMatchObject({ key: 'G', desc: 'hi' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// list()
// ─────────────────────────────────────────────────────────────────────────────
describe('list()', () => {
    test('empty index → []', async () => {
        const { cat } = mk();
        expect(await cat.list()).toEqual([]);
    });

    test('default (no arg) excludes DELETED + skips null members; includeDeleted:true includes DELETED', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'live', { status: STATUS.ACTIVE });
        await seedCategory(redis, 'dead', { status: STATUS.DELETED });
        // index entry whose value was never stored → mGet null → skipped
        await redis.sAdd(IDX, `${SUP}:CONFIG:CATEGORY:GHOST`);

        const active = await cat.list();
        expect(active.map((c) => c.key).sort()).toEqual(['LIVE']);

        const all = await cat.list({ includeDeleted: true });
        expect(all.map((c) => c.key).sort()).toEqual(['DEAD', 'LIVE']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// update() (category metadata)
// ─────────────────────────────────────────────────────────────────────────────
describe('update()', () => {
    test('missing key → MISSING_PARAM', async () => {
        const { cat } = mk();
        await expect(cat.update({})).rejects.toMatchObject({ code: -32602, message: 'Missing parameter: key' });
    });
    test('not found → NOT_FOUND', async () => {
        const { cat } = mk();
        await expect(cat.update({ key: 'x' })).rejects.toMatchObject({ code: -32002, message: 'Category not found' });
    });
    test('applies desc/type/meta when provided', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'u', { desc: 'd0', type: 'LIST', meta: {} });
        const r = await cat.update({ key: 'u', desc: 'd1', type: 'TREE', meta: { a: 1 } });
        expect(r).toMatchObject({ desc: 'd1', type: 'TREE', meta: { a: 1 } });
        expect(r.updatedAt).toBeGreaterThan(1);
        expect(await readDoc(redis, 'u')).toMatchObject({ desc: 'd1', type: 'TREE' });
    });
    test('no fields → only updatedAt changes (false branches)', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'u2', { desc: 'keep', type: 'LIST', meta: { m: 1 } });
        const r = await cat.update({ key: 'u2' });
        expect(r).toMatchObject({ desc: 'keep', type: 'LIST', meta: { m: 1 } });
        expect(r.updatedAt).toBeGreaterThan(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// addItem()
// ─────────────────────────────────────────────────────────────────────────────
describe('addItem()', () => {
    test('missing key → MISSING_PARAM', async () => {
        const { cat } = mk();
        await expect(cat.addItem({})).rejects.toMatchObject({ code: -32602, message: 'Missing parameter: key' });
    });
    test('category missing → NOT_FOUND', async () => {
        const { cat } = mk();
        await expect(cat.addItem({ key: 'x', id: 'i' })).rejects.toMatchObject({ code: -32002, message: 'Category not found' });
    });
    test('explicit id + all fields → echoed item', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'a');
        const item = await cat.addItem({
            key: 'a', id: 'i1', label: { en: 'I' }, desc: 'd', parentId: 'p', meta: { m: 1 },
        });
        expect(item).toMatchObject({ id: 'i1', label: { en: 'I' }, desc: 'd', parentId: 'p', meta: { m: 1 } });
        expect(item.createdAt).toBeDefined();
        expect((await readDoc(redis, 'a')).items).toHaveLength(1);
    });
    test('no id → generated id, defaults for label/desc/parentId/meta', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'a2');
        const item = await cat.addItem({ key: 'a2' });
        expect(item.id).toMatch(/^A2_/);
        expect(item).toMatchObject({ label: { zh: '', en: '' }, desc: '', parentId: null, meta: null });
    });
    test('duplicate id → ALREADY_EXISTS', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'a3', { items: [{ id: 'dup' }] });
        await expect(cat.addItem({ key: 'a3', id: 'dup' })).rejects.toMatchObject({
            code: -32004, message: 'Category item already exists',
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getItem()
// ─────────────────────────────────────────────────────────────────────────────
describe('getItem()', () => {
    test('no key → INVALID_PARAM', async () => {
        const { cat } = mk();
        await expect(cat.getItem({ id: 'i' })).rejects.toMatchObject({ code: -32602, message: 'key and id required' });
    });
    test('key but no id → INVALID_PARAM', async () => {
        const { cat } = mk();
        await expect(cat.getItem({ key: 'k' })).rejects.toMatchObject({ code: -32602, message: 'key and id required' });
    });
    test('category missing → NOT_FOUND', async () => {
        const { cat } = mk();
        await expect(cat.getItem({ key: 'x', id: 'i' })).rejects.toMatchObject({ code: -32002, message: 'Category not found' });
    });
    test('item missing → NOT_FOUND(Category item)', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'gi');
        await expect(cat.getItem({ key: 'gi', id: 'nope' })).rejects.toMatchObject({
            code: -32002, message: 'Category item not found',
        });
    });
    test('found → the node', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'gi2', { items: [{ id: 'i', label: { en: 'X' } }] });
        expect(await cat.getItem({ key: 'gi2', id: 'i' })).toMatchObject({ id: 'i', label: { en: 'X' } });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateItem()
// ─────────────────────────────────────────────────────────────────────────────
describe('updateItem()', () => {
    test('no key → INVALID_PARAM', async () => {
        const { cat } = mk();
        await expect(cat.updateItem({ id: 'i' })).rejects.toMatchObject({ code: -32602, message: 'key and id required' });
    });
    test('key but no id → INVALID_PARAM', async () => {
        const { cat } = mk();
        await expect(cat.updateItem({ key: 'k' })).rejects.toMatchObject({ code: -32602, message: 'key and id required' });
    });
    test('category missing → NOT_FOUND', async () => {
        const { cat } = mk();
        await expect(cat.updateItem({ key: 'x', id: 'i' })).rejects.toMatchObject({ code: -32002, message: 'Category not found' });
    });
    test('item missing → NOT_FOUND(Category item)', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'ui');
        await expect(cat.updateItem({ key: 'ui', id: 'nope' })).rejects.toMatchObject({
            code: -32002, message: 'Category item not found',
        });
    });
    test('all fields provided → applied', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'ui2', { items: [{ id: 'i', label: { en: 'old' }, desc: 'o', parentId: null, meta: null }] });
        const item = await cat.updateItem({ key: 'ui2', id: 'i', label: { en: 'new' }, desc: 'n', parentId: 'p', meta: { m: 1 } });
        expect(item).toMatchObject({ id: 'i', label: { en: 'new' }, desc: 'n', parentId: 'p', meta: { m: 1 } });
        expect(item.updatedAt).toBeDefined();
    });
    test('no fields → only updatedAt stamped (false branches)', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'ui3', { items: [{ id: 'i', label: { en: 'keep' }, desc: 'k' }] });
        const item = await cat.updateItem({ key: 'ui3', id: 'i' });
        expect(item).toMatchObject({ id: 'i', label: { en: 'keep' }, desc: 'k' });
        expect(item.updatedAt).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// removeItem()
// ─────────────────────────────────────────────────────────────────────────────
describe('removeItem()', () => {
    test('no key → INVALID_PARAM', async () => {
        const { cat } = mk();
        await expect(cat.removeItem({ id: 'i' })).rejects.toMatchObject({ code: -32602, message: 'key and id required' });
    });
    test('key but no id → INVALID_PARAM', async () => {
        const { cat } = mk();
        await expect(cat.removeItem({ key: 'k' })).rejects.toMatchObject({ code: -32602, message: 'key and id required' });
    });
    test('category missing → NOT_FOUND', async () => {
        const { cat } = mk();
        await expect(cat.removeItem({ key: 'x', id: 'i' })).rejects.toMatchObject({ code: -32002, message: 'Category not found' });
    });
    test('item missing → NOT_FOUND(Category item)', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'ri');
        await expect(cat.removeItem({ key: 'ri', id: 'nope' })).rejects.toMatchObject({
            code: -32002, message: 'Category item not found',
        });
    });
    test('found → spliced out, {success:true}', async () => {
        const { redis, cat } = mk();
        await seedCategory(redis, 'ri2', { items: [{ id: 'i' }, { id: 'j' }] });
        expect(await cat.removeItem({ key: 'ri2', id: 'i' })).toEqual({ success: true });
        const doc = await readDoc(redis, 'ri2');
        expect(doc.items.map((x) => x.id)).toEqual(['j']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// makeRpcCall internals (exercised via create/delete against the local server)
// ─────────────────────────────────────────────────────────────────────────────
describe('makeRpcCall internals', () => {
    test('non-2xx status → RPC_HTTP_ERROR_<code>', async () => {
        respond = (_req, res) => sendJson(res, { nope: true }, 500);
        const { cat } = mk();
        await expect(cat.create({ key: 'k' })).rejects.toThrow(/RPC_HTTP_ERROR_500/);
    });

    test('invalid JSON body (2xx) → INVALID_JSON_RESPONSE', async () => {
        respond = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('not json {'); };
        const { cat } = mk();
        await expect(cat.create({ key: 'k' })).rejects.toThrow(/INVALID_JSON_RESPONSE/);
    });

    test('request "error" event (connection refused) → rejects', async () => {
        const { cat } = mk({ routerUrl: await deadUrl() });
        await expect(cat.create({ key: 'k' })).rejects.toThrow(/ECONN|connect|socket/i);
    });

    test('https:// URL selects the https client (spied → http) and resolves', async () => {
        const spy = jest.spyOn(https, 'request').mockImplementation((options, cb) => http.request(options, cb));
        try {
            const httpsUrl = routerUrl.replace('http://', 'https://');
            const { cat } = mk({ routerUrl: httpsUrl });
            const data = await cat.create({ key: 'tls' });
            expect(data.key).toBe('TLS');
            expect(spy).toHaveBeenCalledTimes(1); // proves the https branch ran
        } finally {
            spy.mockRestore();
        }
    });

    test('timeout: server hangs + low CATEGORY_RPC_TIMEOUT_MS → CATEGORY_RPC_TIMEOUT_<ms>ms', async () => {
        respond = () => { /* never responds → client timeout fires */ };
        let mod;
        const prev = process.env.CATEGORY_RPC_TIMEOUT_MS;
        jest.isolateModules(() => {
            process.env.CATEGORY_RPC_TIMEOUT_MS = '200';
            mod = require('../category');
        });
        if (prev === undefined) delete process.env.CATEGORY_RPC_TIMEOUT_MS; else process.env.CATEGORY_RPC_TIMEOUT_MS = prev;

        const redis = makeFakeRedis();
        const cat = mod(redis, { serviceName: SVC, routerUrl });
        await expect(cat.create({ key: 'slow' })).rejects.toThrow(/CATEGORY_RPC_TIMEOUT_200ms/);
        expect(errorSpy).toHaveBeenCalled();
    });
});
