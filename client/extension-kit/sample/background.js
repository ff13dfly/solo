/**
 * Sample 扩展的 service worker —— 插件里**唯一**的网络出口。
 *
 * 这份文件就是 kit README §4 那段最小接法的可运行版本。照抄的顺序：
 *   endpoints（地址） → session（token） → rpc（传输） → queue（持久化上行）
 *
 * @why 所有 Router 调用与 token 都收在这里，content script / popup 一律经消息转发：
 *      ① 避开页面 CSP 与 CORS（service worker 的 fetch 只受 host_permissions 约束）；
 *      ② token 不落到目标站点所在的进程里，页面脚本偷不到。
 */
import {
    createRpc, createPasswordAuth, RpcError,
    createQueue, createSession, createEndpoints, chromeArea,
    sendToTab, serveMessages,
} from './kit.js';

/** 改成你自己的环境。[0] = 装完不改任何设置就能用的默认地址。 */
const PRESETS = [
    { url: 'http://localhost:8440/jsonrpc', name: '本地全栈（localhost:8440）' },
    { url: 'http://127.0.0.1:8600/jsonrpc', name: 'Router 直连（8600）' },
];

const DEVICE_ID = 'solo-sample-ext';

const local = chromeArea('local');
const session = createSession({ local, session: chromeArea('session') });
const endpoints = createEndpoints({ backend: local, presets: PRESETS });

// reauth 先声明后赋值：createRpc 与 createPasswordAuth 互相引用，用闭包打断这个环。
let reauth;
const rpc = createRpc({
    getEndpoint: endpoints.get,
    getToken: session.getToken,
    setToken: session.setToken,
    reauth: () => reauth(),
});
reauth = createPasswordAuth({
    rpc,
    deviceId: DEVICE_ID,
    getCredentials: session.getCredentials,
    clearCredentials: session.clearCredentials,
});

const queue = createQueue({
    backend: local,
    // 🔴 `attempt` 不是 `call`：重试策略归队列（持久、扛得住 worker 被回收），
    //    rpc 只负责把这一次请求尽力发出去。用 call 会让两层退避相乘——实测一个条目
    //    跑满 6 次尝试要发 36 次 fetch、耗时 135 秒，全程占着 service worker。
    send: (item) => rpc.attempt(item.method, item.params),
    // 🔴 chrome.alarms 是队列在 worker 被回收后还能醒过来的唯一途径。
    //    Chrome 会把过短的延迟夹到最小值（打包扩展约 1 分钟），所以别指望秒级精度。
    scheduleWake: (ms) => chrome.alarms.create('solo-queue', { when: Date.now() + ms }),
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'solo-queue') queue.drain(); });
// 冷启动补投：worker 上次是被回收的，没送完的条目还在 storage 里等着。
chrome.runtime.onStartup.addListener(() => queue.drain());
chrome.runtime.onInstalled.addListener(() => queue.drain());

/**
 * 问页面要点事实 —— background 侧唯一一处 `chrome.tabs.sendMessage`。
 *
 * 🔴 **必须走 `sendToTab` 而不是裸调。** 向 content script 发消息在 MV3 里是
 *    **必然会瞬时失败**的操作：导航中、bfcache、新文档还没注入完。裸调的症状极具
 *    误导性——一次导航后的抖动会被当成业务失败报出去，而现场看起来像"页面变了"。
 *
 * 页面**没有** content script（不在 manifest 的 matches 里、或是 chrome:// 页）也很正常，
 * 那时退回 tabs API 拿得到的那点信息，别让采集整个失败。
 *
 * ⚠️ 退路本身也可能是空的：`tab.url` / `tab.title` **要 host 权限才看得见**，而
 *    `activeTab` 只在用户手势之后才授予。所以这两个字段随时可能是 undefined——
 *    别把它们当必然存在（CAPTURE 里先判 `!tab.url` 就是为了这个）。
 */
