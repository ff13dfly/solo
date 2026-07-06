/**
 * apps/storage/oss/driver-local.js — storage driver that talks to the
 * single-file local OSS server (local-oss-server.js) over HTTP.
 *
 * @why  Implements the SAME provider interface as driver-aliyun so apps/storage
 *       is byte-identical regardless of vendor. Used for dev/test; the server
 *       it targets is started by deploy/dev.sh or booted in-process by jest.
 *       No ali-oss dependency. SDK-style calls authenticate with a Bearer
 *       secret; presignGet/presignPut mint query-signed URLs the server honors.
 */

const http = require('http');
const https = require('https');
const presign = require('./presign');

function httpRequest(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(u, { method, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function httpStream(urlStr, { method = 'GET', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(u, { method, headers }, (res) => resolve(res));
        req.on('error', reject);
        req.end();
    });
}

function notFound(key) {
    const e = new Error(`NoSuchKey: ${key}`);
    e.code = 'NoSuchKey';
    e.status = 404;
    return e;
}

/**
 * @param {object} cfg
 * @param {string} cfg.endpoint        local-oss-server origin, e.g. http://localhost:8755
 * @param {string} cfg.bucket
 * @param {string} cfg.secret          shared HMAC/Bearer secret
 * @param {string} [cfg.publicBase]    base for publicUrl (default `${endpoint}/${bucket}`)
 * @param {number} [cfg.signedUrlTtl=1800]
 * @param {function} [cfg.now]         time source (default Date.now)
 */
function createLocalDriver(cfg = {}) {
    const { endpoint, bucket, secret } = cfg;
    if (!endpoint) throw new Error('[storage:local] endpoint is required');
    if (!bucket) throw new Error('[storage:local] bucket is required');
    if (!secret) throw new Error('[storage:local] secret is required');
    const ttl = cfg.signedUrlTtl || 1800;
    const now = cfg.now || Date.now;
    const origin = endpoint.replace(/\/$/, '');
    const publicBase = (cfg.publicBase || `${origin}/${bucket}`).replace(/\/$/, '');
    const authHeaders = { Authorization: `Bearer ${secret}` };

    const encKey = (key) => key.split('/').map(encodeURIComponent).join('/');
    const objectUrl = (key) => `${origin}/${bucket}/${encKey(key)}`;
    const procFull = (p) => (p ? `image/${p}` : '');
    const expiryEpoch = (opts) => Math.floor(now() / 1000) + (opts.expires != null ? opts.expires : ttl);

    return {
        async put(key, body, opts = {}) {
            const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
            const r = await httpRequest(objectUrl(key), {
                method: 'PUT',
                headers: {
                    ...authHeaders,
                    'Content-Type': opts.contentType || 'application/octet-stream',
                    'Content-Length': buf.length,
                },
                body: buf,
            });
            if (r.status >= 300) throw new Error(`[storage:local] put ${key} failed: ${r.status} ${r.body.toString()}`);
            let etag;
            try { etag = JSON.parse(r.body.toString()).etag; } catch (_) {}
            return { key, etag, size: buf.length };
        },

        async get(key, opts = {}) {
            const q = opts.process ? `?x-oss-process=${encodeURIComponent(procFull(opts.process))}` : '';
            const r = await httpRequest(objectUrl(key) + q, { headers: authHeaders });
            if (r.status === 404) throw notFound(key);
            if (r.status >= 300) throw new Error(`[storage:local] get ${key} failed: ${r.status}`);
            return { content: r.body, contentType: r.headers['content-type'] };
        },

        async getStream(key, opts = {}) {
            const q = opts.process ? `?x-oss-process=${encodeURIComponent(procFull(opts.process))}` : '';
            const res = await httpStream(objectUrl(key) + q, { headers: authHeaders });
            if (res.statusCode === 404) { res.resume(); throw notFound(key); }
            return { stream: res, contentType: res.headers['content-type'], status: res.statusCode };
        },

        async exists(key) {
            const r = await httpRequest(objectUrl(key), { method: 'HEAD', headers: authHeaders });
            return r.status === 200;
        },

        async head(key) {
            const r = await httpRequest(objectUrl(key), { method: 'HEAD', headers: authHeaders });
            if (r.status !== 200) return null;
            return {
                size: Number(r.headers['content-length']),
                contentType: r.headers['content-type'],
                lastModified: r.headers['last-modified'],
            };
        },

        async delete(key) {
            const r = await httpRequest(objectUrl(key), { method: 'DELETE', headers: authHeaders });
            if (r.status >= 300 && r.status !== 404) throw new Error(`[storage:local] delete ${key} failed: ${r.status}`);
        },

        async deleteMany(keys) {
            const norm = (keys || []).map((k) => (typeof k === 'string' ? k : k && k.name)).filter(Boolean);
            if (!norm.length) return { deleted: [] };
            const body = Buffer.from(JSON.stringify({ keys: norm }));
            const r = await httpRequest(`${origin}/${bucket}?delete`, {
                method: 'POST',
                headers: { ...authHeaders, 'Content-Type': 'application/json', 'Content-Length': body.length },
                body,
            });
            if (r.status >= 300) throw new Error(`[storage:local] deleteMany failed: ${r.status}`);
            let deleted = norm;
            try { deleted = JSON.parse(r.body.toString()).deleted || norm; } catch (_) {}
            return { deleted };
        },

        async list(opts = {}) {
            const params = new URLSearchParams({ list: '1' });
            if (opts.prefix) params.set('prefix', opts.prefix);
            if (opts.max) params.set('max', String(opts.max));
            if (opts.cursor) params.set('cursor', opts.cursor);
            const r = await httpRequest(`${origin}/${bucket}?${params.toString()}`, { headers: authHeaders });
            if (r.status >= 300) throw new Error(`[storage:local] list failed: ${r.status}`);
            const json = JSON.parse(r.body.toString() || '{}');
            return { objects: json.objects || [], cursor: json.nextMarker || undefined };
        },

        presignGet(key, opts = {}) {
            const expires = expiryEpoch(opts);
            const process = procFull(opts.process);
            const signature = presign.sign(secret, { method: 'GET', bucket, key, expires, contentType: '', process });
            let urlStr = `${objectUrl(key)}?Expires=${expires}&Signature=${signature}`;
            if (process) urlStr += `&x-oss-process=${encodeURIComponent(process)}`;
            return urlStr;
        },

        async presignGetAsync(key, opts = {}) {
            return this.presignGet(key, opts);
        },

        presignPut(key, opts = {}) {
            const expires = expiryEpoch(opts);
            const contentType = opts.contentType || '';
            const signature = presign.sign(secret, { method: 'PUT', bucket, key, expires, contentType, process: '' });
            const uploadUrl = `${objectUrl(key)}?Expires=${expires}&Signature=${signature}`;
            return { uploadUrl, key, contentType };
        },

        publicUrl(key, opts = {}) {
            const q = opts.process ? `?x-oss-process=image/${opts.process}` : '';
            return `${publicBase}/${encKey(key)}${q}`;
        },

        capabilities() {
            return { presign: true, imageProcessUrl: true, publicUrl: true, list: true };
        },
    };
}

module.exports = { createLocalDriver };
