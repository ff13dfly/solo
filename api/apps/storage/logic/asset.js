const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const jsonrpc = require('../handlers/jsonrpc');
const generator = require('../../../library/generator');
const { createConfig } = require('../../../library/config');
const { applySearch } = require('../../../library/search');
const { resolvePaging } = require('../../../library/pagination');
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

    // Asset kinds. Absent/'file' = storage owns the bytes (every asset before this
    // existed). 'external' = a placeholder: the box's own service owns the bytes and
    // storage only holds the pointer + the reference identity (assetId), so business
    // entities can keep using assetIds uniformly for files storage never touches.
    // @why not a marker string inside the file content: that is in-band signaling —
    //      any consumer reading bytes without knowing the convention gets a string where
    //      a file should be, and (worse) two placeholders with identical marker text hash
    //      to the same sha256 and collide in the CAS dedup index (see upload step 2).
    //      A metadata field is out-of-band: sha256 stays null, so external assets never
    //      enter the dedup index at all.
    const EXTERNAL_KIND = 'external';

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

    // --- list() helpers ---------------------------------------------------------
    const decorate = (meta) => ({ ...meta, url: urlFor(meta), thumbnails: thumbnailsMapFor(meta.sha256, meta.mimeType) });

    async function mgetMetas(ids) {
        if (!ids.length) return [];
        const raws = await redisClient.mGet(ids.map((id) => `${config.redis.assetPrefix}${id}`));
        return raws.map((raw) => (raw ? JSON.parse(raw) : null));
    }

    async function mgetDecorate(ids) {
        return (await mgetMetas(ids)).map((meta) => (meta ? decorate(meta) : null));
    }

    /**
     * Legacy full-scan path — was list()'s only non-admin/keyword path before the
     * visibility indexes below existed. Kept as the fallback for a deployment that
     * hasn't run deploy/migrate-storage-index.js yet: correct, just O(store size)
     * instead of O(page size).
     */
    async function legacyScanOwnedAndVisible(effOffset, effLimit, ctx) {
        const allIds = await redisClient.zRange(config.redis.assetIdSortedSet, 0, -1, { REV: true }); // SAFE: pre-migration fallback only
        const metas = await mgetMetas(allIds);
        const visibleMetas = metas.filter((meta) => meta && canRead(meta, ctx));
        return {
            items: visibleMetas.slice(effOffset, effOffset + effLimit).map(decorate),
            total: visibleMetas.length
        };
    }

    /**
     * Non-admin, no-keyword list() path.
     *
     * @why canRead is owner-or-visibility gated, and a plain Redis SET/ZSET has no
     *      secondary index on field values — so "which assets can THIS caller see"
     *      historically meant fetching every asset's metadata and checking each one.
     *      Instead, upload() now also indexes each asset into a by-owner ZSET and a
     *      public/internal visibility ZSET (see config.js); ZUNIONSTORE merges exactly
     *      the sets relevant to this ctx (own + public [+ internal if authenticated])
     *      into a throwaway key whose cardinality IS the exact total, then one bounded
     *      ZRANGE gets the page. Total work is now O(page size), not O(store size).
     * @attention Falls back to legacyScanOwnedAndVisible until the migration script has
     *      run (assetVisibilityIndexReadyKey unset) — never returns wrong results for
     *      an unmigrated deployment, just doesn't get the speedup yet.
     */
    async function listOwnedAndVisible(effOffset, effLimit, ctx) {
        const ready = await redisClient.exists(config.redis.assetVisibilityIndexReadyKey);
        if (!ready) return legacyScanOwnedAndVisible(effOffset, effLimit, ctx);

        const keys = [config.redis.assetPublicSortedSet];
        if (ctx && ctx.user) {
            keys.push(config.redis.assetInternalSortedSet, `${config.redis.assetByOwnerPrefix}${ctx.user}`);
        }

        const tmpKey = `STORAGE:ASSETS:TMP:${generator.generateId(12)}`;
        const total = await redisClient.zUnionStore(tmpKey, keys, { AGGREGATE: 'MAX' });
        await redisClient.expire(tmpKey, 30); // safety net if the del in `finally` never runs
        try {
            const pageIds = await redisClient.zRange(tmpKey, '+inf', '-inf', {
                BY: 'SCORE', REV: true, LIMIT: { offset: effOffset, count: effLimit }
            });
            // canRead re-check is defense in depth (query construction already restricts
            // to sets this ctx can see) — cheap, and guards against a future key added
            // to `keys` without updating this filter to match.
            const items = (await mgetDecorate(pageIds)).filter((v) => v && canRead(v, ctx));
            return { items, total };
        } finally {
            await redisClient.del(tmpKey);
        }
    }

    /**
     * Keyword search — id / originalName / sha256, any caller (admin included).
     *
     * @why No secondary index on field VALUES (only on owner/visibility, which are
     *      coarse categories, not arbitrary text) — same limitation library/search.js
     *      documents. This still walks the full sorted set, but in bounded chunks
     *      (one MGET per chunk instead of one GET per asset via Promise.all), so peak
     *      memory and round-trips no longer scale with store size — total work still
     *      does in the worst case (rare/no keyword hits). A real fix needs RediSearch
     *      (api/library/indexer.js already exists, wired only into api/sample/ so far)
     *      — intentionally deferred; see CHANGELOG.
     */
    async function keywordSearch(kw, effOffset, effLimit, ctx) {
        const CHUNK = 200;
        const globalKey = config.redis.assetIdSortedSet;
        const visibleMetas = [];
        let upperBound = '+inf';

        while (true) {
            const chunkIds = await redisClient.zRange(globalKey, upperBound, '-inf', {
                BY: 'SCORE', REV: true, LIMIT: { offset: 0, count: CHUNK }
            });
            if (!chunkIds.length) break;

            const metas = await mgetMetas(chunkIds);
            for (const meta of metas) {
                if (meta && canRead(meta, ctx)) visibleMetas.push(meta);
            }

            if (chunkIds.length < CHUNK) break; // exhausted the set
            const lastScore = await redisClient.zScore(globalKey, chunkIds[chunkIds.length - 1]);
            upperBound = `(${lastScore}`;
        }

        const { items, total } = applySearch(visibleMetas, {
            keyword: kw,
            searchFields: ['id', 'originalName', 'sha256'],
            sortBy: 'createdAt',
            sortDir: 'desc',
            limit: effLimit,
            offset: effOffset,
        });
        return { items: items.map(decorate), total };
    }

    // --- URL / key helpers ---
    const extOf = (meta) => path.extname(meta.originalName || '');
    // Back-compat: legacy Redis records have `path` (= the relative object path) but no `key`.
    const objectKeyOf = (meta) => meta.key || meta.path || keyFor(meta.sha256, extOf(meta));
    const isImage = (mt) => (mt || '').startsWith('image/');
    const thumbLabels = () => Object.keys(thumbSizes);

    function thumbnailsMapFor(sha256, mimeType) {
        if (!sha256) return undefined;   // external placeholder — no bytes, no derivatives
        if (thumbMode !== 'pregenerate' || !isImage(mimeType)) return undefined;
        const map = {};
        for (const label of thumbLabels()) map[label] = store.resolveUrl(thumbKeyFor(sha256, label));
        return map;
    }

    function urlFor(meta, size) {
        // External placeholder: storage holds no bytes for this asset, only a pointer to
        // the service that does. Resolution is the ONLY thing storage contributes — it
        // never proxies the payload (that is the entire point: a large file must not flow
        // through the JSON-RPC plane). No thumbnails either; there is nothing to derive
        // them from, so a size hint is ignored rather than answered with a broken URL.
        if (meta.kind === EXTERNAL_KIND) return meta.externalUrl || null;
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
            const createdAtMs = new Date(metadata.createdAt).getTime();
            await redisClient.zAdd(config.redis.assetIdSortedSet, { score: createdAtMs, value: assetId });
            await redisClient.set(`${config.redis.sha256Prefix}${sha256}`, assetId);

            // Visibility-scoped indexes (list()'s fast path below) — maintained
            // unconditionally for every new upload; legacy assets get these via
            // deploy/migrate-storage-index.js.
            if (owner) {
                await redisClient.zAdd(`${config.redis.assetByOwnerPrefix}${owner}`, { score: createdAtMs, value: assetId });
            }
            if (vis === 'public') {
                await redisClient.zAdd(config.redis.assetPublicSortedSet, { score: createdAtMs, value: assetId });
            } else if (vis === 'internal') {
                await redisClient.zAdd(config.redis.assetInternalSortedSet, { score: createdAtMs, value: assetId });
            }
            // Content-hash refcount — delete()'s O(1) "can I purge the bytes" check.
            await redisClient.incr(`${config.redis.sha256RefcountPrefix}${sha256}`);

            return { ...metadata, url: urlFor(metadata), thumbnails: thumbnailsMapFor(sha256, metadata.mimeType) };
        },

        /**
         * list — keyword (id / originalName / sha256) + pagination. See the
         * keywordSearch / listOwnedAndVisible helpers above for the per-path why.
         */
        async list(params = {}, ctx) {
            // Both paging dialects, via the shared normalizer (this method hand-rolled the
            // same ?? fallback before library/pagination.js existed).
            const { limit: effLimit, offset: effOffset } = resolvePaging(params, { defaultLimit: 20 });
            const kw = (params.keyword || '').trim();
            const isAdmin = ctx === undefined || (ctx && ctx.permit === 'admin');

            if (kw) {
                return keywordSearch(kw, effOffset, effLimit, ctx);
            }

            if (isAdmin) {
                // Fast path: admin / internal callers, bounded by-rank read.
                const total = await redisClient.zCard(config.redis.assetIdSortedSet);
                const pageIds = await redisClient.zRange(config.redis.assetIdSortedSet, effOffset, effOffset + effLimit - 1, { REV: true });
                const items = (await mgetDecorate(pageIds)).filter(Boolean);
                return { items, total };
            }

            return listOwnedAndVisible(effOffset, effLimit, ctx);
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
        /**
         * external — register a placeholder for a file this storage does NOT hold.
         *
         * @why Large files (video, archives, dumps) cannot go through storage.asset.upload:
         *      it takes base64 over JSON-RPC through the Router (declared cap ~3.7MB binary,
         *      a 10s forward timeout, and the payload sits in memory three times over).
         *      Chunked/resumable upload is deliberately NOT in the frame — the requirements
         *      differ too much per box. Instead the box serves its own bytes and registers
         *      the pointer here, so the file still has an assetId and business entities keep
         *      referencing files uniformly (assetIds) whether or not storage holds them.
         * @attention What storage stops guaranteeing for these assets — state it, don't
         *      discover it:
         *   1. **Access control is the downstream service's job.** `visibility` still gates
         *      the RPC (who may resolve the pointer), but once the URL is out, storage does
         *      not sit on the byte path and cannot enforce anything. Handing a `public`
         *      external asset to a caller is handing out whatever that URL serves. This is
         *      the same two-layer trap docs/feedback/done/storage-visibility-semantics.md
         *      documented for the byte plane — here it is total, not partial.
         *   2. **`size` is declared, never verified.** Storage never sees the bytes; the
         *      value is whatever the registrant claimed. Do not bill or quota on it.
         *   3. **No sha256, therefore no dedup and no content identity.** Two registrations
         *      of the same underlying file are two assets.
         *   4. **No thumbnails / image processing** — nothing to derive them from.
         *   5. **The pointer can dangle.** If the box deletes its copy, this record still
         *      resolves to a dead URL. Storage cannot detect it; the owner must keep both
         *      sides in step (delete the asset when deleting the file).
         */
        async external({ url, filename, mimeType, size, visibility }, ctx) {
            if (!url || typeof url !== 'string') throw jsonrpc.INVALID_PARAM('url is required');
            // Only http(s): a pointer is handed to browsers and other clients, so file://
            // and friends are both useless and a small SSRF-shaped foot-gun.
            if (!/^https?:\/\//i.test(url)) throw jsonrpc.INVALID_PARAM('url must be http(s)');

            const owner = (ctx && ctx.user) || null;
            // Same normalization + validation as upload() (asset.js upload step 1).
            const vis = visibility || (config.storage && config.storage.defaultVisibility) || 'internal';
            if (!VISIBILITIES.includes(vis)) {
                throw jsonrpc.INVALID_PARAMS(`visibility must be one of: ${VISIBILITIES.join(', ')}`);
            }

            let assetId;
            let success = false;
            let attempts = 0;
            const assetPrefix = config.redis.assetPrefix;
            while (!success && attempts < 10) {
                assetId = generator.generateId(config.idLengths.asset);
                const r = await redisClient.set(`${assetPrefix}${assetId}`, JSON.stringify({}), { NX: true });
                if (r === 'OK' || r === true) success = true; else attempts++;
            }
            if (!success) throw jsonrpc.INTERNAL_ERROR('Failed to generate unique assetId after 10 attempts');

            const metadata = {
                id: assetId,
                kind: EXTERNAL_KIND,
                externalUrl: url,
                originalName: filename || 'unnamed',
                mimeType: mimeType || 'application/octet-stream',
                // sha256/key/path stay null: no bytes ⇒ never joins the CAS dedup index,
                // never gets a refcount, and delete() must not try to purge an object.
                sha256: null,
                size: Number.isFinite(size) ? size : null,
                sizeVerified: false,
                key: null,
                path: null,
                owner,
                visibility: vis,
                createdAt: new Date().toISOString()
            };

            await redisClient.set(`${assetPrefix}${assetId}`, JSON.stringify(metadata));
            const createdAtMs = new Date(metadata.createdAt).getTime();
            await redisClient.zAdd(config.redis.assetIdSortedSet, { score: createdAtMs, value: assetId });
            if (owner) await redisClient.zAdd(`${config.redis.assetByOwnerPrefix}${owner}`, { score: createdAtMs, value: assetId });
            if (vis === 'public') await redisClient.zAdd(config.redis.assetPublicSortedSet, { score: createdAtMs, value: assetId });
            else if (vis === 'internal') await redisClient.zAdd(config.redis.assetInternalSortedSet, { score: createdAtMs, value: assetId });

            return { ...metadata, url: urlFor(metadata) };
        },

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
            if (meta.owner) await redisClient.zRem(`${config.redis.assetByOwnerPrefix}${meta.owner}`, id);
            if (meta.visibility === 'public') await redisClient.zRem(config.redis.assetPublicSortedSet, id);
            else if (meta.visibility === 'internal') await redisClient.zRem(config.redis.assetInternalSortedSet, id);

            // External placeholder: storage never held bytes for it, so there is no object
            // to purge and no refcount to decrement. Touching either would be wrong —
            // sha256 is null, so the key would be `...REFCOUNT:null` (a shared bucket every
            // external asset would fight over) and the pre-migration fallback below would
            // full-scan for `m.sha256 === null` and happily "purge" on the first match.
            if (meta.kind === EXTERNAL_KIND) return { deleted: id };

            try {
                const refcountKey = `${config.redis.sha256RefcountPrefix}${meta.sha256}`;
                let purge;
                if (await redisClient.exists(refcountKey)) {
                    // Fast path: O(1). Every asset created after this fix incremented this
                    // counter at upload time; deploy/migrate-storage-index.js backfills it
                    // for content that predates the counter.
                    purge = (await redisClient.decr(refcountKey)) <= 0;
                    if (purge) await redisClient.del(refcountKey);
                } else {
                    // No counter for this hash yet (pre-migration content) — fall back to
                    // the full scan rather than assume refcount 0, which could delete bytes
                    // another asset record still references.
                    const remaining = await redisClient.zRange(config.redis.assetIdSortedSet, 0, -1); // SAFE: pre-migration fallback only
                    const metas = await mgetMetas(remaining);
                    purge = !metas.some((m) => m && m.sha256 === meta.sha256);
                }
                if (purge) {
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
                // External placeholders have no stored original to read back from — an
                // image/* mimeType would otherwise send this into the provider for bytes
                // that were never there.
                if (meta.kind === EXTERNAL_KIND) { skipped++; continue; }

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
