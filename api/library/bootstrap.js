/**
 * library/bootstrap.js — 微服务通用启动工具
 *
 * 用法（在 handlers/bootstrap.js 里）：
 *
 *   const config = require('../config');
 *   const { createBootstrap } = require('../../../library/bootstrap');
 *
 *   const { initializeRedis, ensureDefaultCategories } = createBootstrap(config);
 *
 *   // 服务独有步骤直接追加导出：
 *   module.exports = { initializeRedis, ensureDefaultCategories, myExtraStep };
 *
 * 调用方 index.js 无需任何改动。
 */

const redis = require('redis');
const { createLogger } = require('./logger');
const { createWalArchiver } = require('./walarchiver');

function createBootstrap(config) {
    const logger = createLogger(config.serviceName || 'service');
    // 语义 key：优先读 config.redis.semanticPrefix，兼容 core/ 服务
    const semanticPrefix = config.redis?.semanticPrefix || 'SYSTEM:SEMANTIC:';

    async function persistSemantic(redisClient, serviceName) {
        try {
            const key = `${semanticPrefix}${serviceName}`;
            const payload = { source: 'config', ...config.description };
            await redisClient.json.set(key, '$', payload);
            logger.info('Semantic description persisted');
        } catch (e) {
            logger.error('Failed to persist semantic:', e.message);
        }
    }

    async function initializeRedis(serviceName) {
        if (!config.redisUrl) {
            throw new Error(`[${serviceName}] FATAL: Redis URL not configured. Set REDIS_URL environment variable.`);
        }

        const redisClient = redis.createClient({ url: config.redisUrl });
        redisClient.on('error', (err) => logger.error('Redis Client Error', err));
        await redisClient.connect();
        logger.info('Redis connected');

        await persistSemantic(redisClient, serviceName);

        // WAL archiver: drain the atomic entity ledger (WAL:STREAM) into the on-disk
        // file WAL (disaster-recovery copy). All services share one consumer group —
        // work is split, each entry archived exactly once. Opt out: WAL_ARCHIVER=off.
        if (process.env.WAL_ARCHIVER !== 'off') {
            try {
                const archiver = createWalArchiver(redisClient, { consumer: `${serviceName}:${process.pid}` });
                archiver.start().catch((e) => logger.error('WAL archiver failed to start:', e.message));
            } catch (e) {
                logger.error('WAL archiver init error:', e.message);
            }
        }

        return redisClient;
    }

    async function ensureDefaultCategories(redisClient, serviceName) {
        if (!config.seeds?.categories) return;

        const idxKey = `${serviceName.toUpperCase()}:CONFIG:CATEGORY_IDX`;
        for (const cat of config.seeds.categories) {
            const key = `${serviceName.toUpperCase()}:CONFIG:CATEGORY:${cat.key}`;
            const exists = await redisClient.exists(key);
            if (!exists) {
                logger.warn(`[Bootstrap] Seed: "${cat.key}" category missing. Creating defaults...`);
                const now = Date.now();
                const items = (cat.items || []).map(item => ({
                    id: item.id, label: item.label,
                    desc: item.desc || '', parentId: item.parentId || null,
                    createdAt: now,
                }));
                await redisClient.set(key, JSON.stringify({
                    key: cat.key, type: cat.type || 'LIST',
                    scope: cat.scope || 'LOCAL', desc: cat.desc || '',
                    status: cat.status || 'ACTIVE',
                    createdAt: now, updatedAt: now, items,
                }));
                logger.info(`[Bootstrap] Seed: "${cat.key}" category created.`);
            }
            // Always index the seeded category. category.list() walks CATEGORY_IDX, so a data
            // key that isn't in the index is invisible to the API. sAdd is idempotent and also
            // self-heals categories seeded before this line existed (e.g. the ROLE→POWER rename).
            await redisClient.sAdd(idxKey, key);
        }
    }

    return { initializeRedis, ensureDefaultCategories };
}

module.exports = { createBootstrap };
