/**
 * 扩展内部消息层 —— background ↔ content script ↔ popup 之间那条通道。
 *
 * 它解决的是 MV3 里**必然发生**的两件事，而不是异常情况：
 *
 *   ① **向 content script 发消息会瞬时失败。** 导航中、bfcache、新文档还没注入完、
 *      service worker 刚被回收——这些都不是业务失败，是该重试的抖动。
 *   ② **service worker 空闲即被回收**，冷启动瞬间 `chrome.runtime.sendMessage` 会 reject。
 *      裸调让异常冒泡出去，**后面的 UI 代码全不执行**——症状是"点了没反应、也没有报错"。
 *
 * 🔴 **本文件刻意不用 `import` / `export`。** Chrome 的 content script 是 **classic
 *    script**，不是 module——`export` 一个字就是 `SyntaxError: Unexpected token 'export'`，
 *    整节注入当场作废。而一个不含 import/export 的文件在 module 与 classic script
 *    两种上下文里都能求值（2026-08-26 实测），所以这一份能同时给两边用：
 *
 *      service worker / popup（module）：  经 `kit.js` 具名 import
 *      content script（classic）：         manifest 的 `js` 数组里排在使用者**前面**，
 *                                          然后读 `self.SoloMessaging`
 *
 *    kit 其余模块都是标准 ESM，只有这一个是双形态——因为只有这一个要进 content script。
 *
 * @why 判据下沉到框架而不是各项目自己写：瞬时错误的正则**各项目必然各漏各的**——
 *      你只见过自己踩到的那一种措辞。steward 2026-08-25 的正则漏掉了最常见的那种
 *      （`message channel closed`，**没有 `is`**），于是一场 57 步的演示在第 5 步
 *      把一个本该被重试吃掉的抖动升级成整场失败；现场表现还是"用户点了下浏览器的
 *      保存密码弹窗，演示就断了"，指向完全错误的方向。
 */
'use strict';

