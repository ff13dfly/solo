const createDisplay = require('../logic/display');

// Minimal in-memory Redis hash stub (only the calls display.js uses).
function makeRedis(initial = {}) {
    const h = { ...initial };
    return {
        _h: h,
        hGet: jest.fn(async (key, field) => (key === 'SYSTEM:DISPLAY' ? (h[field] ?? null) : null)),
        hGetAll: jest.fn(async (key) => (key === 'SYSTEM:DISPLAY' ? { ...h } : {})),
        hSet: jest.fn(async (key, field, val) => { if (key === 'SYSTEM:DISPLAY') h[field] = val; return 1; }),
        hDel: jest.fn(async (key, field) => { if (key === 'SYSTEM:DISPLAY') delete h[field]; return 1; }),
    };
}

const ADMIN = { isAdmin: true };
const goodManifest = {
    service: 'market', entity: 'commodity',
    views: ['table', 'gallery'], defaultView: 'gallery',
    fields: [{ key: 'name', order: 1 }, { key: 'price', format: 'currency' }],
    computed: [{ key: 'pct', compute: { '/': [{ var: 'a' }, { var: 'b' }] }, format: 'percent' }],
};

describe('administrator display store', () => {
    test('set → get round-trips by service+entity', async () => {
        const d = createDisplay(makeRedis());
        const r = await d.set({ ...ADMIN, service: 'market', entity: 'commodity', manifest: goodManifest });
        expect(r.ok).toBe(true);
        expect(r.scope).toBe('market_commodity');
        const got = await d.get({ service: 'market', entity: 'commodity' });
        expect(got.defaultView).toBe('gallery');
    });

    test('get accepts an explicit id scope', async () => {
        const d = createDisplay(makeRedis({ 'market_commodity': JSON.stringify(goodManifest) }));
        const got = await d.get({ id: 'market_commodity' });
        expect(got.entity).toBe('commodity');
    });

    test('list returns every stored manifest', async () => {
        const d = createDisplay(makeRedis({
            'market_commodity': JSON.stringify(goodManifest),
            'planner_todo': JSON.stringify({ service: 'planner', entity: 'todo', fields: [] }),
        }));
        const { items } = await d.list();
        expect(items).toHaveLength(2);
        expect(items.map((i) => i.scope).sort()).toEqual(['market_commodity', 'planner_todo']);
    });

    test('list skips corrupt rows', async () => {
        const d = createDisplay(makeRedis({ 'good': JSON.stringify(goodManifest), 'bad': '{not json' }));
        const { items } = await d.list();
        expect(items).toHaveLength(1);
        expect(items[0].scope).toBe('good');
    });

    test('set without admin is rejected', async () => {
        const d = createDisplay(makeRedis());
        await expect(d.set({ service: 'market', entity: 'commodity', manifest: goodManifest }))
            .rejects.toMatchObject({ code: expect.any(Number) });
    });

    test('set rejects defaultView not in views', async () => {
        const d = createDisplay(makeRedis());
        await expect(d.set({ ...ADMIN, id: 'x_y', manifest: { views: ['table'], defaultView: 'gallery' } }))
            .rejects.toMatchObject({ message: expect.stringMatching(/defaultView/) });
    });

    test('set rejects computed key colliding with a real field', async () => {
        const d = createDisplay(makeRedis());
        const bad = { fields: [{ key: 'price' }], computed: [{ key: 'price', compute: { var: 'x' } }] };
        await expect(d.set({ ...ADMIN, id: 'x_y', manifest: bad }))
            .rejects.toMatchObject({ message: expect.stringMatching(/collides/) });
    });

    test('set returns a warning for an unknown format (but still stores)', async () => {
        const d = createDisplay(makeRedis());
        const r = await d.set({ ...ADMIN, id: 'x_y', manifest: { fields: [{ key: 'a', format: 'bogus' }] } });
        expect(r.ok).toBe(true);
        expect(r.warnings.join(' ')).toMatch(/bogus/);
    });

    test('delete removes the scope', async () => {
        const redis = makeRedis({ 'market_commodity': JSON.stringify(goodManifest) });
        const d = createDisplay(redis);
        const r = await d.del({ ...ADMIN, id: 'market_commodity' });
        expect(r.ok).toBe(true);
        expect(await d.get({ id: 'market_commodity' })).toBeNull();
    });
});
