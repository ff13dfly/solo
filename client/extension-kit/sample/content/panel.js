/**
 * Content script —— 跑在**目标页面里**的那一半。
 *
 * 🔴 **content script 不是 module，是 classic script。** 这里写一个 `import` 或 `export`
 *    就是 `SyntaxError: Unexpected token`，整节注入当场作废、页面上什么都不会发生。
 *    所以多文件组织的通行做法（wavely 与 steward 各自独立收敛到的同一形态）是：
 *
 *      manifest 的 `js` 数组**按顺序注入** + 前面的文件往 `self.Xxx` 上挂全局
 *
 *    本文件依赖 `self.SoloMessaging`，它由 `kit/messaging.js` 提供——所以 manifest 里
 *    `kit/messaging.js` 必须排在本文件**前面**。顺序错了不会有编译错误，只有运行时的
 *    `Cannot read properties of undefined`。
 *
 * ⚠️ 这个契约有个静态可查的失效点：**把某个文件从 manifest 摘掉后，别处对它那个全局的
 *    引用不会报错，而是运行时炸**（steward 因此踩过两次，其中一次的错误文案还指向
 *    "页面改版、选择器要核对"，方向完全反了）。跑
 *    `node client/extension-kit/lint-injection.js <你的扩展目录>` 扫这一类。
 */
'use strict';

(function () {
    'use strict';

    const { serveMessages } = self.SoloMessaging;

    /** 页面事实 —— 你自己的扩展在这里换成站点 adapter 的 `read()`。 */
    function readPage() {
        const h1 = document.querySelector('h1');
        return {
            title: document.title,
            url: location.href,
            heading: h1 ? h1.textContent.trim().slice(0, 200) : '',
            selection: String(getSelection() || '').trim().slice(0, 500),
        };
    }

    /** 页内反馈条 —— 替代 alert（SOLO UI 规范：原生弹窗一律禁止，插件里也一样）。 */
    let badge;
    function flash(text, ms = 2400) {
        if (!badge) {
            badge = document.createElement('div');
            badge.style.cssText = [
                'position:fixed', 'z-index:2147483647', 'right:12px', 'bottom:12px',
                'max-width:280px', 'padding:8px 12px', 'border-radius:8px',
                'background:#111', 'color:#fff', 'font:12px/1.5 system-ui,sans-serif',
                'box-shadow:0 4px 16px rgba(0,0,0,.3)', 'pointer-events:none',
            ].join(';');
        }
        badge.textContent = text;
        // 页面可能把上一次的节点连着 body 一起换掉（SPA 路由），每次现挂。
        document.body.appendChild(badge);
        clearTimeout(flash.timer);
        flash.timer = setTimeout(() => badge.remove(), ms);
    }

    // 与 background 共用一个信封（`{data}` / `{error}`），两边都由 kit 的 messaging 负责。
    chrome.runtime.onMessage.addListener(serveMessages({
        READ_PAGE: () => readPage(),
        FLASH: ({ text }) => { flash(text); return { shown: true }; },
    }));

    // E2E 挂载点，生产扩展删掉这行（同 background.js 结尾那处）。
    self.__soloContent = { readPage, flash };
})();
