const { createLogger } = require('../../../library/logger');
const logger = createLogger('notification-worker');

// Permanent JSON-RPC failures — retrying cannot fix a method that doesn't exist,
// invalid params, a missing target, or a permission denial. Straight to DLQ.
const PERMANENT_RPC_CODES = new Set([-32600, -32601, -32602, -32002, -32003]);

// DLQ hard cap: Redis list with no bound = unbounded poison accumulation.
// Oldest entries are trimmed away first (audit copy of the message stays in
// NOTIFICATION:MSG; the DLQ entry is just the retry handle).
const DLQ_MAXLEN = (() => {
    const n = parseInt(process.env.NOTIFICATION_DLQ_MAXLEN, 10);
    return Number.isFinite(n) && n > 0 ? n : 1000;
})();

module.exports = (redis, config, { relay, message = null } = {}) => {
    const R = config.redis;
    const W = config.worker;
    let running = false;
    let stopRequested = false;

    // toFix §6.5 — minimal alerting tier (no Prometheus needed): the delivery worker
    // periodically sweeps the fleet's dead-letter depths (all queues live in the
    // same shared Redis) and writes an ops-inbox alert when one crosses the
    // threshold. notification owns the inbox, so this is an in-process write
    // (message.send) — no relay hop. Re-alerting is throttled by message.send's
    // ref-dedup window; /metrics carries the same gauges for real monitoring.
    const DLQ_WATCH = [
        { queue: 'notification_deadletter', kind: 'list',   key: R.queueDead },
        { queue: 'nexus_dlq',               kind: 'stream', key: 'NEXUS:DLQ' },
        { queue: 'orchestrator_deadletter', kind: 'list',   key: 'ORCHESTRATOR:RUNQ:DEADLETTER' },
    ];
    let lastDlqScanAt = 0;

    async function scanDlqDepths(now = Date.now()) {
        if (!message) return [];
        if (now - lastDlqScanAt < W.dlqAlertScanMs) return [];
        lastDlqScanAt = now;

        const alerted = [];
        for (const w of DLQ_WATCH) {
            let depth = -1;
            try {
                depth = w.kind === 'stream' ? await redis.xLen(w.key) : await redis.lLen(w.key);
            } catch (_) { continue; }   // queue unreadable → skip, next sweep retries

            if (depth >= W.dlqAlertThreshold) {
                try {
                    const res = await message.send({
                        targetId: W.opsInbox,
                        type: 'ops.dlq_depth',
                        payload: { queue: w.queue, depth, threshold: W.dlqAlertThreshold, scannedAt: now },
                        sourceId: 'notification',
                        ref: 'dlq_depth:' + w.queue,   // dedup window throttles re-alerts
                    });
                    if (res && res.status !== 'duplicate') alerted.push({ queue: w.queue, depth });
                } catch (e) {
                    logger.warn(`dlq alert for ${w.queue} failed: ${e.message}`);
                }
            }
        }
        return alerted;
    }

    // Exponential backoff with a hard cap. `attempts` is the count of failures so far.
    function backoffMs(attempts) {
        return Math.min(W.retryBaseMs * (2 ** attempts), W.retryMaxMs);
    }

    function isPermanent(err) {
        if (err && PERMANENT_RPC_CODES.has(err.rpcCode)) return true;
        const s = err && err.httpStatus;
        if (Number.isInteger(s) && s >= 400 && s < 500 && s !== 408 && s !== 429) return true;
        return false;
    }

    // Resolve the outbound address: explicit rule params win (special cases);
    // otherwise the user's profile contact field is the DEFAULT outbound address;
    // absent → null = degrade to inbox (the copy written at send() time), NOT a failure.
    async function resolveAddress(channel, params, targetId) {
        if (channel === 'email') {
            if (params.to) return { to: params.to };
            const prof = await relay.call('user.profile', { uid: targetId }).catch(() => null);
            return (prof && prof.email) ? { to: prof.email } : null;
        }
        if (channel === 'sms') {
            if (params.phone) return { phone: params.phone };
            const prof = await relay.call('user.profile', { uid: targetId }).catch(() => null);
            return (prof && prof.phone) ? { phone: prof.phone } : null;
        }
        if (channel === 'webhook') {
            // Machine target — the URL lives in the rule (config.set enforces it).
            return params.url ? {} : null;
        }
        return {};
    }

    // Per-channel gateway params: the message's OWN payload (the actual content —
    // previously dropped entirely) merges over the rule's static params.
    function buildParams(channel, params, msg, address) {
        const payload = msg.payload || {};
        if (channel === 'email') {
            return {
                ...params,
                to: address.to || params.to,
                subject: payload.subject || params.subject || `[${msg.type}]`,
                content: payload.content || params.content || JSON.stringify(payload),
            };
        }
        if (channel === 'sms') {
            return {
                ...params,
                phone: address.phone || params.phone,
                variables: { ...(params.variables || {}), ...(payload.variables || {}) },
            };
        }
        if (channel === 'webhook') {
            return { ...params, type: msg.type, targetId: msg.targetId, payload };
        }
        return { ...params, targetId: msg.targetId, type: msg.type, payload };
    }

    // Returns { ok } — ok:false means retry (or { permanent:true } → straight DLQ).
    async function deliver(task) {
        const { messageId, channel, params = {} } = task;
        const raw = await redis.get(R.msgPrefix + messageId);
        if (!raw) {
            // Message gone (acked-then-purged or never stored). Nothing to deliver.
            logger.warn(`Message ${messageId} not found; dropping queue entry`);
            return { ok: true };
        }

        if (!relay) {
            // No bot token injected yet (notification.token.set). Retry later instead of dropping.
            return { ok: false, reason: 'no-relay' };
        }

        const msg = JSON.parse(raw);
        try {
            const address = await resolveAddress(channel, params, msg.targetId);
            if (address === null) {
                // No outbound address anywhere → the inbox copy IS the delivery.
                logger.warn('deliver.degraded_to_inbox', { messageId, channel, targetId: msg.targetId });
                return { ok: true, degraded: true };
            }

            const result = await relay.call(`gateway.${channel}.send`, buildParams(channel, params, msg, address));

            if (result && result.provider === 'mock') {
                // Honesty: the gateway fell back to its mock (no SMTP/SMS credentials) —
                // nothing actually left the system. Ack (retry won't conjure credentials)
                // but record it as mocked, never as a real delivery.
                logger.warn('deliver.mocked', { messageId, channel, gatewayId: result?.messageId });
                return { ok: true, mocked: true };
            }

            logger.info('deliver.ok', { messageId, channel, gatewayId: result?.id || result?.messageId });
            return { ok: true };
        } catch (err) {
            if (isPermanent(err)) {
                return { ok: false, permanent: true, reason: `permanent: ${err.rpcCode || err.httpStatus} ${err.message}` };
            }
            return { ok: false, reason: err.code || err.message };
        }
    }

    async function handleFailure(task, reason, permanent = false) {
        const attempts = (task.attempts || 0) + 1;

        if (permanent || attempts >= W.maxRetries) {
            const dead = { ...task, attempts, lastError: reason, permanent, failedAt: Date.now() };
            await redis.rPush(R.queueDead, JSON.stringify(dead));
            // Bound the DLQ — oldest entries fall off; message bodies remain queryable.
            await redis.lTrim(R.queueDead, -DLQ_MAXLEN, -1);
            logger.error('deliver.deadletter', { messageId: task.messageId, channel: task.channel, attempts, permanent, reason });
            return;
        }

        const delay = backoffMs(attempts);
        const next = { ...task, attempts };
        await redis.zAdd(R.queueRetry, { score: Date.now() + delay, value: JSON.stringify(next) });
        logger.warn('deliver.retry', { messageId: task.messageId, channel: task.channel, attempts, dueInMs: delay, reason });
    }

    async function processOne(task) {
        const res = await deliver(task);
        if (!res.ok) await handleFailure(task, res.reason, res.permanent === true);
    }

    // Move retry-queue tasks whose backoff has elapsed back onto the pending queue.
    async function promoteDueRetries(client) {
        const due = await client.zRangeByScore(R.queueRetry, 0, Date.now());
        for (const value of due) {
            // zRem first so a task is promoted at most once even under a racing worker.
            if (await client.zRem(R.queueRetry, value)) {
                await client.rPush(R.queuePending, value);
            }
        }
    }

    async function loop(client) {
        running = true;
        logger.info('Notification worker started');
        while (!stopRequested) {
            try {
                await promoteDueRetries(redis);
                await scanDlqDepths();
                const result = await client.blPop(R.queuePending, W.blpopTimeout);
                if (!result) continue;
                const task = JSON.parse(result.element);
                await processOne(task);
            } catch (err) {
                logger.error('Worker error:', err);
                await new Promise(r => setTimeout(r, W.retryBackoffMs));
            }
        }
        running = false;
        logger.info('Notification worker stopped');
    }

    async function start() {
        if (running) return;
        // Worker needs its own connection so blPop doesn't block JSON-RPC traffic.
        const client = redis.duplicate();
        await client.connect();
        loop(client).catch(err => logger.error('Worker loop crashed:', err));
    }

    async function stop() {
        stopRequested = true;
    }

    return { start, stop, processOne, promoteDueRetries, scanDlqDepths };
};
