/**
 * library/indexer.js — RediSearch index manager unit tests. Hermetic: the only
 * collaborator is Redis, faked with a Map-backed double whose `sendCommand`
 * dispatches on argv[0] (FT.CREATE / FT.DROPINDEX / FT.CONFIG), RECORDS every
 * argv so we can assert exact command shape, and can be told to throw on demand
 * (e.g. 'Index already exists' from FT.CREATE, 'Unknown Index name' from
 * FT.DROPINDEX). No network, no real Redis, no time.
 *
 * Only `createIndexer` is exported; the internal helpers (loadSchemas /
 * saveSchemas / createIfMissing / buildIndex) are exercised through the public
 * surface — schemas(), ensureAll(), rebuild(), updateSchemas().
 */
const { createIndexer, buildCreateCommand, maxPrefixExpansions } = require('../indexer');

const KEY = (svc) => `SYSTEM:INDEX_SCHEMA:${svc}`;

/**
 * Map-backed fake Redis.
 *   - get/set back the string-KV the schema persistence layer uses.
 *   - sendCommand dispatches on argv[0], records the argv, and honours injected
 *     failures (failCreateWith / failDropWith / failGetWith).
 */
function makeFakeRedis() {
    const kv = new Map();
    const calls = [];           // every argv passed to sendCommand
    let createErr = null;       // thrown by FT.CREATE when set
    let dropErr = null;         // thrown by FT.DROPINDEX when set
    let getErr = null;          // thrown by get() when set

    return {
        _kv: kv,
        calls,
        failCreateWith(e) { createErr = e; },
        failDropWith(e) { dropErr = e; },
        failGetWith(e) { getErr = e; },
        // convenience filtered views
        creates() { return calls.filter((c) => c[0] === 'FT.CREATE'); },
        drops() { return calls.filter((c) => c[0] === 'FT.DROPINDEX'); },
        configs() { return calls.filter((c) => c[0] === 'FT.CONFIG'); },

        async get(key) {
            if (getErr) throw getErr;
            return kv.has(key) ? kv.get(key) : null;
        },
        async set(key, val) { kv.set(key, val); return 'OK'; },

        async sendCommand(argv) {
            calls.push(argv);
            switch (argv[0]) {
                case 'FT.CREATE':
                    if (createErr) throw createErr;
                    return 'OK';
                case 'FT.DROPINDEX':
                    if (dropErr) throw dropErr;
                    return 'OK';
                case 'FT.CONFIG':
                    return 'OK';
                default:
                    return 'OK';
            }
        },
    };
}

// A well-formed index definition + its expected FT.CREATE argv.
const PRODUCT = {
    name: 'idx:svc_product',
    prefix: 'SVC:PRODUCT:',
    schema: ['$.title', 'AS', 'title', 'TEXT', '$.sku', 'AS', 'sku', 'TAG'],
};
const ORDER = {
    name: 'idx:svc_order',
    prefix: 'SVC:ORDER:',
    schema: ['$.total', 'AS', 'total', 'NUMERIC'],
};
const expectedCreateArgv = (def) => [
    'FT.CREATE', def.name,
    'ON', 'JSON',
    'PREFIX', '1', def.prefix,
    'SCHEMA',
    ...def.schema,
];
const CONFIG_ARGV = ['FT.CONFIG', 'SET', 'MAXSEARCHRESULTS', '-1'];
// 第二堵墙：通配/中缀查询能展开多少个词。默认 200 且超限静默截断，所以框架一并解掉
// （只解一半比两个都不解更坏 —— 调用方会以为这类上限框架管了）。
const PREFIX_ARGV = ['FT.CONFIG', 'SET', 'MAXPREFIXEXPANSIONS', '200000'];

