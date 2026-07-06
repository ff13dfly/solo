const fs = require('fs');
const path = require('path');
const { createLogger, query } = require('../../library/logger');
const config = require('../config');
const jsonrpc = require('./jsonrpc');

const logger = createLogger('Router:System');

// --- SYSTEM MANAGEMENT HANDLERS ---

/**
 * Factory for router-level system and logging RPC methods.
 * 
 * @param {function} addServiceFn - Handshake logic for new services.
 * @param {function} isAdmin - Utility to check administrator status.
 * @param {string} dirname - Base directory for log resolution.
 * @param {object} redisClient - Active Redis client.
 * @param {object} SERVICES - Service registry.
 * @param {object} keypair - Router keypair for signatures.
 * @param {object} CAPABILITY_MAP - Service capability mapping.
 * 
 * @returns {object} Map of JSON-RPC handlers for system operations.
 */
function createSystemHandlers(addServiceFn, isAdmin, dirname, redisClient, SERVICES, keypair, CAPABILITY_MAP) {
    return {
        /**
         * system.service.add
         * Trigger a secure handshake to register a new microservice endpoint.
         * 
         * @why Allows dynamic expansion of the system without configuration redeployment.
         */
        async systemAddService(params, id, res) {
            try {
                const result = await addServiceFn(params.url, SERVICES, redisClient, keypair, CAPABILITY_MAP);
                return res.json({ jsonrpc: '2.0', result, id });
            } catch (e) {
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id });
            }
        },

        /**
         * admin.log.debug
         * Retrieve the low-level debug.log file contents for the router.
         * 
         * @why Provides high-granularity technical logs for troubleshooting router middleware.
         * @attention Admin-only method. Performs synchronous file reads for simple debugging.
         */
        adminGetLogs(params, id, res, isAdminUser) {
            if (!isAdminUser) {
                return jsonrpc.error(res, jsonrpc.ACCESS_DENIED(), id);
            }

            const logPath = path.join(dirname, 'debug.log');
            if (!fs.existsSync(logPath)) {
                return res.json({ jsonrpc: '2.0', result: { logs: [], total: 0 }, id });
            }

            try {
                const pageSize = Math.min(Math.max(parseInt(params.pageSize) || 100, 1), 1000);
                const page = parseInt(params.page) || 1;

                const logContent = fs.readFileSync(logPath, 'utf8');
                const linesArr = logContent.split('\n').filter(l => l !== '');
                const total = linesArr.length;

                // Return most recent logs first (Tail approach)
                const start = Math.max(0, total - page * pageSize);
                const end = Math.max(0, total - (page - 1) * pageSize);
                const resultLines = linesArr.slice(start, end);

                return res.json({
                    jsonrpc: '2.0',
                    result: {
                        logs: resultLines,
                        total,
                        page,
                        pageSize,
                        pages: Math.ceil(total / pageSize)
                    },
                    id
                });
            } catch (e) {
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: 'IO_ERROR: ' + e.message }, id });
            }
        },

        /**
         * admin.log.clear
         * Purge all transient error queues from Redis.
         */
        async adminClearLogs(params, id, res, isAdminUser) {
            if (!isAdminUser) {
                return jsonrpc.error(res, jsonrpc.ACCESS_DENIED(), id);
            }

            try {
                if (redisClient && redisClient.isOpen) {
                    const keys = await redisClient.keys('ERROR:QUEUE:*');
                    if (keys.length > 0) {
                        await redisClient.del(keys);
                        logger.info(`Cleared ${keys.length} error queues`);
                    }
                }
                return res.json({ jsonrpc: '2.0', result: { success: true }, id });
            } catch (e) {
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: 'REDIS_ERROR: ' + e.message }, id });
            }
        },

        /**
         * admin.log.interaction
         * Query analyzed user interaction logs based on temporal partitioning.
         * 
         * @why Uses a monthly partitioning strategy (YYYYMM) and user ownership 
         *      filters to allow fast indexed lookups of prompt histories.
         */
        async adminGetInteractionLogs(params, id, res, isAdminUser) {
            if (!isAdminUser) {
                return jsonrpc.error(res, jsonrpc.ACCESS_DENIED(), id);
            }

            try {
                const { userId, month, limit } = params;
                if (!userId || !month) {
                    return res.json({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing userId or month (YYYYMM)' }, id });
                }

                const partitionKey = `${userId}_${month}`;
                const folder = path.join(dirname, 'logs/interactions');

                const logs = query(partitionKey, folder, limit || 50);

                return res.json({ jsonrpc: '2.0', result: logs, id });
            } catch (e) {
                logger.error(`Interaction log query failed:`, e.message);
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id });
            }
        },
        /**
         * system.config.getTaskWhitelist
         * Retrieve the current background task whitelist.
         */
        async getTaskWhitelist(params, id, res, isAdminUser) {
            if (!isAdminUser) {
                return jsonrpc.error(res, jsonrpc.ACCESS_DENIED(), id);
            }

            try {
                let whitelist = config.taskWhitelist || {};

                // Redis is the source of truth
                if (redisClient && redisClient.isOpen) {
                    const data = await redisClient.get(config.redis.taskWhitelistKey);
                    if (data) {
                        whitelist = JSON.parse(data);
                    }
                }

                return res.json({ jsonrpc: '2.0', result: whitelist, id });
            } catch (e) {
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id });
            }
        },

        /**
         * system.config.updateTaskWhitelist
         * Update the background task whitelist in Redis.
         */
        async updateTaskWhitelist(params, id, res, isAdminUser) {
            if (!isAdminUser) {
                return jsonrpc.error(res, jsonrpc.ACCESS_DENIED(), id);
            }

            const { whitelist } = params;
            if (!whitelist || typeof whitelist !== 'object') {
                return res.json({ jsonrpc: '2.0', error: { code: -32602, message: 'Invalid whitelist format' }, id });
            }

            try {
                if (redisClient && redisClient.isOpen) {
                    await redisClient.set(config.redis.taskWhitelistKey, JSON.stringify(whitelist));
                    require('./tasks').invalidate();   // bust this process's cache → change is effective now, not ≤60s later
                    logger.info('Updated Task Whitelist via API');
                    return res.json({ jsonrpc: '2.0', result: { success: true }, id });
                } else {
                    return res.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Redis unavailable' }, id });
                }
            } catch (e) {
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id });
            }
        },

        /**
         * system.config.getPermitBlacklist
         * Retrieve the method blacklist for permission assignment.
         */
        async getPermitBlacklist(params, id, res, isAdminUser) {
            if (!isAdminUser) {
                return jsonrpc.error(res, jsonrpc.ACCESS_DENIED(), id);
            }

            try {
                let blacklist = [];
                if (redisClient && redisClient.isOpen) {
                    const data = await redisClient.get(config.redis.permitBlacklistKey);
                    if (data) blacklist = JSON.parse(data);
                }
                return res.json({ jsonrpc: '2.0', result: blacklist, id });
            } catch (e) {
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id });
            }
        },

        /**
         * system.config.updatePermitBlacklist
         * Update the method blacklist for permission assignment.
         */
        async updatePermitBlacklist(params, id, res, isAdminUser) {
            if (!isAdminUser) {
                return jsonrpc.error(res, jsonrpc.ACCESS_DENIED(), id);
            }

            const { blacklist } = params;
            if (!Array.isArray(blacklist)) {
                return res.json({ jsonrpc: '2.0', error: { code: -32602, message: 'blacklist must be an array of method names' }, id });
            }

            try {
                if (redisClient && redisClient.isOpen) {
                    await redisClient.set(config.redis.permitBlacklistKey, JSON.stringify(blacklist));
                    logger.info('Updated Permit Blacklist via API');
                    return res.json({ jsonrpc: '2.0', result: { success: true }, id });
                } else {
                    return res.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Redis unavailable' }, id });
                }
            } catch (e) {
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id });
            }
        },

        /**
         * system.wal.stats.daily
         * 按日期统计 WAL 写操作数量（create / update / destroy），用于 Dashboard 系统活动图。
         * 直接读 WAL index 文件，过滤掉 op="-" 的 session/interaction 记录。
         *
         * @why WAL index 格式：stamp|op|key|logFilePath
         *      op="-" 是 Router session 日志，不是实体变更，排除后才是真实业务写量。
         */
        async walStatsDaily(params, id, res, isAdminUser) {
            if (!isAdminUser) {
                return jsonrpc.error(res, jsonrpc.ACCESS_DENIED(), id);
            }
            const days = Math.min(parseInt(params?.days) || 30, 90);
            const walBaseDir = path.join(dirname, 'logs/wal');
            const result = [];

            for (let i = days - 1; i >= 0; i--) {
                const d = new Date(Date.now() - i * 86400_000);
                const year = d.getUTCFullYear().toString();
                const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
                const dd   = String(d.getUTCDate()).padStart(2, '0');
                const dateStr  = `${year}-${mm}-${dd}`;
                const indexPath = path.join(walBaseDir, year, `${dateStr}.index`);

                const dayStartTs = new Date(dateStr + 'T00:00:00Z').getTime();
                const entry = { date: dateStr, ts: dayStartTs, create: 0, update: 0, destroy: 0, total: 0 };

                if (fs.existsSync(indexPath)) {
                    try {
                        const lines = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean);
                        for (const line of lines) {
                            const op = line.split('|')[1];
                            if (!op || op === '-') continue; // skip session/interaction logs
                            if (op === 'create')       { entry.create++;  entry.total++; }
                            else if (op === 'update')  { entry.update++;  entry.total++; }
                            else if (op === 'destroy') { entry.destroy++; entry.total++; }
                        }
                    } catch (_) { /* unreadable, leave zeros */ }
                }

                result.push(entry);
            }

            return res.json({ jsonrpc: '2.0', result, id });
        },

        /**
         * system.wal.stats.range
         * 任意时间范围内按步长统计 WAL 写操作，用于小时钻取视图。
         * @params { start: number, end: number, step: number } — 毫秒时间戳
         */
        async walStatsRange(params, id, res, isAdminUser) {
            if (!isAdminUser) {
                return res.json({ jsonrpc: '2.0', error: { code: -32005, message: 'Forbidden' }, id });
            }
            const { start, end, step } = params || {};
            if (!start || !end || !step) {
                return res.json({ jsonrpc: '2.0', error: { code: -32602, message: 'start, end, step are required' }, id });
            }

            const walBaseDir = path.join(dirname, 'logs/wal');

            // 预建 bucket
            const buckets = new Map();
            for (let ts = start; ts < end; ts += step) {
                buckets.set(ts, { ts, create: 0, update: 0, destroy: 0, total: 0 });
            }

            // 找覆盖该区间的所有 index 文件（按天）
            const cur = new Date(start);
            cur.setUTCHours(0, 0, 0, 0);
            while (cur.getTime() < end) {
                const dateStr  = cur.toISOString().slice(0, 10);
                const year     = dateStr.slice(0, 4);
                const indexPath = path.join(walBaseDir, year, `${dateStr}.index`);

                if (fs.existsSync(indexPath)) {
                    try {
                        const lines = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean);
                        for (const line of lines) {
                            const parts = line.split('|');
                            const stamp = parseInt(parts[0]);
                            const op    = parts[1];
                            if (!stamp || !op || op === '-') continue;
                            if (stamp < start || stamp >= end) continue;

                            const bucketTs = Math.floor((stamp - start) / step) * step + start;
                            const bucket   = buckets.get(bucketTs);
                            if (!bucket) continue;

                            if (op === 'create')       { bucket.create++; bucket.total++; }
                            else if (op === 'update')  { bucket.update++; bucket.total++; }
                            else if (op === 'destroy') { bucket.destroy++; bucket.total++; }
                        }
                    } catch (_) { /* skip */ }
                }
                cur.setUTCDate(cur.getUTCDate() + 1);
            }

            return res.json({ jsonrpc: '2.0', result: Array.from(buckets.values()), id });
        },

        /**
         * system.config.getRateLimits
         * Retrieve the current global rate limit configuration from Redis.
         */
        async getRateLimits(params, id, res, isAdminUser) {
            if (!isAdminUser) {
                return jsonrpc.error(res, jsonrpc.ACCESS_DENIED(), id);
            }

            try {
                let rules = config.rateLimits || {};
                if (redisClient && redisClient.isOpen) {
                    const data = await redisClient.get(config.redis.rateLimitsKey);
                    if (data) {
                        rules = JSON.parse(data);
                    }
                }
                return res.json({ jsonrpc: '2.0', result: rules, id });
            } catch (e) {
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id });
            }
        },

        /**
         * system.config.updateRateLimits
         * Update the global rate limit configuration in Redis.
         */
        async updateRateLimits(params, id, res, isAdminUser) {
            if (!isAdminUser) {
                return jsonrpc.error(res, jsonrpc.ACCESS_DENIED(), id);
            }

            const { rules } = params;
            if (!rules || typeof rules !== 'object') {
                return res.json({ jsonrpc: '2.0', error: { code: -32602, message: 'Invalid rules format' }, id });
            }

            try {
                if (redisClient && redisClient.isOpen) {
                    await redisClient.set(config.redis.rateLimitsKey, JSON.stringify(rules));
                    require('./ratelimit').invalidate();   // bust this process's cache → change is effective now, not ≤60s later
                    logger.info('Updated Rate Limits via API');
                    return res.json({ jsonrpc: '2.0', result: { success: true }, id });
                } else {
                    return res.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Redis unavailable' }, id });
                }
            } catch (e) {
                return res.json({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id });
            }
        }
    };
}

module.exports = { createSystemHandlers };
