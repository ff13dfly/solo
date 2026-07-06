/**
 * Hermetic unit test for library/config.js — the Redis-backed runtime config
 * manager (createConfig factory).
 *
 * NOTE: despite the assignment brief anticipating an env-driven portFor()
 * resolver, this module reads NOTHING from process.env at require time. It is a
 * thin wrapper over a Redis client: effective value = Redis override → local
 * config.js default, with type-casting driven by the type of the default. The
 * only collaborator is a redis client, which we fake with an in-memory hash
 * store + jest.fn spies so we can assert both behavior AND the exact redis
 * calls (key names, stringification).
 *
 * Coverage targets (every branch):
 *   cast()    — boolean ('true'/non-'true'), number (incl. NaN), string passthrough
 *   getPath() — nested hit, top-level miss, intermediate-undefined short-circuit
 *   get()     — redis miss (null → default) vs hit (cast override)
 *   getMany() — empty keys early-return, mixed hit/miss across keys
 *   set()     — String() coercion of arbitrary value types
 *   del()     — field deletion
 *   overrides()— object passthrough vs falsy → {} fallback
 *   publish() — schema shape (service/publishedAt/keys w/ default+type)
 */
const { createConfig } = require('../config');

// In-memory redis double. Hash semantics mirror node-redis v4:
//   hGet    → value | null (missing)
//   hmGet   → array, null per missing field
//   hGetAll → plain object ({} when key absent in real redis)
// Each method is a jest.fn so call args (redisKey, stringified values) are assertable.
function makeRedis() {
    const hashes = new Map(); // hashKey -> Map(field -> string)
    const kv = new Map();     // plain string keys (used by publish)
    const hashOf = (key) => {
        if (!hashes.has(key)) hashes.set(key, new Map());
        return hashes.get(key);
    };
    return {
        hashes,
        kv,
        // test helper: seed a stored override exactly as redis would hold it (string)
        _seed(key, field, value) { hashOf(key).set(field, value); },
        hGet: jest.fn(async (key, field) => {
            const m = hashes.get(key);
            return m && m.has(field) ? m.get(field) : null;
        }),
        hmGet: jest.fn(async (key, fields) => {
            const m = hashes.get(key);
            return fields.map((f) => (m && m.has(f) ? m.get(f) : null));
        }),
        hSet: jest.fn(async (key, field, value) => { hashOf(key).set(field, value); return 1; }),
        hDel: jest.fn(async (key, field) => {
            const m = hashes.get(key);
            const had = m ? m.delete(field) : false;
            return had ? 1 : 0;
        }),
        hGetAll: jest.fn(async (key) => {
            const m = hashes.get(key);
            return m ? Object.fromEntries(m) : {};
        }),
        set: jest.fn(async (key, value) => { kv.set(key, value); return 'OK'; }),
    };
}

// Representative localConfig with boolean / number / string defaults at several
// nesting depths so cast() + getPath() branches are all reachable through the API.
function makeLocalConfig() {
    return {
        serviceName: 'storage',
        maxCacheSize: 1000,                       // number, top-level
        region: 'us-east',                        // string, top-level
        thumbnails: { enabled: true, maxWidth: 256 }, // boolean + number, nested
        flags: { beta: false },                   // boolean (default false)
    };
}

const SERVICE = 'storage';
const REDIS_KEY = `config:${SERVICE}`;

describe('createConfig — factory + shape', () => {
    test('returns the documented API surface', () => {
        const cfg = createConfig(makeRedis(), SERVICE, makeLocalConfig());
        expect(Object.keys(cfg).sort()).toEqual(
            ['del', 'get', 'getMany', 'overrides', 'publish', 'set'].sort(),
        );
        for (const fn of ['get', 'getMany', 'set', 'del', 'overrides', 'publish']) {
            expect(typeof cfg[fn]).toBe('function');
        }
    });
});

