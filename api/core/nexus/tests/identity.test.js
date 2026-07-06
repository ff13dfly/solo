/**
 * nexus §1.2 per-Sentinel identity (hermetic: mock Redis + mock relay, frozen clock).
 * Covers: bot-uid gating, the Router-mirroring permit check, token store + self-refresh
 * + expiry, the config-time pre-audit, and soft-revoke (dropToken).
 */
const createIdentity = require('../logic/identity');
const config = require('../config');

function mockRedis() {
    const store = {};
    return {
        async set(k, v) { store[k] = v; return 'OK'; },
        async get(k) { return store[k] || null; },
        async del(k) { const had = store[k] !== undefined; delete store[k]; return had ? 1 : 0; },
        async exists(k) { return store[k] !== undefined ? 1 : 0; },
        _store: store,
    };
}

const ROLE = 'system.nexus.sentinel.abc123';
const NOW = 1_000_000_000_000;
const now = () => NOW;
const DAY = 24 * 60 * 60 * 1000;
const TKEY = config.redis.sentinelTokenPrefix + ROLE;

describe('nexus identity — gating + permit mirror', () => {
    const id = createIdentity(mockRedis(), config, {});

    test('isBotUid — only system.* opts into scoped identity', () => {
        expect(id.isBotUid('system.nexus.sentinel.x')).toBe(true);
        expect(id.isBotUid('test:ctx')).toBe(false);
        expect(id.isBotUid(undefined)).toBe(false);
    });

    test('permitAllows — mirrors Router checkPermission (full method under service segment)', () => {
        const permit = { allow_all: false, services: { collection: ['collection.payment.get'] } };
        expect(id.permitAllows(permit, 'collection.payment.get')).toBe(true);
        expect(id.permitAllows(permit, 'collection.payment.record')).toBe(false);
        expect(id.permitAllows({ allow_all: true }, 'anything.x.do')).toBe(true);
        expect(id.permitAllows({ allow_all: false, services: { collection: ['*'] } }, 'collection.x.get')).toBe(true);
        expect(id.permitAllows(null, 'a.b.get')).toBe(false);
    });
});

describe('nexus identity — token store', () => {
    test('setToken / getToken / hasToken round-trip', async () => {
        const id = createIdentity(mockRedis(), config, { now });
        await id.setToken({ authorityRole: ROLE, token: 'T1', expiresAt: NOW + DAY });
        expect(await id.hasToken(ROLE)).toBe(true);
        expect(await id.getToken(ROLE)).toBe('T1');
    });

    test('setToken — rejects non-system uid and already-expired token', async () => {
        const id = createIdentity(mockRedis(), config, { now });
        await expect(id.setToken({ authorityRole: 'desc', token: 'T', expiresAt: NOW + DAY })).rejects.toMatchObject({ code: -32602 });
        await expect(id.setToken({ authorityRole: ROLE, token: 'T', expiresAt: NOW - 1 })).rejects.toMatchObject({ code: -32602 });
    });

    test('getToken — throws when none provisioned', async () => {
        const id = createIdentity(mockRedis(), config, { now });
        await expect(id.getToken(ROLE)).rejects.toMatchObject({ code: -32602 });
    });

    test('getToken — an expired token is dropped, then throws', async () => {
        const redis = mockRedis();
        const id = createIdentity(redis, config, { now });
        redis._store[TKEY] = JSON.stringify({ token: 'OLD', expiresAt: NOW - 1 });
        await expect(id.getToken(ROLE)).rejects.toMatchObject({ code: -32602 });
        expect(await id.hasToken(ROLE)).toBe(false);
    });

    test('getToken — self-refreshes near expiry via relay.callAs(user.token.refresh) and persists', async () => {
        const redis = mockRedis();
        const calls = [];
        const relay = { callAs: async (token, method) => { calls.push({ token, method }); return { token: 'T2', expiresAt: NOW + DAY }; } };
        const id = createIdentity(redis, config, { relay, now });
        await id.setToken({ authorityRole: ROLE, token: 'T1', expiresAt: NOW + 60_000 }); // < 2h rotate window
        expect(await id.getToken(ROLE)).toBe('T2');
        expect(calls).toEqual([{ token: 'T1', method: 'user.token.refresh' }]);
        expect(await id.getToken(ROLE)).toBe('T2'); // persisted; no second refresh needed
    });

    test('getToken — refresh failure keeps the still-valid current token', async () => {
        const redis = mockRedis();
        const relay = { callAs: async () => { throw new Error('router down'); } };
        const id = createIdentity(redis, config, { relay, now });
        await id.setToken({ authorityRole: ROLE, token: 'T1', expiresAt: NOW + 60_000 });
        expect(await id.getToken(ROLE)).toBe('T1');
    });

    test('dropToken — soft revoke removes the held token', async () => {
        const id = createIdentity(mockRedis(), config, { now });
        await id.setToken({ authorityRole: ROLE, token: 'T1', expiresAt: NOW + DAY });
        expect((await id.dropToken(ROLE)).dropped).toBe(true);
        expect(await id.hasToken(ROLE)).toBe(false);
    });
});

describe('nexus identity — config-time pre-audit', () => {
    function relayWithPermit(permit) {
        return { callAs: async (token, method, params) => (method === 'user.permit.get' ? { uid: params.uid, permit } : null) };
    }

    test('passes when every method is within the bot permit; rejects an out-of-permit method', async () => {
        const redis = mockRedis();
        const relay = relayWithPermit({ allow_all: false, services: { collection: ['collection.payment.get'] } });
        const id = createIdentity(redis, config, { relay, now });
        await id.setToken({ authorityRole: ROLE, token: 'T1', expiresAt: NOW + DAY });
        await expect(id.preauditMethods(ROLE, ['collection.payment.get'])).resolves.toBeUndefined();
        await expect(id.preauditMethods(ROLE, ['collection.payment.record'])).rejects.toMatchObject({ code: -32602 });
    });

    test('no methods → no-op (does not require a token)', async () => {
        const id = createIdentity(mockRedis(), config, { now });
        await expect(id.preauditMethods(ROLE, [])).resolves.toBeUndefined();
    });
});