// ──────────────────────────────────────────────────────────────────────────
describe('schemas() — loadSchemas: Redis override > local fallback', () => {
    test('redis override merges over local (remote wins per-entity, local fills gaps)', async () => {
        const redis = makeFakeRedis();
        const local = { product: PRODUCT, order: ORDER };
        const remoteOrder = { name: 'idx:remote_order', prefix: 'R:O:', schema: ['$.x', 'AS', 'x', 'TAG'] };
        const remoteUser = { name: 'idx:remote_user', prefix: 'R:U:', schema: ['$.y', 'AS', 'y', 'TAG'] };
        redis._kv.set(KEY('svc'), JSON.stringify({ order: remoteOrder, user: remoteUser }));

        const idx = createIndexer(redis, 'svc', local);
        const s = await idx.schemas();

        expect(s).toEqual({
            product: PRODUCT,        // local, untouched (gap filled)
            order: remoteOrder,      // remote overrode local
            user: remoteUser,        // remote-only addition
        });
    });

    test('redis miss (null) → local only', async () => {
        const redis = makeFakeRedis();
        const idx = createIndexer(redis, 'svc', { product: PRODUCT });
        expect(await idx.schemas()).toEqual({ product: PRODUCT });
    });

    test('redis miss with no localDefs (default {}) → empty object', async () => {
        const redis = makeFakeRedis();
        const idx = createIndexer(redis, 'svc'); // localDefs defaults to {}
        expect(await idx.schemas()).toEqual({});
    });

    test('redis.get throws → caught → local fallback', async () => {
        const redis = makeFakeRedis();
        redis.failGetWith(new Error('READONLY connection lost'));
        const idx = createIndexer(redis, 'svc', { product: PRODUCT });
        expect(await idx.schemas()).toEqual({ product: PRODUCT });
    });

    test('redis returns malformed JSON → JSON.parse throws → caught → local fallback', async () => {
        const redis = makeFakeRedis();
        redis._kv.set(KEY('svc'), '{not valid json');
        const idx = createIndexer(redis, 'svc', { product: PRODUCT });
        expect(await idx.schemas()).toEqual({ product: PRODUCT });
    });

    test('returned object is a fresh copy, not the localDefs reference', async () => {
        const redis = makeFakeRedis();
        const local = { product: PRODUCT };
        const idx = createIndexer(redis, 'svc', local);
        const s = await idx.schemas();
        expect(s).not.toBe(local);
        expect(s).toEqual(local);
    });
});

// ──────────────────────────────────────────────────────────────────────────
describe('ensureAll() — FT.CONFIG then createIfMissing per def', () => {
    test('sets both global limits first, then FT.CREATE each def with exact argv', async () => {
        const redis = makeFakeRedis();
        const idx = createIndexer(redis, 'svc', { product: PRODUCT, order: ORDER });
        await idx.ensureAll();

        // FT.CONFIG is the very first command issued — both limits, before any FT.CREATE.
        expect(redis.calls[0]).toEqual(CONFIG_ARGV);
        expect(redis.calls[1]).toEqual(PREFIX_ARGV);
        expect(redis.configs()).toEqual([CONFIG_ARGV, PREFIX_ARGV]);

        const creates = redis.creates();
        expect(creates).toHaveLength(2);
        expect(creates[0]).toEqual(expectedCreateArgv(PRODUCT));
        expect(creates[1]).toEqual(expectedCreateArgv(ORDER));
    });

    test('empty defs → only FT.CONFIG, no FT.CREATE', async () => {
        const redis = makeFakeRedis();
        const idx = createIndexer(redis, 'svc'); // no defs
        await idx.ensureAll();
        expect(redis.configs()).toEqual([CONFIG_ARGV, PREFIX_ARGV]);
        expect(redis.creates()).toHaveLength(0);
    });

    test("FT.CREATE 'Index already exists' is swallowed (idempotent startup)", async () => {
        const redis = makeFakeRedis();
        redis.failCreateWith(new Error('Index already exists'));
        const idx = createIndexer(redis, 'svc', { product: PRODUCT });
        await expect(idx.ensureAll()).resolves.toBeUndefined();
        expect(redis.creates()).toHaveLength(1); // it WAS attempted
    });

    test('FT.CREATE other error message → rethrown', async () => {
        const redis = makeFakeRedis();
        redis.failCreateWith(new Error('Bad arguments for SCHEMA'));
        const idx = createIndexer(redis, 'svc', { product: PRODUCT });
        await expect(idx.ensureAll()).rejects.toThrow('Bad arguments for SCHEMA');
    });

    test('FT.CREATE error with falsy message → rethrown (covers e.message && short-circuit)', async () => {
        const redis = makeFakeRedis();
        const bare = { code: 'WRONGTYPE' }; // no .message
        redis.failCreateWith(bare);
        const idx = createIndexer(redis, 'svc', { product: PRODUCT });
        await expect(idx.ensureAll()).rejects.toBe(bare);
    });

    test('honours Redis-overridden schemas', async () => {
        const redis = makeFakeRedis();
        const remote = { name: 'idx:remote', prefix: 'R:', schema: ['$.a', 'AS', 'a', 'TAG'] };
        redis._kv.set(KEY('svc'), JSON.stringify({ product: remote }));
        const idx = createIndexer(redis, 'svc', { product: PRODUCT });
        await idx.ensureAll();
        expect(redis.creates()[0]).toEqual(expectedCreateArgv(remote));
    });
});

