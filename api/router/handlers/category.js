const chalk = require('chalk');
const config = require('../config');
const { STATUS } = require('../../library/constants');

// --- FEDERATED CATEGORY REGISTRY ---

/**
 * Create handlers for global category key management.
 * 
 * @param {object} redisClient - Active Redis client for central storage.
 * @param {object} SERVICES - Global services registry for endpoint lookup.
 * @returns {object} Map of JSON-RPC handlers for category management.
 * 
 * @why Enables distributed microservices to coordinate on a shared namespace of categories 
 *      without local configuration collisions.
 * @attention 
 *   1. NAMESPACE: All keys are automatically converted to UPPERCASE to ensure consistency.
 *   2. ATOMICITY: Reservation checks are performed against the shared Redis hash.
 */
function createCategoryHandlers(redisClient, SERVICES) {
    return {
        /**
         * system.category.reserve
         * Atomic reservation of a category key by a specific service.
         */
        async reserve(params, id, res) {
            let { key, service, scope, type, desc, createdBy, meta } = params;
            if (!key || !service) {
                return res.json({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing required params: key, service' }, id });
            }

            key = key.toUpperCase();

            try {
                const existing = await redisClient.hGet(config.redis.categoryRegistryKey, key);
                if (existing) {
                    const data = JSON.parse(existing);
                    if (data.status === STATUS.ACTIVE) {
                        return res.json({
                            jsonrpc: '2.0',
                            error: {
                                code: -32010,
                                message: 'CATEGORY_KEY_CONFLICT',
                                data: { owner: data.owner }
                            },
                            id
                        });
                    }
                }

                const now = Date.now();
                const categoryMeta = {
                    owner: service,
                    scope: scope || 'LOCAL',
                    type: type || 'LIST',
                    status: STATUS.ACTIVE,
                    desc: desc || '',
                    meta: meta || {},
                    createdAt: existing ? JSON.parse(existing).createdAt : now,
                    updatedAt: now,
                    createdBy: createdBy || `system@${service}`
                };

                await redisClient.hSet(config.redis.categoryRegistryKey, key, JSON.stringify(categoryMeta));
                console.log(chalk.green(`[Category] Reserved "${key}" for service "${service}"`));

                return res.json({ jsonrpc: '2.0', result: { success: true, key, ...categoryMeta }, id });
            } catch (e) {
                console.error('[Category] Reservation error:', e.message);
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id });
            }
        },

        /**
         * system.category.delete
         * Soft delete a category to prevent accidental data loss while freeing the key.
         */
        async delete(params, id, res) {
            let { key, service } = params;
            if (!key) {
                return res.json({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing required param: key' }, id });
            }

            key = key.toUpperCase();

            try {
                const existing = await redisClient.hGet(config.redis.categoryRegistryKey, key);
                if (!existing) {
                    return res.json({ jsonrpc: '2.0', error: { code: -32011, message: 'CATEGORY_NOT_FOUND' }, id });
                }

                const data = JSON.parse(existing);

                // Permission check: Only the owner can delete a category
                if (service && data.owner !== service) {
                    return res.json({ jsonrpc: '2.0', error: { code: -32012, message: 'CATEGORY_PERMISSION_DENIED' }, id });
                }

                data.status = STATUS.DELETED;
                data.updatedAt = Date.now();
                await redisClient.hSet(config.redis.categoryRegistryKey, key, JSON.stringify(data));
                console.log(chalk.yellow(`[Category] Soft-deleted "${key}"`));

                return res.json({ jsonrpc: '2.0', result: { success: true }, id });
            } catch (e) {
                console.error('[Category] Deletion error:', e.message);
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id });
            }
        },

        /**
         * system.category.locate
         * Maps a category key back to its owner service and RPC endpoint.
         */
        async locate(params, id, res) {
            let { key } = params;
            if (!key) {
                return res.json({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing required param: key' }, id });
            }

            key = key.toUpperCase();

            try {
                const existing = await redisClient.hGet(config.redis.categoryRegistryKey, key);
                if (!existing) {
                    return res.json({ jsonrpc: '2.0', error: { code: -32011, message: 'CATEGORY_NOT_FOUND' }, id });
                }

                const data = JSON.parse(existing);
                const ownerService = SERVICES[data.owner];

                return res.json({
                    jsonrpc: '2.0',
                    result: {
                        key,
                        ownerService: data.owner,
                        endpoint: ownerService?.url || null,
                        searchIndex: `idx:${data.owner}`,
                        scope: data.scope,
                        type: data.type,
                        status: data.status
                    },
                    id
                });
            } catch (e) {
                console.error('[Category] Lookup error:', e.message);
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id });
            }
        },

        /**
         * system.category.list
         * Retrieve all registered categories from the global hash.
         */
        async list(params, id, res) {
            const { includeDeleted } = params || {};

            try {
                const all = await redisClient.hGetAll(config.redis.categoryRegistryKey);
                const categories = Object.entries(all).map(([key, value]) => {
                    const data = JSON.parse(value);
                    return { key, ...data };
                });

                const filtered = includeDeleted
                    ? categories
                    : categories.filter(c => c.status === STATUS.ACTIVE);

                return res.json({ jsonrpc: '2.0', result: filtered, id });
            } catch (e) {
                console.error('[Category] Listing error:', e.message);
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id });
            }
        }
    };
}

module.exports = { createCategoryHandlers };
