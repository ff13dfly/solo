const jsonrpc = require('../../../library/jsonrpc');
const { WAL } = require('../../../library/constants');

/**
 * Event-bus read endpoints (admin observability).
 * @why The EVENT BUS portal page could list runs but never the events themselves —
 *      debugging "did EVENT:FULFILLMENT:TRANSITIONED actually fire?" meant redis-cli.
 *      Two read-only views over the bus:
 *        streams() — discover EVENT:* streams (bounded SCAN, type-filtered)
 *        recent()  — last N entries of one stream, newest first
 * @attention Read-only by design: no xAdd / xDel / group mutation lives here. The
 *      stream key must start with EVENT: so this can never page arbitrary keys.
 */
module.exports = (redis, { config }) => {
    const MAX_STREAMS = 200;   // discovery bound — dev/ops scale, not a data API
    const MAX_COUNT   = 200;
    const SCAN_BATCH  = 1000;  // xRange page size for the full byTrace scan
    const MAX_SCAN    = 50000; // per-stream scan budget — a runaway-stream backstop (flags truncated)

    // Redis stream entries are flat string maps; lift JSON fields if present.
    // (Same semantics as the consumer's parseEvent in logic/stream.js.)
    function liftJson(message) {
        const out = { ...message };
        for (const k of Object.keys(out)) {
            const v = out[k];
            if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
                try { out[k] = JSON.parse(v); } catch (_) { /* keep string */ }
            }
        }
        return out;
    }

    /** List EVENT:* streams on the bus with length + last-entry recency. */
    async function streams() {
        const keys = [];
        for await (const key of redis.scanIterator({ MATCH: 'EVENT:*', TYPE: 'stream', COUNT: 100 })) {
            // node-redis v4 yields strings; v5 yields batches — normalize both.
            if (Array.isArray(key)) keys.push(...key); else keys.push(key);
            if (keys.length >= MAX_STREAMS) break;
        }
        const items = [];
        for (const key of keys.slice(0, MAX_STREAMS)) {
            const [length, last] = await Promise.all([
                redis.xLen(key),
                redis.xRevRange(key, '+', '-', { COUNT: 1 }),
            ]);
            const lastEntry = last && last[0];
            items.push({
                key,
                length,
                lastId: lastEntry ? lastEntry.id : null,
                // stream entry ids are "<ms>-<seq>" — surface the ms part for display
                lastAt: lastEntry ? Number(String(lastEntry.id).split('-')[0]) || null : null,
            });
        }
        items.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
        return { items, truncated: keys.length >= MAX_STREAMS };
    }

    /** Read the last `count` entries of one EVENT:* stream, newest first. */
    async function recent({ stream, count } = {}) {
        if (!stream || typeof stream !== 'string') throw jsonrpc.MISSING_PARAM('stream');
        if (!stream.startsWith('EVENT:')) {
            throw jsonrpc.INVALID_PARAM('stream must be an EVENT:* key');
        }
        const n = Math.max(1, Math.min(Number(count) || 50, MAX_COUNT));
        const raw = await redis.xRevRange(stream, '+', '-', { COUNT: n });
        const entries = (raw || []).map((e) => ({
            id: e.id,
            at: Number(String(e.id).split('-')[0]) || null,
            ...liftJson(e.message || {}),
        }));
        return { stream, entries };
    }

    // Events carry `trace_id` on the envelope; entity-WAL rows carry `trace`. Match both.
    const traceOf = (lifted) => lifted.trace_id || lifted.trace || (lifted.payload && lifted.payload.trace_id);

    /** Full (batched, budget-capped) scan of one stream collecting entries for a trace_id. */
    async function scanStreamForTrace(stream, traceId, budget) {
        const matches = [];
        let cursor = '-';
        let scanned = 0;
        while (scanned < budget) {
            const batch = await redis.xRange(stream, cursor, '+', { COUNT: SCAN_BATCH });
            if (!batch || batch.length === 0) break;
            for (const e of batch) {
                const lifted = { id: e.id, at: Number(String(e.id).split('-')[0]) || null, ...liftJson(e.message || {}) };
                if (traceOf(lifted) === traceId) matches.push({ stream, ...lifted });
            }
            scanned += batch.length;
            if (batch.length < SCAN_BATCH) break;            // reached the end of the stream
            cursor = '(' + batch[batch.length - 1].id;       // exclusive: resume past the last id
        }
        return { matches, truncated: scanned >= budget };
    }

    /**
     * byTrace — EVERY event of one trace_id across all EVENT:* streams, chronological.
     * @why recent() only returns the last N of ONE stream, so reconstructing a whole chain
     *      client-side (fan out + window-filter) silently MISSES events older than the window.
     *      This scans each stream's FULL history server-side → a complete, single-call trace
     *      view. Read-only; bounded by MAX_SCAN per stream (flags `truncated` if it ever hits).
     */
    async function byTrace({ traceId } = {}) {
        if (!traceId || typeof traceId !== 'string') throw jsonrpc.MISSING_PARAM('traceId');
        const keys = [];
        for await (const key of redis.scanIterator({ MATCH: 'EVENT:*', TYPE: 'stream', COUNT: 100 })) {
            if (Array.isArray(key)) keys.push(...key); else keys.push(key);
            if (keys.length >= MAX_STREAMS) break;
        }
        let truncated = keys.length >= MAX_STREAMS;
        const events = [];
        // Also scan the entity-WAL ledger (entity writes carry `trace`) — a different key family
        // than EVENT:*, added explicitly. NOTE: WAL is a bounded ring buffer (MAXLEN), so only
        // recent entity writes are here; older ones live in the file archive (an honest gap).
        const allStreams = [...keys.slice(0, MAX_STREAMS), WAL.STREAM];
        for (const stream of allStreams) {
            const r = await scanStreamForTrace(stream, traceId, MAX_SCAN);
            events.push(...r.matches);
            if (r.truncated) truncated = true;
        }
        events.sort((a, b) => (a.at || 0) - (b.at || 0));    // chronological across streams
        return { traceId, events, streamsScanned: allStreams.length, truncated };
    }

    return { streams, recent, byTrace };
};
