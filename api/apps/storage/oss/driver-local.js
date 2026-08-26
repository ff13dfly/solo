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

/**
 * Wrap a transport-level failure so the target is never lost.
 * @why A refused connection to a DUAL-STACK hostname gives Node's happy-eyeballs
 *      an AggregateError whose `message` is the empty string (the per-address
 *      messages hide in `.errors[]`). Callers then see {code:'ECONNREFUSED',
 *      message:''} — no host, no port, nothing to grep for. Cost us a multi-round
 *      hunt: docs/feedback/done/storage-local-oss-server-never-started.md §三.2.
 */
function transportError(e, method, urlStr) {
    const detail = (e && Array.isArray(e.errors) && e.errors.length)
        ? e.errors.map((x) => x && x.message).filter(Boolean).join('; ')
        : (e && e.message);
    const err = new Error(`[storage:local] ${method} ${urlStr} failed: ${detail || (e && e.code) || 'unknown transport error'}`);
    if (e && e.code) err.code = e.code;
    err.cause = e;
    return err;
}

function httpRequest(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(u, { method, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', (e) => reject(transportError(e, method, urlStr)));
        if (body) req.write(body);
        req.end();
    });
}

function httpStream(urlStr, { method = 'GET', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(u, { method, headers }, (res) => resolve(res));
        req.on('error', (e) => reject(transportError(e, method, urlStr)));
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
 * @param {string} cfg.endpoint        local-oss-server origin, e.g. http://127.0.0.1:8750/_oss
 *                                     — how THIS PROCESS reaches the object store (put/get/
 *                                     head/delete/list all dial it). Loopback is correct here.
 * @param {string} cfg.bucket
 * @param {string} cfg.secret          shared HMAC/Bearer secret
 * @param {string} [cfg.outwardOrigin] scheme+host(+mount) OTHERS should use to reach the
 *                                     store (public URL of a reverse proxy mapping to
 *                                     `endpoint`). Swapped into every URL handed out —
 *                                     presignGet/presignPut and the publicBase default —
 *                                     while self-access keeps dialing `endpoint`. Safe to
 *                                     swap: the presign canonical string (presign.js) is
 *                                     `METHOD\n/{bucket}/{key}\n…` — it contains NO host,
 *                                     so signatures verify unchanged behind any hostname.
 *                                     Without it, private-mode signed URLs point at
 *                                     `endpoint` (loopback) and are dead for any browser
 *                                     on another machine.
 *                                     (docs/feedback/done/local-oss-outward-base-only-covers-public-access.md)
 * @param {string} [cfg.publicBase]    FULL base for publicUrl, bucket segment included
 *                                     (default `${outwardOrigin || endpoint}/${bucket}`).
 *                                     public-mode only; private-mode URLs never read it —
 *                                     that is what outwardOrigin is for.
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
    // Two audiences, two origins: `origin` is how this process reaches the store;
    // `outwardOrigin` is how it tells everyone else to. They only coincide on a
    // single-machine deploy, which is why defaulting outward to `origin` is a
    // fallback, not the design.
    const outwardOrigin = cfg.outwardOrigin ? String(cfg.outwardOrigin).replace(/\/$/, '') : null;
    const publicBase = (cfg.publicBase || `${outwardOrigin || origin}/${bucket}`).replace(/\/$/, '');
    const authHeaders = { Authorization: `Bearer ${secret}` };

    const encKey = (key) => key.split('/').map(encodeURIComponent).join('/');
    const objectUrl = (key) => `${origin}/${bucket}/${encKey(key)}`;
    // URLs handed to callers (presign GET/PUT). Path shape stays `/{bucket}/{key}` so the
    // server-side verifier parses the same canonical string regardless of which host the
    // request arrived through.
    const outwardUrl = (key) => `${outwardOrigin || origin}/${bucket}/${encKey(key)}`;
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
            let urlStr = `${outwardUrl(key)}?Expires=${expires}&Signature=${signature}`;
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
            const uploadUrl = `${outwardUrl(key)}?Expires=${expires}&Signature=${signature}`;
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
