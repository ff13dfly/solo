/**
 * 契约测试：hermetic 测试用的 fake redis（library/tests/utils/redis-scan-sim.js 的
 * scanBatches）跟真实 node-redis 客户端的 SCAN 系列迭代器行为是否一致。
 *
 * @why 排查 v5 批次坑（core/nexus/logic/events.js、core/orchestrator/logic/run.js、
 *      core/user/logic/user.js、core/nexus/logic/schedule.js 历次修复）时发现，仓库里
 *      所有手写的 fake redis 都假设 scanIterator 系列逐条 yield 单值——这个假设本身
 *      从没被验证过，只是被反复抄。hermetic 测试因此从没真正走到过消费方代码里
 *      `Array.isArray(batch)` 的数组分支，只有真实 Redis 数据量大到产生多个 SCAN 批次
 *      的 e2e 才会暴露。
 *
 *      这个文件不测生产逻辑，测的是"我们对 node-redis v5 行为的假设"本身：连真实
 *      Redis，验证 scanIterator/sScanIterator 确实逐批 yield 数组、且不丢数据。如果
 *      未来 node-redis 升级又变了语义，这里会先炸，而不是等下一次 e2e 撞大运才发现。
 *
 * 需要真实 Redis（redis-stack，同 entity-cursor-pagination.test.js 的约定）。
 */
const { createClient } = require('redis');
const { scanBatches } = require('./utils/redis-scan-sim');

const PREFIX = 'SCANCONTRACT77';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redis;

beforeAll(async () => {
    redis = createClient({ url: REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();
});

afterAll(async () => {
    await redis.del(`${PREFIX}:SET`);
    const keys = [];
    for await (const k of redis.scanIterator({ MATCH: `${PREFIX}:KV:*`, COUNT: 500 })) {
        if (Array.isArray(k)) keys.push(...k); else keys.push(k);
    }
    if (keys.length) await redis.del(keys);
    await redis.quit();
});

/** 把一个真实 xScanIterator 跑到底，记录每次 yield 的原始值（不做任何归一化）。 */
async function drainRaw(iterator) {
    const yields = [];
    for await (const v of iterator) yields.push(v);
    return yields;
}

describe('真实 Redis：sScanIterator/scanIterator 逐批 yield 数组（不是单值）', () => {
    test('sScanIterator：集合超过一页时，每次 yield 都是数组，且不丢成员', async () => {
        // 成员数必须超过 set-max-listpack-entries（默认 128）——小集合在 Redis 内部是
        // listpack/intset 紧凑编码，SSCAN 会无视 COUNT 提示、一次性整坨返回（真实
        // 验证过：37 个成员时 yields.length 恒为 1，COUNT:5 完全不起作用）。只有超过
        // 阈值转成 hashtable 编码后，SCAN 才是真正的增量游标扫描，COUNT 才会生效。
        const key = `${PREFIX}:SET`;
        const members = Array.from({ length: 200 }, (_, i) => `m${i}`);
        await redis.sAdd(key, members);

        const yields = await drainRaw(redis.sScanIterator(key, { COUNT: 5 }));

        expect(yields.length).toBeGreaterThan(1); // 确认真的触发了多批次，不是巧合单批
        for (const batch of yields) {
            expect(Array.isArray(batch)).toBe(true); // 核心假设：v5 每次 yield 都是数组
        }
        const flattened = yields.flat();
        expect(flattened.length).toBe(members.length);
        expect(new Set(flattened)).toEqual(new Set(members)); // 无丢失、无重复
    });

    test('sScanIterator：集合小于一页时，依然是数组（不会因为数据小就退化成单值）', async () => {
        const key = `${PREFIX}:SET`;
        await redis.del(key);
        await redis.sAdd(key, ['only-one']);

        const yields = await drainRaw(redis.sScanIterator(key, { COUNT: 500 }));

        expect(yields.length).toBeGreaterThanOrEqual(1);
        for (const batch of yields) expect(Array.isArray(batch)).toBe(true);
        expect(yields.flat()).toEqual(['only-one']);
    });

    test('scanIterator（顶层 key 扫描）：同样逐批 yield 数组', async () => {
        const keys = Array.from({ length: 23 }, (_, i) => `${PREFIX}:KV:${i}`);
        for (const k of keys) await redis.set(k, '1');

        const yields = await drainRaw(redis.scanIterator({ MATCH: `${PREFIX}:KV:*`, COUNT: 5 }));

        for (const batch of yields) expect(Array.isArray(batch)).toBe(true);
        const flattened = yields.flat();
        expect(new Set(flattened)).toEqual(new Set(keys));
    });
});

describe('fake redis 的 scanBatches 模拟器：跟上面验证的真实行为形状一致', () => {
    test('切块大小遵循 COUNT，逐批都是数组，展平后不丢不重', async () => {
        const items = Array.from({ length: 37 }, (_, i) => `m${i}`);
        const yields = await drainRaw(scanBatches(items, { COUNT: 5 }));

        expect(yields.length).toBeGreaterThan(1);
        for (const batch of yields) expect(Array.isArray(batch)).toBe(true);
        expect(yields.flat()).toEqual(items);
    });

    test('没传 COUNT 时有默认切块大小，而不是整坨一次性返回（否则測不出多批次分支）', async () => {
        const items = Array.from({ length: 25 }, (_, i) => `m${i}`);
        const yields = await drainRaw(scanBatches(items));

        expect(yields.length).toBeGreaterThan(1);
        expect(yields.flat()).toEqual(items);
    });
});
