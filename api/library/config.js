/**
 * library/config.js — Unified Runtime Config Manager
 *
 * Provides a declarative, Redis-backed approach to microservice configuration.
 * Each microservice declares its local defaults from config.js, then reads
 * effective values with the following priority chain:
 *
 *   Redis (config:{serviceName}) > config.js defaults
 *
 * Redis values are stored as strings; type casting is automatic based on
 * the type of the local default value.
 *
 * Usage:
 *   const { createConfig } = require('../../library/config');
 *   const cfg = createConfig(redisClient, config.serviceName, config);
 *
 *   // Read a single value (with fallback to local default)
 *   const enabled = await cfg.get('thumbnails.enabled');
 *
 *   // Read multiple values at once
 *   const { 'thumbnails.enabled': enabled, 'maxCacheSize': size } = await cfg.getMany([
 *       'thumbnails.enabled',
 *       'maxCacheSize',
 *   ]);
 *
 *   // List all Redis overrides for this service (for portal/system UI)
 *   const overrides = await cfg.overrides();
 *
 * RPC handlers (administrator service):
 *   cfg.set(key, value)   — write override to Redis
 *   cfg.del(key)          — remove override (reverts to local default)
 *   cfg.overrides()       — list all active overrides
 */

const REDIS_KEY_PREFIX = 'config:';

/**
 * Cast a Redis string value to the type of the local default.
 *
 * @param {string} val        — raw string from Redis
 * @param {*}      defaultVal — local default (used to determine target type)
 * @returns {boolean|number|string}
 */
function cast(val, defaultVal) {
    if (typeof defaultVal === 'boolean') return val === 'true';
    if (typeof defaultVal === 'number')  return Number(val);
    return val;
}

/**
 * Resolve a dot-path key against a nested object.
 * e.g. getPath(config, 'thumbnails.enabled') → config.thumbnails.enabled
 *
 * @param {object} obj
 * @param {string} dotPath
 * @returns {*} the value, or undefined if not found
 */
function getPath(obj, dotPath) {
    return dotPath.split('.').reduce((cur, part) => cur?.[part], obj);
}

/**
 * Create a config manager instance for a microservice.
 *
 * @param {object} redis        — connected redis client
 * @param {string} serviceName  — e.g. 'storage', 'commodity'
 * @param {object} localConfig  — the service's full config.js export (for default values)
 * @returns {object} config manager API
 */
function createConfig(redis, serviceName, localConfig) {
    const redisKey = `${REDIS_KEY_PREFIX}${serviceName}`;

    /**
     * Read a single config value.
     * Priority: Redis override → local config default.
     *
     * @param {string} key — dot-path key, e.g. 'thumbnails.enabled'
     * @returns {*} effective value
     */
    async function get(key) {
        const defaultVal = getPath(localConfig, key);
        const val = await redis.hGet(redisKey, key);
        if (val === null) return defaultVal;
        return cast(val, defaultVal);
    }

    /**
     * Read multiple config values in a single Redis call.
     *
     * @param {string[]} keys — array of dot-path keys
     * @returns {object} { key: effectiveValue, ... }
     */
    async function getMany(keys) {
        if (!keys.length) return {};
        const vals = await redis.hmGet(redisKey, keys);
        const result = {};
        keys.forEach((key, i) => {
            const defaultVal = getPath(localConfig, key);
            result[key] = vals[i] === null ? defaultVal : cast(vals[i], defaultVal);
        });
        return result;
    }

    /**
     * Write a single override to Redis.
     * Value is stored as string regardless of input type.
     *
     * @param {string} key
     * @param {*}      value
     */
    async function set(key, value) {
        await redis.hSet(redisKey, key, String(value));
    }

    /**
     * Remove a single override, reverting to local default.
     *
     * @param {string} key
     */
    async function del(key) {
        await redis.hDel(redisKey, key);
    }

    /**
     * List all active Redis overrides for this service.
     * Returns raw strings as stored; does not cast.
     * Intended for portal/system UI display.
     *
     * @returns {object} { key: rawStringValue, ... } or {} if no overrides
     */
    async function overrides() {
        const all = await redis.hGetAll(redisKey);
        return all || {};
    }

    /**
     * Publish this service's supported config keys to Redis for portal discovery.
     * Call once at bootstrap after the service is ready.
     *
     * @param {string[]} keys — dot-path keys the service supports for dynamic override
     */
    async function publish(keys) {
        const schema = {
            service: serviceName,
            publishedAt: new Date().toISOString(),
            keys: keys.map(key => {
                const defaultVal = getPath(localConfig, key);
                return { key, default: defaultVal, type: typeof defaultVal };
            }),
        };
        await redis.set(`SYSTEM:CONFIG:SCHEMA:${serviceName}`, JSON.stringify(schema));
    }

    return { get, getMany, set, del, overrides, publish };
}

module.exports = { createConfig };
