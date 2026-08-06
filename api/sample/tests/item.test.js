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
// 集合索引 sAdd/sMembers/sRem/sCard、游标索引 incr/zAdd/zRem/zCard/zRange/zScore、
// 以及 multi().set().sAdd().exec() 原子写。
// 没有 duplicate() —— library/optimistic.js 会自动退回普通 read-modify-write,单测够用。
//
// ⚠️ 这份 mock 的命令集跟着 api/library/entity.js 的依赖走。抄到自己服务里之后,
//    每次升级 Solo 都要回来对一次差——v1.1.13 起 create()/delete() 无条件写游标
//    ZSET(incr/zAdd/zRem),缺了它们测试会在升级后立刻 `TypeError: redis.incr is
//    not a function`(生产不受影响,真 Redis 什么都有——正因如此只有测试能暴露它)。
//
// ⚠️ 补命令时语义要按真 Redis 写,不能"能跑就行":假实现的语义错了比没有假实现
//    更危险——hermetic 全绿,错误假设一路藏到真 Redis 才炸。典型陷阱:zRange 在
//    REV 下入参是 (max, min) 而不是 (min, max)。下面的 zRange 按真语义实现,并有
//    cursor 用例钉住它。
function makeFakeRedis() {
    const kv = new Map();    // key -> string
    const sets = new Map();  // key -> Set
    const zsets = new Map(); // key -> Map(member -> score) — entity.js cursor index
    const counters = new Map();
    const getSet = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));
    const getZset = (k) => (zsets.has(k) ? zsets.get(k) : zsets.set(k, new Map()).get(k));

    const apply = {
        set: (k, v, opts) => { if (opts && opts.NX && kv.has(k)) return null; kv.set(k, v); return 'OK'; },
        sAdd: (k, m) => { const s = getSet(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        del: (k) => { const had = kv.delete(k); sets.delete(k); return had ? 1 : 0; },
        sRem: (k, m) => { const s = sets.get(k); return s && s.delete(m) ? 1 : 0; },
        zAdd: (k, { score, value }) => { getZset(k).set(value, score); return 1; },
        zRem: (k, m) => { const z = zsets.get(k); return z && z.delete(m) ? 1 : 0; },
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
        async sCard(k) { return sets.has(k) ? sets.get(k).size : 0; },
        async incr(k) { const n = (counters.get(k) || 0) + 1; counters.set(k, n); return n; },
        async zAdd(k, entry) { return apply.zAdd(k, entry); },
        async zRem(k, m) { return apply.zRem(k, m); },
        async zCard(k) { return zsets.has(k) ? zsets.get(k).size : 0; },
        async zScore(k, m) { const z = zsets.get(k); return z && z.has(m) ? z.get(m) : null; },
        // 只实现 _listByCursor 用到的 BYSCORE 路径,但边界/排序语义与真 Redis 对齐:
        // REV 时 (start, stop) = (max, min);边界支持 +inf / -inf / "(n" 开区间。
        async zRange(k, start, stop, opts = {}) {
            if (opts.BY !== 'SCORE') throw new Error('fake zRange: only BY:"SCORE" is implemented');
            const parse = (b) => {
                if (b === '+inf') return { v: Infinity, excl: false };
                if (b === '-inf') return { v: -Infinity, excl: false };
                const s = String(b);
                return s.startsWith('(') ? { v: Number(s.slice(1)), excl: true } : { v: Number(s), excl: false };
            };
            const a = parse(start); const b = parse(stop);
            const max = opts.REV ? a : b; const min = opts.REV ? b : a;
            const entries = [...(zsets.get(k) || new Map())]
                .filter(([, score]) => (min.excl ? score > min.v : score >= min.v) &&
                                       (max.excl ? score < max.v : score <= max.v))
                .sort(([m1, s1], [m2, s2]) => (s1 - s2) || (m1 < m2 ? -1 : m1 > m2 ? 1 : 0));
            if (opts.REV) entries.reverse();
            const off = opts.LIMIT ? opts.LIMIT.offset : 0;
            const cnt = opts.LIMIT ? opts.LIMIT.count : entries.length;
            return entries.slice(off, off + cnt).map(([member]) => member);
        },
        multi() {
            const ops = [];
            const chain = {
                set(k, v, opts) { ops.push(['set', k, v, opts]); return chain; },
                sAdd(k, m) { ops.push(['sAdd', k, m]); return chain; },
                del(k) { ops.push(['del', k]); return chain; },
                sRem(k, m) { ops.push(['sRem', k, m]); return chain; },
                zAdd(k, entry) { ops.push(['zAdd', k, entry]); return chain; },
                zRem(k, m) { ops.push(['zRem', k, m]); return chain; },
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

    test('list({cursor}) → 有界翻页直到 nextCursor=null(钉住 mock 的 zRange/zScore 真语义)', async () => {
        const created = [];
        for (let i = 0; i < 5; i++) created.push(await item.create({ name: `it-${i}` }));

        const page1 = await item.list({ cursor: null, limit: 2 });
        expect(page1.items).toHaveLength(2);
        expect(page1.items.map((x) => x.name)).toEqual(['it-4', 'it-3']); // 插入序倒排
        expect(page1.nextCursor).toBeTruthy();

        const page2 = await item.list({ cursor: page1.nextCursor, limit: 2 });
        expect(page2.items.map((x) => x.name)).toEqual(['it-2', 'it-1']);

        const page3 = await item.list({ cursor: page2.nextCursor, limit: 2 });
        expect(page3.items.map((x) => x.name)).toEqual(['it-0']);
        expect(page3.nextCursor).toBeNull();                   // 不足一页 = 走完了

        // 三页拼起来恰好每条一次:mock 的 (max,min)+开区间边界写反任何一处都到不了这里
        const walked = [...page1.items, ...page2.items, ...page3.items].map((x) => x.id);
        expect(new Set(walked).size).toBe(5);
    });
});
