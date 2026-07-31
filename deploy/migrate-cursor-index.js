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
 * Usage:
 *   REDIS_URL=redis://localhost:6379 node deploy/migrate-cursor-index.js <serviceName> <entityName> [json]
 *
 * Examples:
 *   node deploy/migrate-cursor-index.js commodity product
 *   node deploy/migrate-cursor-index.js storage asset json     # RedisJSON-backed entity
 */
const { createClient } = require('../api/node_modules/redis');
const createEntity = require('../api/library/entity');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6699';

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
