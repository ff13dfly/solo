/**
 * apps/storage/oss/local-oss-server.js — single-file, disk-backed OSS emulator.
 *
 * @why  Lets the storage service run the SAME OSS code path in dev/test as in
 *       prod: driver-local talks to this server exactly as driver-aliyun talks
 *       to real Aliyun OSS. It is NOT a Solo microservice — it has no Router
 *       auth, no introspection, no services.json entry. Start it from
 *       deploy/dev.sh (like Redis on 6699) or boot it in-process for jest.
 *
 * @model  Objects live at `${root}/${key}` (key opaque, '/'-separated → nested
 *         dirs). The key comes from apps/storage/oss/keying.js, which is
 *         byte-identical to filestore's 2/2/2 layout, so pointing `root` at the
 *         existing uploads/assets dir is a zero-copy cutover. Per-object
 *         content-type/etag live in a sibling `${root}/.meta/<key>.json` so the
 *         object tree itself stays pristine (and `.meta` is skipped by list()).
 *
 * @auth   Two independent grants, mirroring real OSS:
 *           1. SDK calls (driver-local) send `Authorization: Bearer <secret>`.
 *           2. Browser/direct calls use a presigned query (?Expires&Signature),
 *              validated via apps/storage/oss/presign.js (shared canonical).
 *         Unsigned GET is refused unless publicRead=true — so the storage
 *         IDOR hole (B3/SOLO-SEC-004) stays CLOSED by default.
 *
 * @routes (bucket-scoped; key may contain '/')
 *   PUT    /<bucket>/<key>           upload (signed-PUT or Bearer); body = bytes
 *   GET    /<bucket>/<key>           download (?x-oss-process=image/resize,...)
 *   HEAD   /<bucket>/<key>           metadata only
 *   DELETE /<bucket>/<key>           idempotent delete (204 even if absent)
 *   GET    /<bucket>?list&prefix&max&cursor   list objects (Bearer)
 *   POST   /<bucket>?delete          batch delete {keys:[...]} (Bearer)
 *   GET    /                         health probe
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const presign = require('./presign');

let sharp;
try { sharp = require('sharp'); } catch (_) { sharp = null; }

const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp', '.pdf': 'application/pdf', '.json': 'application/json',
    '.txt': 'text/plain', '.csv': 'text/csv', '.mp4': 'video/mp4',
    '.bin': 'application/octet-stream',
};

function mimeFromExt(key) {
    return MIME[path.extname(key).toLowerCase()] || 'application/octet-stream';
}

function ctEqual(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    if (x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
}

/**
 * Resolve an object key to an absolute path inside `root`, or null if the key
 * would escape root (path traversal). Keys legitimately contain '/'.
 */
function safeResolve(root, key) {
    if (!key || key.includes('\0')) return null;
    if (key.split('/').some((s) => s === '..' || s === '')) return null;
    const base = path.resolve(root);
    const resolved = path.resolve(base, key);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    return resolved;
}

/**
 * Parse an Aliyun-style image-process spec and apply it with sharp.
 * @param {Buffer} buf
 * @param {string} spec  the value AFTER 'image/', e.g. 'resize,w_320,m_lfit'
 * @returns {Promise<Buffer>|null} transformed jpeg buffer, or null to fall back
 */
async function applyProcess(buf, spec) {
    if (!sharp || !spec) return null;
    const ops = spec.split(',');
    if (ops[0] !== 'resize') return null; // only resize emulated
    let width, height, mode = 'lfit', quality = 82;
    for (const op of ops.slice(1)) {
        const i = op.indexOf('_');
        const k = i === -1 ? op : op.slice(0, i);
        const v = i === -1 ? '' : op.slice(i + 1);
        if (k === 'w') width = parseInt(v, 10) || undefined;
        else if (k === 'h') height = parseInt(v, 10) || undefined;
        else if (k === 'm') mode = v;
        else if (k === 'q') quality = parseInt(v, 10) || quality;
    }
    if (!width && !height) return null;
    const fitMap = { lfit: 'inside', mfit: 'outside', fill: 'cover', pad: 'contain', fixed: 'fill' };
    return sharp(buf)
        .resize({ width, height, fit: fitMap[mode] || 'inside', withoutEnlargement: mode === 'lfit' })
        .jpeg({ quality })
        .toBuffer();
}

