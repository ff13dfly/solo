/**
 * Hermetic unit test for the external-principal entity + bridge (authority.md §4.1).
 * Roles come from the unified role store (role.js). Fake redis + real passport crypto.
 */
const createPassport = require('../logic/passport');
const createRole = require('../logic/role');

const config = {
    redis: {
        userPrefix: 'user:',
        sessionPrefix: 'session:',
        userSessionsPrefix: 'USER:SESSIONS:',
        role: { prefix: 'USER:ROLE:', idsSet: 'USER:ROLE:IDS' },
        passport: { prefix: 'USER:PASSPORT:', idsSet: 'USER:PASSPORT:IDS', saltPrefix: 'PASSPORT:SALT:', proofPrefix: 'PASSPORT:PROOFS:' },
    },
};

function fakeRedis() {
    const store = new Map(), hashes = new Map(), sets = new Map();
    const hOf = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
    const sOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
    const api = {
        store, hashes, sets,
        async get(k) { return store.has(k) ? store.get(k) : null; },
        async set(k, v) { store.set(k, v); return 'OK'; },
        async del(k) { const had = store.delete(k); sets.delete(k); hashes.delete(k); return had ? 1 : 0; },
        async sAdd(k, v) { sOf(k).add(v); return 1; },
        async sRem(k, v) { sOf(k).delete(v); return 1; },
        async sMembers(k) { return [...sOf(k)]; },
        async hSet(k, f, v) { hOf(k).set(f, v); return 1; },
        async hGet(k, f) { return hOf(k).has(f) ? hOf(k).get(f) : null; },
        async hKeys(k) { return [...hOf(k).keys()]; },
        multi() {
            const ops = [];
            const m = {
                set: (k, v) => { ops.push(() => store.set(k, v)); return m; },
                setEx: (k, _t, v) => { ops.push(() => store.set(k, v)); return m; },
                sAdd: (k, v) => { ops.push(() => sOf(k).add(v)); return m; },
                hSet: (k, f, v) => { ops.push(() => hOf(k).set(f, v)); return m; },
                expire: () => { ops.push(() => {}); return m; },
                del: (k) => { ops.push(() => { store.delete(k); }); return m; },
                exec: async () => { ops.forEach((o) => o()); return []; },
            };
            return m;
        },
    };
    return api;
}

async function setup() {
    const redis = fakeRedis();
    const role = createRole(redis, config);
    const P = createPassport(redis, config, { role });
    await role.set({ role: 'supplier', services: { collection: ['collection.payment.get'] }, ownerField: 'ownerId', scope: 'external' });
    return { redis, P, role };
}

describe('passport entity + bridge (unified roles)', () => {
    test('register binds role + app; list/get reflect it', async () => {
        const { redis, P } = await setup();
        const r = await P.register({ anchor: 'sup-1', role: 'supplier', app: 'appX', deviceId: 'd1', deviceToken: 'secret', name: 'Acme' });
        expect(r).toMatchObject({ anchor: 'sup-1', role: 'supplier', app: 'appX', status: 'ACTIVE' });

        const ent = JSON.parse(redis.store.get('USER:PASSPORT:sup-1'));
        expect(ent).toMatchObject({ id: 'sup-1', role: 'supplier', app: 'appX', name: 'Acme', status: 'ACTIVE' });

        const got = await P.get({ anchor: 'sup-1' });
        expect(got.devices).toEqual(['d1']);
    });

    test('list filters by app', async () => {
        const { P } = await setup();
        await P.register({ anchor: 'a1', role: 'supplier', app: 'appX', deviceId: 'd', deviceToken: 't' });
        await P.register({ anchor: 'b1', role: 'supplier', app: 'appY', deviceId: 'd', deviceToken: 't' });
        expect((await P.list({ app: 'appX' })).items.map((x) => x.id)).toEqual(['a1']);
        expect((await P.list()).items.map((x) => x.id).sort()).toEqual(['a1', 'b1']);
    });

    test('register requires a real role', async () => {
        const { P } = await setup();
        await expect(P.register({ anchor: 'x', role: 'ghost', deviceId: 'd', deviceToken: 't' }))
            .rejects.toMatchObject({ code: -32002 });
    });

    test('verify reads role from the ENTITY → resolved permit + $owner scoped to anchor', async () => {
        const { redis, P } = await setup();
        await P.register({ anchor: 'sup-1', role: 'supplier', deviceId: 'd1', deviceToken: 'secret' });
        const v = await P.verify({ anchor: 'sup-1', deviceId: 'd1', deviceToken: 'secret' });
        expect(v.role).toBe('supplier');
        const sess = JSON.parse(redis.store.get('session:' + v.token));
        expect(sess.kind).toBe('external');
        expect(sess.permit.services).toEqual({ collection: ['collection.payment.get'] });
        expect(sess.permit.constraints.$owner).toEqual({ field: 'ownerId', value: 'sup-1' });
    });

    test('fail-closed: verify REFUSES a session when the bound role lacks $owner (§3.7)', async () => {
        const { P, role } = await setup();
        // a scope:'both' role with NO ownerField → resolve yields a permit without $owner.
        // (role.set blocks scope:'external' without ownerField, so this is the way in.)
        await role.set({ role: 'noiso', services: { collection: ['collection.payment.get'] } });
        await P.register({ anchor: 'tenant9', role: 'noiso', deviceId: 'd1', deviceToken: 'secret' });
        await expect(P.verify({ anchor: 'tenant9', deviceId: 'd1', deviceToken: 'secret' }))
            .rejects.toMatchObject({ code: -32603, message: expect.stringMatching(/row-isolated/) });
    });

    test('verify rejects wrong token / unknown anchor / disabled', async () => {
        const { P } = await setup();
        await P.register({ anchor: 'sup-1', role: 'supplier', deviceId: 'd1', deviceToken: 'secret' });
        await expect(P.verify({ anchor: 'sup-1', deviceId: 'd1', deviceToken: 'WRONG' })).rejects.toMatchObject({ code: -32003 });
        await expect(P.verify({ anchor: 'ghost', deviceId: 'd1', deviceToken: 'secret' })).rejects.toMatchObject({ code: -32003 });
        await P.disable({ anchor: 'sup-1' });
        await expect(P.verify({ anchor: 'sup-1', deviceId: 'd1', deviceToken: 'secret' })).rejects.toMatchObject({ code: -32003 });
    });

    test('disable revokes live sessions', async () => {
        const { redis, P } = await setup();
        await P.register({ anchor: 'sup-1', role: 'supplier', deviceId: 'd1', deviceToken: 'secret' });
        const v = await P.verify({ anchor: 'sup-1', deviceId: 'd1', deviceToken: 'secret' });
        expect(redis.store.has('session:' + v.token)).toBe(true);
        const d = await P.disable({ anchor: 'sup-1' });
        expect(d.revoked).toBe(1);
        expect(redis.store.has('session:' + v.token)).toBe(false);
    });
});