(function (root) {
    'use strict';

    /**
     * Chrome 对「通道没接住」这件事有**四种**措辞，宽匹配把它们一网打尽：
     *
     *   · `...but the message channel closed before a response was received`   ← 无 `is`
     *   · `The message port closed before a response was received.`            ← port 不是 channel
     *   · `Could not establish connection. Receiving end does not exist.`
     *   · `The page keeping the extension port is moved into back/forward cache`
     *
     * 🔴 **按类型写，别照着某一次的报错原文抄**——抄出来的正则只覆盖你踩过的那一种。
     *
     * ⚠️ 刻意**不**包含 `Extension context invalidated`：那是扩展被重载、这个页面上的
     *    旧 content script 已经死了，**重试永远不会成功**，只会白等几轮退避。
     */
    const TRANSIENT_CHANNEL_ERROR =
        /back\/forward cache|message (port|channel) .*closed|Receiving end does not exist/i;

    /**
     * 这个错误是不是「通道瞬时失败」——是就该重试，不是就该当业务失败报出去。
     *
     * @param {unknown} e  Error、字符串、或 `chrome.runtime.lastError` 都收
     * @returns {boolean}
     */
    function isTransientChannelError(e) {
        if (!e) return false;
        const text = typeof e === 'string' ? e : (e.message || String(e));
        return TRANSIENT_CHANNEL_ERROR.test(text);
    }

    const nap = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * 向某个标签页的 content script 发消息，**瞬时错误自动重试**。
     *
     * @param {number} tabId
     * @param {object} message
     * @param {object} [opts]
     * @param {number} [opts.retries=3]     重试次数（总尝试 = retries + 1）
     * @param {number} [opts.baseDelay=150] 退避基数，第 i 轮等 baseDelay * 2^i 毫秒
     * @param {number} [opts.frameId]       只发给某个 frame；不给就是主 frame
     * @param {(tabId:number)=>any} [opts.ensureInjected]
     *        重试前的「补一针注入」回调。@why 单纯等待治不好"这个文档根本没注入过"
     *        （手动 `chrome.scripting.executeScript` 的页、注入前就导航走的页）——
     *        那种情况等到天亮还是 `Receiving end does not exist`。回调抛错不致命，
     *        当作这一针没打上，继续退避重试。
     * @param {(ms:number)=>Promise} [opts.sleep] 注入等待（测试用，省得真等）
     * @returns {Promise<any>} content script 的响应
     * @throws 重试用尽或遇到非瞬时错误时抛出；瞬时错误抛出前会打上 `err.transient = true`
     */
    async function sendToTab(tabId, message, opts = {}) {
        const {
            retries = 3, baseDelay = 150, frameId,
            ensureInjected, sleep = nap, isTransient = isTransientChannelError,
        } = opts;

        let last;
        for (let i = 0; i <= retries; i += 1) {
            try {
                return frameId === undefined
                    ? await root.chrome.tabs.sendMessage(tabId, message)
                    : await root.chrome.tabs.sendMessage(tabId, message, { frameId });
            } catch (e) {
                last = e;
                if (!isTransient(e) || i === retries) break;
                if (ensureInjected) {
                    try { await ensureInjected(tabId); } catch { /* 这一针没打上，交给退避重试 */ }
                }
                await sleep(baseDelay * 2 ** i);
            }
        }
        const err = last instanceof Error ? last : new Error(String(last && last.message || last));
        if (isTransient(err)) err.transient = true;
        throw err;
    }

    /**
     * 页面侧（popup / options / content script）调 background，**永不抛**。
     *
     * @why 归一成 `{ok:false}` 而不是 reject：这是 MV3 里最容易静默出错的一处——
     *      裸调在 worker 冷启动瞬间 reject，异常冒泡出去把**后面整段 UI 代码**带走，
     *      而调用方多半没有 try/catch（谁会给一个"发条消息"加呢）。返回值形态
     *      逼调用方看一眼结果，比指望每处都记得 catch 靠谱。
     *
     * 信封是 kit 的约定（与 `serveMessages` 成对）：background 回 `{data}` 或 `{error}`。
     * `!res` 单独判成「后台无响应」——worker 刚被回收时就是这个形态，不是异常。
     *
     * @param {string} type
     * @param {object} [payload]
     * @param {object} [opts] 同 sendToTab 的 retries/baseDelay/sleep
     * @returns {Promise<{ok:true,data:any}|{ok:false,error:string,transient?:boolean}>}
     */
    async function callBackground(type, payload = {}, opts = {}) {
        const { retries = 2, baseDelay = 120, sleep = nap, isTransient = isTransientChannelError } = opts;

        let last = '后台无响应';
        for (let i = 0; i <= retries; i += 1) {
            try {
                const res = await root.chrome.runtime.sendMessage({ type, payload });
                // worker 刚被回收 / 监听器还没装上：不是异常，是没人接
                if (!res) { last = 'background 无响应（service worker 可能刚被回收）'; }
                else if (res.error) return { ok: false, error: String(res.error) };
                else return { ok: true, data: res.data };
            } catch (e) {
                last = (e && e.message) || String(e);
                if (!isTransient(e)) return { ok: false, error: last };
            }
            if (i < retries) await sleep(baseDelay * 2 ** i);
        }
        return { ok: false, error: last, transient: true };
    }

    /**
     * 装 background 侧的消息路由 —— 与 `callBackground` 共用一个信封。
     *
     * ```js
     * chrome.runtime.onMessage.addListener(serveMessages(handlers));
     * ```
     *
     * 🔴 **它替你守住 `return true`。** MV3 里监听器同步返回假值 = 通道当场关闭，
     *    而这**恰恰就是** `callBackground` 那边看到的
     *    `The message port closed before a response was received.`——
     *    一个自己造出来的"瞬时错误"，重试永远修不好。手写这段的人漏掉它是常态。
     *
     * @param {Record<string, (payload:object, sender:object)=>any>} handlers
     * @param {object} [opts]
     * @param {(e:Error)=>string} [opts.formatError] 错误对象 → 回给页面的字符串
     * @param {()=>Record<string,Function>} [opts.getHandlers]
     *        延迟取 handlers（跨组调用时用，见 sample/README「长大之后怎么拆」）
     */
    function serveMessages(handlers, opts = {}) {
        const { formatError = (e) => String((e && e.message) || e), getHandlers = () => handlers || {} } = opts;
        return (msg, sender, sendResponse) => {
            const fn = getHandlers()[msg && msg.type];
            if (!fn) { sendResponse({ error: `未知消息 ${msg && msg.type}` }); return false; }
            Promise.resolve()
                .then(() => fn(msg.payload || {}, sender))
                .then((data) => sendResponse({ data }))
                .catch((e) => sendResponse({ error: formatError(e) }));
            return true;    // 🔴 见上：漏了它，异步 sendResponse 就打在一条已关的通道上
        };
    }

    root.SoloMessaging = {
        isTransientChannelError, sendToTab, callBackground, serveMessages,
        TRANSIENT_CHANNEL_ERROR,
    };
})(globalThis);
