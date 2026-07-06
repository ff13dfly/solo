/**
 * item.test.js — 范本:微服务 logic 层的 hermetic 单元测试。
 *
 * 这是新服务该照抄的"测试方法":
 *   1. 不起栈、不连真 Redis、不走 Router —— 注入一个 Map 支撑的 fake redis。
 *   2. 直接构造 logic 工厂(`createItemLogic(redis, config)`),调它的方法,断言行为。
 *   3. 纯函数式、确定性、毫秒级 —— 因此能进 `jest.ci.config.js` 白名单,每次 push 都跑。
 *
 * 对比:跨服务/事件链/真实投递这类"接线"验证属于 e2e(repo 根 `e2e/`,full profile),
 * 不要在这里 mock 半个系统去模拟它。单测只管"我这个服务的逻辑分支对不对"。
 *
 * WAL(library/logger)写磁盘:用 LOG_DIR 指到临时目录,避免污染 api/logs。
 * 必须在 require 任何会 `require('library/entity')` 的模块**之前**设置(logger 在加载时读 WAL_DIR)。
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-sample-itest-${process.pid}`);

const createItemLogic = require('../logic/item');

// ── fake redis ────────────────────────────────────────────────────────────────
// 只实现 Entity Factory(string 存储路径)真正用到的命令:get/set(NX)/del/mGet、
// 集合索引 sAdd/sMembers/sRem、以及 multi().set().sAdd().exec() 原子写。
// 没有 duplicate() —— library/optimistic.js 会自动退回普通 read-modify-write,单测够用。
function makeFakeRedis() {
    const kv = new Map();    // key -> string
    const sets = new Map();  // key -> Set
    const getSet = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));

    const apply = {
        set: (k, v, opts) => { if (opts && opts.NX && kv.has(k)) return null; kv.set(k, v); return 'OK'; },
        sAdd: (k, m) => { const s = getSet(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        del: (k) => { const had = kv.delete(k); sets.delete(k); return had ? 1 : 0; },
        sRem: (k, m) => { const s = sets.get(k); return s && s.delete(m) ? 1 : 0; },
    };

    return {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v, opts) { return apply.set(k, v, opts); },
        async del(k) { return apply.del(k); },
        async mGet(keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
        async sAdd(k, m) { return apply.sAdd(k, m); },
        async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
        async sRem(k, m) { return apply.sRem(k, m); },
        async sIsMember(k, m) { return sets.has(k) && sets.get(k).has(m) ? 1 : 0; },
        multi() {
            const ops = [];
            const chain = {
                set(k, v, opts) { ops.push(['set', k, v, opts]); return chain; },
                sAdd(k, m) { ops.push(['sAdd', k, m]); return chain; },
                del(k) { ops.push(['del', k]); return chain; },
                sRem(k, m) { ops.push(['sRem', k, m]); return chain; },
                async exec() { return ops.map(([op, ...args]) => apply[op](...args)); },
            };
            return chain;
        },
    };
}

const CONFIG = { serviceName: 'sample', idLengths: { item: 16 } };

describe('sample item logic (hermetic — injected fake redis)', () => {
    let redis, item;
    beforeEach(() => { redis = makeFakeRedis(); item = createItemLogic(redis, CONFIG); });

    test('create → 落 ACTIVE,可按 id 取回', async () => {
        const created = await item.create({ name: 'widget', description: 'a sample item' });
        expect(created.id).toBeTruthy();
        expect(created.status).toBe('ACTIVE');
        expect(created.name).toBe('widget');
        expect(created.createdAt).toEqual(expect.any(Number));

        const got = await item.get({ id: created.id });
        expect(got).toMatchObject({ id: created.id, name: 'widget', description: 'a sample item' });
    });

    test('get 不存在的 id → NOT_FOUND', async () => {
        await expect(item.get({ id: 'does-not-exist' })).rejects.toMatchObject({ code: expect.any(Number) });
    });

    test('list → 包含已创建的 active 项', async () => {
        const a = await item.create({ name: 'A' });
        const b = await item.create({ name: 'B' });
        const res = await item.list({});
        const items = Array.isArray(res) ? res : res.items;
        const ids = items.map((x) => x.id);
        expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    });

    test('update → 顶层字段合并', async () => {
        const c = await item.create({ name: 'old', description: 'keep me' });
        const u = await item.update({ id: c.id, name: 'new' });
        expect(u.name).toBe('new');
        expect(u.description).toBe('keep me');                 // 未传的字段保留
        expect((await item.get({ id: c.id })).name).toBe('new');
    });

    test('softDelete: delete → status 变 DELETED(记录仍在)', async () => {
        const c = await item.create({ name: 'gone' });
        await item.delete({ id: c.id });
        const after = await item.get({ id: c.id });
        expect(after.status).toBe('DELETED');                  // 软删:记录还在,状态翻成 DELETED
    });
});
