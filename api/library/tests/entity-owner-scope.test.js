/**
 * entity-owner-scope — Entity Factory 自动执行行隔离（constraints.$owner）。
 *
 * 背景：passport.md §3.7 在三处强制外部角色声明 ownerField（不声明拒发会话），但执行
 * 此前不存在——$owner 被下发后没有任何一环消费它，外部主体能读到全表
 * (docs/feedback/done/passport-owner-isolation-declared-not-enforced.md)。现在服务经
 * requestContext(req) 把 $owner 注入 walContext，工厂在数据层自动执行：
 *   create 盖章（覆盖客户端伪造）· get/update/delete/destroy 校验归属（不符 → NOT_FOUND，
 *   与 collection 手工实现同语义）· list/multiGet 过滤 · update 不能改走 owner 字段。
 * 无 $owner（内部/admin 会话、无上下文的直调）→ 行为与从前完全一致。
 *
 * Needs a real Redis on 6379 (redis-stack in CI).
 */
const { createClient } = require('redis');
const createEntity = require('../entity');
const { walContext, requestContext } = require('../entity');

const SERVICE = 'OWNERSCOPE77';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redis;
let entity;

// 模拟一个 passport 外部会话的 req（Router 下发 constraints.$owner）
const reqFor = (anchor) => ({
    user: `uid-${anchor}`,
    meta: {},
    constraints: { $owner: { field: 'ownerId', value: anchor } },
});
const asOwner = (anchor, fn) => walContext.run(requestContext(reqFor(anchor)), fn);
// 内部/admin 会话：有上下文但无 $owner
const asAdmin = (fn) => walContext.run(requestContext({ user: 'admin-uid', meta: {}, constraints: {} }), fn);

