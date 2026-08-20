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

        const day = new Date().toISOString().slice(0, 10);
        const idemKey = await rpc.sha256(`${method}:${tab.url}:${day}`);
        const res = await queue.enqueue({
            method,
            params: { url: tab.url, title: tab.title || '', capturedAt: new Date().toISOString() },
            idemKey,
        });
        const stat = await queue.drain();
        return { ...res, idemKey: idemKey.slice(0, 12), drained: stat };
    },

    async QUEUE_STATS() {
        return { ...(await queue.stats()), dead: await queue.listDead() };
    },
    async QUEUE_DRAIN() { return queue.drain(); },
    async QUEUE_RETRY_DEAD() { return { requeued: await queue.retryDead() }; },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const fn = handlers[msg && msg.type];
    if (!fn) { sendResponse({ error: `未知消息 ${msg && msg.type}` }); return false; }
    fn(msg.payload || {})
        .then((data) => sendResponse({ data }))
        .catch((e) => sendResponse({ error: e instanceof RpcError ? `[${e.code}] ${e.message}` : String(e.message || e) }));
    return true;    // 异步 sendResponse 必须返回 true，否则通道当场关闭
});

// E2E 用的挂载点：让测试能在 service worker 里直接驱动队列，不必经 popup UI。
globalThis.__solo = { queue, rpc, session, endpoints };
