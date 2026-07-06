/**
 * nexus Sentinel logic — create / update / disable (hermetic, mock Redis).
 * Focus: the new update() re-syncs eventSubscriptions and establishes consumer
 * groups on newly-added streams.
 */
const createSentinel = require('../logic/sentinel');
const config = require('../config');

function mockRedis() {
    const store = {}, sets = {}, groups = [];
    const api = {
        async set(k, v, o) { if (o && o.NX && store[k] !== undefined) return null; store[k] = v; return 'OK'; },
        async get(k) { return store[k] || null; },
        async sAdd(k, v) { (sets[k] = sets[k] || new Set()).add(v); },
        async sRem(k, v) { if (sets[k]) sets[k].delete(v); },
        async sMembers(k) { return sets[k] ? [...sets[k]] : []; },
        async mGet(ks) { return ks.map((k) => store[k] || null); },
        async exists(k) { return store[k] ? 1 : 0; },
        async del(k) { delete store[k]; },
        async xGroupCreate(stream) { groups.push(stream); return 'OK'; },
        multi() {
            const ops = [];
            const p = {
                set(k, v) { ops.push(() => { store[k] = v; }); return p; },
                del(k) { ops.push(() => { delete store[k]; }); return p; },
                sAdd(k, v) { ops.push(() => { (sets[k] = sets[k] || new Set()).add(v); }); return p; },
                sRem(k, v) { ops.push(() => { if (sets[k]) sets[k].delete(v); }); return p; },
                async exec() { ops.forEach((o) => o()); return []; },
            };
            return p;
        },
        _groups: groups,
    };
    return api;
}

const SUB = (s) => config.redis.subscriptionPrefix + s;

let redis, logic;
beforeEach(() => { redis = mockRedis(); logic = createSentinel(redis, config, {}); });

describe('nexus.sentinel', () => {
    test('create — ACTIVE profile + subscription set + consumer group on the stream', async () => {
        const r = await logic.create({ name: 's1', authorityRole: 'role:a', eventSubscriptions: ['EVENT:A'] });
        expect(r.status).toBe('ACTIVE');
        expect(r.id).toBeTruthy();
        expect((await logic.get({ id: r.id })).name).toBe('s1');
        expect(await redis.sMembers(SUB('EVENT:A'))).toContain(r.id);
        expect(redis._groups).toContain('EVENT:A');
    });

    test('create — requires name + authorityRole', async () => {
        await expect(logic.create({ authorityRole: 'x' })).rejects.toMatchObject({ code: -32602 });
        await expect(logic.create({ name: 'x' })).rejects.toMatchObject({ code: -32602 });
    });

    test('update — merges fields and re-syncs subscriptions (add + remove) + groups new streams', async () => {
        const c = await logic.create({ name: 's2', authorityRole: 'r', eventSubscriptions: ['EVENT:OLD'] });
        redis._groups.length = 0;

        const u = await logic.update({ id: c.id, name: 's2-renamed', eventSubscriptions: ['EVENT:NEW'] });
        expect(u.name).toBe('s2-renamed');
        expect(await redis.sMembers(SUB('EVENT:OLD'))).not.toContain(c.id); // removed
        expect(await redis.sMembers(SUB('EVENT:NEW'))).toContain(c.id);     // added
        expect(redis._groups).toContain('EVENT:NEW');                       // group on the new stream
        // unchanged fields are preserved
        expect((await logic.get({ id: c.id })).authorityRole).toBe('r');
    });

    test('update — NOT_FOUND for an unknown id', async () => {
        await expect(logic.update({ id: 'absent' })).rejects.toMatchObject({ code: -32002 });
    });

    test('update — webhook reachability requires a webhookUrl', async () => {
        const c = await logic.create({ name: 's4', authorityRole: 'r' });
        await expect(logic.update({ id: c.id, reachability: 'webhook' })).rejects.toMatchObject({ code: -32602 });
    });

    test('disable — flips status to DISABLED and drops it from subscription sets (§2.4)', async () => {
        const c = await logic.create({ name: 's3', authorityRole: 'r', eventSubscriptions: ['EVENT:A', 'EVENT:B'] });
        expect(await redis.sMembers(SUB('EVENT:A'))).toContain(c.id);

        expect((await logic.disable({ id: c.id })).status).toBe('DISABLED');
        expect(await redis.sMembers(SUB('EVENT:A'))).not.toContain(c.id); // cleaned
        expect(await redis.sMembers(SUB('EVENT:B'))).not.toContain(c.id);
    });

    test('enable — re-activates a DISABLED Sentinel and re-adds its subscriptions + groups (§2.4)', async () => {
        const c = await logic.create({ name: 's5', authorityRole: 'r', eventSubscriptions: ['EVENT:A'] });
        await logic.disable({ id: c.id });
        redis._groups.length = 0;

        const e = await logic.enable({ id: c.id });
        expect(e.status).toBe('ACTIVE');
        expect(await redis.sMembers(SUB('EVENT:A'))).toContain(c.id); // re-added
        expect(redis._groups).toContain('EVENT:A');                   // group re-established
        expect((await logic.get({ id: c.id })).disabledAt).toBeUndefined();
    });

    test('delete — removes profile, registry-set membership, and subscriptions (§2.4)', async () => {
        const c = await logic.create({ name: 's6', authorityRole: 'r', eventSubscriptions: ['EVENT:A'] });
        const r = await logic.remove({ id: c.id });
        expect(r).toEqual({ id: c.id, deleted: true });
        await expect(logic.get({ id: c.id })).rejects.toMatchObject({ code: -32002 }); // NOT_FOUND
        expect(await redis.sMembers(config.redis.sentinelSet)).not.toContain(c.id);
        expect(await redis.sMembers(SUB('EVENT:A'))).not.toContain(c.id);
    });

    test('enable / delete — NOT_FOUND for an unknown id', async () => {
        await expect(logic.enable({ id: 'absent' })).rejects.toMatchObject({ code: -32002 });
        await expect(logic.remove({ id: 'absent' })).rejects.toMatchObject({ code: -32002 });
    });
});

