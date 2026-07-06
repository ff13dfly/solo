/**
 * Hermetic unit test for the role entity (authority.md) — named permit templates,
 * materialized onto a principal. Fake redis, no stack.
 */
const createRole = require('../logic/role');

const config = { redis: { userPrefix: 'user:', role: { prefix: 'USER:ROLE:', idsSet: 'USER:ROLE:IDS' } } };

function fakeRedis(seed = {}) {
    const store = new Map(Object.entries(seed));
    const sets = new Map();
    const sOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
    return {
        store, sets,
        async get(k) { return store.has(k) ? store.get(k) : null; },
        async set(k, v) { store.set(k, v); return 'OK'; },
        async del(k) { return store.delete(k) ? 1 : 0; },
        async sAdd(k, v) { sOf(k).add(v); return 1; },
        async sRem(k, v) { sOf(k).delete(v); return 1; },
        async sMembers(k) { return [...sOf(k)]; },
    };
}

describe('role entity', () => {
    test('set stores a named permit template (services + $owner field) + indexes it', async () => {
        const redis = fakeRedis();
        const R = createRole(redis, config);
        const r = await R.set({ role: 'partner', services: { collection: ['collection.payment.get'] }, ownerField: 'ownerId', scope: 'external' });
        expect(r).toEqual({ role: 'partner', scope: 'external' });
        const doc = JSON.parse(redis.store.get('USER:ROLE:partner'));
        expect(doc).toMatchObject({ id: 'partner', scope: 'external', services: { collection: ['collection.payment.get'] }, constraints: { $owner: { field: 'ownerId' } } });
        expect((await R.list()).items.map((x) => x.id)).toEqual(['partner']);
    });

    test("fail-closed: scope:'external' role WITHOUT ownerField is rejected (row isolation, §3.7)", async () => {
        const redis = fakeRedis();
        const R = createRole(redis, config);
        await expect(R.set({ role: 'vendor', services: { collection: ['collection.payment.get'] }, scope: 'external' }))
            .rejects.toMatchObject({ code: -32602 });
        // not persisted
        expect(redis.store.has('USER:ROLE:vendor')).toBe(false);
        // scope:'both' (default) without ownerField is still allowed — the verify-side gate
        // catches an external passport bound to it.
        await expect(R.set({ role: 'mixed', services: { collection: ['x.y.get'] } })).resolves.toBeTruthy();
    });

    test('resolve composes a permit; injects $owner.value when an owner value is given', async () => {
        const redis = fakeRedis();
        const R = createRole(redis, config);
        await R.set({ role: 'partner', services: { collection: ['x.y.get'] }, ownerField: 'ownerId' });
        const p = await R.resolve('partner', 'anchor-7');
        expect(p.allow_all).toBe(false);
        expect(p.services).toEqual({ collection: ['x.y.get'] });
        expect(p.constraints.$owner).toEqual({ field: 'ownerId', value: 'anchor-7' });
        // without owner value → field present, no value
        const p2 = await R.resolve('partner');
        expect(p2.constraints.$owner).toEqual({ field: 'ownerId' });
    });

    test('assign MATERIALIZES the role permit onto an internal user record (no runtime role lookup)', async () => {
        const redis = fakeRedis({ 'user:u-1': JSON.stringify({ id: 'u-1', name: 'Bob', permit: { allow_all: false, services: {} } }) });
        const R = createRole(redis, config);
        await R.set({ role: 'ops', services: { collection: ['collection.payment.list'] } });
        const res = await R.assign({ uid: 'u-1', role: 'ops' });
        expect(res).toEqual({ uid: 'u-1', role: 'ops' });
        const u = JSON.parse(redis.store.get('user:u-1'));
        expect(u.permit.services).toEqual({ collection: ['collection.payment.list'] });   // materialized (RBAC axis)
        expect(u.role).toBe('ops');               // RBAC role
        expect(u.categories).toBeUndefined();     // tier axis (categories.POWER) untouched
        expect(u.name).toBe('Bob');               // other fields preserved
    });

    test('get / assign on unknown role / user throw', async () => {
        const redis = fakeRedis();
        const R = createRole(redis, config);
        await expect(R.get({ role: 'nope' })).rejects.toMatchObject({ code: -32002 });
        await R.set({ role: 'ops', services: {} });
        await expect(R.assign({ uid: 'ghost', role: 'ops' })).rejects.toMatchObject({ code: -32002 });
    });
});
