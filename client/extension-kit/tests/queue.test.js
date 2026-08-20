/**
 * queue —— MV3 休眠幸存的持久化队列。
 *
 * 这里锁的是**投递语义**，不是实现细节：
 *   · 条目只有在确认成功之后才出队（worker 死在中途 = 重发，不是丢）
 *   · idemKey 必填（重发安全的唯一依据）
 *   · 溢出/永久失败/放弃重试 一律进死信，**不静默丢**
 * 背景见 lib/queue.js 顶部。
 */
import { createQueue } from '../lib/queue.js';
import { memoryArea } from '../lib/storage.js';

/** 可控时钟：退避是分钟级的，真等就没法测了。 */
function fakeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

const item = (n) => ({ method: 'demo.thing.create', params: { n }, idemKey: `k${n}` });

describe('enqueue', () => {
    test('idemKey 缺失直接抛 —— 少了它一次休眠就可能变成重复业务数据', async () => {
        const q = createQueue({ backend: memoryArea(), send: async () => {} });
        await expect(q.enqueue({ method: 'a.b.c', params: {} })).rejects.toThrow(/idemKey/);
    });

    test('同 idemKey 不重复入队（人连点两下按钮是常态）', async () => {
        const q = createQueue({ backend: memoryArea(), send: async () => {} });
        expect(await q.enqueue(item(1))).toEqual({ queued: true });
        expect(await q.enqueue(item(1))).toEqual({ queued: false, duplicate: true });
        expect((await q.listPending()).length).toBe(1);
    });

    test('溢出的条目进死信，不是静默丢 —— 静默丢正是本模块存在的理由', async () => {
        const backend = memoryArea();
        const q = createQueue({ backend, send: async () => {}, maxItems: 3 });
        for (let i = 1; i <= 5; i++) await q.enqueue(item(i));

        expect((await q.listPending()).map((it) => it.idemKey)).toEqual(['k3', 'k4', 'k5']);
        const dead = await q.listDead();                 // 转存是 await 的，enqueue 返回时已落盘
        expect(dead.map((d) => d.idemKey)).toEqual(['k1', 'k2']);
        expect(dead[0].deadReason).toMatch(/overflow/);
    });
});

