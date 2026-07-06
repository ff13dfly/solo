/**
 * returns-contract.test.js — proves the `user` service handlers' ACTUAL output satisfies
 * the declared return contract (introspection `returns_schema`). Hermetic: real logic
 * modules wired over an injected Map-backed fake Redis (the collection/returns-contract +
 * role.test pattern). No stack, no live Redis, no LLM.
 *
 * Why this matters: orchestration / AI binds to these shapes. The prior audit found several
 * lying declarations (user.register said it returned [id,email,name,username,status] but
 * returns {success,uid}; account.list put records under `users` not `items`; account.status
 * declared a `deleted` field the code never computes; profile declared a non-existent
 * `username`; category.list is a bare array). This test pins reality.
 *
 * Methods that require an outbound Router RPC (category.create/delete), the full crypto
 * login handshake, or AsyncLocalStorage-scoped session context are listed as `unverified`
 * in the task report and rely on the static-derived schema instead.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-user-contract-${process.pid}`);
process.env.WAL_DIR = path.join(os.tmpdir(), `solo-user-contract-wal-${process.pid}`);

const createUserLogic = require('../logic/user');
const createBotLogic = require('../logic/bot');
const createRoleLogic = require('../logic/role');
const createPassportLogic = require('../logic/passport');
const createKeyLogic = require('../logic/key');
const config = require('../config');
const introspection = require('../handlers/introspection');
const { checkReturn } = require('../../../library/contract');

// Fake Redis — Map-backed, covers the string + set + hash + multi commands the user/bot/
// role/passport/key logic actually touch. setEx/expire are no-ops on TTL (we don't assert
// expiry); incr backs the sign rate-limiter.
function makeFakeRedis() {
    const kv = new Map();
    const sets = new Map();
    const hashes = new Map();
    const sOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
    const hOf = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
    const apply = {
        set: (k, v, opts) => { if (opts && opts.NX && kv.has(k)) return null; kv.set(k, v); return 'OK'; },
        setEx: (k, _ttl, v) => { kv.set(k, v); return 'OK'; },
        del: (k) => { const had = kv.delete(k) || sets.delete(k) || hashes.delete(k); return had ? 1 : 0; },
        sAdd: (k, m) => { const s = sOf(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        sRem: (k, m) => { const s = sets.get(k); return s && s.delete(m) ? 1 : 0; },
        expire: () => 1,
        hSet: (k, f, v) => { hOf(k).set(f, v); return 1; },
    };
    const redis = {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v, opts) { return apply.set(k, v, opts); },
        async setEx(k, ttl, v) { return apply.setEx(k, ttl, v); },
        async del(k) { return apply.del(k); },
        async mGet(keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
        async keys(pattern) {
            // minimal glob: only the `*kw*` / `prefix*` forms the user.list fuzzy path uses.
            const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
            return [...kv.keys()].filter((k) => re.test(k));
        },
        async sAdd(k, m) { return apply.sAdd(k, m); },
        async sRem(k, m) { return apply.sRem(k, m); },
        async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
        async sCard(k) { return sets.has(k) ? sets.get(k).size : 0; },
        async expire(k, ttl) { return apply.expire(k, ttl); },
        async incr(k) { const n = Number(kv.get(k) || 0) + 1; kv.set(k, String(n)); return n; },
        async hSet(k, f, v) { return apply.hSet(k, f, v); },
        async hGet(k, f) { const h = hashes.get(k); return h && h.has(f) ? h.get(f) : null; },
        async hKeys(k) { return hashes.has(k) ? [...hashes.get(k).keys()] : []; },
        multi() {
            const ops = [];
            const chain = {
                set(k, v, opts) { ops.push(['set', k, v, opts]); return chain; },
                setEx(k, ttl, v) { ops.push(['setEx', k, ttl, v]); return chain; },
                sAdd(k, m) { ops.push(['sAdd', k, m]); return chain; },
                sRem(k, m) { ops.push(['sRem', k, m]); return chain; },
                del(k) { ops.push(['del', k]); return chain; },
                expire(k, ttl) { ops.push(['expire', k, ttl]); return chain; },
                hSet(k, f, v) { ops.push(['hSet', k, f, v]); return chain; },
                async exec() { return ops.map(([op, ...args]) => apply[op](...args)); },
            };
            return chain;
        },
    };
    return redis;
}

const byName = Object.fromEntries(introspection.map((m) => [m.name, m]));
const method = (n) => byName[n];
const ok = (name, result) => expect(checkReturn(method(name), result)).toEqual([]);

describe('user service — actual returns satisfy declared returns_schema', () => {
    let redis, user, bot, role, passport, key;
    beforeEach(() => {
        redis = makeFakeRedis();
        user = createUserLogic(redis, config);
        bot = createBotLogic(redis, config);
        role = createRoleLogic(redis, config);
        passport = createPassportLogic(redis, config, { role });
        key = createKeyLogic(redis, config);
    });

    // ── user.* account lifecycle ────────────────────────────────────────────
    async function makeUser(name = 'alice') {
        const r = await user.register({ name, email: `${name}@ex.com`, phone: '12345' });
        return r.uid;
    }

    test('user.register → {success, uid}', async () => {
        const r = await user.register({ name: 'alice', email: 'a@ex.com' });
        ok('user.register', r);
        expect(r.success).toBe(true);
        expect(typeof r.uid).toBe('string');
    });

    test('user.profile (getProfile) → full profile, no `username`', async () => {
        const uid = await makeUser('bob');
        const p = await user.getProfile({ uid });
        ok('user.profile', p);
        expect(p).not.toHaveProperty('username'); // the lie the audit caught
        expect(p.name).toBe('bob');
        expect(p).not.toHaveProperty('hash'); // sensitive material filtered
    });

    test('user.account.status (stats) → {active, total}, never `deleted`', async () => {
        await makeUser('c1'); await makeUser('c2');
        const s = await user.stats();
        ok('user.account.status', s);
        expect(s).not.toHaveProperty('deleted'); // never computed
        expect(s.total).toBe(2);
    });

    test('user.account.list → records under `users` (not `items`)', async () => {
        await makeUser('d1'); await makeUser('d2');
        const res = await user.list({});
        ok('user.account.list', res);
        expect(Array.isArray(res.users)).toBe(true);
        expect(res).not.toHaveProperty('items'); // the lie the audit caught
    });

    test('user.account.update → {success, uid, categories, meta}', async () => {
        const uid = await makeUser('e1');
        const res = await user.update({ uid, lang: 'en', meta: { foo: 1 } });
        ok('user.account.update', res);
        expect(res.uid).toBe(uid);
    });

    test('user.account.remove → {success, id} (and {success, message} idempotent path)', async () => {
        const uid = await makeUser('f1');
        const res = await user.remove({ id: uid });
        ok('user.account.remove', res);
        const again = await user.remove({ id: uid }); // already-deleted early-return
        ok('user.account.remove', again);
        expect(again.message).toBeDefined();
    });

    test('user.account.restore → {success[, id]} (both paths)', async () => {
        const uid = await makeUser('g1');
        await user.remove({ id: uid });
        const res = await user.restore({ id: uid });
        ok('user.account.restore', res);
        const noop = await user.restore({ id: uid }); // already-active early-return: {success:true}
        ok('user.account.restore', noop);
    });

    test('user.account.check (checkDeletable) → {canDestroy}', async () => {
        const uid = await makeUser('h1');
        ok('user.account.check', await user.checkDeletable({ id: uid }));
    });

    test('user.account.destroy → {success, id}', async () => {
        const uid = await makeUser('i1');
        ok('user.account.destroy', await user.destroy({ id: uid }));
    });

    // ── user.permit.* ───────────────────────────────────────────────────────
    test('user.permit.update → {success, uid}', async () => {
        const uid = await makeUser('j1');
        const res = await user.updatePermit({ uid, permit: { allow_all: false, services: {} } });
        ok('user.permit.update', res);
    });

    test('user.permit.get → {uid, permit}', async () => {
        const uid = await makeUser('k1');
        const res = await user.getPermit({ uid });
        ok('user.permit.get', res);
        expect(typeof res.permit).toBe('object');
    });

    test('user.permit.batch → {results}', async () => {
        const uid = await makeUser('l1');
        const res = await user.batchPermits({ permits: [{ uid, permit: { allow_all: false, services: {} } }] });
        ok('user.permit.batch', res);
        expect(Array.isArray(res.results)).toBe(true);
    });

    // ── user.bot.* ──────────────────────────────────────────────────────────
    async function makeBot(uid = 'system.worker') {
        await bot.create({ uid, permit: { allow_all: false, services: {} }, desc: 'd' });
        return uid;
    }

    test('user.bot.create → {id}', async () => {
        ok('user.bot.create', await bot.create({ uid: 'system.b1', permit: { allow_all: false, services: {} } }));
    });

    test('user.bot.list → {items}', async () => {
        await makeBot('system.b2');
        ok('user.bot.list', await bot.list());
    });

    test('user.bot.get → full bot record', async () => {
        const uid = await makeBot('system.b3');
        ok('user.bot.get', await bot.get({ uid }));
    });

    test('user.bot.update → {id}', async () => {
        const uid = await makeBot('system.b4');
        ok('user.bot.update', await bot.update({ uid, desc: 'updated' }));
    });

    test('user.bot.delete (remove) → {id}', async () => {
        const uid = await makeBot('system.b5');
        ok('user.bot.delete', await bot.remove({ uid }));
    });

    test('user.bot.issue.token → {token, expiresAt}', async () => {
        const uid = await makeBot('system.b6');
        ok('user.bot.issue.token', await bot.issueToken({ uid }));
    });

    test('user.bot.suspend → {id, status, revoked}', async () => {
        const uid = await makeBot('system.b7');
        await bot.issueToken({ uid });
        const res = await bot.suspend({ uid });
        ok('user.bot.suspend', res);
        const noop = await bot.suspend({ uid }); // already-suspended early-return
        ok('user.bot.suspend', noop);
    });

    test('user.bot.resume → {id, status} (both paths)', async () => {
        const uid = await makeBot('system.b8');
        await bot.suspend({ uid });
        ok('user.bot.resume', await bot.resume({ uid }));
        ok('user.bot.resume', await bot.resume({ uid })); // already-active early-return
    });

    test('user.token.refresh → {token, expiresAt}', async () => {
        const uid = await makeBot('system.b9');
        ok('user.token.refresh', await bot.tokenRefresh({}, uid));
    });

    test('user.token.revoke → {uid, revoked}', async () => {
        const uid = await makeBot('system.b10');
        await bot.issueToken({ uid });
        ok('user.token.revoke', await bot.revoke({ uid }));
    });

    // ── user.role.* ─────────────────────────────────────────────────────────
    test('user.role.set → {role, scope}', async () => {
        ok('user.role.set', await role.set({ role: 'ops', services: { collection: ['x.y.get'] } }));
    });

    test('user.role.list → {items}', async () => {
        await role.set({ role: 'ops', services: {} });
        ok('user.role.list', await role.list());
    });

    test('user.role.get → full role doc', async () => {
        await role.set({ role: 'ops', services: { collection: ['x.y.get'] } });
        ok('user.role.get', await role.get({ role: 'ops' }));
    });

    test('user.role.assign → {uid, role}', async () => {
        const uid = await makeUser('m1');
        await role.set({ role: 'ops', services: {} });
        ok('user.role.assign', await role.assign({ uid, role: 'ops' }));
    });

    // ── user.passport.* ─────────────────────────────────────────────────────
    async function makePassport(anchor = 'ext-1') {
        await role.set({ role: 'partner', services: { collection: ['x.y.get'] }, ownerField: 'ownerId', scope: 'external' });
        const r = await passport.register({ anchor, role: 'partner', app: 'acme', deviceToken: 'tok-123' });
        return { anchor, deviceId: r.deviceId };
    }

    test('user.passport.register → {anchor, role, app, deviceId, status}', async () => {
        await role.set({ role: 'partner', services: {}, ownerField: 'ownerId', scope: 'external' });
        const res = await passport.register({ anchor: 'ext-r', role: 'partner', app: 'acme', deviceToken: 'tok' });
        ok('user.passport.register', res);
    });

    test('user.passport.list → {items}', async () => {
        await makePassport('ext-l');
        ok('user.passport.list', await passport.list({}));
    });

    test('user.passport.get → entity + devices[]', async () => {
        const { anchor } = await makePassport('ext-g');
        const res = await passport.get({ anchor });
        ok('user.passport.get', res);
        expect(Array.isArray(res.devices)).toBe(true);
    });

    test('user.passport.disable → {anchor, status, revoked}', async () => {
        const { anchor } = await makePassport('ext-d');
        ok('user.passport.disable', await passport.disable({ anchor }));
    });

    test('user.passport.verify → restricted session {token, expiresAt, anchor, role}', async () => {
        const { anchor, deviceId } = await makePassport('ext-v');
        const res = await passport.verify({ anchor, deviceId, deviceToken: 'tok-123' });
        ok('user.passport.verify', res);
    });

    // ── user.key.* (Ed25519 signing keys) ───────────────────────────────────
    const PW = 'correct-horse-battery';

    test('user.key.generate → {uid, publicKey, createdAt}', async () => {
        const res = await key.generate({ password: PW }, { actor: 'uid-signer-1' });
        ok('user.key.generate', res);
    });

    test('user.key.sign → {uid, digest, signature, publicKey}', async () => {
        const actor = 'uid-signer-2';
        await key.generate({ password: PW }, { actor });
        const res = await key.sign({ digest: 'deadbeefdeadbeef', password: PW }, { actor });
        ok('user.key.sign', res);
    });

    test('user.key.public (getPublic) → {uid, publicKey, status, history} — both with and without a key', async () => {
        const actor = 'uid-signer-3';
        ok('user.key.public', await key.getPublic({ uid: actor })); // no key yet: publicKey null
        await key.generate({ password: PW }, { actor });
        ok('user.key.public', await key.getPublic({ uid: actor }));
    });

    test('user.key.status → {uid, hasKey, publicKey} — both states', async () => {
        const actor = 'uid-signer-4';
        ok('user.key.status', await key.status({ uid: actor }, { actor })); // no key
        await key.generate({ password: PW }, { actor });
        ok('user.key.status', await key.status({ uid: actor }, { actor }));
    });

    test('user.key.revoke → {uid, revoked[, reason]} — both paths', async () => {
        const actor = 'uid-signer-5';
        ok('user.key.revoke', await key.revoke({ uid: actor })); // no key: {uid, revoked:false, reason}
        await key.generate({ password: PW }, { actor });
        ok('user.key.revoke', await key.revoke({ uid: actor })); // has key: {uid, revoked:true}
    });

    // ── bare-array provider: user.category.list ─────────────────────────────
    // The shared library/category list() returns a BARE top-level array; the flat object-key
    // dialect cannot express that, so the method declares NO returns_schema. checkReturn with
    // an empty/no contract returns [] (nothing to assert) — we assert the SHAPE directly.
    test('user.category.list returns a bare array (no object-key contract to violate)', async () => {
        const category = require('../../../library/category')(redis, { serviceName: 'user' });
        const res = await category.list({});
        expect(Array.isArray(res)).toBe(true);
        // And the declaration honestly carries no returns_schema (would be a lie for an array).
        expect(method('user.category.list').returns_schema).toBeUndefined();
        expect(method('user.category.list').returns).toBeUndefined();
        // checkReturn over a no-contract method is vacuously []:
        expect(checkReturn(method('user.category.list'), res)).toEqual([]);
    });

    // ── local-only category mutations (create/delete need the Router RPC; these don't) ──
    test('user.category.item.* + get/update over a locally-seeded category', async () => {
        const category = require('../../../library/category')(redis, { serviceName: 'user' });
        // Seed a category locally (bypasses the Router-reserving create()).
        const SERVICE_UPPER = 'USER';
        const seedKey = `${SERVICE_UPPER}:CONFIG:CATEGORY:POWER`;
        const doc = { key: 'POWER', type: 'LIST', scope: 'LOCAL', desc: 'tier', meta: {}, items: [], status: 'ACTIVE', createdAt: Date.now(), updatedAt: Date.now() };
        await redis.set(seedKey, JSON.stringify(doc));
        await redis.sAdd('USER:CONFIG:CATEGORY_IDX', seedKey);

        ok('user.category.get', await category.get({ key: 'POWER' }));
        ok('user.category.update', await category.update({ key: 'POWER', desc: 'tier2' }));

        const added = await category.addItem({ key: 'POWER', id: 'admin', label: { zh: '管理员', en: 'Admin' } });
        ok('user.category.item.add', added);

        ok('user.category.item.get', await category.getItem({ key: 'POWER', id: 'admin' }));
        ok('user.category.item.update', await category.updateItem({ key: 'POWER', id: 'admin', desc: 'd' }));
        ok('user.category.item.remove', await category.removeItem({ key: 'POWER', id: 'admin' }));
    });
});
