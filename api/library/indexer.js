/**
 * library/indexer.js — Unified RediSearch Index Manager
 *
 * Provides a declarative, config-driven approach to RediSearch index management.
 * Each microservice declares its index schemas either:
 *   1. In Redis (SYSTEM:INDEX_SCHEMA:{serviceName}) — editable via Portal UI
 *   2. In local config (config.indexes) — hardcoded fallback
 *
 * Priority: Redis config > local config
 *
 * Usage:
 *   const { createIndexer } = require('../../library/indexer');
 *   const indexer = createIndexer(redisClient, config.serviceName, config.indexes);
 *   await indexer.ensureAll();               // startup: build all indexes
 *   await indexer.rebuild();                 // RPC: drop + recreate all
 *   await indexer.rebuild('product');        // RPC: drop + recreate one
 *   const schemas = await indexer.schemas(); // RPC: return current schemas
 */

const REDIS_KEY_PREFIX = 'SYSTEM:INDEX_SCHEMA:';

/**
 * Load index definitions: Redis override > local fallback.
 *
 * @param {object} redis       — connected redis client
 * @param {string} serviceName — e.g. 'commodity'
 * @param {object} localDefs   — local fallback { entityName: { name, prefix, schema } }
 * @returns {object} merged index definitions
 */
async function loadSchemas(redis, serviceName, localDefs) {
    const key = `${REDIS_KEY_PREFIX}${serviceName}`;
    try {
        const raw = await redis.get(key);
        if (raw) {
            const remote = JSON.parse(raw);
            // Merge: remote overrides local per-entity, local fills gaps
            return { ...localDefs, ...remote };
        }
    } catch (_) {
        // Redis read failure or parse error — fall through to local
    }
    return { ...localDefs };
}

/**
 * Save index definitions to Redis (for Portal UI edits).
 *
 * @param {object} redis
 * @param {string} serviceName
 * @param {object} schemas — { entityName: { name, prefix, schema } }
 */
async function saveSchemas(redis, serviceName, schemas) {
    const key = `${REDIS_KEY_PREFIX}${serviceName}`;
    await redis.set(key, JSON.stringify(schemas));
}

/**
 * Create a RediSearch index only if it does not already exist.
 * Used by ensureAll() on startup — avoids rebuild windows on every restart.
 *
 * @param {object} redis
 * @param {object} def — { name, prefix, schema }
 */
async function createIfMissing(redis, def) {
    if (!def || !def.name || !def.prefix || !def.schema) {
        throw new Error(`Invalid index definition: missing name, prefix, or schema`);
    }
    try {
        await redis.sendCommand([
            'FT.CREATE', def.name,
            'ON', 'JSON',
            'PREFIX', '1', def.prefix,
            'SCHEMA',
            ...def.schema,
        ]);
    } catch (e) {
        if (e.message && e.message.includes('Index already exists')) return;
        throw e;
    }
}

/**
 * Drop then recreate a single RediSearch index.
 * Used by rebuild() RPC — intentionally destructive.
 *
 * @param {object} redis
 * @param {object} def — { name, prefix, schema }
 */
async function buildIndex(redis, def) {
    if (!def || !def.name || !def.prefix || !def.schema) {
        throw new Error(`Invalid index definition: missing name, prefix, or schema`);
    }

    try {
        await redis.sendCommand(['FT.DROPINDEX', def.name]);
    } catch (_) { /* not found, ok */ }

    await redis.sendCommand([
        'FT.CREATE', def.name,
        'ON', 'JSON',
        'PREFIX', '1', def.prefix,
        'SCHEMA',
        ...def.schema,
    ]);
}

/**
 * Create an indexer instance for a microservice.
 *
 * @param {object} redis        — connected redis client
 * @param {string} serviceName  — e.g. 'commodity', 'crm', 'sale'
 * @param {object} [localDefs]  — local fallback index definitions from config.js
 *   Format: {
 *     entityName: {
 *       name: 'idx:service_entity',     // RediSearch index name
 *       prefix: 'SERVICE:ENTITY:',      // Redis key prefix to index
 *       schema: ['$.field', 'AS', 'alias', 'TAG', ...]  // FT.CREATE SCHEMA args
 *     }
 *   }
 * @returns {object} indexer API
 */
function createIndexer(redis, serviceName, localDefs = {}) {

    /**
     * Resolve the effective schemas (Redis override > local fallback).
     * @returns {object} { entityName: { name, prefix, schema } }
     */
    async function schemas() {
        return loadSchemas(redis, serviceName, localDefs);
    }

    /**
     * Ensure all indexes exist. Safe to call on every startup.
     * Creates indexes that are missing; skips those that already exist.
     * Sets global RediSearch config (MAXSEARCHRESULTS) before building.
     */
    async function ensureAll() {
        await redis.sendCommand(['FT.CONFIG', 'SET', 'MAXSEARCHRESULTS', '-1']);

        const defs = await schemas();
        for (const [, def] of Object.entries(defs)) {
            await createIfMissing(redis, def);
        }
    }

    /**
     * Rebuild one or all indexes (drop + recreate).
     * @param {string} [entityName] — if omitted, rebuilds all
     * @returns {{ rebuilt: string[] }} — list of rebuilt index names
     */
    async function rebuild(entityName) {
        await redis.sendCommand(['FT.CONFIG', 'SET', 'MAXSEARCHRESULTS', '-1']);

        const defs = await schemas();
        const rebuilt = [];

        if (entityName) {
            const def = defs[entityName];
            if (!def) {
                throw { code: -32602, message: `Unknown index entity: ${entityName}` };
            }
            await buildIndex(redis, def);
            rebuilt.push(def.name);
        } else {
            for (const [, def] of Object.entries(defs)) {
                await buildIndex(redis, def);
                rebuilt.push(def.name);
            }
        }

        return { rebuilt };
    }

    /**
     * Persist schema definitions to Redis (for Portal UI edits).
     * @param {object} newSchemas — full or partial schema overrides
     */
    async function updateSchemas(newSchemas) {
        const current = await schemas();
        const merged = { ...current, ...newSchemas };
        await saveSchemas(redis, serviceName, merged);
        return merged;
    }

    return {
        schemas,
        ensureAll,
        rebuild,
        updateSchemas,
    };
}

module.exports = { createIndexer };
