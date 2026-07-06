const crypto = require('crypto');
const clock = require('../../../library/clock');
const jsonrpc = require('../handlers/jsonrpc');

/**
 * Review queue — deliveries a source's `dataSchema` rejects (ingest.js) land here
 * instead of being silently dropped: an undeclared field or a declared-field type/
 * pattern mismatch is exactly the shape a prompt-injection attempt would take
 * (toFix.md "AI 当执行器" — unexpected/extra content trying to reach a downstream
 * decision prompt), so it's the highest-value signal to put in front of a human
 * rather than auto-discard. A human calls approve() (emits it, unchanged) or
 * discard() (drops it, unchanged) — see ingress.review.* in index.js.
 *
 * Bounded Redis list (notification/logic/deadletter.js pattern) — a transient
 * operational queue, not a durable business entity, so no Entity Factory here.
 */
module.exports = (redis, { config, relay, source }) => {
    const KEY = config.ingest.reviewQueueKey;
    const MAXLEN = config.ingest.reviewMaxlen;

    async function push({ sourceId, source: sourceName, requestId, data, violations }) {
        const reviewId = 'rvw_' + crypto.randomBytes(8).toString('hex');
        const entry = { reviewId, sourceId, source: sourceName, requestId, data: data ?? {}, violations, rejectedAt: clock.now() };
        await redis.rPush(KEY, JSON.stringify(entry));
        // Bound — under sustained abuse the oldest held reviews fall off rather than
        // growing this list without limit (same tradeoff as every other DLQ in SOLO).
        await redis.lTrim(KEY, -MAXLEN, -1);
        return reviewId;
    }

    async function list({ page = 1, pageSize = config.pageSize } = {}) {
        const total = await redis.lLen(KEY);
        const start = (Math.max(1, page) - 1) * pageSize;
        const raw = await redis.lRange(KEY, start, start + pageSize - 1);
        const items = raw.map((s) => { try { return JSON.parse(s); } catch { return { raw: s }; } });
        return { items, total };
    }

    async function findAndRemove(reviewId) {
        const entries = await redis.lRange(KEY, 0, -1);
        for (const s of entries) {
            let entry;
            try { entry = JSON.parse(s); } catch { continue; }
            if (entry.reviewId !== reviewId) continue;
            if (!(await redis.lRem(KEY, 1, s))) continue;
            return entry;
        }
        return null;
    }

    // Human reviewed a held delivery and decided it's legitimate — emit it now.
    // Bypasses dataSchema on purpose: the human IS the check at this point.
    async function approve({ reviewId } = {}) {
        if (!reviewId) throw jsonrpc.MISSING_PARAM('reviewId');
        const entry = await findAndRemove(reviewId);
        if (!entry) throw jsonrpc.NOT_FOUND('review entry');
        await relay.call('event.emit', {
            stream: source.streamFor(entry.source),
            type: config.ingest.eventType,
            actor: `webhook:${entry.source}`,
            payload: { request_id: entry.requestId, data: entry.data },
        });
        await source.recordFire(entry.sourceId, { outcome: 'accepted' });
        return { ok: true, reviewId, stream: source.streamFor(entry.source), request_id: entry.requestId };
    }

    // Human reviewed a held delivery and decided it's bad — drop it, never emitted.
    async function discard({ reviewId } = {}) {
        if (!reviewId) throw jsonrpc.MISSING_PARAM('reviewId');
        const entry = await findAndRemove(reviewId);
        if (!entry) throw jsonrpc.NOT_FOUND('review entry');
        return { ok: true, reviewId };
    }

    return { push, list, approve, discard };
};