describe('drain —— 投递语义', () => {
    test('成功才出队', async () => {
        const sent = [];
        const q = createQueue({ backend: memoryArea(), send: async (it) => { sent.push(it.idemKey); } });
        await q.enqueue(item(1));
        await q.enqueue(item(2));

        const stat = await q.drain();
        expect(stat.sent).toBe(2);
        expect(sent).toEqual(['k1', 'k2']);
        expect(await q.listPending()).toEqual([]);
    });

    test('🔴 worker 死在「已发出、还没出队」之间 → 下轮重发，不丢', async () => {
        const backend = memoryArea();
        const delivered = [];

        // 忠实建模：worker 被回收 ≠ send 抛错（那只是普通失败，走退避）。
        // 真实情况是**请求已经发出去了，而这一轮 drain 永远不会结束**——
        // 于是"确认成功后才出队"那一步根本没机会执行。
        const q1 = createQueue({
            backend,
            send: async (it) => {
                delivered.push(it.idemKey);
                await new Promise(() => {});      // 永不 settle = 进程在这里没了
            },
        });
        await q1.enqueue(item(1));
        q1.drain();                                // 故意不 await
        await new Promise((r) => setTimeout(r, 5));

        expect(delivered).toEqual(['k1']);         // 已经发出去了
        expect((await q1.listPending()).map((i) => i.idemKey)).toEqual(['k1']);   // 但没出队

        // 新 worker 起来：新实例，同一份 storage
        const q2 = createQueue({ backend, send: async (it) => { delivered.push(it.idemKey); } });
        const stat = await q2.drain();
        expect(stat.sent).toBe(1);
        expect(await q2.listPending()).toEqual([]);
        // 送达两次 —— at-least-once，去重靠服务端认 idemKey。这正是契约，不是缺陷。
        expect(delivered).toEqual(['k1', 'k1']);
    });

    test('永久错误（权限不足）立刻进死信，不占着队列反复撞', async () => {
        const backend = memoryArea();
        const err = Object.assign(new Error('forbidden'), { code: -32005 });
        const q = createQueue({ backend, send: async () => { throw err; } });
        await q.enqueue(item(1));

        const stat = await q.drain();
        expect(stat.dead).toBe(1);
        expect(await q.listPending()).toEqual([]);
        const dead = await q.listDead();
        expect(dead[0].deadReason).toMatch(/permanent.*-32005/);
    });

    test('瞬态错误按退避重试，到 maxAttempts 才进死信', async () => {
        const clock = fakeClock();
        const backend = memoryArea();
        const err = Object.assign(new Error('rate limited'), { code: -32029 });
        let calls = 0;
        const q = createQueue({
            backend, now: clock.now, maxAttempts: 3,
            send: async () => { calls++; throw err; },
        });
        await q.enqueue(item(1));

        await q.drain();                          // attempt 1 → 退避
        expect((await q.listPending())[0].attempts).toBe(1);
        expect(await q.listDead()).toEqual([]);

        await q.drain();                          // 还没到期 → 不该发
        expect(calls).toBe(1);

        clock.advance(60_000);
        await q.drain();                          // attempt 2
        clock.advance(10 * 60_000);
        await q.drain();                          // attempt 3 → 放弃
        expect(calls).toBe(3);
        expect(await q.listPending()).toEqual([]);
        expect((await q.listDead())[0].deadReason).toMatch(/gave up after 3/);
    });

    test('nextWakeMs 报出下次该醒的时刻，并喂给 scheduleWake', async () => {
        const clock = fakeClock();
        const wakes = [];
        const err = Object.assign(new Error('boom'), { code: -32029 });
        const q = createQueue({
            backend: memoryArea(), now: clock.now,
            scheduleWake: (ms) => wakes.push(ms),
            send: async () => { throw err; },
        });
        await q.enqueue(item(1));
        const stat = await q.drain();
        expect(stat.nextWakeMs).toBe(30_000);     // 第一档退避
        expect(wakes).toEqual([30_000]);
    });

    test('drain 可重入：并发两次不会重复发送', async () => {
        let inFlight = 0;
        let maxParallel = 0;
        const q = createQueue({
            backend: memoryArea(),
            send: async () => {
                inFlight++; maxParallel = Math.max(maxParallel, inFlight);
                await new Promise((r) => setTimeout(r, 5));
                inFlight--;
            },
        });
        await q.enqueue(item(1));
        await q.enqueue(item(2));
        const [a, b] = await Promise.all([q.drain(), q.drain()]);
        expect(maxParallel).toBe(1);
        expect(a.sent + b.sent).toBe(2);          // 合计两条，不是四条
    });
});

describe('死信', () => {
    test('retryDead 把条目放回队列并清空死信（修完权限之后用）', async () => {
        const backend = memoryArea();
        const err = Object.assign(new Error('forbidden'), { code: -32005 });
        let fail = true;
        const q = createQueue({ backend, send: async () => { if (fail) throw err; } });
        await q.enqueue(item(1));
        await q.drain();
        expect((await q.listDead()).length).toBe(1);

        fail = false;
        expect(await q.retryDead()).toBe(1);
        expect(await q.listDead()).toEqual([]);
        const stat = await q.drain();
        expect(stat.sent).toBe(1);
    });

    test('stats 报 pending / due / dead', async () => {
        const clock = fakeClock();
        const q = createQueue({ backend: memoryArea(), now: clock.now, send: async () => {} });
        await q.enqueue(item(1));
        expect(await q.stats()).toEqual({ pending: 1, due: 1, dead: 0 });
    });
});