async function readPage(tab) {
    try {
        // 🔴 重试次数要配得上"你有多需要这个答案"。这是**可选的增补**（拿不到也照样入队），
        //    所以只重试 1 次；主路径上的动作（点一下就必须点中的那种）才值得默认的 3 次。
        //    默认 3 次在没有 content script 的页面上要白等 1 秒多才认输。
        const res = await sendToTab(tab.id, { type: 'READ_PAGE' }, { retries: 1 });
        return res && res.data ? res.data : null;      // 信封由 content 侧的 serveMessages 打
    } catch (e) {
        // 重试用尽仍失败：这一页就是没有我们的 content script。
        return { title: tab.title || '', url: tab.url, unreachable: e.message };
    }
}

// ── popup 的消息路由 ────────────────────────────────────────────
const handlers = {
    async PING() {
        await rpc.raw('system.ping', {}, await session.getToken());
        return { ok: true, endpoint: await endpoints.get() };
    },

    async LIST_ENDPOINTS() {
        return { items: await endpoints.list(), current: await endpoints.get() };
    },

    async SET_ENDPOINT({ url }) {
        // 换 Router 就换了账号体系（各自的 Redis），旧 token 一定不能留。
        await session.clearToken();
        return { endpoint: await endpoints.set(url) };
    },

    async LOGIN({ name, password, remember }) {
        await session.setRemember(remember);
        const out = await rpc.login(name, password, DEVICE_ID);
        if (remember) await session.setCredentials({ name, password });
        return { uid: out.uid };
    },

    async LOGOUT() {
        await session.logout();
        return { ok: true };
    },

    async AUTH_STATE() {
        return {
            loggedIn: Boolean(await session.getToken()),
            remembered: Boolean(await session.getCredentials()),
            endpoint: await endpoints.get(),
        };
    },

    /**
     * 采当前页 → 入队 → 立刻试送一次。
     *
     * `idemKey` 用 (method, url, 当天) 派生：同一页一天一条。**这个键要按你的业务定**，
     * 它是重发安全的唯一依据（见 lib/queue.js 顶部的投递语义）。
     */
    async CAPTURE({ method }) {
        if (!method) throw new Error('先在弹窗里填上报方法（如 yourservice.capture.create）');
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) throw new Error('拿不到当前标签页');

        const page = await readPage(tab);
        const day = new Date().toISOString().slice(0, 10);
        const idemKey = await rpc.sha256(`${method}:${tab.url}:${day}`);
        const res = await queue.enqueue({
            method,
            params: { url: tab.url, title: tab.title || '', capturedAt: new Date().toISOString(), page },
            idemKey,
        });
        const stat = await queue.drain();
        // 页内回一条反馈。best-effort：页面没注入 content script 也不该让采集失败。
        sendToTab(tab.id, { type: 'FLASH', payload: { text: `SOLO 已入队 ${idemKey.slice(0, 8)}…` } }, { retries: 1 })
            .catch(() => {});
        return { ...res, idemKey: idemKey.slice(0, 12), drained: stat, page };
    },

    async QUEUE_STATS() {
        return { ...(await queue.stats()), dead: await queue.listDead() };
    },
    async QUEUE_DRAIN() { return queue.drain(); },
    async QUEUE_RETRY_DEAD() { return { requeued: await queue.retryDead() }; },
};

// `serveMessages` 替你守住「异步 handler 必须 return true」——漏了它通道当场关闭，
// 页面那边收到的正是 "The message port closed…"，一个自己造出来的假瞬时错误。
chrome.runtime.onMessage.addListener(serveMessages(handlers, {
    formatError: (e) => (e instanceof RpcError ? `[${e.code}] ${e.message}` : String(e.message || e)),
}));

// E2E 用的挂载点：让测试能在 service worker 里直接驱动队列，不必经 popup UI。
globalThis.__solo = { queue, rpc, session, endpoints, readPage };
