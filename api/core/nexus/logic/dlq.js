/**
 * nexus/logic/dlq.js — dead-letter queue for events the stream consumer could not
 * deliver after maxDeliveries attempts (context.md §7.3).
 *
 * Entries live in the NEXUS:DLQ stream as flat field maps:
 *   { sourceStream, sourceId, event(JSON of the original flat fields), attempts, failedAt }
 * `nexus.dlq.retry` re-XADDs the original event back onto its source stream (so the
 * consumer picks it up fresh) and removes the DLQ entry. Admin-only (wired in index.js).
 */
const jsonrpc = require('../handlers/jsonrpc');

module.exports = (redis, config) => {
    const DLQ = config.redis.dlqStream;

    function shape(entry) {
        const m = entry.message || {};
        let event = m.event;
        try { event = JSON.parse(m.event); } catch (_) { /* keep raw string */ }
        return {
            id: entry.id,
            sourceStream: m.sourceStream,
            sourceId: m.sourceId,
            attempts: Number(m.attempts) || 0,
            failedAt: Number(m.failedAt) || null,
            event,
        };
    }

    async function list({ page = 1, pageSize = 50 } = {}) {
        // DLQ is bounded operationally; read newest-first and paginate in memory.
        const entries = await redis.xRange(DLQ, '-', '+');
        const items = entries.map(shape).reverse();
        const total = items.length;
        const offset = (Math.max(1, page) - 1) * pageSize;
        return { items: items.slice(offset, offset + pageSize), total };
    }

    async function retry({ id } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const entries = await redis.xRange(DLQ, id, id);
        if (!entries.length) throw jsonrpc.NOT_FOUND(`dlq entry ${id}`);

        const m = entries[0].message || {};
        if (!m.sourceStream) throw jsonrpc.INTERNAL_ERROR('dlq entry missing sourceStream');
        let fields;
        try { fields = JSON.parse(m.event); } catch (_) { throw jsonrpc.INTERNAL_ERROR('dlq entry has unparseable event'); }
        if (!fields || typeof fields !== 'object') throw jsonrpc.INTERNAL_ERROR('dlq entry event is not a field map');

        // Re-emit the ORIGINAL event onto its source stream → consumer re-processes it
        // fresh (new stream id, attempt counter reset). Then drop the DLQ entry.
        const newId = await redis.xAdd(m.sourceStream, '*', fields);
        await redis.xDel(DLQ, id);
        return { retried: true, sourceStream: m.sourceStream, newId };
    }

    return { list, retry };
};
