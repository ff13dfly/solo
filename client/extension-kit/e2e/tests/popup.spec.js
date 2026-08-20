/**
 * Popup —— 只做冒烟：能开、不炸、拿得到 background 的数据。
 *
 * @why 不做 UI 细节断言：sample 的 popup 是给人抄的起点，样式和文案本就该被改掉；
 *      有价值的是"popup ↔ background 的消息通道通不通"，那才是抄过去也要继续用的东西。
 */
import { test, expect } from '../fixtures.js';

test('popup 打得开，没有未捕获报错，Router 下拉渲染出来了', async ({ extPage }) => {
    const errors = [];
    extPage.on('pageerror', (e) => errors.push(e.message));

    await expect(extPage.locator('#endpoint option')).not.toHaveCount(0);
    await expect(extPage.locator('#login-box')).toBeVisible();     // 未登录时显示登录框
    expect(errors).toEqual([]);
});

test('popup → background 的消息通道通（AUTH_STATE）', async ({ extPage }) => {
    const res = await extPage.evaluate(() => new Promise((r) =>
        chrome.runtime.sendMessage({ type: 'AUTH_STATE', payload: {} }, r)));
    expect(res.data).toMatchObject({ loggedIn: false });
    expect(res.data.endpoint).toMatch(/^https?:\/\//);
});

test('未知消息返回明确错误，不是静默无响应', async ({ extPage }) => {
    const res = await extPage.evaluate(() => new Promise((r) =>
        chrome.runtime.sendMessage({ type: 'NOPE' }, r)));
    expect(res.error).toMatch(/未知消息/);
});
