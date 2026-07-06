/**
 * apps/storage/oss/driver-aliyun.js — Aliyun OSS driver (ali-oss v6 pass-through).
 *
 * @why  Faithful 1:1 mapping of the provider interface onto the exact ali-oss
 *       surface verified in the qr project (put / get / head / delete /
 *       deleteMulti / list / signatureUrl). secure:true is load-bearing — the
 *       https-only bucket policy rejects http preflight, so signed URLs MUST be
 *       https. ali-oss's signatureUrl is SYNCHRONOUS, which is why presignGet
 *       stays sync (apps/storage builds URLs in tight non-async loops).
 *
 *       ali-oss is an optional dependency: guarded with the same require-or-null
 *       pattern sharp uses (asset.js:14 / worker.js:5). The factory throws a
 *       CLEAR error at construction (not an NPE on first put) when the module or
 *       credentials are missing, so the bundle still boots with provider=local.
 */

let OSS;
try { OSS = require('ali-oss'); } catch (_) { OSS = null; }

/**
 * @param {object} cfg
 * @param {string} cfg.region            e.g. 'oss-cn-hangzhou'
 * @param {string} cfg.bucket
 * @param {string} cfg.accessKeyId
 * @param {string} cfg.accessKeySecret
 * @param {boolean} [cfg.secure=true]
 * @param {string} [cfg.endpoint]        optional custom endpoint (overrides region)
 * @param {string} [cfg.cdnBase]         public/CDN base for publicUrl (no trailing slash)
 * @param {number} [cfg.signedUrlTtl=1800]
 */
function createAliyunDriver(cfg = {}) {
    if (!OSS) {
        throw new Error('[storage:aliyun] ali-oss is not installed — run `npm i ali-oss` or set STORAGE_PROVIDER=local');
    }
    if (!cfg.accessKeyId || !cfg.accessKeySecret || !cfg.bucket) {
        throw new Error('[storage:aliyun] missing credentials (OSS_KEY_ID / OSS_KEY_SECRET / OSS_BUCKET)');
    }
    if (cfg.cdnBase && /\/$/.test(cfg.cdnBase)) {
        throw new Error('[storage:aliyun] cdnBase (OSS_CDN_BASE) must not end with a trailing slash');
    }

    const client = new OSS({
        region: cfg.region,
        accessKeyId: cfg.accessKeyId,
        accessKeySecret: cfg.accessKeySecret,
        bucket: cfg.bucket,
        secure: cfg.secure !== false,
        ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    });

    const ttl = cfg.signedUrlTtl || 1800;
    const cdnBase = (cfg.cdnBase || '').replace(/\/$/, '');
    const procFull = (p) => (p ? `image/${p}` : undefined);

    return {
        async put(key, body, opts = {}) {
            const headers = {};
            if (opts.contentType) headers['Content-Type'] = opts.contentType;
            if (opts.cacheControl) headers['Cache-Control'] = opts.cacheControl;
            const r = await client.put(key, body, { headers, ...(opts.meta ? { meta: opts.meta } : {}) });
            return {
                key: r.name,
                etag: r.res && r.res.headers && r.res.headers.etag,
                size: Buffer.isBuffer(body) ? body.length : undefined,
            };
        },

        async get(key, opts = {}) {
            const r = await client.get(key, opts.process ? { process: procFull(opts.process) } : {});
            return { content: r.content, contentType: r.res && r.res.headers && r.res.headers['content-type'] };
        },

        async getStream(key, opts = {}) {
            const r = await client.getStream(key, opts.process ? { process: procFull(opts.process) } : {});
            return { stream: r.stream, contentType: r.res && r.res.headers && r.res.headers['content-type'] };
        },

        async exists(key) {
            try { await client.head(key); return true; }
            catch (e) { if (e.code === 'NoSuchKey' || e.status === 404) return false; throw e; }
        },

        async head(key) {
            try {
                const r = await client.head(key);
                const h = (r.res && r.res.headers) || {};
                return { size: Number(h['content-length']), contentType: h['content-type'], lastModified: h['last-modified'] };
            } catch (e) {
                if (e.code === 'NoSuchKey' || e.status === 404) return null;
                throw e;
            }
        },

        async delete(key) {
            await client.delete(key);
        },

        async deleteMany(keys) {
            const norm = (keys || []).map((k) => (typeof k === 'string' ? k : k && k.name)).filter(Boolean);
            if (!norm.length) return { deleted: [] };
            await client.deleteMulti(norm, { quiet: true });
            return { deleted: norm };
        },

        async list(opts = {}) {
            const r = await client.list({ prefix: opts.prefix, 'max-keys': opts.max || 200, marker: opts.cursor }, {});
            const objects = (r.objects || []).map((o) => ({ key: o.name, size: o.size, lastModified: o.lastModified }));
            return { objects, cursor: r.nextMarker || undefined };
        },

        presignGet(key, opts = {}) {
            return client.signatureUrl(key, { method: 'GET', expires: opts.expires || ttl, process: procFull(opts.process) });
        },

        async presignGetAsync(key, opts = {}) {
            return client.asyncSignatureUrl(key, { method: 'GET', expires: opts.expires || ttl, process: procFull(opts.process) });
        },

        presignPut(key, opts = {}) {
            const o = { method: 'PUT', expires: opts.expires || ttl };
            if (opts.contentType) o['Content-Type'] = opts.contentType;
            const uploadUrl = client.signatureUrl(key, o);
            return { uploadUrl, key, contentType: opts.contentType };
        },

        publicUrl(key, opts = {}) {
            const base = cdnBase || `https://${cfg.bucket}.${cfg.region}.aliyuncs.com`;
            const q = opts.process ? `?x-oss-process=image/${opts.process}` : '';
            return `${base}/${key}${q}`;
        },

        capabilities() {
            return { presign: true, imageProcessUrl: true, publicUrl: !!cdnBase, list: true };
        },

        _client: client,
    };
}

module.exports = { createAliyunDriver, hasOSS: () => !!OSS };