describe('get() — Redis override → local default priority', () => {
    let redis;
    let cfg;
    beforeEach(() => {
        redis = makeRedis();
        cfg = createConfig(redis, SERVICE, makeLocalConfig());
    });

    test('redis miss (null) falls back to the local default, unchanged type', async () => {
        await expect(cfg.get('maxCacheSize')).resolves.toBe(1000);   // number default
        await expect(cfg.get('region')).resolves.toBe('us-east');    // string default
        await expect(cfg.get('thumbnails.enabled')).resolves.toBe(true); // boolean default
        // it queried the right hash + field
        expect(redis.hGet).toHaveBeenCalledWith(REDIS_KEY, 'maxCacheSize');
    });

    test('boolean cast: stored "true" → true, anything-else → false', async () => {
        redis._seed(REDIS_KEY, 'thumbnails.enabled', 'true');
        await expect(cfg.get('thumbnails.enabled')).resolves.toBe(true);

        redis._seed(REDIS_KEY, 'flags.beta', 'false');               // default false, stored 'false'
        await expect(cfg.get('flags.beta')).resolves.toBe(false);

        // a non-'true' string still casts to false against a boolean default
        redis._seed(REDIS_KEY, 'thumbnails.enabled', 'yes');
        await expect(cfg.get('thumbnails.enabled')).resolves.toBe(false);
    });

    test('number cast: numeric string → Number, garbage → NaN', async () => {
        redis._seed(REDIS_KEY, 'maxCacheSize', '2048');
        await expect(cfg.get('maxCacheSize')).resolves.toBe(2048);
        expect(typeof (await cfg.get('maxCacheSize'))).toBe('number');

        redis._seed(REDIS_KEY, 'maxCacheSize', 'not-a-number');
        await expect(cfg.get('maxCacheSize')).resolves.toBeNaN();
    });

    test('string cast: raw passthrough (no coercion)', async () => {
        redis._seed(REDIS_KEY, 'region', 'eu-west');
        await expect(cfg.get('region')).resolves.toBe('eu-west');
    });

    test('unknown key → default undefined; redis still consulted', async () => {
        // getPath misses entirely (top-level key absent) → defaultVal undefined,
        // redis also misses → returns undefined
        await expect(cfg.get('does.not.exist')).resolves.toBeUndefined();

        // getPath short-circuits on an intermediate non-object, redis hit casts as
        // a string (typeof undefined default is not boolean/number)
        redis._seed(REDIS_KEY, 'region.deeper.path', 'raw-value');
        await expect(cfg.get('region.deeper.path')).resolves.toBe('raw-value');
    });
});

describe('getMany() — batched reads', () => {
    let redis;
    let cfg;
    beforeEach(() => {
        redis = makeRedis();
        cfg = createConfig(redis, SERVICE, makeLocalConfig());
    });

    test('empty key list short-circuits to {} without touching redis', async () => {
        await expect(cfg.getMany([])).resolves.toEqual({});
        expect(redis.hmGet).not.toHaveBeenCalled();
    });

    test('mixed hits/misses: each key uses its own default + cast', async () => {
        redis._seed(REDIS_KEY, 'maxCacheSize', '4096');             // hit → number
        redis._seed(REDIS_KEY, 'thumbnails.enabled', 'false');      // hit → boolean
        // 'region' left unseeded → miss → string default
        const out = await cfg.getMany(['maxCacheSize', 'thumbnails.enabled', 'region']);
        expect(out).toEqual({
            maxCacheSize: 4096,
            'thumbnails.enabled': false,
            region: 'us-east',
        });
        expect(redis.hmGet).toHaveBeenCalledWith(
            REDIS_KEY,
            ['maxCacheSize', 'thumbnails.enabled', 'region'],
        );
    });

    test('all misses → all defaults', async () => {
        const out = await cfg.getMany(['region', 'flags.beta']);
        expect(out).toEqual({ region: 'us-east', 'flags.beta': false });
    });
});

describe('set() — writes stringified override under the service hash', () => {
    let redis;
    let cfg;
    beforeEach(() => {
        redis = makeRedis();
        cfg = createConfig(redis, SERVICE, makeLocalConfig());
    });

    test('coerces value to string regardless of input type', async () => {
        await cfg.set('thumbnails.enabled', false);
        expect(redis.hSet).toHaveBeenCalledWith(REDIS_KEY, 'thumbnails.enabled', 'false');

        await cfg.set('maxCacheSize', 8192);
        expect(redis.hSet).toHaveBeenCalledWith(REDIS_KEY, 'maxCacheSize', '8192');

        await cfg.set('region', 'ap-south');
        expect(redis.hSet).toHaveBeenCalledWith(REDIS_KEY, 'region', 'ap-south');
    });

    test('a value written by set() is then visible to get() (round-trip)', async () => {
        await cfg.set('maxCacheSize', 123);
        await expect(cfg.get('maxCacheSize')).resolves.toBe(123); // cast back to number
    });
});

