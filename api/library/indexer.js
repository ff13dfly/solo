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
 *
 * 🔴 CJK (Chinese/Japanese/Korean) data — read this before declaring a TEXT field:
 *   RediSearch's default tokenizer splits on whitespace and punctuation, so a Chinese
 *   product name is ONE token: `@name:收纳` against a default TEXT field returns 0 rows.
 *   Declare `language: 'chinese'` on the index def (see createIndexer's localDefs format)
 *   to get the CJK tokenizer. The alternative some reach for — `TAG WITHSUFFIXTRIE`
 *   queried as `@name:{*词*}` — is a wildcard query bounded by MAXPREFIXEXPANSIONS and
 *   TRUNCATES SILENTLY past it; see the constant below.
 */

const { intFromEnv } = require('./env');

const REDIS_KEY_PREFIX = 'SYSTEM:INDEX_SCHEMA:';

/**
 * RediSearch global limits. These are two DIFFERENT walls and solving only one is worse
 * than solving neither — callers assume the framework handles this class of limit:
 *
 *   MAXSEARCHRESULTS     how many rows a query may RETURN          (set to -1 = unlimited)
 *   MAXPREFIXEXPANSIONS  how many distinct terms a wildcard/prefix/suffix query may EXPAND
 *
 * The default MAXPREFIXEXPANSIONS is 200, and exceeding it is SILENT: the query succeeds
 * and returns a truncated count with no error and no warning. Measured on 5,860 synthetic
 * CJK product names (redis-stack 7.4.0-v8, search 21020): `@name:{*收纳*}` over a
 * `TAG WITHSUFFIXTRIE` field returned 200 of 2,000 matches (10.0%) at the default and
 * 2,000 of 2,000 once raised. The failure scales with how many DISTINCT terms match, so
 * rare words stay correct while common ones silently lose rows — i.e. it looks perfect in
 * development and degrades exactly as the data grows.
 *
 * Range is >= 1 (both 0 and -1 are rejected with "Value is outside acceptable bounds",
 * so the -1 = unlimited convention of MAXSEARCHRESULTS does NOT apply here).
 */
const MAXPREFIXEXPANSIONS_DEFAULT = 200000;

function maxPrefixExpansions() {
    const v = intFromEnv('REDISEARCH_MAXPREFIXEXPANSIONS', MAXPREFIXEXPANSIONS_DEFAULT);
    if (v < 1) {
        console.warn(`[indexer] REDISEARCH_MAXPREFIXEXPANSIONS=${v} 不在合法范围 (>= 1)，`
            + `已忽略，仍用默认值 ${MAXPREFIXEXPANSIONS_DEFAULT}`);
        return MAXPREFIXEXPANSIONS_DEFAULT;
    }
    return v;
}

/**
 * Apply the global RediSearch limits. Called before building indexes.
 * @param {object} redis
 */
async function applyGlobalLimits(redis) {
    await redis.sendCommand(['FT.CONFIG', 'SET', 'MAXSEARCHRESULTS', '-1']);
    await redis.sendCommand(['FT.CONFIG', 'SET', 'MAXPREFIXEXPANSIONS', String(maxPrefixExpansions())]);
}

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
 * Assemble the FT.CREATE command for one index definition.
 *
 * @attention `LANGUAGE` must sit BEFORE the `SCHEMA` keyword — RediSearch parses
 *      everything after `SCHEMA` as field definitions, so a language injected through
 *      def.schema can never be valid. That ordering is the whole reason this lives in
 *      one helper instead of being inlined at both call sites.
 *
 * @param {object} def — { name, prefix, schema, language? }
 * @returns {string[]} argv for redis.sendCommand
 */
function buildCreateCommand(def) {
    return [
        'FT.CREATE', def.name,
        'ON', 'JSON',
        'PREFIX', '1', def.prefix,
        ...(def.language ? ['LANGUAGE', def.language] : []),
        'SCHEMA',
        ...def.schema,
    ];
}

/**
 * Create a RediSearch index only if it does not already exist.
 * Used by ensureAll() on startup — avoids rebuild windows on every restart.
 *
 * @attention An index that already exists is left ALONE — editing `language` (or any
 *      schema field) in config and restarting therefore changes nothing. Call
 *      `rebuild(entityName)` to actually apply it. This is pre-existing behaviour, but it
 *      bites hardest with `language`, whose symptom is silently wrong search results
 *      rather than an error.
 *
 * @param {object} redis
 * @param {object} def — { name, prefix, schema, language? }
 */
async function createIfMissing(redis, def) {
    if (!def || !def.name || !def.prefix || !def.schema) {
        throw new Error(`Invalid index definition: missing name, prefix, or schema`);
    }
    try {
        await redis.sendCommand(buildCreateCommand(def));
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
 * @param {object} def — { name, prefix, schema, language? }
 */
async function buildIndex(redis, def) {
    if (!def || !def.name || !def.prefix || !def.schema) {
        throw new Error(`Invalid index definition: missing name, prefix, or schema`);
    }

    try {
        await redis.sendCommand(['FT.DROPINDEX', def.name]);
    } catch (_) { /* not found, ok */ }

    await redis.sendCommand(buildCreateCommand(def));
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
 *       schema: ['$.field', 'AS', 'alias', 'TAG', ...],  // FT.CREATE SCHEMA args
 *       language: 'chinese'             // optional — FT.CREATE LANGUAGE, see below
 *     }
 *   }
 *
 *   `language` selects the tokenizer for TEXT fields in this index. Omit it for
 *   whitespace-delimited data (the default, unchanged). Set `'chinese'` for CJK text —
 *   without it a TEXT field over Chinese content matches nothing, because the whole
 *   string is one token. Measured on 5,860 synthetic CJK product names: `@name:收纳`
 *   returned 0 rows against a default TEXT field and 2,000 of 2,000 with
 *   `language: 'chinese'`.
 *
 *   ⚠️ CJK tokenization splits on word boundaries, so a query term that is a PREFIX of
 *   the indexed word is a different token: in the same run `@name:不锈钢` found 862 of
 *   1,307 (66%) because names like "不锈钢锅" tokenize as one word. Where substring
 *   recall must be exact, pair it with a TAG field (and see MAXPREFIXEXPANSIONS above).
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
     * Sets global RediSearch config (MAXSEARCHRESULTS + MAXPREFIXEXPANSIONS) before building.
     */
    async function ensureAll() {
        await applyGlobalLimits(redis);

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
        await applyGlobalLimits(redis);

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

// buildCreateCommand / maxPrefixExpansions are exported for unit tests — the FT.CREATE
// argument ORDER (LANGUAGE before SCHEMA) and the MAXPREFIXEXPANSIONS bound are exactly
// the kind of thing that breaks silently, so they get asserted directly.
module.exports = { createIndexer, buildCreateCommand, maxPrefixExpansions };
