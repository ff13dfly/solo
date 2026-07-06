const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Shared Category Management Logic
 * 
 * @protocol Federated Category Protocol (docs/zh/protocol/category.md)
 * @description Implements "Local Ownership, Global Discovery" pattern for microservices.
 * 
 * @param {Object} redis - Redis client instance
 * @param {Object} config - Configuration object
 * @param {string} config.serviceName - Name of the service owning the categories
 * @param {string} [config.routerUrl] - URL of the Router service
 */
const jsonrpc = require('./jsonrpc');
const { STATUS } = require('./constants');

module.exports = (redis, { serviceName, routerUrl }) => {
    const SERVICE_UPPER = serviceName.toUpperCase();
    const IDX_KEY = `${SERVICE_UPPER}:CONFIG:CATEGORY_IDX`;

    return {
        // Create category (with Router reservation)
        async create({ key, type, scope, desc, items, meta }) {
            if (!key) throw jsonrpc.MISSING_PARAM('key');
            key = key.toUpperCase();

            // 1. Reserve in Router (Global Registry)
            const rpcUrl = routerUrl || process.env.ROUTER_URL;
            if (!rpcUrl) throw jsonrpc.INTERNAL_ERROR('ROUTER_URL_NOT_CONFIGURED');
            try {
                const reservation = await makeRpcCall(rpcUrl, 'system.category.reserve', {
                    key,
                    service: serviceName,
                    scope: scope || 'LOCAL',
                    type: type || 'LIST',
                    desc: desc || '',
                    meta: meta || {}
                });


                if (reservation.error) {
                    // If strictly required, throw internal error from router message
                    throw jsonrpc.INTERNAL_ERROR(reservation.error.message || 'ROUTER_RESERVATION_FAILED');
                }
            } catch (e) {
                console.error(`[${serviceName}] Category reservation failed:`, e.message);
                throw e;
            }

            // 2. Create Locally
            const existingKey = `${SERVICE_UPPER}:CONFIG:CATEGORY:${key}`;
            const existing = await redis.get(existingKey);

            if (existing) {
                const data = JSON.parse(existing);
                if (data.status === STATUS.ACTIVE) {
                    console.warn(`[${serviceName}] Overwriting locally ${STATUS.ACTIVE} category ${key} after successful Router reservation.`);
                }

            }

            const now = Date.now();
            const data = {
                key,
                type: type || 'LIST',
                scope: scope || 'LOCAL',
                desc: desc || '',
                meta: meta || {},
                items: items || [],
                status: STATUS.ACTIVE,
                createdAt: now,
                updatedAt: now
            };

            await redis.set(existingKey, JSON.stringify(data));
            await redis.sAdd(IDX_KEY, existingKey);
            return data;
        },

        // Get single category by key
        async get({ key }) {
            if (!key) throw jsonrpc.MISSING_PARAM('key');
            key = key.toUpperCase();

            const data = await redis.get(`${SERVICE_UPPER}:CONFIG:CATEGORY:${key}`);
            if (!data) throw jsonrpc.NOT_FOUND('Category');
            return JSON.parse(data);
        },

        // List all categories for this service
        async list({ includeDeleted = false } = {}) {
            const fullKeys = await redis.sMembers(IDX_KEY);
            if (!fullKeys.length) return [];

            const values = await redis.mGet(fullKeys);
            const categories = [];
            for (const raw of values) {
                if (!raw) continue;
                const data = JSON.parse(raw);
                if (includeDeleted || data.status === STATUS.ACTIVE) {
                    categories.push(data);
                }
            }
            return categories;
        },

        // Update category metadata
        async update({ key, desc, type, meta }) {
            if (!key) throw jsonrpc.MISSING_PARAM('key');
            key = key.toUpperCase();

            const redisKey = `${SERVICE_UPPER}:CONFIG:CATEGORY:${key}`;
            const existing = await redis.get(redisKey);
            if (!existing) throw jsonrpc.NOT_FOUND('Category');

            const data = JSON.parse(existing);

            if (desc !== undefined) data.desc = desc;
            if (type !== undefined) data.type = type;
            if (meta !== undefined) data.meta = meta;
            data.updatedAt = Date.now();

            await redis.set(redisKey, JSON.stringify(data));
            return data;
        },

        // Soft delete category
        async delete({ key }) {
            if (!key) throw jsonrpc.MISSING_PARAM('key');
            key = key.toUpperCase();

            const SERVICE_UPPER = serviceName.toUpperCase();

            // 1. Delete in Router
            const rpcUrl = routerUrl || process.env.ROUTER_URL;
            if (!rpcUrl) throw jsonrpc.INTERNAL_ERROR('ROUTER_URL_NOT_CONFIGURED');
            try {
                const result = await makeRpcCall(rpcUrl, 'system.category.delete', {
                    key,
                    service: serviceName
                });

                if (result.error) {
                    if (result.error.code === -32012) {
                        throw jsonrpc.INTERNAL_ERROR('ROUTER_PERMISSION_DENIED');
                    }
                    console.warn(`[${serviceName}] Router delete warning:`, result.error.message);
                }
            } catch (e) {
                if (e.message === 'ROUTER_PERMISSION_DENIED') throw e;
                console.error(`[${serviceName}] Router delete failed:`, e.message);
            }

            // 2. Delete Locally
            const redisKey = `${SERVICE_UPPER}:CONFIG:CATEGORY:${key}`;
            const existing = await redis.get(redisKey);
            if (!existing) throw jsonrpc.NOT_FOUND('Category');

            const data = JSON.parse(existing);
            data.status = STATUS.DELETED;
            data.updatedAt = Date.now();

            await redis.set(redisKey, JSON.stringify(data));
            return { success: true };
        },

        // Add item to category
        async addItem({ key, id, label, desc, parentId, meta }) {
            if (!key) throw jsonrpc.MISSING_PARAM('key');
            key = key.toUpperCase();

            const redisKey = `${SERVICE_UPPER}:CONFIG:CATEGORY:${key}`;
            const existing = await redis.get(redisKey);
            if (!existing) throw jsonrpc.NOT_FOUND('Category');

            const data = JSON.parse(existing);
            const itemId = id || `${key}_${Date.now().toString(36)}`;

            // Check for duplicate
            if (data.items.find(i => i.id === itemId)) {
                throw jsonrpc.ALREADY_EXISTS('Category item');
            }

            const newItem = {
                id: itemId,
                label: label || { zh: '', en: '' },
                desc: desc || '',
                parentId: parentId || null,
                meta: meta || null,
                createdAt: Date.now()
            };

            data.items.push(newItem);
            data.updatedAt = Date.now();

            await redis.set(redisKey, JSON.stringify(data));
            return newItem;
        },

        // Get a single category item by id (reads the whole category, returns just the one node)
        async getItem({ key, id }) {
            if (!key || !id) throw jsonrpc.INVALID_PARAM('key and id required');
            key = key.toUpperCase();

            const redisKey = `${SERVICE_UPPER}:CONFIG:CATEGORY:${key}`;
            const existing = await redis.get(redisKey);
            if (!existing) throw jsonrpc.NOT_FOUND('Category');

            const data = JSON.parse(existing);
            const item = data.items.find(i => i.id === id);
            if (!item) throw jsonrpc.NOT_FOUND('Category item');

            return item;
        },

        // Update category item
        async updateItem({ key, id, label, desc, parentId, meta }) {
            if (!key || !id) throw jsonrpc.INVALID_PARAM('key and id required');
            key = key.toUpperCase();

            const redisKey = `${SERVICE_UPPER}:CONFIG:CATEGORY:${key}`;
            const existing = await redis.get(redisKey);
            if (!existing) throw jsonrpc.NOT_FOUND('Category');

            const data = JSON.parse(existing);
            const item = data.items.find(i => i.id === id);
            if (!item) throw jsonrpc.NOT_FOUND('Category item');

            if (label !== undefined) item.label = label;
            if (desc !== undefined) item.desc = desc;
            if (parentId !== undefined) item.parentId = parentId;
            if (meta !== undefined) item.meta = meta;
            item.updatedAt = Date.now();

            data.updatedAt = Date.now();
            await redis.set(redisKey, JSON.stringify(data));
            return item;
        },

        // Upsert multiple items into a category (add if not exists, update if exists)
        async syncItems({ key, items = [] }) {
            if (!key) throw jsonrpc.MISSING_PARAM('key');
            key = key.toUpperCase();

            const redisKey = `${SERVICE_UPPER}:CONFIG:CATEGORY:${key}`;
            const existing = await redis.get(redisKey);
            if (!existing) throw jsonrpc.NOT_FOUND('Category');

            const data = JSON.parse(existing);
            const now = Date.now();
            let added = 0, updated = 0;

            for (const item of items) {
                if (!item.id) continue;
                const idx = data.items.findIndex(i => i.id === item.id);
                if (idx === -1) {
                    data.items.push({
                        id: item.id,
                        label: item.label || {},
                        desc: item.desc || '',
                        parentId: item.parentId || null,
                        meta: item.meta || null,
                        createdAt: now
                    });
                    added++;
                } else {
                    if (item.label !== undefined) data.items[idx].label = item.label;
                    if (item.desc !== undefined) data.items[idx].desc = item.desc;
                    if (item.parentId !== undefined) data.items[idx].parentId = item.parentId;
                    if (item.meta !== undefined) data.items[idx].meta = item.meta;
                    data.items[idx].updatedAt = now;
                    updated++;
                }
            }

            data.updatedAt = now;
            await redis.set(redisKey, JSON.stringify(data));
            return { added, updated, total: items.length };
        },

        // Remove category item
        async removeItem({ key, id }) {
            if (!key || !id) throw jsonrpc.INVALID_PARAM('key and id required');
            key = key.toUpperCase();

            const redisKey = `${SERVICE_UPPER}:CONFIG:CATEGORY:${key}`;
            const existing = await redis.get(redisKey);
            if (!existing) throw jsonrpc.NOT_FOUND('Category');

            const data = JSON.parse(existing);
            const index = data.items.findIndex(i => i.id === id);
            if (index === -1) throw jsonrpc.NOT_FOUND('Category item');

            data.items.splice(index, 1);
            data.updatedAt = Date.now();

            await redis.set(redisKey, JSON.stringify(data));
            return { success: true };
        }
    };
};

// Bound the federation RPC so a stalled Router can't hang category create/delete
// forever (category ops are fast, so a tight default is fine). Override via env.
const CATEGORY_RPC_TIMEOUT_MS = Number(process.env.CATEGORY_RPC_TIMEOUT_MS) || 15000;

function makeRpcCall(urlStr, method, params) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const client = url.protocol === 'https:' ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + (url.search || ''),
            method: 'POST',
            timeout: CATEGORY_RPC_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json',
            }
        };

        const req = client.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`RPC_HTTP_ERROR_${res.statusCode}: ${data}`));
                }

                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('INVALID_JSON_RESPONSE'));
                }
            });
        });

        req.on('timeout', () => req.destroy(new Error(`CATEGORY_RPC_TIMEOUT_${CATEGORY_RPC_TIMEOUT_MS}ms`)));
        req.on('error', (e) => reject(e));

        req.write(JSON.stringify({
            jsonrpc: '2.0',
            method,
            params,
            id: Date.now()
        }));

        req.end();
    });
}