// ──────────────────────────────────────────────────────────────────────────
describe('ensureAll() — createIfMissing rejects invalid definitions', () => {
    const cases = {
        'def is null': null,
        'missing name': { prefix: 'P:', schema: ['$.x', 'AS', 'x', 'TAG'] },
        'missing prefix': { name: 'idx:x', schema: ['$.x', 'AS', 'x', 'TAG'] },
        'missing schema': { name: 'idx:x', prefix: 'P:' },
    };
    for (const [label, badDef] of Object.entries(cases)) {
        test(`${label} → throws "Invalid index definition"`, async () => {
            const redis = makeFakeRedis();
            const idx = createIndexer(redis, 'svc', { bad: badDef });
            await expect(idx.ensureAll()).rejects.toThrow('Invalid index definition');
            // guard fires BEFORE any FT.CREATE is issued
            expect(redis.creates()).toHaveLength(0);
        });
    }
});

// ──────────────────────────────────────────────────────────────────────────
describe('rebuild(entityName) — buildIndex: drop then recreate one', () => {
    test('valid entity → FT.CONFIG, FT.DROPINDEX, FT.CREATE; returns {rebuilt:[name]}', async () => {
        const redis = makeFakeRedis();
        const idx = createIndexer(redis, 'svc', { product: PRODUCT });
        const res = await idx.rebuild('product');

        expect(res).toEqual({ rebuilt: [PRODUCT.name] });
        expect(redis.calls[0]).toEqual(CONFIG_ARGV);
        expect(redis.drops()).toEqual([['FT.DROPINDEX', PRODUCT.name]]);
        expect(redis.creates()).toEqual([expectedCreateArgv(PRODUCT)]);
    });

    test('FT.DROPINDEX "Unknown Index name" is swallowed; FT.CREATE still runs', async () => {
        const redis = makeFakeRedis();
        redis.failDropWith(new Error('Unknown Index name'));
        const idx = createIndexer(redis, 'svc', { product: PRODUCT });
        const res = await idx.rebuild('product');

        expect(res).toEqual({ rebuilt: [PRODUCT.name] });
        expect(redis.drops()).toHaveLength(1);          // drop WAS attempted
        expect(redis.creates()).toEqual([expectedCreateArgv(PRODUCT)]); // and create still ran
    });

    test('unknown entity → throws { code: -32602 } before any build', async () => {
        const redis = makeFakeRedis();
        const idx = createIndexer(redis, 'svc', { product: PRODUCT });
        await expect(idx.rebuild('ghost')).rejects.toMatchObject({
            code: -32602,
            message: 'Unknown index entity: ghost',
        });
        expect(redis.drops()).toHaveLength(0);
        expect(redis.creates()).toHaveLength(0);
    });
});

