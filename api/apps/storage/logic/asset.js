const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const jsonrpc = require('../handlers/jsonrpc');
const generator = require('../../../library/generator');
const { createConfig } = require('../../../library/config');
const { applySearch } = require('../../../library/search');
const { createLogger } = require('../../../library/logger');
const { keyFor, thumbKeyFor } = require('../oss/keying');

let sharp;
try { sharp = require('sharp'); } catch (_) { sharp = null; }

/**
 * Asset Business Logic
 * @why Content-Addressable Storage (CAS) with SHA256 deduplication. The bytes
 *      live in an OSS provider (aliyun in prod, the single-file local-oss-server
 *      in dev/test) — this layer never touches disk. Hashing is offloaded to a
 *      Worker pool to keep the event loop responsive; dedup + the asset index
 *      stay in Redis. Object keys come from oss/keying.js (2/2/2 layout, byte
 *      identical to the legacy on-disk paths → zero-copy migration).
 *
 * @param {object} store  the storage provider (see oss/index.js createStorageProvider)
 */
module.exports = (redisClient, config, store) => {
    const logger = createLogger(config.serviceName);

    if (!store) throw jsonrpc.INTERNAL_ERROR('asset logic requires a storage provider (store)');
    if (!config.idLengths || !config.idLengths.asset) {
        throw jsonrpc.MISSING_PARAM('idLengths.asset is not defined in config.js');
    }

    const cfg = createConfig(redisClient, 'storage', config);
    const thumbMode = (config.storage && config.storage.thumbnails && config.storage.thumbnails.mode) || 'off';
    const thumbSizes = (config.thumbnails && config.thumbnails.sizes) || {};

    // --- Worker Pool Initialization (HASH offload) ---
    const CPU_COUNT = os.cpus().length;
    const poolSize = Math.max(2, Math.min(CPU_COUNT - 1, 4)); // Leave at least 1 core for main thread
    const workers = [];
    const queue = [];
    let activeTasks = 0;

    const workerPath = path.join(__dirname, 'worker.js');
    const workersEnabled = fs.existsSync(workerPath);
    let taskCounter = 0;

    function createWorker() {
        if (!workersEnabled) return null;
        const worker = new Worker(workerPath);
        worker.on('error', (err) => logger.error('Worker error:', err));
        worker.on('exit', (code) => {
            if (code !== 0) logger.error(`Worker stopped with exit code ${code}`);

            const idx = workers.indexOf(worker);
            if (idx > -1) workers.splice(idx, 1);
            if (workers.length < poolSize && workersEnabled) workers.push(createWorker());
        });
        return worker;
    }

    if (workersEnabled) {
        for (let i = 0; i < poolSize; i++) {
            workers.push(createWorker());
        }
    } else {
        logger.warn(`[Storage] worker.js not found at ${workerPath}. Thread pool disabled; falling back to main-thread hashing.`);
    }

    async function runTask(type, payload) {
        if (!workersEnabled) {
            // Fallback: synchronous execution in main thread to prevent crash loops
            if (type === 'HASH') {
                const sha256 = crypto.createHash('sha256').update(payload.buffer).digest('hex');
                return { sha256 };
            }
            throw jsonrpc.INTERNAL_ERROR(`Unsupported worker task "${type}" in main-thread fallback`);
        }
        return new Promise((resolve, reject) => {
            const task = { type, payload, resolve, reject };
            queue.push(task);
            processQueue();
        });
    }

    /**
     * @why Each task carries a unique taskId echoed back by the worker.
     *      Without it, two tasks on the same worker both match `msg.type === "HASH_RESULT"`
     *      and the second task resolves with the first task's payload — causing cross-user
     *      SHA256 drift (unrelated assetIds claim the same content bytes). See
     *      issues/issue_20260425/REPORT.md for the 523 cross-user cases this caused in prod.
     */
    function processQueue() {
        if (activeTasks >= workers.length || queue.length === 0) return;

        const task = queue.shift();
        const worker = workers[activeTasks % workers.length]; // Simple distribution
        activeTasks++;
        const taskId = ++taskCounter;
        let settled = false;

        const settle = (fn) => {
            if (settled) return;
            settled = true;
            worker.off('message', onMessage);
            worker.off('error', onError);
            activeTasks--;
            processQueue();
            fn();
        };

        const onMessage = (msg) => {
            if (!msg || msg.taskId !== taskId) return;   // ← ignore other tasks' results
            if (msg.type === `${task.type}_RESULT`) {
                settle(() => task.resolve(msg.payload));
            } else if (msg.type === 'ERROR') {
                settle(() => task.reject(new Error(msg.payload)));
            }
        };

        const onError = (err) => {
            settle(() => task.reject(err));
        };

        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.postMessage({ taskId, type: task.type, payload: task.payload });
    }

    // --- In-Memory LRU Cache for Existence Check ---
    const RECENT_UPLOADS = new Map();
    const MAX_CACHE_SIZE = config.maxCacheSize || 1000;

    function addToCache(id) {
        if (RECENT_UPLOADS.size >= MAX_CACHE_SIZE) {
            const firstKey = RECENT_UPLOADS.keys().next().value;
            RECENT_UPLOADS.delete(firstKey);
        }
        RECENT_UPLOADS.set(id, Date.now());
    }

    // --- Per-asset authorization (toFix §6.4) ---
    // ctx = { user, permit } from the RPC perimeter (index.js). When ctx is
    // undefined the caller is internal (the /file route gate, tests, sibling
    // logic) and enforcement is skipped — the perimeter is where it binds.
    // Legacy assets without a visibility field behave as 'internal'.
    const VISIBILITIES = ['public', 'internal', 'private'];

    function canRead(meta, ctx) {
        if (ctx === undefined) return true;
        if (ctx && ctx.permit === 'admin') return true;
        const vis = meta.visibility || 'internal';
        if (vis === 'public') return true;
        if (vis === 'internal') return !!(ctx && ctx.user);
        return !!(ctx && ctx.user && meta.owner && ctx.user === meta.owner);   // private
    }

    function canDelete(meta, ctx) {
        if (ctx === undefined) return true;
        if (ctx && ctx.permit === 'admin') return true;
        return !!(ctx && ctx.user && meta.owner && ctx.user === meta.owner);
    }

    function assertRead(meta, ctx) {
        if (!canRead(meta, ctx)) throw jsonrpc.FORBIDDEN(`No access to asset (visibility: ${meta.visibility || 'internal'})`);
    }

    // --- URL / key helpers ---
    const extOf = (meta) => path.extname(meta.originalName || '');
    // Back-compat: legacy Redis records have `path` (= the relative object path) but no `key`.
    const objectKeyOf = (meta) => meta.key || meta.path || keyFor(meta.sha256, extOf(meta));
    const isImage = (mt) => (mt || '').startsWith('image/');
    const thumbLabels = () => Object.keys(thumbSizes);

    function thumbnailsMapFor(sha256, mimeType) {
        if (thumbMode !== 'pregenerate' || !isImage(mimeType)) return undefined;
        const map = {};
        for (const label of thumbLabels()) map[label] = store.resolveUrl(thumbKeyFor(sha256, label));
        return map;
    }

    function urlFor(meta, size) {
        if (size && thumbMode === 'pregenerate' && isImage(meta.mimeType) && thumbSizes[size]) {
            return store.resolveUrl(thumbKeyFor(meta.sha256, size));
        }
        return store.resolveUrl(objectKeyOf(meta));
    }

    async function generateThumbnails(buffer, sha256, mimeType) {
        if (thumbMode !== 'pregenerate' || !sharp || !isImage(mimeType)) return;
        const quality = await cfg.get('thumbnails.quality');
        for (const [label, px] of Object.entries(thumbSizes)) {
            try {
                const buf = await sharp(buffer)
                    .resize(px, px, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality })
                    .toBuffer();
                await store.put(thumbKeyFor(sha256, label), buf, { contentType: 'image/jpeg' });
            } catch (e) {
                logger.warn(`[Storage] thumbnail '${label}' failed for ${sha256}: ${e.message}`);
            }
        }
    }

    return {
        /**
         * upload — hash, dedup, persist bytes to the provider, generate thumbnails.
         */
        async upload({ file, filename, mimeType, visibility }, ctx) {
            const buffer = Buffer.from(file, 'base64');

            // toFix §6.4 — ownership + visibility recorded at birth.
            const owner = (ctx && ctx.user) || null;
            const vis = visibility || (config.storage && config.storage.defaultVisibility) || 'internal';
            if (!VISIBILITIES.includes(vis)) {
                throw jsonrpc.INVALID_PARAMS(`visibility must be one of: ${VISIBILITIES.join(', ')}`);
            }

            // 1. Calculate SHA256 in Worker
            const { sha256 } = await runTask('HASH', { buffer });
            const ext = filename ? path.extname(filename) : '';
            const key = keyFor(sha256, ext);

            // 2. Fast dedup via Redis sha256 index (O(1)).
            // Owner-aware (toFix §6.4): the byte-level CAS dedup still applies (same
            // object key), but the metadata record is only reused for the SAME owner —
            // otherwise user B uploading user A's bytes would inherit A's record and
            // visibility. Different owner → fall through and mint a fresh record over
            // the shared bytes (delete's sha256 refcount already handles N records).
            const existingId = await redisClient.get(`${config.redis.sha256Prefix}${sha256}`);
            if (existingId) {
                const raw = await redisClient.get(`${config.redis.assetPrefix}${existingId}`);
                if (raw) {
                    const meta = JSON.parse(raw);
                    if ((meta.owner || null) === owner) {
                        addToCache(sha256);
                        // Heal thumbnails in the background if they might be missing
                        if (thumbMode === 'pregenerate' && isImage(mimeType || meta.mimeType)) {
                            generateThumbnails(buffer, sha256, mimeType || meta.mimeType).catch(() => {});
                        }
                        return { ...meta, url: urlFor(meta), thumbnails: thumbnailsMapFor(meta.sha256, meta.mimeType) };
                    }
                }
            }

            // 3. Persist bytes to the object store (content-addressed key → idempotent)
            if (!(await store.exists(key))) {
                await store.put(key, buffer, { contentType: mimeType || 'application/octet-stream' });
            }
            addToCache(sha256);

            // 4. Pre-generate thumbnails (awaited so the returned URLs resolve immediately)
            await generateThumbnails(buffer, sha256, mimeType);

            // 5. Generate System Asset ID
            let assetId;
            let success = false;
            let attempts = 0;
            const maxAttempts = 10;
            const assetPrefix = config.redis.assetPrefix;

            while (!success && attempts < maxAttempts) {
                assetId = generator.generateId(config.idLengths.asset);
                const result = await redisClient.set(`${assetPrefix}${assetId}`, JSON.stringify({}), { NX: true });
                if (result === 'OK' || result === true) success = true;
                else attempts++;
            }

            if (!success) throw jsonrpc.INTERNAL_ERROR(`Failed to generate unique assetId after ${maxAttempts} attempts`);

            const metadata = {
                id: assetId,
                originalName: filename || 'unnamed',
                mimeType: mimeType || 'application/octet-stream',
                sha256,
                size: buffer.length,
                key,
                path: key, // kept for back-compat with consumers reading `path`
                owner,                 // toFix §6.4 — who uploaded (UID string, null = unowned/legacy)
                visibility: vis,       // 'public' | 'internal' | 'private'
                createdAt: new Date().toISOString()
            };

            // 6. Persist metadata + indexes
            await redisClient.set(`${assetPrefix}${assetId}`, JSON.stringify(metadata));
            await redisClient.zAdd(config.redis.assetIdSortedSet, {
                score: new Date(metadata.createdAt).getTime(),
                value: assetId
            });
            await redisClient.set(`${config.redis.sha256Prefix}${sha256}`, assetId);

            return { ...metadata, url: urlFor(metadata), thumbnails: thumbnailsMapFor(sha256, metadata.mimeType) };
        },

        /**
         * list — keyword (id / originalName / sha256) + pagination.
         */
        async list({ page = 1, pageSize = 20, keyword, offset, limit } = {}, ctx) {
            const effLimit  = limit  ?? pageSize;
            const effOffset = offset ?? (page - 1) * pageSize;
            const kw = (keyword || '').trim();

            const decorate = (meta) => ({ ...meta, url: urlFor(meta), thumbnails: thumbnailsMapFor(meta.sha256, meta.mimeType) });
            // toFix §6.4 — listing shows only what the caller could read anyway.
            const visible = (meta) => canRead(meta, ctx);

            if (!kw && (ctx === undefined || (ctx && ctx.permit === 'admin'))) {
                // Fast path (no row filter needed): admin / internal callers.
                const total = await redisClient.zCard(config.redis.assetIdSortedSet);
                const pageIds = await redisClient.zRange(config.redis.assetIdSortedSet, effOffset, effOffset + effLimit - 1, { REV: true }); // SAFE: small
                const items = (await Promise.all(pageIds.map(async (id) => { // SAFE: small
                    const raw = await redisClient.get(`${config.redis.assetPrefix}${id}`);
                    if (!raw) return null;
                    return decorate(JSON.parse(raw));
                }))).filter(Boolean);
                return { items, total };
            }

            const allIds = await redisClient.zRange(config.redis.assetIdSortedSet, 0, -1, { REV: true }); // SAFE: small
            const allItems = (await Promise.all(allIds.map(async (id) => { // SAFE: small
                const raw = await redisClient.get(`${config.redis.assetPrefix}${id}`);
                if (!raw) return null;
                const meta = JSON.parse(raw);
                return visible(meta) ? decorate(meta) : null;
            }))).filter(Boolean);

            if (!kw) {
                return { items: allItems.slice(effOffset, effOffset + effLimit), total: allItems.length };
            }

            return applySearch(allItems, {
                keyword: kw,
                searchFields: ['id', 'originalName', 'sha256'],
                sortBy: 'createdAt',
                sortDir: 'desc',
                limit: effLimit,
                offset: effOffset,
            });
        },

        /**
         * get — asset metadata by ID.
         */
        async get({ id }, ctx) {
            const data = await redisClient.get(`${config.redis.assetPrefix}${id}`);
            if (!data) throw jsonrpc.ASSET_NOT_FOUND();
            const meta = JSON.parse(data);
            assertRead(meta, ctx);   // toFix §6.4 — visibility/owner gate at the perimeter
            return meta;
        },

        /**
         * resolve — map an asset ID (optionally a thumbnail size) to a public URL.
         */
        async resolve({ id, size }, ctx) {
            const meta = await this.get({ id }, ctx); // validates existence + access
            return { url: urlFor(meta, size) };
        },

        /**
         * delete — remove metadata + index, and the object (incl. thumbnails) when
         *          no other asset record references the same sha256 (CAS refcount).
         */
        async delete({ id }, ctx) {
            const data = await redisClient.get(`${config.redis.assetPrefix}${id}`);
            if (!data) throw jsonrpc.ASSET_NOT_FOUND();
            const meta = JSON.parse(data);

            // toFix §6.4 — delete is owner-or-admin only (visibility never grants delete).
            if (!canDelete(meta, ctx)) throw jsonrpc.FORBIDDEN('Only the owner or an admin can delete this asset');

            await redisClient.del(`${config.redis.assetPrefix}${id}`);
            await redisClient.zRem(config.redis.assetIdSortedSet, id);

            try {
                const remaining = await redisClient.zRange(config.redis.assetIdSortedSet, 0, -1); // SAFE: small
                let refCount = 0;
                for (const aid of remaining) {
                    const raw = await redisClient.get(`${config.redis.assetPrefix}${aid}`);
                    if (!raw) continue;
                    if (JSON.parse(raw).sha256 === meta.sha256) { refCount++; break; }
                }
                if (refCount === 0) {
                    const keys = [objectKeyOf(meta), ...thumbLabels().map((l) => thumbKeyFor(meta.sha256, l))];
                    await store.deleteMany(keys);
                    RECENT_UPLOADS.delete(meta.sha256);
                }
            } catch (e) {
                logger.warn(`[Storage] delete cleanup for ${id} failed: ${e.message}`);
            }

            return { deleted: id };
        },

        /**
         * thumbnailRebuild — regenerate thumbnails for image assets from the stored
         *                    original (read back from the provider).
         */
        async thumbnailRebuild({ force = false, id } = {}) {
            if (!sharp) throw jsonrpc.INTERNAL_ERROR('sharp is not installed on this server');
            if (thumbMode !== 'pregenerate') throw jsonrpc.INTERNAL_ERROR(`thumbnailRebuild requires storage.thumbnails.mode='pregenerate' (current: '${thumbMode}')`);

            const quality = await cfg.get('thumbnails.quality');
            const assetIds = id ? [id] : await redisClient.zRange(config.redis.assetIdSortedSet, 0, -1); // SAFE: small

            let processed = 0, skipped = 0, failed = 0;
            const errors = [];

            for (const assetId of assetIds) {
                const raw = await redisClient.get(`${config.redis.assetPrefix}${assetId}`);
                if (!raw) continue;
                const meta = JSON.parse(raw);
                if (!isImage(meta.mimeType)) { skipped++; continue; }

                let original;
                try {
                    original = (await store.get(objectKeyOf(meta))).content;
                } catch (e) {
                    skipped++;
                    continue;
                }

                let anyGenerated = false;
                for (const [label, px] of Object.entries(thumbSizes)) {
                    const thumbKey = thumbKeyFor(meta.sha256, label);
                    if (!force && await store.exists(thumbKey)) continue;
                    try {
                        const buf = await sharp(original)
                            .resize(px, px, { fit: 'inside', withoutEnlargement: true })
                            .jpeg({ quality })
                            .toBuffer();
                        await store.put(thumbKey, buf, { contentType: 'image/jpeg' });
                        anyGenerated = true;
                    } catch (err) {
                        failed++;
                        errors.push({ id: assetId, size: label, error: err.message });
                    }
                }
                if (anyGenerated) processed++;
                else skipped++;
            }

            return { processed, skipped, failed, total: assetIds.length, errors };
        },

        /**
         * multiResolve — batch resolve asset IDs to URLs.
         */
        async multiResolve({ ids }, ctx) {
            if (!ids || !Array.isArray(ids)) throw jsonrpc.INVALID_PARAM('ids must be an array');

            const results = await Promise.all(ids.map(async (id) => { // SAFE: small
                try {
                    const res = await this.resolve({ id }, ctx);
                    return { id, url: res.url };
                } catch (e) {
                    return { id, url: null, error: e.message };
                }
            }));

            return { items: results };
        }
    };
};
