/**
 * 装扩展的 playwright fixture。
 *
 * 🔴 三条实测出来的硬约束，改动前先读（2026-08-20 测于 playwright 1.62 / Chrome 141）：
 *
 *   ① **必须 `channel: 'chromium'`。** 不加的话 headless 下 `waitForEvent('serviceworker')`
 *      直接超时——症状像扩展没装上，实际是装上了但那个 headless 通道不支持扩展。
 *   ② **必须 `launchPersistentContext`。** 普通 `launch()` 不能装扩展。
 *   ③ **service worker 被杀之后，旧的 sw handle 上再 `evaluate()` 会永久挂住**
 *      （不是抛错，是挂住，只能靠超时发现）。所以杀过 SW 的用例一律改走**扩展页面**
 *      （`chrome.runtime.sendMessage` / `chrome.storage`），别再碰那个 handle。
 */
import { test as base, chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeRouter } from './helpers/fake-router.js';

const KIT_DIR = path.resolve(import.meta.dirname, '..');
const SAMPLE_DIR = path.join(KIT_DIR, 'sample');

export const test = base.extend({
    // eslint-disable-next-line no-empty-pattern
    context: async ({}, use) => {
        // kit 必须在扩展根**内部**——扩展根是封闭的树，越界 import 会让 SW 起得来但完全
        // 不工作且不报错（见 sync.sh 顶部）。这里主动同步一次，所以本套用例也顺带证明了
        // sync.sh 是有效的。
        execFileSync('bash', [path.join(KIT_DIR, 'sync.sh'), SAMPLE_DIR], { stdio: 'pipe' });

        const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-ext-e2e-'));
        const context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium',
            headless: true,
            args: [
                `--disable-extensions-except=${SAMPLE_DIR}`,
                `--load-extension=${SAMPLE_DIR}`,
            ],
        });
        await use(context);
        await context.close();
        fs.rmSync(profile, { recursive: true, force: true });
    },

    serviceWorker: async ({ context }, use) => {
        const sw = context.serviceWorkers()[0]
            || await context.waitForEvent('serviceworker', { timeout: 30_000 });
        await use(sw);
    },

    extensionId: async ({ serviceWorker }, use) => {
        await use(new URL(serviceWorker.url()).host);
    },

    /** 假 Router，并且已经把扩展的 endpoint 指过去。 */
    router: async ({ serviceWorker }, use) => {
        const r = await startFakeRouter();
        await serviceWorker.evaluate((url) => chrome.storage.local.set({ endpoint: url }), r.url);
        await use(r);
        await r.close();
    },

    /** 一个扩展内的页面 —— 杀过 SW 之后唯一可靠的驱动通道（见顶部 ③）。 */
    extPage: async ({ context, extensionId }, use) => {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await use(page);
        await page.close();
    },
});

export { expect };

/** 从扩展页面驱动 background 的消息处理器（不依赖 sw handle）。 */
export const callBackground = (page, type, payload = {}) => page.evaluate(
    ([t, p]) => new Promise((resolve) => chrome.runtime.sendMessage({ type: t, payload: p }, resolve)),
    [type, payload],
);

/** CDP 强杀 service worker —— 模拟 MV3 空闲回收。 */
export async function killServiceWorker(context, page) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.detach().catch(() => {});
}
