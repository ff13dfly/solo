/**
 * messaging —— 通道瞬时错误的统一判据 + 两侧的消息包装。
 *
 * 这套的核心是**第一组**：正则漏一种措辞，一个本该被重试吃掉的抖动就升级成整场失败
 * （steward 2026-08-25 实测）。所以四种措辞逐条钉住，业务错误逐条钉住不误伤。
 */
import { jest } from '@jest/globals';
import '../lib/messaging.js';

const { isTransientChannelError, sendToTab, callBackground, serveMessages } = globalThis.SoloMessaging;

const noSleep = () => Promise.resolve();

afterEach(() => { delete globalThis.chrome; });

// ── 判据 ────────────────────────────────────────────────────────────────

describe('isTransientChannelError', () => {
    // 🔴 Chrome 的四种真实措辞，逐字取自真机。别"简化"它们——差一个 is 就是漏网。
    test.each([
        ['无 is 的那种（最常见，也最容易漏）', 'Could not establish connection, but the message channel closed before a response was received'],
        ['port 不是 channel', 'The message port closed before a response was received.'],
        ['接收端不存在', 'Could not establish connection. Receiving end does not exist.'],
        ['bfcache', 'The page keeping the extension port is moved into back/forward cache, so the message channel is closed'],
    ])('瞬时：%s', (_name, text) => {
        expect(isTransientChannelError(new Error(text))).toBe(true);
        expect(isTransientChannelError(text)).toBe(true);          // 字符串也收
    });

    test.each([
        ['业务失败：找不到元素', '找不到元素 .price'],
        ['业务失败：页面动作失败', '页面动作失败'],
        ['权限错误', '[-32005] permission denied'],
        // 🔴 扩展被重载 = 这个页面上的旧 content script 已经死了，重试永远不会成功。
        //    把它算成瞬时，就是白等几轮退避再报同一个错。
        ['扩展被重载（永久，刻意不重试）', 'Extension context invalidated.'],
    ])('非瞬时：%s', (_name, text) => {
        expect(isTransientChannelError(new Error(text))).toBe(false);
    });

    test('空值不算错误', () => {
        expect(isTransientChannelError(null)).toBe(false);
        expect(isTransientChannelError(undefined)).toBe(false);
    });
});

// ── background → content script ─────────────────────────────────────────

describe('sendToTab', () => {
    const mkTabs = (impl) => { globalThis.chrome = { tabs: { sendMessage: jest.fn(impl) } }; return globalThis.chrome.tabs.sendMessage; };

    test('瞬时错误重试后成功 —— 这就是它存在的全部理由', async () => {
        let n = 0;
        const send = mkTabs(async () => {
            n += 1;
            if (n < 3) throw new Error('The message port closed before a response was received.');
            return { ok: true };
        });
        await expect(sendToTab(7, { type: 'READ' }, { sleep: noSleep })).resolves.toEqual({ ok: true });
        expect(send).toHaveBeenCalledTimes(3);
    });

    test('🔴 业务错误立刻抛，一次都不重试 —— 重试业务失败只是把错误推迟几秒', async () => {
        const send = mkTabs(async () => { throw new Error('找不到元素 .price'); });
        await expect(sendToTab(7, {}, { sleep: noSleep })).rejects.toThrow('找不到元素');
        expect(send).toHaveBeenCalledTimes(1);
    });

    test('重试用尽：抛出并标记 transient，让调用方分得清"通道抖动"和"业务失败"', async () => {
        mkTabs(async () => { throw new Error('Receiving end does not exist.'); });
        const err = await sendToTab(7, {}, { retries: 2, sleep: noSleep }).catch((e) => e);
        expect(err.transient).toBe(true);
        expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledTimes(3);   // retries + 1
    });

    test('退避是指数的，且用注入的 sleep（测试不真等）', async () => {
        mkTabs(async () => { throw new Error('Receiving end does not exist.'); });
        const waited = [];
        await sendToTab(7, {}, { retries: 3, baseDelay: 100, sleep: (ms) => { waited.push(ms); return Promise.resolve(); } }).catch(() => {});
        expect(waited).toEqual([100, 200, 400]);
    });

    test('ensureInjected 在每轮重试前补一针 —— 光等治不好"这个文档根本没注入过"', async () => {
        let n = 0;
        mkTabs(async () => { n += 1; if (n < 2) throw new Error('Receiving end does not exist.'); return 'ok'; });
        const inject = jest.fn();
        await expect(sendToTab(7, {}, { ensureInjected: inject, sleep: noSleep })).resolves.toBe('ok');
        expect(inject).toHaveBeenCalledWith(7);
    });

    test('ensureInjected 自己抛错不致命 —— 当这一针没打上，继续退避重试', async () => {
        let n = 0;
        mkTabs(async () => { n += 1; if (n < 3) throw new Error('Receiving end does not exist.'); return 'ok'; });
        const inject = jest.fn(async () => { throw new Error('cannot access chrome:// URL'); });
        await expect(sendToTab(7, {}, { ensureInjected: inject, sleep: noSleep })).resolves.toBe('ok');
        expect(inject).toHaveBeenCalledTimes(2);
    });

    test('frameId 给了才透传（不给就是主 frame，别塞个 undefined 进去）', async () => {
        const send = mkTabs(async () => 'ok');
        await sendToTab(7, { a: 1 });
        expect(send).toHaveBeenLastCalledWith(7, { a: 1 });
        await sendToTab(7, { a: 1 }, { frameId: 3 });
        expect(send).toHaveBeenLastCalledWith(7, { a: 1 }, { frameId: 3 });
    });
});

