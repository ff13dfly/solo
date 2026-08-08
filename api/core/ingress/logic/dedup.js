/**
 * Dedup — idempotency on (source, request_id).
 *
 * Atomic SET NX EX: the first delivery wins the key and proceeds; any retry /
 * concurrent duplicate (external systems redeliver) finds the key set and is
 * skipped. TTL = the source's dedup window (covers the external retry period).
 *
 * request_id is listener-assigned and must be stable across redeliveries of the
 * same external event (e.g. GitHub's X-GitHub-Delivery), so the same logical
 * delivery maps to the same key.
 */
module.exports = (redis, { config }) => {
    const PREFIX = config.ingest.dedupPrefix;

    // Returns true if this (source, request_id) is NEW (claimed now);
    // false if it was already seen within the TTL window (duplicate).
    async function claim(sourceName, requestId, ttlSec) {
        const key = `${PREFIX}${sourceName}:${requestId}`;
        const res = await redis.set(key, '1', { NX: true, EX: ttlSec });
        return res === 'OK';
    }

    // Undo a claim when the delivery that claimed it never actually made it onto
    // the event bus (Router blocked/deduped it downstream of us). Without this,
    // a recoverable failure becomes a PERMANENT loss: the external sender's retry
    // finds the key still set and is told "duplicate" for something that in truth
    // never landed anywhere.
    async function release(sourceName, requestId) {
        await redis.del(`${PREFIX}${sourceName}:${requestId}`);
    }

    return { claim, release };
};
