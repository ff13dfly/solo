/**
 * Global System Constants
 * @why Centralized definitions for shared state and logic conventions.
 */

const { intFromEnv } = require('./env');

module.exports = {
    // Entity Lifecycle Status
    STATUS: {
        ACTIVE: 'ACTIVE',
        DELETED: 'DELETED',
        DORMANT: 'DORMANT',
        EXPIRED: 'EXPIRED'
    },

    // Entity WAL ledger (entity.js writes, walarchiver.js drains to file)
    WAL: {
        // Single shared stream per Redis instance — entries carry the full data key
        // (SERVICE:ENTITY:ID) so one archiver covers every service.
        STREAM: process.env.WAL_STREAM || 'WAL:STREAM',
        // Safety valve only (XADD MAXLEN ~): the stream is a hot ring buffer; the
        // durable full history lives in the archiver's files. Bounds Redis memory
        // if the archiver is down; sized so the archive lag window is never the
        // binding constraint in normal operation.
        // @attention 这里**刻意不直接取** intFromEnv 的裸值：`threshold: 0` 传给 xAdd 的
        //   MAXLEN 不是"关掉修剪"，而是"把 WAL 热流裁到几乎不剩"——与 EVENT:* 流那边
        //   `0 = 不修剪` 的语义正好相反（那边 0 是跳过 TRIM 参数，这边 0 是真的裁）。
        //   所以 0 / 负数一律落回默认值，并**出声**，而不是像旧写法 `parseInt(x,10) || D`
        //   那样静默吞掉。（docs/feedback/done/event-bus-xadd-unbounded-dead-config.md）
        MAXLEN: (() => {
            const n = intFromEnv('WAL_STREAM_MAXLEN', 10000);
            if (n > 0) return n;
            console.warn(`[constants] WAL_STREAM_MAXLEN=${n} 会把 WAL 热流裁空，已忽略，仍用 10000`);
            return 10000;
        })(),
        // Archiver consumer group
        GROUP: 'wal-archiver',
        // Per-snapshot cap inside a ledger row (parity with logger.js MAX_ROW_LENGTH;
        // oversized before/after snapshots are replaced with a truncation marker).
        MAX_SNAPSHOT: 32 * 1024
    }
};
