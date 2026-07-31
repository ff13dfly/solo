#!/usr/bin/env node
/**
 * deploy/migrate-storage-index.js
 *
 * One-time backfill for storage.asset.list()'s bounded non-admin/no-keyword path and
 * storage.asset.delete()'s O(1) content-hash refcount check. Assets uploaded before
 * these indexes existed only have the legacy global sorted set — list() and delete()
 * transparently fall back to their old (correct, just O(store size)) behavior for
 * anything not yet indexed, so running this is a performance win, not a correctness
 * requirement — but it's the only way non-admin listing and delete's byte-purge check
 * actually get fast on an existing deployment. New assets never need this: upload()
 * maintains all of this going forward. Idempotent — safe to re-run.
 *
 * Usage:
 *   REDIS_URL=redis://localhost:6379 node deploy/migrate-storage-index.js
 */
const { createClient } = require('../api/node_modules/redis');
const storageConfig = require('../api/apps/storage/config');

const REDIS_URL = process.env.REDIS_URL || storageConfig.redisUrl;

async function main() {
    const redis = createClient({ url: REDIS_URL });
    redis.on('error', (e) => console.error('[migrate-storage-index] Redis error:', e.message));
    await redis.connect();

    const R = storageConfig.redis;

    try {
        const ids = await redis.zRange(R.assetIdSortedSet, 0, -1);
        console.log(`[migrate-storage-index] ${ids.length} asset id(s) found in ${R.assetIdSortedSet}`);

        const refcounts = new Map(); // sha256 -> count
        let indexed = 0;

        const CHUNK = 500;
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            const raws = await redis.mGet(chunk.map((id) => `${R.assetPrefix}${id}`));
            const multi = redis.multi();
            let queued = false;

            chunk.forEach((id, j) => {
                const raw = raws[j];
                if (!raw) return; // ghost id (metadata gone but index entry lingered)
                const meta = JSON.parse(raw);
                const createdAtMs = new Date(meta.createdAt).getTime();
                const score = Number.isFinite(createdAtMs) ? createdAtMs : 0;

                if (meta.owner) {
                    multi.zAdd(`${R.assetByOwnerPrefix}${meta.owner}`, { score, value: id });
                    queued = true;
                }
                const vis = meta.visibility || 'internal'; // canRead's own fallback for legacy rows
                if (vis === 'public') {
                    multi.zAdd(R.assetPublicSortedSet, { score, value: id });
                    queued = true;
                } else if (vis === 'internal') {
                    multi.zAdd(R.assetInternalSortedSet, { score, value: id });
                    queued = true;
                }
                if (meta.sha256) refcounts.set(meta.sha256, (refcounts.get(meta.sha256) || 0) + 1);
                indexed++;
            });

            if (queued) await multi.exec();
        }

        const sha256Entries = [...refcounts.entries()];
        for (let i = 0; i < sha256Entries.length; i += CHUNK) {
            const chunk = sha256Entries.slice(i, i + CHUNK);
            const multi = redis.multi();
            for (const [sha256, count] of chunk) multi.set(`${R.sha256RefcountPrefix}${sha256}`, String(count));
            await multi.exec();
        }

        await redis.set(R.assetVisibilityIndexReadyKey, '1');

        console.log(`[migrate-storage-index] Indexed ${indexed} asset(s), ${sha256Entries.length} distinct content hash(es). ` +
            `list() non-admin/no-keyword and delete()'s byte-purge check are now on the fast path.`);
    } finally {
        await redis.quit();
    }
}

main().catch((e) => {
    console.error('[migrate-storage-index] Failed:', e.message);
    process.exit(1);
});