describe('del() — removes an override under the service hash', () => {
    test('deletes the field; get() reverts to local default', async () => {
        const redis = makeRedis();
        const cfg = createConfig(redis, SERVICE, makeLocalConfig());
        redis._seed(REDIS_KEY, 'region', 'eu-west');
        await expect(cfg.get('region')).resolves.toBe('eu-west');

        await cfg.del('region');
        expect(redis.hDel).toHaveBeenCalledWith(REDIS_KEY, 'region');
        await expect(cfg.get('region')).resolves.toBe('us-east'); // back to default
    });
});

describe('overrides() — raw dump for portal UI', () => {
    test('returns the stored hash verbatim (strings, uncast)', async () => {
        const redis = makeRedis();
        const cfg = createConfig(redis, SERVICE, makeLocalConfig());
        redis._seed(REDIS_KEY, 'maxCacheSize', '4096');
        redis._seed(REDIS_KEY, 'thumbnails.enabled', 'true');
        await expect(cfg.overrides()).resolves.toEqual({
            maxCacheSize: '4096',
            'thumbnails.enabled': 'true',
        });
        expect(redis.hGetAll).toHaveBeenCalledWith(REDIS_KEY);
    });

    test('no overrides → empty object', async () => {
        const redis = makeRedis();
        const cfg = createConfig(redis, SERVICE, makeLocalConfig());
        await expect(cfg.overrides()).resolves.toEqual({});
    });

    test('falsy hGetAll result (null) is coalesced to {}', async () => {
        const redis = makeRedis();
        redis.hGetAll.mockResolvedValueOnce(null); // some redis builds return null for missing key
        const cfg = createConfig(redis, SERVICE, makeLocalConfig());
        await expect(cfg.overrides()).resolves.toEqual({});
    });
});

describe('publish() — schema discovery doc for the portal', () => {
    test('writes SYSTEM:CONFIG:SCHEMA:<service> with key/default/type per key', async () => {
        const redis = makeRedis();
        const cfg = createConfig(redis, SERVICE, makeLocalConfig());

        const before = Date.now();
        await cfg.publish(['thumbnails.enabled', 'maxCacheSize', 'region', 'missing.key']);
        const after = Date.now();

        expect(redis.set).toHaveBeenCalledTimes(1);
        const [schemaKey, raw] = redis.set.mock.calls[0];
        expect(schemaKey).toBe(`SYSTEM:CONFIG:SCHEMA:${SERVICE}`);

        const schema = JSON.parse(raw);
        expect(schema.service).toBe(SERVICE);
        // publishedAt is a valid ISO timestamp bracketed by the call window
        const ts = Date.parse(schema.publishedAt);
        expect(Number.isNaN(ts)).toBe(false);
        expect(ts).toBeGreaterThanOrEqual(before - 1000);
        expect(ts).toBeLessThanOrEqual(after + 1000);

        expect(schema.keys).toEqual([
            { key: 'thumbnails.enabled', default: true, type: 'boolean' },
            { key: 'maxCacheSize', default: 1000, type: 'number' },
            { key: 'region', default: 'us-east', type: 'string' },
            // unknown path → default undefined (dropped by JSON), type 'undefined'
            { key: 'missing.key', type: 'undefined' },
        ]);
    });

    test('empty key list publishes an empty keys array', async () => {
        const redis = makeRedis();
        const cfg = createConfig(redis, SERVICE, makeLocalConfig());
        await cfg.publish([]);
        const schema = JSON.parse(redis.set.mock.calls[0][1]);
        expect(schema.keys).toEqual([]);
        expect(schema.service).toBe(SERVICE);
    });
});

describe('service name isolation — hash key derivation', () => {
    test('different serviceName → different redis hash key', async () => {
        const redis = makeRedis();
        const cfg = createConfig(redis, 'nexus', { foo: 'bar' });
        await cfg.set('foo', 'baz');
        expect(redis.hSet).toHaveBeenCalledWith('config:nexus', 'foo', 'baz');
        await cfg.get('foo');
        expect(redis.hGet).toHaveBeenCalledWith('config:nexus', 'foo');
    });
});
