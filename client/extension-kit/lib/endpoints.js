/**
 * Router 地址清单 —— 插件里的**单一真源**。
 *
 * 🔴 background 与 popup 都从这里取值，**别在两边各写一份默认地址**。
 *    wavely 插件踩过这个坑：两处默认值漂移之后，popup 显示连着 A、实际请求发去 B，
 *    症状是"登录成功但什么都读不到"，排查方向会被完全带偏（会去查权限、查数据，
 *    就是不会想到地址）。
 *
 * 🔴 **地址不自动补尾斜杠。** `/rpc/`（nginx 反代，靠尾斜杠剥前缀，漏了先吃一个 308）
 *    与 `/jsonrpc`（Router 直连）的正确形态不同，猜一个必然把另一个改坏。拿不准就从
 *    预置里选。
 *
 * @why 预置清单注入而非写死：每个项目的环境不一样（wavely 有线上测试域名，steward 只有
 *      本地），而"默认地址"恰恰是最该跟着项目走的东西。kit 只保证**取值路径唯一**。
 *
 * ⚠️ 改 `presets[0]` 不会追平已经用过插件的浏览器：`get()` 的顺序是
 *    `storage.endpoint → presets[0]`，一旦选过一次，地址就固化在 storage 里了。
 *    popup 里当前选中的**就是实际生效的地址**，以它为准。
 */

const KEY = 'endpoint';
const CUSTOM_KEY = 'customEndpoints';

/**
 * @param {object} opts
 * @param {object} opts.backend  存储后端（storage.js）
 * @param {Array<{url:string,name:string}>} opts.presets  项目自己的预置清单，[0] 即默认
 */
export function createEndpoints({ backend, presets }) {
    if (!Array.isArray(presets) || presets.length === 0) {
        throw new Error('createEndpoints 需要非空 presets —— [0] 是装完不改任何设置就能用的默认地址');
    }

    /** 当前生效地址。 */
    async function get() {
        return (await backend.get(KEY)) || presets[0].url;
    }

    async function set(url) {
        await backend.set(KEY, normalize(url));
        return normalize(url);
    }

    /** 预置在前、用户自加的在后，供 popup 下拉直接渲染。 */
    async function list() {
        const custom = (await backend.get(CUSTOM_KEY)) || [];
        return [...presets, ...custom];
    }

    /**
     * 记住一个自定义地址。已在清单里则不重复加。
     * @why 调用方应当**先 ping 通再调它**——否则打错的地址会永久占一个下拉项。
     */
    async function add(url, name) {
        const clean = normalize(url);
        const custom = (await backend.get(CUSTOM_KEY)) || [];
        if (![...presets, ...custom].some((e) => e.url === clean)) {
            await backend.set(CUSTOM_KEY, [...custom, { url: clean, name: name || clean }]);
        }
        return clean;
    }

    async function remove(url) {
        const custom = (await backend.get(CUSTOM_KEY)) || [];
        await backend.set(CUSTOM_KEY, custom.filter((e) => e.url !== normalize(url)));
    }

    return { get, set, list, add, remove, presets };
}

/** 只做合法性校验与去空白，**不猜尾斜杠**（见顶部 🔴）。 */
export function normalize(url) {
    const s = String(url || '').trim();
    if (!s) throw new Error('Router 地址不能为空');
    let parsed;
    try {
        parsed = new URL(s);
    } catch {
        throw new Error(`不是合法的地址：${s}`);
    }
    if (!/^https?:$/.test(parsed.protocol)) {
        throw new Error(`Router 地址必须是 http/https：${s}`);
    }
    return s;
}
