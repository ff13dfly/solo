/**
 * 装载与接线 —— 单元测试结构上够不到的那一层。
 *
 * 这套用例的头号价值是**守住"扩展根是封闭的树"那个坑**：只要有人把 sample/kit.js 的
 * `./kit/` 改回 `../lib/`，或者 sync.sh 坏了，这里当场红。而那个故障在浏览器里的表现是
 * **service worker 注册成功、不报任何错、URL 看着正常，但模块从未求值**——
 * 没有这条用例，它只会在某个人手动装扩展时才暴露。
 */
import { test, expect } from '../fixtures.js';

test('扩展装得起来，service worker 是 background.js', async ({ serviceWorker }) => {
    expect(serviceWorker.url()).toMatch(/\/background\.js$/);
});

test('🔴 kit 在真 service worker 里 import 成功（越界 import 回归守卫）', async ({ serviceWorker }) => {
    const mounted = await serviceWorker.evaluate(() => Object.keys(globalThis.__solo || {}));
    // background.js 结尾挂的 __solo —— 它存在就证明整条 import 链求值到底了
    expect(mounted.sort()).toEqual(['endpoints', 'queue', 'rpc', 'session']);
});

test('kit 的各模块确实是同一份实现（不是被谁掉包成桩）', async ({ serviceWorker }) => {
    const shape = await serviceWorker.evaluate(() => ({
        queue: Object.keys(globalThis.__solo.queue).sort(),
        rpc: Object.keys(globalThis.__solo.rpc).sort(),
    }));
    expect(shape.queue).toEqual(
        ['clearDead', 'drain', 'enqueue', 'listDead', 'listPending', 'retryDead', 'stats'],
    );
    expect(shape.rpc).toEqual(['attempt', 'call', 'login', 'raw', 'sha256']);
});

test('chrome.alarms / chrome.storage 权限到位（manifest 声明与实际可用一致）', async ({ serviceWorker }) => {
    const caps = await serviceWorker.evaluate(() => ({
        alarms: typeof chrome.alarms?.create === 'function',
        local: typeof chrome.storage?.local?.get === 'function',
        session: typeof chrome.storage?.session?.get === 'function',
    }));
    // session 区是"不记住密码"时 token 的家；缺了它 session.js 会静默退化成 local
    expect(caps).toEqual({ alarms: true, local: true, session: true });
});