/**
 * @param {object} opts
 * @param {string} opts.root            disk directory backing the bucket
 * @param {string} opts.secret          HMAC/Bearer shared secret
 * @param {string} [opts.bucket='solo']
 * @param {boolean} [opts.publicRead=false]  allow UNSIGNED GET/HEAD
 * @param {string} [opts.bodyLimit='64mb']
 * @param {function} [opts.now]          time source (default Date.now)
 * @param {object} [opts.logger]         optional { info, warn, error }
 * @returns {{ app, listen, close, port }}
 */
function createLocalOssServer(opts = {}) {
    const { root, secret, bucket = 'solo', publicRead = false, bodyLimit = '64mb' } = opts;
    if (!root) throw new Error('[local-oss] root is required');
    if (!secret) throw new Error('[local-oss] secret is required (signed URLs are forgeable without it)');
    const now = opts.now || Date.now;
    const log = opts.logger || { info() {}, warn() {}, error() {} };

    const metaDir = path.join(path.resolve(root), '.meta');
    const metaPath = (key) => path.join(metaDir, `${key}.json`);

    function writeMeta(key, meta) {
        const mp = metaPath(key);
        fs.mkdirSync(path.dirname(mp), { recursive: true });
        fs.writeFileSync(mp, JSON.stringify(meta));
    }
    function readMeta(key) {
        try { return JSON.parse(fs.readFileSync(metaPath(key), 'utf8')); } catch (_) { return null; }
    }

    function listObjects(prefix, max, marker) {
        const baseAbs = path.resolve(root);
        const out = [];
        const walk = (dir) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const e of entries) {
                if (dir === baseAbs && e.name === '.meta') continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { walk(full); continue; }
                const key = path.relative(baseAbs, full).split(path.sep).join('/');
                const st = fs.statSync(full);
                out.push({ key, size: st.size, lastModified: st.mtime.toISOString() });
            }
        };
        walk(baseAbs);
        let filtered = prefix ? out.filter((o) => o.key.startsWith(prefix)) : out;
        filtered.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        if (marker) filtered = filtered.filter((o) => o.key > marker);
        const page = filtered.slice(0, max);
        const nextMarker = filtered.length > max ? page[page.length - 1].key : null;
        return { objects: page, nextMarker };
    }

    const app = express();
    app.use(express.raw({ type: () => true, limit: bodyLimit }));

    app.use(async (req, res) => {
        const url = new URL(req.originalUrl, 'http://local');
        const pathname = decodeURIComponent(url.pathname);

        if (pathname === '/' || pathname === '') {
            return res.status(200).type('text/plain').send('local-oss');
        }

        const segs = pathname.replace(/^\/+/, '').split('/');
        const reqBucket = segs.shift();
        const key = segs.join('/');
        if (reqBucket !== bucket) return sendErr(res, 404, 'NoSuchBucket');

        // --- authorization grants ---
        const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
            || req.headers['x-local-oss-secret'] || '';
        const authed = bearer && ctEqual(bearer, secret);

        const expires = Number(url.searchParams.get('Expires'));
        const signature = url.searchParams.get('Signature');
        const processVal = url.searchParams.get('x-oss-process') || '';
        const checkSigned = (method, contentType) => {
            if (!signature || !expires) return false;
            if (now() > expires * 1000) return false; // expired
            return presign.verify(secret, { method, bucket, key, expires, contentType: contentType || '', process: processVal }, signature);
        };

        // --- bucket-level ops (empty key) ---
        if (!key) {
            if (req.method === 'GET') {
                if (!authed) return sendErr(res, 403, 'AccessDenied');
                const prefix = url.searchParams.get('prefix') || '';
                const max = Math.min(Number(url.searchParams.get('max') || url.searchParams.get('max-keys')) || 200, 1000);
                const marker = url.searchParams.get('cursor') || url.searchParams.get('marker') || '';
                return res.json(listObjects(prefix, max, marker));
            }
            if (req.method === 'POST') {
                if (!authed) return sendErr(res, 403, 'AccessDenied');
                let keys = [];
                try { keys = (JSON.parse((req.body || Buffer.alloc(0)).toString('utf8') || '{}').keys) || []; } catch (_) {}
                const norm = keys.map((k) => (typeof k === 'string' ? k : k && k.name)).filter(Boolean);
                const deleted = [];
                for (const k of norm) {
                    const abs = safeResolve(root, k);
                    if (!abs) continue;
                    try { fs.unlinkSync(abs); } catch (_) {}
                    try { fs.unlinkSync(metaPath(k)); } catch (_) {}
                    deleted.push(k);
                }
                return res.json({ deleted });
            }
            return sendErr(res, 405, 'MethodNotAllowed');
        }

        // --- object-level ops ---
        const abs = safeResolve(root, key);
        if (!abs) return sendErr(res, 400, 'InvalidKey');

        if (req.method === 'PUT') {
            const ct = req.headers['content-type'] || 'application/octet-stream';
            if (!authed && !checkSigned('PUT', ct)) return sendErr(res, 403, 'SignatureDoesNotMatch');
            const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, buf);
            const etag = `"${crypto.createHash('md5').update(buf).digest('hex')}"`;
            writeMeta(key, { contentType: ct, size: buf.length, etag });
            return res.status(200).json({ key, etag, size: buf.length });
        }

        if (req.method === 'HEAD') {
            if (!authed && !checkSigned('GET', '') && !publicRead) return sendErr(res, 403, 'AccessDenied');
            if (!fs.existsSync(abs)) return res.status(404).end();
            const st = fs.statSync(abs);
            const meta = readMeta(key);
            res.setHeader('Content-Length', st.size);
            res.setHeader('Content-Type', (meta && meta.contentType) || mimeFromExt(key));
            res.setHeader('Last-Modified', st.mtime.toUTCString());
            if (meta && meta.etag) res.setHeader('ETag', meta.etag);
            return res.status(200).end();
        }

        if (req.method === 'GET') {
            if (!authed && !checkSigned('GET', '') && !publicRead) return sendErr(res, 403, 'AccessDenied');
            if (!fs.existsSync(abs)) return sendErr(res, 404, 'NoSuchKey');
            let buf = fs.readFileSync(abs);
            const meta = readMeta(key);
            let ct = (meta && meta.contentType) || mimeFromExt(key);
            if (processVal && processVal.startsWith('image/')) {
                try {
                    const out = await applyProcess(buf, processVal.slice('image/'.length));
                    if (out) { buf = out; ct = 'image/jpeg'; }
                } catch (e) { log.warn(`[local-oss] image process failed: ${e.message}`); }
            }
            res.setHeader('Content-Type', ct);
            return res.status(200).end(buf);
        }

        if (req.method === 'DELETE') {
            if (!authed && !checkSigned('DELETE', '')) return sendErr(res, 403, 'AccessDenied');
            try { fs.unlinkSync(abs); } catch (_) {}
            try { fs.unlinkSync(metaPath(key)); } catch (_) {}
            return res.status(204).end();
        }

        return sendErr(res, 405, 'MethodNotAllowed');
    });

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        log.error(`[local-oss] ${err.message}`);
        res.status(500).json({ code: 'InternalError', status: 500, message: err.message });
    });

    let server = null;
    let actualPort = null;

    return {
        app,
        listen(port = opts.port || 8755) {
            return new Promise((resolve, reject) => {
                server = app.listen(port, () => {
                    actualPort = server.address().port;
                    log.info(`[local-oss] listening on ${actualPort} (bucket=${bucket}, root=${root})`);
                    resolve(actualPort);
                });
                server.on('error', reject);
            });
        },
        close() {
            return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
        },
        get port() { return actualPort; },
    };
}

function sendErr(res, status, code) {
    return res.status(status).json({ code, status, message: code });
}

module.exports = { createLocalOssServer };
