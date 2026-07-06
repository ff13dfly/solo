const config = require('../config');

let CACHED_RULES = null;
let LAST_FETCH = 0;
const CACHE_TTL = 60000; // 60 seconds

/**
 * Validates and retrieves the rate limit rules, prioritizing Redis source of truth.
 */
async function getRules(redisClient) {
    const now = Date.now();
    if (CACHED_RULES && (now - LAST_FETCH < CACHE_TTL)) {
        return CACHED_RULES;
    }

    if (redisClient && redisClient.isOpen) {
        try {
            const data = await redisClient.get(config.redis.rateLimitsKey);
            if (data) {
                CACHED_RULES = JSON.parse(data);
                LAST_FETCH = now;
                return CACHED_RULES;
            }
        } catch (e) {
            console.warn('[RateLimit] Failed to fetch rules from Redis, falling back to config:', e.message);
        }
    }

    if (!CACHED_RULES) {
        CACHED_RULES = config.rateLimits || {};
    }
    return CACHED_RULES;
}

/**
 * Resolve the applicable rate limit rule for a given method.
 * 
 * @param {string} method - The RPC method name.
 * @param {object} capabilityMap - The global capability map.
 * @param {object} rules - The rate limit rules configuration.
 * @returns {object} { window, max, by }
 */
function resolveLimit(method, capabilityMap, rules) {
    // 1. Method-level override (from microservice introspection)
    const cap = capabilityMap[method];
    if (cap && cap.limit) {
        return cap.limit;
    }

    // 2. Prefix-level rules (from rules config)
    const prefixes = rules?.prefixes || {};
    for (const [prefix, rule] of Object.entries(prefixes)) {
        if (method.startsWith(prefix)) {
            return rule;
        }
    }

    // 3. Global default
    return rules?.default || { window: 60, max: 60, by: 'ip' };
}

// ── In-memory fallback counter ────────────────────────────────────────────────
// When Redis is down/erroring, falling fully open turns one blip into a global
// rate-limit outage. This per-process Map keeps limiting (per Router instance —
// slightly more permissive than the shared counter, but bounded, not open).
const memCounters = new Map();   // key → count
let memWindow = 0;               // current window bucket for cheap wholesale reset

function memoryCheck(method, identity, rule) {
    const { window: windowSeconds, max } = rule;
    const now = Date.now();
    const windowKey = Math.floor(now / (windowSeconds * 1000));

    // New window → drop all old counters (single shared clock keeps this O(1) amortized).
    if (windowKey !== memWindow) {
        memCounters.clear();
        memWindow = windowKey;
    }

    const key = `${method}:${identity}`;
    const count = (memCounters.get(key) || 0) + 1;
    memCounters.set(key, count);

    const resetAt = (windowKey + 1) * windowSeconds * 1000;
    return {
        allowed: count <= max,
        remaining: Math.max(0, max - count),
        resetIn: Math.ceil((resetAt - now) / 1000),
        fallback: 'memory'
    };
}

/**
 * Check and increment rate limit counter in Redis; falls back to the in-process
 * counter (NOT open) when Redis is unavailable or errors.
 *
 * @param {object} redisClient - Active Redis client.
 * @param {string} method - The RPC method name.
 * @param {string} identity - The user ID or IP address.
 * @param {object} rule - { window, max }
 * @returns {Promise<object>} { allowed, remaining, resetIn }
 */
async function checkLimit(redisClient, method, identity, rule) {
    if (!redisClient || !redisClient.isOpen) {
        return memoryCheck(method, identity, rule);
    }

    const { window: windowSeconds, max } = rule;
    const now = Date.now();
    const windowKey = Math.floor(now / (windowSeconds * 1000));
    const redisKey = `RL:${method}:${identity}:${windowKey}`;

    try {
        const count = await redisClient.incr(redisKey);

        if (count === 1) {
            await redisClient.expire(redisKey, windowSeconds);
        }

        const remaining = Math.max(0, max - count);
        const resetAt = (windowKey + 1) * windowSeconds * 1000;
        const resetIn = Math.ceil((resetAt - now) / 1000);

        return {
            allowed: count <= max,
            remaining,
            resetIn
        };
    } catch (err) {
        console.error('[RateLimit] Redis error — degrading to in-memory limiter:', err.message);
        return memoryCheck(method, identity, rule);
    }
}

/**
 * Invalidate the in-process rules cache so the next getRules() re-reads Redis immediately
 * (instead of up to CACHE_TTL later). Called by system.js right after an admin rate-limit
 * write. Purely additive: the read path (getRules) is unchanged and the 60s TTL fallback
 * still self-heals if this is never called.
 */
function invalidate() {
    CACHED_RULES = null;
    LAST_FETCH = 0;
}

module.exports = {
    getRules,
    resolveLimit,
    checkLimit,
    invalidate
};
