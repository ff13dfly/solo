/**
 * WAL Archiver — drains the atomic entity ledger (Redis Stream, entity.js walMulti)
 * into the on-disk file WAL (logger.insert), preserving the exact file layout the
 * disaster-recovery replay (library/tests/wal-recovery.test.js) and e2e/lib/wal.js
 * already read.
 *
 * Two-tier ledger design:
 *   hot  — WAL.STREAM in Redis: written atomically WITH the data (same MULTI),
 *          bounded ring buffer (XADD MAXLEN ~), survives process crashes.
 *   cold — hash-sharded files via logger.insert(): second failure domain
 *          (survives Redis destruction), full history, replayable.
 *
 * Consumer-group semantics:
 *   - group WAL.GROUP, consumer name `${service}:${pid}` — every service started
 *     through library/bootstrap runs one; they share the work (an entry is archived
 *     exactly once). Coverage is complete as long as ≥1 archiver runs per Redis.
 *   - group created at '0' so entries written before the first archiver boots are
 *     still archived.
 *   - xAck only after the file append; crash between append and ack → entry is
 *     re-delivered via xAutoClaim → at-least-once: a duplicate file line is
 *     possible, a missing one is not. Rows carry `ref` (stream entry id) so
 *     duplicates are detectable; replay-by-stamp is idempotent (sets same value).
 *   - NOGROUP (stream trimmed/deleted) → recreate group and continue, never wedge
 *     (mirrors orchestrator matcher / nexus stream recovery).
 *
 * Honest boundary: if Redis is destroyed, entries not yet drained (typically a
 * sub-second window) are lost to the file tier. Data durability itself is Redis
 * AOF's job — the file tier is the independent audit/forensics copy.
 */
const logger = require('./logger');
const { WAL } = require('./constants');

const log = logger.createLogger('wal-archiver');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createWalArchiver(redis, {
    stream = WAL.STREAM,
    group = WAL.GROUP,
    consumer = `archiver:${process.pid}`,
    blockMs = 2000,
    batchSize = 100,
    // pending entries idle longer than this are reclaimed from dead consumers
    claimIdleMs = 60000,
} = {}) {
    let stopRequested = false;
    let client = null;
    let loopPromise = null;

    async function ensureGroup(c) {
        try {
            await c.xGroupCreate(stream, group, '0', { MKSTREAM: true });
            log.info('archiver.group.created', { stream, group });
        } catch (err) {
            if (!String(err).includes('BUSYGROUP')) throw err;
        }
    }

    // Stream fields are flat strings — rebuild the row logger.insert/query expects.
    function toRow(id, message) {
        const parse = (s) => { try { return JSON.parse(s); } catch (_) { return s; } };
        return {
            op: message.op || null,
            key: message.key,
            before: parse(message.before ?? 'null'),
            after: parse(message.after ?? 'null'),
            user: message.user || null,
            txn: message.txn || null,
            trace: message.trace || null,
            stamp: parseInt(message.stamp, 10) || Date.now(),
            ref: id,
        };
    }

    function archiveBatch(entries) {
        let archived = 0;
        for (const { id, message } of entries) {
            if (!message || !message.key) continue; // malformed — ack below, nothing to archive
            logger.insert(message.key, toRow(id, message));
            archived++;
        }
        return archived;
    }

    // One read + archive + ack cycle. Exposed for tests.
    async function drainOnce(c) {
        // Reclaim entries stuck on dead consumers first (at-least-once delivery).
        let claimed = [];
        try {
            const res = await c.xAutoClaim(stream, group, consumer, claimIdleMs, '0-0', { COUNT: batchSize });
            claimed = (res && res.messages) ? res.messages.filter(Boolean) : [];
        } catch (err) {
            if (!String(err).includes('NOGROUP')) throw err;
            await ensureGroup(c);
            return 0;
        }

        let fresh = [];
        const result = await c.xReadGroup(group, consumer, [{ key: stream, id: '>' }],
            { COUNT: batchSize, BLOCK: blockMs });
        if (result) {
            for (const s of result) fresh = fresh.concat(s.messages);
        }

        const entries = claimed.concat(fresh);
        if (entries.length === 0) return 0;

        const archived = archiveBatch(entries);
        await c.xAck(stream, group, entries.map((e) => e.id));
        return archived;
    }

    async function loop() {
        log.info('WAL archiver started', { stream, group, consumer });
        while (!stopRequested) {
            try {
                await drainOnce(client);
            } catch (err) {
                if (stopRequested) break;
                log.error('archiver.loop.error:', err.message);
                await sleep(5000);
            }
        }
        log.info('WAL archiver stopped');
    }

    async function start() {
        client = redis.duplicate();
        client.on('error', (err) => { if (!stopRequested) log.error('archiver.redis.error:', err.message); });
        await client.connect();
        await ensureGroup(client);
        loopPromise = loop();
        return loopPromise.catch((err) => log.error('archiver.loop.crashed:', err.message));
    }

    async function stop() {
        stopRequested = true;
        // Unblock the pending xReadGroup by killing the connection, then wait for the loop.
        if (client) await client.disconnect().catch(() => {});
        if (loopPromise) await loopPromise.catch(() => {});
    }

    return { start, stop, drainOnce, ensureGroup };
}

module.exports = { createWalArchiver };
