const crypto = require('crypto');
const { createLogger } = require('../../../library/logger');
const jsonrpc = require('../handlers/jsonrpc');

const logger = createLogger('notification');

function generateId(length = 12) {
    return crypto.randomBytes(Math.ceil(length * 0.75)).toString('base64')
        .replace(/[+/=]/g, '').slice(0, length);
}

module.exports = (redis, config) => {
    const R = config.redis;

    async function send({ targetId, type, payload, sourceId = null, ref = null } = {}) {
        if (!targetId) throw jsonrpc.MISSING_PARAM('targetId');
        if (!type)     throw jsonrpc.MISSING_PARAM('type');

        const id = generateId(config.idLengths.message);
        const createdAt = Date.now();

        // Idempotency: when the caller supplies a stable `ref` (e.g. the source stream
        // entry id), a redelivery/retry of the same (targetId, ref) must NOT create a
        // second inbox message. Claim the dedup key atomically (SET NX); if it's already
        // held, this is a duplicate — return the existing message id, do nothing else.
        const dedupKey = ref ? R.dedupPrefix + targetId + ':' + ref : null;
        if (dedupKey) {
            const claimed = await redis.set(dedupKey, id, { NX: true, EX: config.dedupTtlSec });
            if (claimed === null) {
                const existing = await redis.get(dedupKey);
                return { id: existing, status: 'duplicate', queued: 0 };
            }
        }

        const msg = {
            id,
            targetId,
            type,
            payload: payload || {},
            sourceId,
            ref,
            status: 'unread',
            readAt: null,
            createdAt
        };

        const multi = redis.multi();
        multi.set(R.msgPrefix + id, JSON.stringify(msg));
        multi.zAdd(R.inboxPrefix + targetId, { score: createdAt, value: id });
        multi.zAdd(R.indexKey, { score: createdAt, value: id });
        await multi.exec();

        const rules = await loadConfig(targetId);
        const channels = matchRules(rules, type);
        for (const r of channels) {
            if (r.channel === 'none') continue;
            const task = { messageId: id, channel: r.channel, params: r.params || {} };
            await redis.rPush(R.queuePending, JSON.stringify(task));
        }

        return { id, status: 'stored', queued: channels.length };
    }

    async function inboxList({ targetId, unreadOnly = true, page = 1, pageSize = config.pageSize } = {}) {
        if (!targetId) throw jsonrpc.MISSING_PARAM('targetId');

        const offset = (Math.max(1, page) - 1) * pageSize;
        const ids = await redis.zRange(
            R.inboxPrefix + targetId,
            offset,
            offset + pageSize - 1,
            { REV: true }
        );

        if (ids.length === 0) {
            const total = await redis.zCard(R.inboxPrefix + targetId);
            return { items: [], total };
        }

        const raw = await redis.mGet(ids.map(i => R.msgPrefix + i));
        let items = raw.filter(Boolean).map(JSON.parse);
        if (unreadOnly) items = items.filter(m => m.status === 'unread');

        const total = await redis.zCard(R.inboxPrefix + targetId);
        return { items, total };
    }

    async function inboxAck({ ids } = {}) {
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            throw jsonrpc.MISSING_PARAM('ids');
        }

        const now = Date.now();
        let acked = 0;
        for (const id of ids) {
            const key = R.msgPrefix + id;
            const raw = await redis.get(key);
            if (!raw) continue;
            const msg = JSON.parse(raw);
            if (msg.status === 'read') continue;
            msg.status = 'read';
            msg.readAt = now;
            await redis.set(key, JSON.stringify(msg));
            acked++;
        }
        return { acked };
    }

    async function loadConfig(targetId) {
        const raw = await redis.get(R.configPrefix + targetId);
        if (!raw) return [];
        try {
            const cfg = JSON.parse(raw);
            return Array.isArray(cfg.rules) ? cfg.rules : [];
        } catch (e) {
            logger.warn(`Malformed config for ${targetId}: ${e.message}`);
            return [];
        }
    }

    function matchRules(rules, type) {
        return rules.filter(r => r.type === type || r.type === '*');
    }

    return { send, inboxList, inboxAck };
};
