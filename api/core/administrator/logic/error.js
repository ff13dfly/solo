const jsonrpc = require('../handlers/jsonrpc');
const config = require('../config');

/**
 * Error Logic Handler
 * Handles system-wide error log retrieval and management from Redis queues.
 */
const ErrorLogic = {
    /**
     * List error logs for a specific service or all services.
     * 
     * @why Centralized error monitoring allows the Router and Admin portal to 
     *      diagnose cross-service failures without direct SSH access to nodes.
     * @attention 
     *   1. Implements a "transitional" key check (lowercase vs capitalized) to remain 
     *      compatible with older service logging versions.
     *   2. Output is limited by `limit` to prevent OOM when a service is crash-looping.
     * @side_effects None (Read-only operation).
     */
    async list(redisClient, params) {
        const { service, limit = 50, offset = 0 } = params;
        if (!service) return this.listAll(redisClient, params);

        const sName = service.toLowerCase();
        const key = `${config.redis.errorQueuePrefix}${sName}`;
        try {
            // Also try capitalized if lowercase is empty (transitional)
            let logs = await redisClient.lRange(key, offset, offset + limit - 1);
            if (logs.length === 0) {
                const altKey = `${config.redis.errorQueuePrefix}${sName.charAt(0).toUpperCase() + sName.slice(1)}`;
                logs = await redisClient.lRange(altKey, offset, offset + limit - 1);
            }
            return { service: sName, logs: logs.map(l => {
                const parsed = JSON.parse(l);
                return { ...parsed, service: sName };
            }) };
        } catch (err) {
            console.error(err);
            throw jsonrpc.INTERNAL_ERROR('Failed to list errors');
        }
    },

    /**
     * Internal helper to scan Redis for all error logs.
     * 
     * @why Used when the UI needs a "global view" of system health across all microservices.
     * @attention 
     *   1. Uses `SCAN` approach (implied by keys*) which might be slow if Redis has 
     *      millions of keys. Ensure error queue prefixes are unique.
     *   2. Automatically filters out malformed JSON strings to prevent API crashes.
     * @side_effects High Redis CPU usage if key space is large.
     */
    async listAll(redisClient, params) {
        const { limit = 100 } = params;
        try {
            // Robust approach: Scan Redis for all error queue keys
            const keys = await redisClient.keys(`${config.redis.errorQueuePrefix}*`);
            const allLogs = [];

            for (const key of keys) {
                const sName = key.split(':')[2].toLowerCase(); // Extract service name from key
                
                const logs = await redisClient.lRange(key, 0, limit - 1);
                allLogs.push(...logs.map(l => {
                    try {
                        const parsed = JSON.parse(l);
                        return { ...parsed, service: sName };
                    } catch (e) { return null; }
                }).filter(x => x));
            }

            return { logs: allLogs };
        } catch (err) {
            console.error(err);
            throw jsonrpc.INTERNAL_ERROR('Failed to list all errors: ' + err.message);
        }
    },

    /**
     * Clear error logs for a service or all services.
     * 
     * @why Allows operators to reset the error state after fixing a bug or deploying a patch.
     * @attention 
     *   1. PRV-LEVEL: Requires `isAdmin` flag from Router (Level 3 Auth).
     *   2. Destructive: Once cleared, logs cannot be recovered unless backed up externally.
     * @side_effects Resets the error counters in the Admin dashboard.
     */
    async clear(redisClient, params) {
        const { service } = params;
        if (!service) {
            // Clear all if no service specified
            return this.clearAll(redisClient, params);
        }
        
        if (!params.isAdmin) {
             throw { code: -403, message: 'Admin privileges required' };
        }

        try {
            const sName = service.toLowerCase();
            await redisClient.del(`${config.redis.errorQueuePrefix}${sName}`);
            await redisClient.del(`${config.redis.errorQueuePrefix}${sName.charAt(0).toUpperCase() + sName.slice(1)}`);
            return { success: true, service: sName };
        } catch (err) {
            console.error(err);
            throw jsonrpc.INTERNAL_ERROR('Failed to clear errors');
        }
    },

    /**
     * Helper to clear ALL system-wide error logs.
     * 
     * @why Emergency "Reset" function for major system maintenance.
     * @attention 
     *   1. Iterates through the `activeServicesKey` to find all potential log queues.
     *   2. Explicitly includes 'router' and 'administrator' as they might not 
     *      register themselves in the active service list.
     * @side_effects Complete loss of system error history.
     */
    async clearAll(redisClient, params) {
        if (!params.isAdmin) {
             throw { code: -403, message: 'Admin privileges required' };
        }
        try {
            const servicesData = await redisClient.get(config.redis.activeServicesKey);
            const servicesMap = servicesData ? JSON.parse(servicesData) : {};
            const serviceIds = Object.keys(servicesMap);
            
            if (!serviceIds.includes('administrator')) serviceIds.push('administrator');
            if (!serviceIds.includes('router')) serviceIds.push('router');

            for (const id of serviceIds) {
                const sName = id.toLowerCase();
                await redisClient.del(`${config.redis.errorQueuePrefix}${sName}`);
                await redisClient.del(`${config.redis.errorQueuePrefix}${sName.charAt(0).toUpperCase() + sName.slice(1)}`);
            }
            return { success: true };
        } catch (err) {
            console.error(err);
            throw jsonrpc.INTERNAL_ERROR('Failed to clear all errors');
        }
    }
};

module.exports = ErrorLogic;
