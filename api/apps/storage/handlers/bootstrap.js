const config = require('../config');
const { createLogger } = require('../../../library/logger');

const logger = createLogger(config.serviceName || 'storage');

/**
 * Persists the service's semantic metadata to Redis.
 */
async function persistSemanticDescription(redisClient, SERVICE_NAME) {
    try {
        const key = `SYSTEM:SEMANTIC:${SERVICE_NAME}`;
        const payload = { source: 'config', ...config.description };
        await redisClient.json.set(key, '$', payload);
        logger.info(`Semantic description persisted`);
    } catch (e) {
        logger.error(`Failed to persist semantic:`, e.message);
    }
}

/**
 * Ensures defaults (no categories for storage for now).
 */
async function ensureDefaultCategories(redisClient, SERVICE_NAME) {
    // Storage doesn't use categories currently
    return;
}

module.exports = { persistSemanticDescription, ensureDefaultCategories };