// ──────────────────────────────────────────────────────────────────────────
describe('rebuild() — all entities', () => {
    test('rebuilds every def in order, returns {rebuilt:[names]}', async () => {
        const redis = makeFakeRedis();
        const idx = createIndexer(redis, 'svc', { product: PRODUCT, order: ORDER });
        const res = await idx.rebuild();

        expect(res).toEqual({ rebuilt: [PRODUCT.name, ORDER.name] });
        expect(redis.calls[0]).toEqual(CONFIG_ARGV);
        expect(redis.drops()).toEqual([
            ['FT.DROPINDEX', PRODUCT.name],
            ['FT.DROPINDEX', ORDER.name],
        ]);
        expect(redis.creates()).toEqual([
            expectedCreateArgv(PRODUCT),
            expectedCreateArgv(ORDER),
        ]);
    });

    test('no defs → {rebuilt:[]}, only FT.CONFIG issued', async () => {
        const redis = makeFakeRedis();
        const idx = createIndexer(redis, 'svc');
        expect(await idx.rebuild()).toEqual({ rebuilt: [] });
        expect(redis.creates()).toHaveLength(0);
        expect(redis.drops()).toHaveLength(0);
    });
});

// ──────────────────────────────────────────────────────────────────────────
describe('rebuild() — buildIndex rejects invalid definitions', () => {
    // buildIndex's own guard. The all-entities loop reaches it even for a null
    // value (rebuild(name) would short-circuit on the rebuild-level !def check).
    test('null def value → throws "Invalid index definition" (via all-loop)', async () => {
        const redis = makeFakeRedis();
        const idx = createIndexer(redis, 'svc', { bad: null });
        await expect(idx.rebuild()).rejects.toThrow('Invalid index definition');
    });

    const presentButBroken = {
        'missing name': { prefix: 'P:', schema: ['$.x', 'AS', 'x', 'TAG'] },
        'missing prefix': { name: 'idx:x', schema: ['$.x', 'AS', 'x', 'TAG'] },
        'missing schema': { name: 'idx:x', prefix: 'P:' },
    };
    for (const [label, badDef] of Object.entries(presentButBroken)) {
        test(`${label} → throws "Invalid index definition" (via rebuild(name))`, async () => {
            const redis = makeFakeRedis();
            const idx = createIndexer(redis, 'svc', { bad: badDef });
            // def is truthy so rebuild's -32602 check passes; buildIndex's guard fires.
            await expect(idx.rebuild('bad')).rejects.toThrow('Invalid index definition');
        });
    }
});

// ──────────────────────────────────────────────────────────────────────────
describe('updateSchemas() — saveSchemas: merge over current and persist', () => {
    test('merges newSchemas over current, persists JSON, returns merged', async () => {
        const redis = makeFakeRedis();
        const idx = createIndexer(redis, 'svc', { product: PRODUCT, order: ORDER });

        const newOrder = { name: 'idx:order2', prefix: 'O2:', schema: ['$.z', 'AS', 'z', 'TAG'] };
        const newUser = { name: 'idx:user', prefix: 'U:', schema: ['$.u', 'AS', 'u', 'TAG'] };
        const merged = await idx.updateSchemas({ order: newOrder, user: newUser });

        const expected = { product: PRODUCT, order: newOrder, user: newUser };
        expect(merged).toEqual(expected);

        // persisted to the canonical key, JSON-encoded.
        const persisted = redis._kv.get(KEY('svc'));
        expect(JSON.parse(persisted)).toEqual(expected);

        // and readable back through schemas() (Redis override now in effect).
        expect(await idx.schemas()).toEqual(expected);
    });

    test('current is read from the Redis override, then merged again', async () => {
        const redis = makeFakeRedis();
        const remote = { name: 'idx:remote', prefix: 'R:', schema: ['$.a', 'AS', 'a', 'TAG'] };
        redis._kv.set(KEY('svc'), JSON.stringify({ product: remote }));
        const idx = createIndexer(redis, 'svc', { product: PRODUCT, order: ORDER });

        const merged = await idx.updateSchemas({ order: ORDER });
        // current = { product: remote (override wins), order: ORDER (local gap) }
        // then { ...current, order: ORDER } → order unchanged, product stays remote.
        expect(merged).toEqual({ product: remote, order: ORDER });
        expect(JSON.parse(redis._kv.get(KEY('svc')))).toEqual({ product: remote, order: ORDER });
    });
});

