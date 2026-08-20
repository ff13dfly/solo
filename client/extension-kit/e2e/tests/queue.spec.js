/**
 * 队列 —— 在真 MV3 环境里验它的核心主张：**熬过 service worker 被回收**。
 *
 * 单元测试用的是我自己写的模型（storage 是个 Map、worker 死亡是模拟的）。模型跟实现
 * 出自同一个脑子，所以它证明不了"我对 MV3 的理解是对的"。这套才能。
 */
import { test, expect, callBackground, killServiceWorker } from '../fixtures.js';

const enqueue = (sw, idemKey, n = 1) => sw.evaluate(
    ([k, i]) => globalThis.__solo.queue.enqueue({ method: 'demo.thing.create', params: { n: i }, idemKey: k }),
    [idemKey, n],
);

test('入队 → drain → 真的打到了 Router，参数原样', async ({ serviceWorker, router }) => {
    await enqueue(serviceWorker, 'k1', 7);
    const stat = await serviceWorker.evaluate(() => globalThis.__solo.queue.drain());

    expect(stat.sent).toBe(1);
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0].method).toBe('demo.thing.create');
    expect(router.calls[0].params).toEqual({ n: 7 });
    // 成功之后才出队
    expect(await serviceWorker.evaluate(() => globalThis.__solo.queue.listPending())).toEqual([]);
});

test('条目真的落进 chrome.storage.local（不是只在内存里）', async ({ serviceWorker }) => {
    await enqueue(serviceWorker, 'k1');
    const raw = await serviceWorker.evaluate(() => chrome.storage.local.get('solo:queue'));
    expect(raw['solo:queue'].map((i) => i.idemKey)).toEqual(['k1']);
});

test('同 idemKey 不重复入队', async ({ serviceWorker }) => {
    expect(await enqueue(serviceWorker, 'k1')).toEqual({ queued: true });
    expect(await enqueue(serviceWorker, 'k1')).toEqual({ queued: false, duplicate: true });
});

test('idemKey 缺失当场抛（重发安全的唯一依据）', async ({ serviceWorker }) => {
    const msg = await serviceWorker.evaluate(async () => {
        try {
            await globalThis.__solo.queue.enqueue({ method: 'a.b.c', params: {} });
            return 'NO THROW';
        } catch (e) { return e.message; }
    });
    expect(msg).toMatch(/idemKey/);
});

test('永久错误（-32005 权限不足）直接进死信，不占着队列反复撞', async ({ serviceWorker, router }) => {
    router.reply(() => ({ error: { code: -32005, message: 'forbidden' } }));
    await enqueue(serviceWorker, 'k1');
    const stat = await serviceWorker.evaluate(() => globalThis.__solo.queue.drain());

    expect(stat.dead).toBe(1);
    expect(router.calls).toHaveLength(1);          // 没有重试
    const dead = await serviceWorker.evaluate(() => globalThis.__solo.queue.listDead());
    expect(dead[0].deadReason).toMatch(/permanent.*-32005/);
});

test('🔴 service worker 被回收后，未送出的条目仍在，唤醒后照常送达', async ({
    context, serviceWorker, router, extensionId,
}) => {
    await enqueue(serviceWorker, 'k1', 1);
    await enqueue(serviceWorker, 'k2', 2);
    expect(router.calls).toHaveLength(0);          // 还没 drain，一条都没发

    // 杀掉 SW。注意：此后**绝不能**再碰 serviceWorker handle（evaluate 会永久挂住）。
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await killServiceWorker(context, page);

    // 换扩展页面这条通道读持久状态
    const survived = await page.evaluate(() => chrome.storage.local.get('solo:queue'));
    expect(survived['solo:queue'].map((i) => i.idemKey)).toEqual(['k1', 'k2']);

    // sendMessage 会把 SW 叫醒 —— 这正是真实场景（alarm / popup 唤醒后补投）
    const res = await callBackground(page, 'QUEUE_DRAIN');
    expect(res.data.sent).toBe(2);
    expect(router.methodsSeen()).toEqual(['demo.thing.create', 'demo.thing.create']);
    await page.close();
});

test('🔴 限流不把端点打爆：一次 drain 只发一次请求', async ({ serviceWorker, router }) => {
    // sample 的 send 用的是 rpc.attempt 而不是 rpc.call。改回 call 的话，这里会看到 6 次
    //（实测一个条目跑满队列的 6 次尝试要发 36 次 fetch、耗时 135 秒，全程占着 service
    // worker，而且多数是打在一个已经在限流的端点上——只会让限流档位更深）。
    router.reply(() => ({ error: { code: -32029, message: 'rate limited' } }));
    await enqueue(serviceWorker, 'k1');

    const started = Date.now();
    await serviceWorker.evaluate(() => globalThis.__solo.queue.drain());

    expect(router.calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);      // 用 call 的话这里要 22.5s
});

test('尊重服务端下发的 retry_after，而不是本地猜的退避档', async ({ serviceWorker, router }) => {
    router.reply(() => ({ error: { code: -32029, message: 'rl', data: { retry_after: 9 } } }));
    await enqueue(serviceWorker, 'k1');
    const stat = await serviceWorker.evaluate(() => globalThis.__solo.queue.drain());
    // 区间而不是等值：nextWakeMs = 排定时刻 - 此刻，真实时钟下中间必然过掉几毫秒。
    // （单元测试用假时钟，那边才断言等于。这条在单独跑时曾侥幸通过、全量跑时才现形。）
    expect(stat.nextWakeMs).toBeGreaterThan(8_000);
    expect(stat.nextWakeMs).toBeLessThanOrEqual(9_000);    // 默认第一档是 5000，这里听服务端的 9s
});

test('重试时排上 chrome.alarms —— 这是 worker 死后唯一的唤醒途径', async ({ serviceWorker, router }) => {
    // 非永久错误 → 队列退避 → scheduleWake → chrome.alarms.create
    //
    // @why 用 -32000 而不是 -32029：**重试是两层的**。rpc.js 对它自己那张 TRANSIENT 表
    //      （-32029/-32006/-32007/-32099）会先退避重试 5 轮（合计 22.5s）才放行到队列；
    //      队列再按自己的档退避。拿 -32029 测这条，等的是 rpc 那一层，用例要跑 24 秒，
    //      而且测的根本不是想测的东西。-32000 不在 rpc 的表里、也不在队列的 PERMANENT 表里
    //      ——正好只走队列这一层。
    router.reply(() => ({ error: { code: -32000, message: 'server error' } }));
    await enqueue(serviceWorker, 'k1');
    await serviceWorker.evaluate(() => globalThis.__solo.queue.drain());

    const alarms = await serviceWorker.evaluate(() => chrome.alarms.getAll());
    expect(alarms.map((a) => a.name)).toContain('solo-queue');
});
