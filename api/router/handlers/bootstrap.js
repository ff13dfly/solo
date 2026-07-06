const { createLogger } = require('../../library/logger');
const { createClient } = require('redis');
const config = require('../config');

const logger = createLogger('Router:Bootstrap');

let redisClient = null;

// --- INITIALIZATION ---

/**
 * Initialize Redis connection and load persistent service registry.
 * 
 * @param {object} SERVICES - Global services registry to populate.
 * @param {object} CAPABILITY_MAP - Shared capability map to populate.
 * @param {function} updateCapabilityMap - Async function to refresh capabilities.
 * @returns {Promise<object>} Authenticated Redis client instance.
 * 
 * @why The router depends on Redis for both session management and service discovery. 
 *      Initializing this first is critical for the rest of the system's availability.
 * @attention 
 *   1. PERSISTENCE: Serves as the "memory" of the router, allowing it to recover 
 *      service URLs and caps after a restart.
 *   2. AUTO-REFRESH: Starts background timers to keep the capability map synced 
 *      with downstream microservices.
 */
async function initializeRedis(SERVICES, CAPABILITY_MAP, updateCapabilityMap) {
    try {
        if (!config.redisUrl) {
            throw new Error('Redis URL not configured in config.js');
        }

        redisClient = createClient({
            url: config.redisUrl
        });

        redisClient.on('error', err => logger.error('Redis Client Error:', err.message));

        await redisClient.connect();
        logger.info('Connected to Redis infrastructure');

        // Load services and capability map from Redis storage
        const [storedServices, storedCapabilities] = await Promise.all([
            redisClient.get(config.redis.activeServicesKey),
            redisClient.get(config.redis.capabilityKey)
        ]);

        if (storedServices) {
            Object.assign(SERVICES, JSON.parse(storedServices));
            logger.info('Service registry restored from Redis');
        } else {
            logger.warn('Service registry empty in Redis; awaiting discovery');
        }

        if (storedCapabilities) {
            Object.assign(CAPABILITY_MAP, JSON.parse(storedCapabilities));
            logger.info('Capability map restored from Redis');
        }

        // Strategy: Delay initial refresh to allow services to stabilize, then poll.
        if (updateCapabilityMap) {
            setTimeout(updateCapabilityMap, 2000);
            setInterval(updateCapabilityMap, 60000);
        }

        // --- SEED CONFIGURATION ---
        // Ensure critical configuration exists in Redis (Source of Truth)
        if (config.taskWhitelist) {
            const whitelistKey = config.redis.taskWhitelistKey;
            const exists = await redisClient.exists(whitelistKey);
            if (!exists) {
                await redisClient.set(whitelistKey, JSON.stringify(config.taskWhitelist));
                logger.info('Seeded Task Whitelist to Redis');
            }
        }

        if (config.rateLimits) {
            const rateLimitsKey = config.redis.rateLimitsKey;
            const exists = await redisClient.exists(rateLimitsKey);
            if (!exists) {
                await redisClient.set(rateLimitsKey, JSON.stringify(config.rateLimits));
                logger.info('Seeded Rate Limits to Redis');
            }
        }

        return redisClient;
    } catch (err) {
        logger.error('Redis initialization FATAL:', err.message);
        return null;
    }
}

// --- ACCESSORS ---

/**
 * Retrieve the active Redis client.
 */
function getRedisClient() {
    return redisClient;
}

/**
 * Override the Redis client (primarily for testing suites).
 */
function setRedisClient(client) {
    redisClient = client;
}

module.exports = {
    initializeRedis,
    getRedisClient,
    setRedisClient
};
