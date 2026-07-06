/**
 * Global System Constants
 * @why Centralized definitions for shared state and logic conventions.
 */

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
        MAXLEN: parseInt(process.env.WAL_STREAM_MAXLEN, 10) || 10000,
        // Archiver consumer group
        GROUP: 'wal-archiver',
        // Per-snapshot cap inside a ledger row (parity with logger.js MAX_ROW_LENGTH;
        // oversized before/after snapshots are replaced with a truncation marker).
        MAX_SNAPSHOT: 32 * 1024
    }
};
