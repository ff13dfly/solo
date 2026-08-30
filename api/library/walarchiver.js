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
const fs = require('fs');
const logger = require('./logger');
const { WAL } = require('./constants');

// Disk watermark for the WAL archive. Unbounded growth is by design (an audit trail is
// append-only), so the thing that must NOT be silent is running out of room: the archive
// shares a filesystem with Redis persistence and the service logs, so a full disk takes the
// whole stack down, not just archiving. Thresholds are percentage AND absolute — a 5% floor
// means very different things on a 24GB N100 and a 2TB box, so whichever trips first wins.
const DISK_WARN_PCT = Number(process.env.WAL_DISK_WARN_PCT || 15);
const DISK_CRIT_PCT = Number(process.env.WAL_DISK_CRIT_PCT || 5);
const DISK_WARN_MB = Number(process.env.WAL_DISK_WARN_MB || 2048);
const DISK_CRIT_MB = Number(process.env.WAL_DISK_CRIT_MB || 512);
const DISK_CHECK_MS = Number(process.env.WAL_DISK_CHECK_MS || 60000);

const log = logger.createLogger('wal-archiver');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createWalArchiver(redis, {
    stream = WAL.STREAM,
    group = WAL.GROUP,
    consumer = `archiver:${process.pid}`,
    blockMs = 2000,
    // 1000, not 100: each drain cycle costs a fixed handful of Redis round trips
    // (read + ack + reclaim), so a bigger window is what keeps the archiver ahead of a
    // bulk writer. ~1000 ledger rows ≈ 400KB in flight.
    batchSize = 1000,
    // pending entries idle longer than this are reclaimed from dead consumers
    claimIdleMs = 60000,
} = {}) {
    // Warn once the stream holds this many entries — the archiver is falling behind and
    // the XADD safety valve (WAL.MAXLEN) is the only thing left between it and data loss.
    const BACKLOG_WARN = Math.floor(WAL.MAXLEN / 2);

    let stopRequested = false;
    let lastDiskCheck = 0;
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
        // ONE append for the whole batch (logger.insertMany), not one file per row.
        // @why the per-row path (logger.insert) ran at ~3.7k rows/s and cost a filesystem
        //      block per ledger row; that made the archiver the ceiling on audit
        //      completeness — a bulk writer outran it and the stream's ring buffer
        //      silently dropped rows that were never archived. Batched + day-sharded is
        //      123x faster and 13x smaller on the same data, so the drain side is no
        //      longer the binding constraint.
        const batch = [];
        for (const { id, message } of entries) {
            if (!message || !message.key) continue; // malformed — ack below, nothing to archive
            batch.push({ key: message.key, row: toRow(id, message) });
        }
        if (batch.length === 0) return 0;
        return logger.insertMany(batch).written;
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
        await reclaim(c);
        return archived;
    }

    /**
     * Disk watermark check for the WAL archive directory.
     *
     * @why The archive only ever grows (append-only audit trail, no retention policy —
     *      see BACKLOG "WAL 落盘面残项"). Growth itself is fine and slow; what is not fine
     *      is discovering the ceiling as a full disk, because Redis persistence, the
     *      service logs and the archive share it. Measured growth is ~445 bytes per ledger
     *      row, so a monthly 200k-row re-import is ~178MB/month — years of runway on a
     *      normal box, which is exactly why nobody would notice it filling without this.
     * @attention Rate-limited to one check per DISK_CHECK_MS, and it never throws: a
     *      failed statfs (unsupported fs, permissions) must not stop archiving.
     */
    function checkDisk() {
        const now = Date.now();
        if (now - lastDiskCheck < DISK_CHECK_MS) return;
        lastDiskCheck = now;
        try {
            const dir = logger.walDir();
            if (!fs.existsSync(dir)) return;
            const st = fs.statfsSync(dir);
            const freeMb = (st.bavail * st.bsize) / (1024 * 1024);
            const freePct = st.blocks > 0 ? (st.bavail / st.blocks) * 100 : 100;
            const critical = freePct <= DISK_CRIT_PCT || freeMb <= DISK_CRIT_MB;
            const warning = freePct <= DISK_WARN_PCT || freeMb <= DISK_WARN_MB;
            if (!warning) return;
            const payload = {
                dir,
                freeMb: Math.round(freeMb),
                freePct: Number(freePct.toFixed(1)),
                thresholdPct: critical ? DISK_CRIT_PCT : DISK_WARN_PCT,
                thresholdMb: critical ? DISK_CRIT_MB : DISK_WARN_MB,
                hint: 'WAL archive shares this filesystem with Redis persistence and service logs; '
                    + 'compress/move old day logs (deploy/wal-rotate.sh) or grow the volume',
            };
            if (critical) log.error('archiver.disk.critical', payload);
            else log.warn('archiver.disk.low', payload);
        } catch (err) {
            // statfs is unavailable on some filesystems — never let housekeeping stop the drain.
            log.warn('archiver.disk.check.failed', { error: String((err && err.message) || err) });
        }
    }

    /**
     * Reclaim stream memory for entries that are safely archived — XTRIM MINID, never MAXLEN.
     *
     * @why XADD's `MAXLEN ~` valve trims by COUNT, which cannot tell an archived entry from
     *      one the archiver has not read yet: under a burst it silently discarded ledger rows.
     *      Trimming by MINID at the oldest still-pending entry only ever drops rows that are
     *      both delivered AND acked, so audit completeness no longer depends on the producer
     *      staying slower than the archiver. If every archiver dies the stream simply grows —
     *      visible (and still capped by the XADD valve) instead of quietly lossy.
     */
    async function reclaim(c) {
        try {
            // The oldest un-acked entry is the safe floor: everything below it is archived.
            const pending = await c.xPending(stream, group);
            const floor = (pending && pending.pending > 0 && pending.firstId) ? pending.firstId : null;
            if (floor) {
                await c.xTrim(stream, 'MINID', floor);
            } else {
                const info = await c.xInfoGroups(stream);
                const g = (info || []).find((x) => x.name === group);
                // node-redis returns this field kebab-cased (`last-delivered-id`); the
                // camelCase alias does not exist, so reading it silently yields undefined
                // → xTrim throws → the entire reclaim is skipped and the stream never
                // shrinks. Accept both spellings.
                const lastDelivered = g && (g['last-delivered-id'] || g.lastDeliveredId);
                if (lastDelivered) await c.xTrim(stream, 'MINID', lastDelivered);
            }

            // Backlog must never be silent again: if the stream keeps growing, say so.
            const len = await c.xLen(stream);
            if (len > BACKLOG_WARN) {
                log.warn('archiver.backlog.high', {
                    streamLength: len, warnAt: BACKLOG_WARN,
                    hint: 'WAL entries risk being trimmed before archiving — check archiver health / disk',
                });
            }
        } catch (err) {
            // Reclaim is best-effort housekeeping; never fail a drain because of it.
            log.warn('archiver.reclaim.failed', { error: String(err && err.message || err) });
        }
    }

    async function loop() {
        log.info('WAL archiver started', { stream, group, consumer });
        while (!stopRequested) {
            try {
                // Before draining, not inside it: an idle archiver on a filling disk is
                // exactly the case that must still warn, and drainOnce() returns early
                // when there is nothing to archive.
                checkDisk();
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
