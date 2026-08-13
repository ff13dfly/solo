#!/usr/bin/env node
/**
 * deploy/migrate-cursor-index.js
 *
 * One-time backfill for entity.js's cursor pagination (list({cursor})). Entities created
 * before the cursor ZSET existed only have the legacy unordered SET index — list({cursor})
 * refuses to run against them (INVALID_PARAMS, not a silent slow-path fallback) until this
 * has been run once. New entities never need this: create() maintains the ZSET going
 * forward. Idempotent — safe to re-run (zAdd overwrites, SEQ resets to the same count).
 *
 * When you need it: you're adding `limit`/`offset`/`cursor` to an existing `*.list` method
 * (see docs/authoring/service.md §6.5) on a service that already has data in Redis. Run it
 * once per entity, then cursor mode works. Skip it for a brand-new service.
 *
 * `redis` resolves from the project root's node_modules (same as deploy/seed-registry.js);
 * `entity` comes from the Solo-synced api/library/.
 *
 * Usage:
 *   REDIS_URL=redis://localhost:6379 node deploy/migrate-cursor-index.js <serviceName> <entityName> [json]
 *
 * Examples:
 *   node deploy/migrate-cursor-index.js myservice widget
 *   node deploy/migrate-cursor-index.js myservice asset json     # RedisJSON-backed entity
 *
 * serviceName must match config.serviceName (it's the Redis key prefix, uppercased); pass
 * `json` as the third arg only when the entity declares storageType: 'json'. Getting either
 * wrong points the migration at an empty key space and reports "0 id(s) indexed".
 */
const { createClient } = require('redis');
const createEntity = require('../api/library/entity');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

async function main() {
    const [serviceName, entityName, storageTypeArg] = process.argv.slice(2);
    if (!serviceName || !entityName) {
        console.error('Usage: node deploy/migrate-cursor-index.js <serviceName> <entityName> [json]');
        process.exit(1);
    }
    const storageType = storageTypeArg === 'json' ? 'json' : 'string';

    const redis = createClient({ url: REDIS_URL });
    redis.on('error', (e) => console.error('[migrate-cursor-index] Redis error:', e.message));
    await redis.connect();

    try {
        const entity = createEntity(redis, { serviceName, entityName, storageType });
        const { migrated } = await entity.migrateCursorIndex();
        console.log(`[migrate-cursor-index] ${serviceName}:${entityName} — ${migrated} id(s) indexed. list({cursor}) is ready.`);
    } finally {
        await redis.quit();
    }
}

main().catch((e) => {
    console.error('[migrate-cursor-index] Failed:', e.message);
    process.exit(1);
});
