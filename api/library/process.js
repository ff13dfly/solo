const { STATUS } = require('./constants');
const jsonrpc = require('./jsonrpc');

/**
 * Shared Business Process Logic
 * Implements Process Protocol v1.1.0 (O(1) status-based dispatch)
 * 
 * @param {Object} redis - Redis client instance
 * @param {Object} config - Configuration object
 * @param {string} config.serviceName - Name of the service owning the processes
 */
module.exports = (redis, { serviceName }) => {
    const SERVICE_UPPER = serviceName.toUpperCase();

    /**
     * Validate process data against Process Protocol v1.1.0
     * @private
     */
    function validate(data) {
        if (!data.id) throw jsonrpc.INVALID_PARAM('Process ID required');
        if (!data.flows || typeof data.flows !== 'object') {
            throw jsonrpc.INVALID_PARAM('Flows must be an object (Record<status, Flow>)');
        }

        // Validate each flow
        for (const [status, flow] of Object.entries(data.flows)) {
            if (!flow.ui || typeof flow.ui !== 'object') {
                throw jsonrpc.INVALID_PARAM(`Flow "${status}" missing ui definition`);
            }
            if (!flow.ui.title) {
                throw jsonrpc.INVALID_PARAM(`Flow "${status}" missing ui.title`);
            }

            // Validate actions
            if (flow.ui.actions) {
                if (!Array.isArray(flow.ui.actions)) {
                    throw jsonrpc.INVALID_PARAM(`Flow "${status}" ui.actions must be an array`);
                }
                for (const action of flow.ui.actions) {
                    if (!action.id) throw jsonrpc.INVALID_PARAM(`Action in "${status}" missing id`);
                    if (!action.text) throw jsonrpc.INVALID_PARAM(`Action "${action.id}" missing text`);
                    if (!action.rpc) throw jsonrpc.INVALID_PARAM(`Action "${action.id}" missing rpc method`);
                    
                    // Security check: identity fields must NOT use dynamic variables
                    if (action.params && typeof action.params === 'object') {
                        const forbiddenVars = ['$user.id', '$user.name', '$user.uid', '$user.username'];
                        for (const [key, val] of Object.entries(action.params)) {
                            if (typeof val === 'string' && forbiddenVars.some(v => val.includes(v))) {
                                // Specific check for identity-looking keys
                                if (['userId', 'operatorId', 'approvedBy', 'uid'].includes(key)) {
                                    throw jsonrpc.INVALID_PARAM(`Security Error: Identity field "${key}" cannot be set via dynamic variable in action "${action.id}"`);
                                }
                            }
                        }
                    }

                    // Validate action types
                    const validTypes = ['PRIMARY', 'SUCCESS', 'DANGER', 'GHOST'];
                    if (action.type && !validTypes.includes(action.type)) {
                        throw jsonrpc.INVALID_PARAM(`Action "${action.id}" has invalid type: ${action.type}`);
                    }
                }
            }
        }
        return true;
    }

    return {
        /**
         * Create or Update a process definition
         * @param {Object} data - Process definition JSON
         */
        async save(data) {
            validate(data); // Throws if invalid

            const id = data.id;
            const redisKey = `${SERVICE_UPPER}:PROCESS:${id}`;

            const now = Date.now();
            const record = {
                ...data,
                status: data.status || STATUS.ACTIVE,
                createdAt: data.createdAt || now,
                updatedAt: now
            };

            await redis.set(redisKey, JSON.stringify(record));
            return record;
        },

        /**
         * Get a process definition
         * @param {string} id - Process ID
         * @param {Object} [hardcoded] - Optional map of static/hardcoded processes for the service
         */
        async get({ id, hardcoded = {} }) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');

            // 1. Check hardcoded first (Stateless/Deployment-bound logic)
            if (hardcoded[id]) {
                return hardcoded[id];
            }

            // 2. Check Redis (Dynamic/Configuration-bound logic)
            const redisKey = `${SERVICE_UPPER}:PROCESS:${id}`;
            const data = await redis.get(redisKey);
            
            if (!data) throw jsonrpc.NOT_FOUND(`Process "${id}"`);
            
            const record = JSON.parse(data);
            if (record.status === STATUS.DELETED) throw jsonrpc.NOT_FOUND(`Process "${id}" (Deleted)`);

            return record;
        },

        /**
         * List all process definitions for this service
         * @param {boolean} [includeDeleted=false]
         */
        async list({ includeDeleted = false } = {}) {
            const keys = await redis.keys(`${SERVICE_UPPER}:PROCESS:*`);
            const processes = [];

            for (const k of keys) {
                const data = await redis.get(k);
                if (data) {
                    const record = JSON.parse(data);
                    if (includeDeleted || record.status === STATUS.ACTIVE) {
                        processes.push(record);
                    }
                }
            }

            return processes;
        },

        /**
         * Delete a process definition
         * @param {string} id
         * @param {boolean} [hard=false] - If true, permanently removes the key
         */
        async delete({ id, hard = false }) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            const redisKey = `${SERVICE_UPPER}:PROCESS:${id}`;

            if (hard) {
                await redis.del(redisKey);
                return { success: true, hard: true };
            }

            const data = await redis.get(redisKey);
            if (!data) throw jsonrpc.NOT_FOUND(`Process "${id}"`);

            const record = JSON.parse(data);
            record.status = STATUS.DELETED;
            record.updatedAt = Date.now();

            await redis.set(redisKey, JSON.stringify(record));
            return { success: true, soft: true };
        },

        // Export validation for standalone use
        validate
    };
};
