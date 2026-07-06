const jsonrpc = require('../handlers/jsonrpc');

module.exports = (redis, config) => {
    const R = config.redis;

    async function list({ page = 1, pageSize = config.pageSize } = {}) {
        const total = await redis.lLen(R.queueDead);
        const start = (Math.max(1, page) - 1) * pageSize;
        const raw = await redis.lRange(R.queueDead, start, start + pageSize - 1);
        const items = raw.map(s => {
            try { return JSON.parse(s); } catch { return { raw: s }; }
        });
        return { items, total };
    }

    // Loop guard: each requeue stamps a counter — a poison task that keeps dying can
    // only be re-burned MAX_REQUEUES times; after that it stays in the DLQ for a human.
    // (Previously requeue({all:true}) reset attempts:0 unconditionally → infinite re-burn.)
    const MAX_REQUEUES = 3;

    async function requeue({ messageId, all = false } = {}) {
        if (!messageId && !all) throw jsonrpc.MISSING_PARAM('messageId');

        const entries = await redis.lRange(R.queueDead, 0, -1);
        let requeued = 0;
        let exhausted = 0;
        for (const s of entries) {
            let task;
            try { task = JSON.parse(s); } catch { continue; }
            if (!all && task.messageId !== messageId) continue;
            if ((task.requeues || 0) >= MAX_REQUEUES) { exhausted++; continue; }

            // Remove this exact dead entry, then re-enqueue a fresh task (attempts reset,
            // requeue counter carried forward).
            if (!(await redis.lRem(R.queueDead, 1, s))) continue;
            const fresh = {
                messageId: task.messageId, channel: task.channel, params: task.params || {},
                attempts: 0, requeues: (task.requeues || 0) + 1,
            };
            await redis.rPush(R.queuePending, JSON.stringify(fresh));
            requeued++;
        }
        return { requeued, exhausted };
    }

    return { list, requeue };
};