// ── 页面 → background ───────────────────────────────────────────────────

describe('callBackground', () => {
    const mkRuntime = (impl) => { globalThis.chrome = { runtime: { sendMessage: jest.fn(impl) } }; return globalThis.chrome.runtime.sendMessage; };

    test('成功：剥掉信封只给 data', async () => {
        mkRuntime(async () => ({ data: { uid: 'u1' } }));
        await expect(callBackground('AUTH_STATE')).resolves.toEqual({ ok: true, data: { uid: 'u1' } });
    });

    test('🔴 永不抛 —— 裸调 reject 会把后面整段 UI 代码带走，"点了没反应、也没报错"', async () => {
        mkRuntime(async () => { throw new Error('Extension context invalidated.'); });
        await expect(callBackground('PING')).resolves.toEqual({ ok: false, error: 'Extension context invalidated.' });
    });

    test('!res 判成"后台无响应"而不是异常 —— worker 刚被回收就是这个形态', async () => {
        mkRuntime(async () => undefined);
        const r = await callBackground('PING', {}, { retries: 1, sleep: noSleep });
        expect(r.ok).toBe(false);
        expect(r.transient).toBe(true);
        expect(r.error).toMatch(/无响应/);
        expect(globalThis.chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    });

    test('冷启动 reject 之后重试成功 —— service worker 醒过来了', async () => {
        let n = 0;
        mkRuntime(async () => {
            n += 1;
            if (n === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
            return { data: 'awake' };
        });
        await expect(callBackground('PING', {}, { sleep: noSleep })).resolves.toEqual({ ok: true, data: 'awake' });
    });

    test('业务错误直接归一，不重试 —— 后台已经答话了，再问一遍还是同一个答案', async () => {
        const send = mkRuntime(async () => ({ error: '[-32005] permission denied' }));
        await expect(callBackground('CAPTURE')).resolves.toEqual({ ok: false, error: '[-32005] permission denied' });
        expect(send).toHaveBeenCalledTimes(1);
    });

    test('payload 缺省成空对象，信封形状固定', async () => {
        const send = mkRuntime(async () => ({ data: 1 }));
        await callBackground('PING');
        expect(send).toHaveBeenCalledWith({ type: 'PING', payload: {} });
    });
});

// ── background 侧的路由 ─────────────────────────────────────────────────

describe('serveMessages', () => {
    const drive = (listener, msg) => new Promise((resolve) => listener(msg, { tab: { id: 1 } }, resolve));

    test('🔴 异步 handler 时返回 true —— 漏了它通道当场关闭，对面收到的正是"message port closed"', () => {
        const listener = serveMessages({ async PING() { return 'pong'; } });
        expect(listener({ type: 'PING' }, {}, () => {})).toBe(true);
    });

    test('未知消息立刻回错并返回 false（没有异步，不用占着通道）', () => {
        const listener = serveMessages({});
        const sendResponse = jest.fn();
        expect(listener({ type: 'NOPE' }, {}, sendResponse)).toBe(false);
        expect(sendResponse).toHaveBeenCalledWith({ error: '未知消息 NOPE' });
    });

    test('handler 的返回值进 data，抛错进 error', async () => {
        const listener = serveMessages({
            async OK() { return { n: 1 }; },
            async BOOM() { throw new Error('炸了'); },
        });
        await expect(drive(listener, { type: 'OK' })).resolves.toEqual({ data: { n: 1 } });
        await expect(drive(listener, { type: 'BOOM' })).resolves.toEqual({ error: '炸了' });
    });

    test('同步抛错的 handler 也被接住（不是每个 handler 都是 async）', async () => {
        const listener = serveMessages({ BOOM() { throw new Error('同步炸'); } });
        await expect(drive(listener, { type: 'BOOM' })).resolves.toEqual({ error: '同步炸' });
    });

    test('handler 拿得到 sender（判断消息来自哪个标签页）', async () => {
        const seen = [];
        const listener = serveMessages({ WHO(_p, sender) { seen.push(sender.tab.id); return 'ok'; } });
        await drive(listener, { type: 'WHO' });
        expect(seen).toEqual([1]);
    });

    test('getHandlers 延迟取值 —— 跨组调用时，装配还没跑完就持有引用会拿到 undefined', async () => {
        let table = {};
        const listener = serveMessages(null, { getHandlers: () => table });
        table = { LATE: async () => 'ready' };          // 装配比监听器安装晚
        await expect(drive(listener, { type: 'LATE' })).resolves.toEqual({ data: 'ready' });
    });

    test('formatError 可注入 —— 项目要把 RpcError 的 code 带出去', async () => {
        const listener = serveMessages(
            { BOOM: async () => { const e = new Error('nope'); e.code = -32005; throw e; } },
            { formatError: (e) => `[${e.code}] ${e.message}` },
        );
        await expect(drive(listener, { type: 'BOOM' })).resolves.toEqual({ error: '[-32005] nope' });
    });
});
