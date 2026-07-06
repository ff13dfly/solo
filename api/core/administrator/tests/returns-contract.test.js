/**
 * returns-contract.test.js — proves administrator's ACTUAL handler output satisfies the
 * declared return contract (introspection `returns_schema`). Hermetic: real logic modules
 * (logic/identity.js + logic/error.js) over an injected Map-backed fake Redis. No stack,
 * no live Redis, no RedisJSON. Modeled on apps/collection/tests/returns-contract.test.js.
 *
 * Coverage = every HERMETICALLY-CALLABLE method:
 *   - admin.login.request / admin.login.verify / admin.password.reset (identity, seeded via saveAdmin)
 *   - admin.self.lock                                                  (identity, session seeded into fake redis)
 *   - admin.log.error  (both single-service AND all-services paths)    (error.list / error.listAll)
 *   - admin.log.clear  (both single-service AND all-services paths)    (error.clear / error.clearAll)
 *
 * NOT covered here (see `unverified` in the task report): the inline setting.* methods live in
 * index.js, not in createLogic(), and several read RedisJSON-published payloads / are bare-array
 * or arbitrary-key shapes — their returns_schema is static-derived from the index.js source.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-administrator-contract-${process.pid}`);

const crypto = require('crypto');
const createLogic = require('../logic');
const introspection = require('../handlers/introspection');
const config = require('../config');
const { checkReturn } = require('../../../library/contract');

// fake redis — covers exactly the commands logic/identity.js + logic/error.js touch.
// String KV + Redis lists (lRange / del) + key scan (keys). Map-backed, synchronous core.
function makeFakeRedis() {
    const kv = new Map();    // string keys
    const lists = new Map(); // list keys → array
    return {
        isOpen: true,
        async disconnect() { this.isOpen = false; }, // identity.cleanup() calls this
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v) { kv.set(k, v); return 'OK'; },
        async setEx(k, _ttl, v) { kv.set(k, v); return 'OK'; },
        async expire() { return 1; },
        async del(k) {
            const had = kv.delete(k) || lists.delete(k);
            return had ? 1 : 0;
        },
        async lPush(k, v) {
            const arr = lists.has(k) ? lists.get(k) : lists.set(k, []).get(k);
            arr.unshift(v);
            return arr.length;
        },
        async lRange(k, start, stop) {
            const arr = lists.get(k) || [];
            // redis lRange is inclusive of stop; -1 means end
            const end = stop === -1 ? arr.length : stop + 1;
            return arr.slice(start, end);
        },
        async keys(pattern) {
            // only the trailing-'*' prefix form is used by the error logic
            const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
            const out = [];
            for (const k of kv.keys()) if (k.startsWith(prefix)) out.push(k);
            for (const k of lists.keys()) if (k.startsWith(prefix)) out.push(k);
            return out;
        },
    };
}

const byName = Object.fromEntries(introspection.map((m) => [m.name, m]));
const method = (n) => byName[n];

describe('administrator — actual return satisfies declared returns_schema', () => {
    let redis;
    let identity;
    let error;

    beforeEach(async () => {
        redis = makeFakeRedis();
        const logic = createLogic(redis, config);
        identity = logic.identity;
        error = logic.error;
        // Bind the module-level redis client identity.js uses internally (no sweeper timer needed,
        // but init also wires `redisClient`). Pass our fake client.
        await identity.init(redis);
    });

    afterEach(async () => {
        // stop the challenge-sweep interval so jest exits clean
        await identity.cleanup();
    });

    // --- identity: password.reset / login.request / login.verify ---

    test('admin.password.reset (saveAdmin) → { success, username }', async () => {
        const res = await identity.saveAdmin({ username: 'root', password: 'hunter2hunter2' });
        expect(checkReturn(method('admin.password.reset'), res)).toEqual([]);
        expect(res.success).toBe(true);
        expect(res.username).toBe('root');
    });

    test('admin.login.request (loginRequest) → { challenge, salt, iterations }', async () => {
        // known user → salt/iterations come from the stored record
        await identity.saveAdmin({ username: 'root', password: 'hunter2hunter2' });
        const res = await identity.loginRequest({ username: 'root' });
        expect(checkReturn(method('admin.login.request'), res)).toEqual([]);
        expect(typeof res.challenge).toBe('string');
        expect(typeof res.salt).toBe('string');
        expect(typeof res.iterations).toBe('number');
    });

    test('admin.login.request for UNKNOWN user still returns all three keys', async () => {
        const res = await identity.loginRequest({ username: 'nobody' });
        expect(checkReturn(method('admin.login.request'), res)).toEqual([]);
    });

    test('admin.login.verify (loginVerify) → { success, token } on the happy path', async () => {
        // 1. provision the admin so getUser() resolves and login_hash exists
        await identity.saveAdmin({ username: 'root', password: 'hunter2hunter2' });
        // 2. read back the stored user to recompute the expected challenge-response
        const stored = JSON.parse(await redis.get(config.redis.userKeyPrefix + 'root'));
        // 3. request a challenge, then craft the correct response sha256(challenge + login_hash)
        const { challenge } = await identity.loginRequest({ username: 'root' });
        const response = crypto.createHash('sha256').update(challenge + stored.login_hash).digest('hex');
        const res = await identity.loginVerify({ username: 'root', challenge, response });
        expect(checkReturn(method('admin.login.verify'), res)).toEqual([]);
        expect(res.success).toBe(true);
        expect(typeof res.token).toBe('string');
        // The declaration was corrected to drop the phantom `user` key — prove it never appears.
        expect(res.user).toBeUndefined();
    });

    // --- identity: self.lock ---

    test('admin.self.lock (lockAdmin) → { ok, tokenExpiresIn }', async () => {
        // Seed an admin session for the caller token to satisfy the in-handler auth re-check.
        const token = 'tok-abc';
        await redis.set(
            `${config.redis.sessionKeyPrefix}${token}`,
            JSON.stringify({ username: 'root', role: 'admin', permit: { allow_all: true } })
        );
        const res = await identity.lockAdmin(token, () => null); // no real server to close
        expect(checkReturn(method('admin.self.lock'), res)).toEqual([]);
        expect(res.ok).toBe(true);
        expect(res.tokenExpiresIn).toBe(60);
    });

    // --- error: log.error (list) — BOTH paths ---

    test('admin.log.error single-service path → { logs, service }', async () => {
        const key = `${config.redis.errorQueuePrefix}router`;
        await redis.lPush(key, JSON.stringify({ message: 'boom', ts: 1 }));
        const res = await error.list(redis, { service: 'router', limit: 10, offset: 0 });
        expect(checkReturn(method('admin.log.error'), res)).toEqual([]);
        expect(Array.isArray(res.logs)).toBe(true);
        expect(res.service).toBe('router');
    });

    test('admin.log.error all-services path (no service) → { logs } (no `service` key, still valid)', async () => {
        await redis.lPush(`${config.redis.errorQueuePrefix}router`, JSON.stringify({ message: 'r', ts: 1 }));
        await redis.lPush(`${config.redis.errorQueuePrefix}user`, JSON.stringify({ message: 'u', ts: 2 }));
        const res = await error.list(redis, { limit: 100 }); // delegates to listAll
        expect(checkReturn(method('admin.log.error'), res)).toEqual([]);
        expect(Array.isArray(res.logs)).toBe(true);
        expect(res.service).toBeUndefined(); // service is conditional, NOT required
    });

    // --- error: log.clear (clear) — BOTH paths ---

    test('admin.log.clear single-service path → { success, service }', async () => {
        await redis.lPush(`${config.redis.errorQueuePrefix}router`, JSON.stringify({ message: 'x' }));
        const res = await error.clear(redis, { service: 'router', isAdmin: true });
        expect(checkReturn(method('admin.log.clear'), res)).toEqual([]);
        expect(res.success).toBe(true);
        expect(res.service).toBe('router');
    });

    test('admin.log.clear all-services path (no service) → { success } (no `service` key, still valid)', async () => {
        await redis.set(config.redis.activeServicesKey, JSON.stringify({ user: {}, agent: {} }));
        const res = await error.clear(redis, { isAdmin: true }); // delegates to clearAll
        expect(checkReturn(method('admin.log.clear'), res)).toEqual([]);
        expect(res.success).toBe(true);
        expect(res.service).toBeUndefined();
    });
});