// §1.2 visibility — get/list surface the identity mode (shared vs own bot) and
// whether that bot's token is provisioned, so the portal can show it.
describe('nexus.sentinel — identity visibility (§1.2)', () => {
    test('descriptive authorityRole → identity.mode "shared"', async () => {
        const redis = mockRedis();
        const logic = createSentinel(redis, config, {});
        const c = await logic.create({ name: 'shared-s', authorityRole: 'ops.watcher', eventSubscriptions: ['EVENT:A'] });
        const got = await logic.get({ id: c.id });
        expect(got.identity).toEqual({ mode: 'shared' });
        const { items } = await logic.list({});
        expect(items.find(i => i.id === c.id).identity).toEqual({ mode: 'shared' });
    });

    test('system.* authorityRole → identity.mode "bot" + hasToken from the identity helper', async () => {
        const redis = mockRedis();
        const identityStub = { isBotUid: (r) => String(r).startsWith('system.'), hasToken: async () => true };
        const logic = createSentinel(redis, config, { identity: identityStub });
        const c = await logic.create({ name: 'bot-s', authorityRole: 'system.watcher', eventSubscriptions: ['EVENT:A'] });
        const got = await logic.get({ id: c.id });
        expect(got.identity).toEqual({ mode: 'bot', uid: 'system.watcher', hasToken: true });
    });

    test('system.* authorityRole without an identity helper → hasToken null (unknown)', async () => {
        const redis = mockRedis();
        const logic = createSentinel(redis, config, {});
        const c = await logic.create({ name: 'bot-s2', authorityRole: 'system.watcher2', eventSubscriptions: ['EVENT:A'] });
        const got = await logic.get({ id: c.id });
        expect(got.identity).toEqual({ mode: 'bot', uid: 'system.watcher2', hasToken: null });
    });
});

// G1/G3 visibility — activity ledger enrichment + expiry-aware identity.
describe('nexus.sentinel — activity ledger + token expiry visibility', () => {
    test('expired token → identity carries expired:true (tokenState path)', async () => {
        const redis = mockRedis();
        const identityStub = {
            isBotUid: (r) => String(r).startsWith('system.'),
            hasToken: async () => true,
            tokenState: async () => ({ hasToken: true, expiresAt: 1000, expired: true }),
        };
        const logic = createSentinel(redis, config, { identity: identityStub });
        const c = await logic.create({ name: 'exp-s', authorityRole: 'system.expired', eventSubscriptions: ['EVENT:A'] });
        const got = await logic.get({ id: c.id });
        expect(got.identity).toEqual({ mode: 'bot', uid: 'system.expired', hasToken: true, expired: true, expiresAt: 1000 });
    });

    test('activity ledger is parsed from the hash; absent hash → zeros', async () => {
        const redis = mockRedis();
        const hashes = {};
        redis.hGetAll = async (k) => hashes[k] || {};
        const logic = createSentinel(redis, config, {});
        const c = await logic.create({ name: 'act-s', authorityRole: 'ops.act', eventSubscriptions: ['EVENT:A'] });

        // never fired → zeros
        let got = await logic.get({ id: c.id });
        expect(got.activity).toEqual({ fired: 0, skipped: 0, failed: 0, lastFiredAt: null, lastFailedAt: null });

        // consumer wrote counters → numbers lifted from strings
        hashes[config.redis.sentinelActivityPrefix + c.id] = { fired: '3', skipped: '12', failed: '1', lastFiredAt: '1700000005000' };
        got = await logic.get({ id: c.id });
        expect(got.activity).toEqual({ fired: 3, skipped: 12, failed: 1, lastFiredAt: 1700000005000, lastFailedAt: null });
    });
});
