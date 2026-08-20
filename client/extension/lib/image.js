/**
 * 图片抓取与规格化 —— 把一个图片 URL 变成 `storage.asset.upload` 收得下的载荷。
 *
 * @why 这一层看起来"跟业务无关所以每个项目自己写就行"，实际上它的每一条都由
 *      **`storage.asset.upload` 自己的约束**推导出来，跟采哪个站点毫无关系：
 *
 *      ① **`btoa(String.fromCharCode(...bytes))` 在几 MB 的数组上会爆调用栈。**
 *         必须按块 apply。wavely 的注释原话是"这是老实现里最容易踩的坑"——它不报
 *         "图片太大"，报的是 `RangeError: Maximum call stack size exceeded`，
 *         第一反应会去查递归而不是查编码。
 *      ② **`file` 参数 maxLength = 5242880**（见 apps/storage/handlers/introspection.js）。
 *         这是 **base64 之后**的长度上限，约等于 3.9MB 原图。超了 Router 直接 -32602，
 *         而手机拍的图轻松过线。所以要就地逐级降质。
 *
 *      两条都跟 1688 / YouTube / 任何站点无关，却只存在于一个派生项目里。
 *
 * ## 站点知识不在这里
 * CDN 的缩略图后缀规则（alicdn 的 `_250x250.jpg`、别家的 `?x-oss-process=`…）是**站点
 * 知识**，走 `normalizeUrl` 注入，别往 kit 里加第二个站点的正则。
 */

/** 与 storage.asset.upload 的 `file` 参数 maxLength 对齐。改这里之前先去看那边的声明。 */
export const MAX_BASE64_LEN = 5242880;

/** String.fromCharCode 的单次实参上限远低于此，取 32K 是安全且高效的折中。 */
const CHUNK = 0x8000;

/**
 * 分块 base64。**别改回一次性 apply**——见本文件顶部 ①。
 * @param {Uint8Array} bytes
 */
export function bytesToBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return globalThis.btoa(out);
}

/** `//host/x.jpg` → `https://host/x.jpg`；非 http(s) 一律返回 null（别把 data: 塞给上传）。 */
export function toAbsoluteUrl(url) {
    if (!url) return null;
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('http')) return url;
    return null;
}

/** 逐级降质到 base64 长度合规：先降 quality，仍超限再缩边长。 */
const SHRINK_STEPS = [
    { scale: 1,    quality: 0.85 },
    { scale: 1,    quality: 0.7 },
    { scale: 0.75, quality: 0.7 },
    { scale: 0.5,  quality: 0.65 },
    { scale: 0.35, quality: 0.6 },
];

async function shrink(blob, maxLen) {
    const bitmap = await globalThis.createImageBitmap(blob);
    try {
        for (const { scale, quality } of SHRINK_STEPS) {
            const w = Math.max(1, Math.round(bitmap.width * scale));
            const h = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = new globalThis.OffscreenCanvas(w, h);
            canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
            const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
            const b64 = bytesToBase64(new Uint8Array(await out.arrayBuffer()));
            if (b64.length <= maxLen) {
                return { base64: b64, mimeType: 'image/jpeg', shrunk: true, width: w, height: h };
            }
        }
    } finally {
        bitmap.close();
    }
    throw new Error(`图片过大：逐级降质后仍超过 ${maxLen} 的 base64 上限`);
}

/**
 * 抓一张图，转成 `storage.asset.upload` 可直接用的载荷。
 *
 * @param {string}   rawUrl
 * @param {object}   [opts]
 * @param {function} [opts.normalizeUrl] (url) => url  站点专属的 URL 规整（还原原图等）
 * @param {number}   [opts.retries]      默认 2
 * @param {number}   [opts.maxLen]       默认 MAX_BASE64_LEN
 * @param {function} [opts.fetchImpl]    测试注入
 * @returns {{base64, mimeType, filename, bytes, shrunk}}
 */
export async function fetchAsUploadPayload(rawUrl, opts = {}) {
    const { normalizeUrl, retries = 2, maxLen = MAX_BASE64_LEN } = opts;
    const doFetch = opts.fetchImpl || ((...a) => globalThis.fetch(...a));

    const url = toAbsoluteUrl(normalizeUrl ? normalizeUrl(rawUrl) : rawUrl);
    if (!url) throw new Error(`无法解析图片地址: ${rawUrl}`);

    const res = await fetchWithRetry(doFetch, url, retries);
    const blob = await res.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());

    let payload = {
        base64: bytesToBase64(bytes),
        mimeType: blob.type || 'image/jpeg',
        shrunk: false,
    };
    if (payload.base64.length > maxLen) payload = await shrink(blob, maxLen);

    const tail = url.split('/').pop().split('?')[0] || 'image.jpg';
    const named = /\.(jpe?g|png|webp)$/i.test(tail) ? tail : `${tail}.jpg`;
    return {
        ...payload,
        filename: payload.shrunk ? named.replace(/\.\w+$/, '.jpg') : named,
        // 注意：是**下载到的原图**大小，不是降质后的。降质与否看 `shrunk`，
        // 实际上传体积看 `base64.length`（与 wavely 原实现一致，别改语义）。
        bytes: blob.size,
    };
}

/**
 * @why 图床偶尔抽风（CDN 抖动 / 防盗链），一张失败就少一张入库图，值得退避重试。
 *      **4xx 不重试**——再试也没用，只是把用户多晾两秒。
 */
async function fetchWithRetry(doFetch, url, retries) {
    for (let attempt = 0; ; attempt++) {
        let res;
        try {
            res = await doFetch(url, { credentials: 'omit' });
        } catch (e) {
            if (attempt < retries) { await sleep(700 * (attempt + 1)); continue; }
            throw new Error(`图片下载失败（${e && e.message}）`);
        }
        if (res.ok) return res;
        if (res.status >= 500 && attempt < retries) { await sleep(700 * (attempt + 1)); continue; }
        throw new Error(`图片下载失败 HTTP ${res.status}`);
    }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
