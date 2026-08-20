/**
 * image —— 锁两个跟站点无关、却只存在于一个派生项目里的坑：
 *   ① 分块 base64（一次性 apply 会爆调用栈，报的是 RangeError 不是"图太大"）
 *   ② 超 storage.asset.upload 的 5MB base64 上限时逐级降质
 */
import { bytesToBase64, toAbsoluteUrl, fetchAsUploadPayload, MAX_BASE64_LEN } from '../lib/image.js';

const bytesOf = (n, fill = 65) => new Uint8Array(n).fill(fill);
const res = (bytes, { ok = true, status = 200, type = 'image/jpeg' } = {}) => ({
    ok, status, blob: async () => new Blob([bytes], { type }),
});

describe('bytesToBase64', () => {
    test('与 Buffer 的 base64 逐字节一致', () => {
        const b = new Uint8Array([0, 1, 2, 250, 251, 255, 65, 66]);
        expect(bytesToBase64(b)).toBe(Buffer.from(b).toString('base64'));
    });

    test('🔴 2MB 不爆调用栈（一次性 String.fromCharCode.apply 会 RangeError）', () => {
        const big = bytesOf(2 * 1024 * 1024, 7);
        let out;
        expect(() => { out = bytesToBase64(big); }).not.toThrow();
        expect(out).toBe(Buffer.from(big).toString('base64'));
    });

    test('空数组不炸', () => expect(bytesToBase64(new Uint8Array(0))).toBe(''));
});

describe('toAbsoluteUrl', () => {
    test.each([
        ['//cdn.x/a.jpg', 'https://cdn.x/a.jpg'],
        ['https://cdn.x/a.jpg', 'https://cdn.x/a.jpg'],
        ['data:image/png;base64,AAA', null],     // 别把 data: 塞给上传
        ['', null],
        [null, null],
    ])('%s → %s', (input, want) => expect(toAbsoluteUrl(input)).toBe(want));
});

describe('fetchAsUploadPayload', () => {
    test('产出 upload 直接可用的载荷', async () => {
        const bytes = bytesOf(32);
        const out = await fetchAsUploadPayload('https://cdn.x/pic.jpg', {
            fetchImpl: async () => res(bytes),
        });
        expect(out).toMatchObject({ mimeType: 'image/jpeg', filename: 'pic.jpg', bytes: 32, shrunk: false });
        expect(out.base64).toBe(Buffer.from(bytes).toString('base64'));
    });

    test('normalizeUrl 是站点知识的注入点（kit 里不放第二个站点的正则）', async () => {
        let asked;
        await fetchAsUploadPayload('https://cdn.x/a.jpg_250x250.jpg', {
            normalizeUrl: (u) => u.replace(/(\.jpg)_[^/]*$/, '$1'),
            fetchImpl: async (u) => { asked = u; return res(bytesOf(4)); },
        });
        expect(asked).toBe('https://cdn.x/a.jpg');
    });

    test('无扩展名时补 .jpg', async () => {
        const out = await fetchAsUploadPayload('https://cdn.x/abc?spm=1', { fetchImpl: async () => res(bytesOf(4)) });
        expect(out.filename).toBe('abc.jpg');
    });

    test('5xx 退避重试，4xx 不重试（再试也没用，只是把人多晾两秒）', async () => {
        let n = 0;
        const out = await fetchAsUploadPayload('https://cdn.x/a.jpg', {
            retries: 2,
            fetchImpl: async () => (++n < 3 ? res(null, { ok: false, status: 503 }) : res(bytesOf(4))),
        });
        expect(n).toBe(3);
        expect(out.bytes).toBe(4);

        let m = 0;
        await expect(fetchAsUploadPayload('https://cdn.x/a.jpg', {
            retries: 2,
            fetchImpl: async () => { m++; return res(null, { ok: false, status: 403 }); },
        })).rejects.toThrow(/HTTP 403/);
        expect(m).toBe(1);
    });

    test('超上限触发逐级降质，产出标记 shrunk 且转成 jpg', async () => {
        // OffscreenCanvas / createImageBitmap 在 node 里没有，给最小替身来跑真实的降质循环。
        globalThis.createImageBitmap = async () => ({ width: 1000, height: 800, close() {} });
        globalThis.OffscreenCanvas = class {
            constructor(w, h) { this.w = w; this.h = h; }
            getContext() { return { drawImage() {} }; }
            // 面积越小产出越小：第一档还超限，第二档（scale 1 / q 0.7）过。
            async convertToBlob({ quality }) {
                const size = quality >= 0.85 ? 40 : 8;
                return new Blob([bytesOf(size)], { type: 'image/jpeg' });
            }
        };
        try {
            const out = await fetchAsUploadPayload('https://cdn.x/big.png', {
                maxLen: 20,
                fetchImpl: async () => res(bytesOf(64), { type: 'image/png' }),
            });
            expect(out.shrunk).toBe(true);
            expect(out.mimeType).toBe('image/jpeg');
            expect(out.filename).toBe('big.jpg');       // 降质后扩展名跟着改
            expect(out.base64.length).toBeLessThanOrEqual(20);
        } finally {
            delete globalThis.createImageBitmap;
            delete globalThis.OffscreenCanvas;
        }
    });

    test('上限默认对齐 storage.asset.upload 的 maxLength', () => {
        expect(MAX_BASE64_LEN).toBe(5242880);
    });
});
