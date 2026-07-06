/**
 * ratelimit.test.js — 限流逻辑 hermetic 单测。
 *
 * 顺带锁住 system.report 这条 public 端点拿到的是**收紧**的限流规则——它在
 * index.js 的本地分发表里(绕过 PHASE-3 限流闸),已在分发前补了一道限流;这里
 * 钉死规则与节流行为,防它再退化成无限流的刷接口面(docs/planning/security.md)。
 */
const ratelimit = require('../handlers/ratelimit');
const config = require('../config');

function fakeRedis() {
    const kv = new Map();
    return {
        isOpen: true,
        async incr(k) { const n = (kv.get(k) || 0) + 1; kv.set(k, n); return n; },
        async expire() { return 1; },
    };
}

describe('router rate limit', () => {
    test('resolveLimit: system.report 命中收紧规则(30/分 by ip)', () => {
        const rule = ratelimit.resolveLimit('system.report', {}, config.rateLimits);
        expect(rule).toMatchObject({ max: 30, by: 'ip' });
    });

    test('resolveLimit: 未匹配任何前缀 → 全局默认(500/分)', () => {
        const rule = ratelimit.resolveLimit('user.profile.get', {}, config.rateLimits);
        expect(rule).toMatchObject({ max: 500, by: 'ip' });
    });

    test('checkLimit: 到 max 仍允许, 超过即拒', async () => {
        const redis = fakeRedis();
        const rule = { window: 60, max: 30, by: 'ip' };
        let last;
        for (let i = 1; i <= 30; i++) {
            last = await ratelimit.checkLimit(redis, 'system.report', '1.2.3.4', rule);
        }
        expect(last.allowed).toBe(true);                 // 第 30 次仍允许
        const over = await ratelimit.checkLimit(redis, 'system.report', '1.2.3.4', rule);
        expect(over.allowed).toBe(false);                // 第 31 次被拒
    });

    test('checkLimit: 不同 IP 各自独立计数', async () => {
        const redis = fakeRedis();
        const rule = { window: 60, max: 1, by: 'ip' };
        expect((await ratelimit.checkLimit(redis, 'system.report', 'A', rule)).allowed).toBe(true);
        expect((await ratelimit.checkLimit(redis, 'system.report', 'A', rule)).allowed).toBe(false); // A 第二次拒
        expect((await ratelimit.checkLimit(redis, 'system.report', 'B', rule)).allowed).toBe(true);  // B 独立计数
    });

    // ── Redis 故障不再 fail-open:退化为进程内计数器,继续限流 ────────────────
    test('checkLimit: redis 不可用时退化为内存限流(首个放行,超限即拒)', async () => {
        const rule = { window: 60, max: 1 };
        const first = await ratelimit.checkLimit({ isOpen: false }, 'mem.test.a', 'x', rule);
        expect(first.allowed).toBe(true);
        expect(first.fallback).toBe('memory');
        const second = await ratelimit.checkLimit({ isOpen: false }, 'mem.test.a', 'x', rule);
        expect(second.allowed).toBe(false);   // 一次 Redis blip 不再等于全局关限流
    });

    test('checkLimit: redis 抛错时同样落到内存限流而非放行', async () => {
        const broken = { isOpen: true, async incr() { throw new Error('redis down'); }, async expire() { return 1; } };
        const rule = { window: 60, max: 1 };
        const first = await ratelimit.checkLimit(broken, 'mem.test.b', 'y', rule);
        expect(first.allowed).toBe(true);
        const second = await ratelimit.checkLimit(broken, 'mem.test.b', 'y', rule);
        expect(second.allowed).toBe(false);
        expect(second.fallback).toBe('memory');
    });

    test('checkLimit: 内存兜底下不同 identity 各自独立计数', async () => {
        const rule = { window: 60, max: 1 };
        expect((await ratelimit.checkLimit({ isOpen: false }, 'mem.test.c', 'A', rule)).allowed).toBe(true);
        expect((await ratelimit.checkLimit({ isOpen: false }, 'mem.test.c', 'B', rule)).allowed).toBe(true);
    });

    test('invalidate: bust 缓存 → 下次 getRules 立即重读 Redis(不等 60s TTL)', async () => {
        const kv = new Map();
        const redis = {
            isOpen: true,
            async get(k) { return kv.has(k) ? kv.get(k) : null; },
        };
        const A = { 'foo.bar': { window: 60, max: 1, by: 'ip' } };
        const B = { 'foo.bar': { window: 60, max: 999, by: 'ip' } };

        ratelimit.invalidate();                                  // 清掉可能被其它用例污染的模块级缓存
        kv.set(config.redis.rateLimitsKey, JSON.stringify(A));
        expect(await ratelimit.getRules(redis)).toEqual(A);      // 读到 A 并缓存
        kv.set(config.redis.rateLimitsKey, JSON.stringify(B));   // 底层改成 B
        expect(await ratelimit.getRules(redis)).toEqual(A);      // TTL 内仍返回缓存的 A
        ratelimit.invalidate();
        expect(await ratelimit.getRules(redis)).toEqual(B);      // bust 后立即重读 B
        ratelimit.invalidate();                                  // 收尾:别把缓存留给后续
    });
});