// ──────────────────────────────────────────────────────────────────────────
// CJK 索引：`language` 直通 FT.CREATE，且 MAXPREFIXEXPANSIONS 可配。
//
// 这一组测的是两件"坏起来完全没有声音"的事：LANGUAGE 拼在 SCHEMA 之后就永远
// 不是合法命令（RediSearch 把 SCHEMA 之后的一切当字段定义），而 MAXPREFIXEXPANSIONS
// 超限只会让查询少返回几行、不报错。实测依据见 library/indexer.js 顶部注释。
describe('language + MAXPREFIXEXPANSIONS', () => {
    const CN = {
        name: 'idx:svc_product_cn',
        prefix: 'SVC:PRODUCT:',
        schema: ['$.name', 'AS', 'name', 'TEXT'],
        language: 'chinese',
    };

    test('buildCreateCommand: LANGUAGE 落在 SCHEMA 之前', () => {
        const argv = buildCreateCommand(CN);
        expect(argv.indexOf('LANGUAGE')).toBeLessThan(argv.indexOf('SCHEMA'));
        expect(argv).toEqual([
            'FT.CREATE', CN.name,
            'ON', 'JSON',
            'PREFIX', '1', CN.prefix,
            'LANGUAGE', 'chinese',
            'SCHEMA',
            ...CN.schema,
        ]);
    });

    test('不带 language 的 def，argv 与改动前逐字节一致（向后兼容）', () => {
        expect(buildCreateCommand(PRODUCT)).toEqual(expectedCreateArgv(PRODUCT));
        expect(buildCreateCommand(PRODUCT)).not.toContain('LANGUAGE');
    });

    test('ensureAll 把 language 透传给 FT.CREATE', async () => {
        const redis = makeFakeRedis();
        const idx = createIndexer(redis, 'svc', { product: CN });
        await idx.ensureAll();
        expect(redis.creates()[0]).toEqual(buildCreateCommand(CN));
    });

    test('rebuild 同样透传 language（drop 后重建才是 language 生效的唯一途径）', async () => {
        const redis = makeFakeRedis();
        const idx = createIndexer(redis, 'svc', { product: CN });
        await idx.rebuild('product');
        expect(redis.creates()[0]).toEqual(buildCreateCommand(CN));
    });

    test('Redis 覆盖的 schema 也能带 language（loadSchemas 整对象覆盖）', async () => {
        const redis = makeFakeRedis();
        redis._kv.set(KEY('svc'), JSON.stringify({ product: CN }));
        const idx = createIndexer(redis, 'svc', { product: PRODUCT });
        await idx.ensureAll();
        expect(redis.creates()[0]).toEqual(buildCreateCommand(CN));
    });

    describe('maxPrefixExpansions()', () => {
        const ENV = 'REDISEARCH_MAXPREFIXEXPANSIONS';
        afterEach(() => { delete process.env[ENV]; });

        test('默认 200000', () => {
            delete process.env[ENV];
            expect(maxPrefixExpansions()).toBe(200000);
        });

        test('环境变量可覆盖', () => {
            process.env[ENV] = '5000';
            expect(maxPrefixExpansions()).toBe(5000);
        });

        // RediSearch 的下界是 1：0 与 -1 都被拒 (Value is outside acceptable bounds)，
        // 所以 MAXSEARCHRESULTS 那套 -1 = unlimited 的约定在这里不成立。
        test.each([['0', 0], ['-1', -1]])('非法值 %s 退回默认而不是发出去', (raw) => {
            process.env[ENV] = raw;
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            expect(maxPrefixExpansions()).toBe(200000);
            expect(warn).toHaveBeenCalled();     // 退回是响亮的，不是静默的
            warn.mockRestore();
        });

        test('非整数退回默认（intFromEnv 自身的行为，这里钉住）', () => {
            process.env[ENV] = 'lots';
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            expect(maxPrefixExpansions()).toBe(200000);
            warn.mockRestore();
        });
    });
});