beforeAll(async () => {
    redis = createClient({ url: REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();
    entity = createEntity(redis, { serviceName: SERVICE, entityName: 'ROW', idLength: 8 });
});

async function clearService() {
    const keys = [];
    for await (const k of redis.scanIterator({ MATCH: `${SERVICE}:*`, COUNT: 500 })) {
        if (Array.isArray(k)) keys.push(...k); else keys.push(k);
    }
    if (keys.length) await redis.del(keys);
}

beforeEach(clearService);

afterAll(async () => {
    await clearService();
    await redis.quit();
});

describe('requestContext', () => {
    test('builds uid/trace/depth/owner from a Router-authenticated req', () => {
        const ctx = requestContext({
            user: 'u1',
            meta: { trace: 't1', depth: 2 },
            constraints: { $owner: { field: 'ownerId', value: 'a1' } },
        });
        expect(ctx).toEqual({ uid: 'u1', trace: 't1', depth: 2, owner: { field: 'ownerId', value: 'a1' } });
    });

    test('no constraints / no req → owner null, defaults intact', () => {
        expect(requestContext({ user: 'u1' })).toEqual({ uid: 'u1', trace: null, depth: 0, owner: null });
        expect(requestContext(undefined)).toEqual({ uid: null, trace: null, depth: 0, owner: null });
    });
});

describe('create — owner stamping', () => {
    test('rows created by an owner-scoped session are stamped with the owner field', async () => {
        const row = await asOwner('alice', () => entity.create({ name: 'r1' }));
        expect(row.ownerId).toBe('alice');
    });

    test('stamp overrides a client-supplied owner field (no spoofing)', async () => {
        const row = await asOwner('alice', () => entity.create({ name: 'r1', ownerId: 'bob' }));
        expect(row.ownerId).toBe('alice');
    });

    test('unscoped create leaves data untouched', async () => {
        const row = await asAdmin(() => entity.create({ name: 'r1' }));
        expect(row.ownerId).toBeUndefined();
    });
});

describe('get / update / delete / destroy — ownership enforcement', () => {
    test('cross-owner get → NOT_FOUND (no existence leak)', async () => {
        const row = await asOwner('alice', () => entity.create({ name: 'r1' }));
        await expect(asOwner('bob', () => entity.get({ id: row.id }))).rejects.toMatchObject({ code: -32002 });
        // 自己的行照常可读
        const mine = await asOwner('alice', () => entity.get({ id: row.id }));
        expect(mine.id).toBe(row.id);
    });

    test('rows WITHOUT the owner field are invisible to scoped sessions (fail-closed)', async () => {
        const adminRow = await asAdmin(() => entity.create({ name: 'admin-made' }));
        await expect(asOwner('alice', () => entity.get({ id: adminRow.id }))).rejects.toMatchObject({ code: -32002 });
    });

    test('cross-owner update → NOT_FOUND; own update cannot reassign the owner field', async () => {
        const row = await asOwner('alice', () => entity.create({ name: 'r1' }));
        await expect(asOwner('bob', () => entity.update({ id: row.id, name: 'hacked' })))
            .rejects.toMatchObject({ code: -32002 });
        const updated = await asOwner('alice', () => entity.update({ id: row.id, name: 'renamed', ownerId: 'bob' }));
        expect(updated.name).toBe('renamed');
        expect(updated.ownerId).toBe('alice');   // 行不能被转让/脱离隔离
    });

    test('cross-owner hard delete / destroy → NOT_FOUND', async () => {
        const row = await asOwner('alice', () => entity.create({ name: 'r1' }));
        await expect(asOwner('bob', () => entity.delete({ id: row.id }))).rejects.toMatchObject({ code: -32002 });
        await expect(asOwner('bob', () => entity.destroy({ id: row.id }))).rejects.toMatchObject({ code: -32002 });
        // admin（无 $owner）不受限
        await asAdmin(() => entity.destroy({ id: row.id }));
    });
});

describe('list / multiGet — owner filtering', () => {
    test('scoped list returns only own rows; unscoped list returns all', async () => {
        await asOwner('alice', () => entity.create({ name: 'a1' }));
        await asOwner('alice', () => entity.create({ name: 'a2' }));
        await asOwner('bob', () => entity.create({ name: 'b1' }));
        await asAdmin(() => entity.create({ name: 'x1' }));   // 无 owner 字段

        const alice = await asOwner('alice', () => entity.list());
        expect(alice.total).toBe(2);
        expect(alice.items.map((i) => i.name).sort()).toEqual(['a1', 'a2']);

        const all = await asAdmin(() => entity.list());
        expect(all.total).toBe(4);
    });

    test('owner predicate composes with keyword/custom filter instead of being dropped', async () => {
        const kwEntity = createEntity(redis, {
            serviceName: SERVICE, entityName: 'KWROW', idLength: 8, searchFields: ['name'],
        });
        await asOwner('alice', () => kwEntity.create({ name: 'match-me' }));
        await asOwner('bob', () => kwEntity.create({ name: 'match-me' }));

        const res = await asOwner('alice', () => kwEntity.list({ keyword: 'match' }));
        expect(res.total).toBe(1);
        expect(res.items[0].ownerId).toBe('alice');
    });

    test('multiGet called directly is filtered too', async () => {
        const a = await asOwner('alice', () => entity.create({ name: 'a1' }));
        const b = await asOwner('bob', () => entity.create({ name: 'b1' }));
        const res = await asOwner('alice', () => entity.multiGet({ ids: [a.id, b.id] }));
        expect(res.items.map((i) => i.id)).toEqual([a.id]);
    });

    test('cursor path filters as well', async () => {
        await entity.migrateCursorIndex();
        await asOwner('alice', () => entity.create({ name: 'a1' }));
        await asOwner('bob', () => entity.create({ name: 'b1' }));
        const res = await asOwner('alice', () => entity.list({ cursor: null, limit: 10 }));
        expect(res.items.map((i) => i.name)).toEqual(['a1']);
    });
});

// The two properties a multi-tenant service depends on that are easy to break in a
// refactor and near-impossible to notice afterwards
// (docs/feedback/done/passport-owner-isolation-declared-not-enforced.md 追记 ①③).
describe('scope resolution — the two contracts callers depend on', () => {
    test('$owner.value (not the caller uid) decides the scope — they diverge on proxied calls', async () => {
        // A bot acting FOR a tenant: uid is the bot, $owner.value is the tenant. Filtering
        // by uid here would silently serve the wrong tenant's rows.
        const proxied = {
            user: 'system.some-bot',
            meta: {},
            constraints: { $owner: { field: 'ownerId', value: 'alice' } },
        };
        await asOwner('alice', () => entity.create({ name: 'a1' }));
        await asOwner('bob', () => entity.create({ name: 'b1' }));

        const seen = await walContext.run(requestContext(proxied), () => entity.list());
        expect(seen.items.map((i) => i.name)).toEqual(['a1']);      // tenant's rows, not the bot's
        const made = await walContext.run(requestContext(proxied), () => entity.create({ name: 'a2' }));
        expect(made.ownerId).toBe('alice');                          // stamped with the tenant too
    });

    test('no walContext at all (background loop / direct logic call) → NO filtering, not an empty scope', async () => {
        // Schedulers and cross-tenant risk math call logic directly, outside any request.
        // If absence of context ever resolved to "empty scope" instead of "unscoped", they
        // would see zero rows — an engine that silently stops, which reads as a data bug,
        // not a permissions one.
        await asOwner('alice', () => entity.create({ name: 'a1' }));
        await asOwner('bob', () => entity.create({ name: 'b1' }));

        const all = await entity.list();                             // no walContext.run wrapper
        expect(all.total).toBe(2);
        const direct = await entity.create({ name: 'sys' });
        expect(direct.ownerId).toBeUndefined();                      // nothing stamped either
    });
});
