/**
 * Content script —— 「顺序注入 + `self.Xxx` 全局」这个契约，只有真 Chrome 能证。
 *
 * 这套守住的是本 kit 里最反直觉的一处设计：**`lib/messaging.js` 刻意不用 import/export**，
 * 因为同一份文件既要被 service worker `import`（module），又要被 manifest 当
 * **classic script** 注入进 content script。写一个 `export` 就是 `SyntaxError`，
 * 而它的表现是**整节注入静默作废**——页面上什么都不会发生，chrome://extensions 也不报错。
 * 单元测试结构上够不到这一层：jest 里怎么跑都是 module 上下文。
 *
 * ⚠️ `page.evaluate` 跑在**主世界**，看不见 content script 的隔离世界，所以这里一律
 *    通过**可观察的效果**断言（页面 DOM 里的反馈条、background 拿到的页面事实），
 *    不去偷看 `self.SoloMessaging`。这样验的也正好是真实链路。
 */
import { test, expect } from '../fixtures.js';

/** 打开一张会被注入的普通网页，并让它成为当前活动标签页。 */
async function openTargetPage(context, router) {
    const page = await context.newPage();
    await page.goto(router.pageUrl);
    await page.bringToFront();
    return page;
}

test('🔴 classic script 形态的 messaging 真的注入成功了（写了 export 这里当场红）', async ({ context, router, serviceWorker }) => {
    const page = await openTargetPage(context, router);

    // background → content：走 sendToTab，读回页面事实。
    // 能拿到 heading 就说明 ① 注入没作废 ② panel.js 拿到了 self.SoloMessaging
    // ③ serveMessages 的 `return true` 守住了异步通道。
    const facts = await serviceWorker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return globalThis.__solo.readPage(tab);
    });

    expect(facts).toMatchObject({ title: '假商品页', heading: '一件很贵的东西' });
    expect(facts.unreachable).toBeUndefined();
    await page.close();
});

test('content → 页面 DOM：FLASH 反馈条真的挂上去了（禁用 alert 之后的替代品）', async ({ context, router, serviceWorker }) => {
    const page = await openTargetPage(context, router);

    const ack = await serviceWorker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return chrome.tabs.sendMessage(tab.id, { type: 'FLASH', payload: { text: 'SOLO 已入队 abc…' } });
    });
    expect(ack).toEqual({ data: { shown: true } });          // 信封由 serveMessages 打

    await expect(page.getByText('SOLO 已入队 abc…')).toBeVisible();
    await page.close();
});

test('没有 content script 的页面：优雅退化，不把整次采集拖垮', async ({ context, serviceWorker }) => {
    // about:blank 不在 matches 里 —— 这是**常态**（chrome:// 页、没配的站点都一样），
    // 不该被当成失败。sendToTab 重试用尽后 readPage 退回 tabs API 那点信息。
    const page = await context.newPage();
    await page.goto('about:blank');
    await page.bringToFront();

    const facts = await serviceWorker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return globalThis.__solo.readPage(tab);
    });

    expect(facts.unreachable).toMatch(/Receiving end does not exist|Could not establish connection/);
    // ⚠️ 这里刻意**不**断言 facts.url —— `tab.url`/`tab.title` 要 host 权限才看得见，
    //    而 `activeTab` 只在用户手势之后才授予。about:blank 上两者都是 undefined，
    //    这不是 bug，是 MV3 的权限模型（sample 的 CAPTURE 本来就先判 `!tab.url` 再走）。
    expect(typeof facts.title).toBe('string');
    await page.close();
});

test('采集把页面事实一并上报 —— content script 与队列是接通的', async ({ context, router, serviceWorker }) => {
    const page = await openTargetPage(context, router);
    // 采集要登录态：直接塞一个 token，省掉一整轮挑战-响应（auth.spec 专门验那条）。
    await serviceWorker.evaluate(() => chrome.storage.session.set({ token: 'tok-e2e' }));

    const res = await serviceWorker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const page_ = await globalThis.__solo.readPage(tab);
        return globalThis.__solo.queue.enqueue({
            method: 'demo.capture.create',
            params: { url: tab.url, page: page_ },
            idemKey: 'e2e-content-1',
        });
    });
    expect(res).toBeTruthy();

    await serviceWorker.evaluate(() => globalThis.__solo.queue.drain());
    const sent = router.calls.find((c) => c.method === 'demo.capture.create');
    expect(sent.params.page).toMatchObject({ heading: '一件很贵的东西' });

    await page.close();
});
