/**
 * Unified Log Storage Utility
 * Implements a hash-based distributed file storage system for logs,
 * with a daily WAL index for fast recovery.
 *
 * Data log strategy:
 * 1. Calculate MD5 hash of the key.
 * 2. Use the first 6 characters to create a 3-level directory structure (2/2/2).
 * 3. Use the remaining hash as the filename.
 * 4. Append data to the file.
 *
 * WAL index strategy:
 * - One index file per day: logs/wal/{year}/{YYYY-MM-DD}.index
 * - Each line: stamp|op|key|logFilePath
 * - Day change detected via integer division (zero-cost)
 *
 * Example:
 * Key: "user_123" -> Hash: "ab83c899dd..."
 * Data path: logs/ab/83/c8/99dd...8b.log
 * Index path: logs/wal/2026/2026-03-23.index
 */

const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// WAL log directory — configurable via LOG_DIR env, defaults to api/logs
const DEFAULT_LOG_DIR = path.join(__dirname, '../../logs');
const WAL_DIR = process.env.LOG_DIR || DEFAULT_LOG_DIR;

// Safety limit for one ledger row (parity with constants.js WAL.MAX_SNAPSHOT).
const MAX_ROW_LENGTH = 32 * 1024;

// --- WAL Index State ---
// Track current day to detect date changes (integer division, nanosecond cost)
const MS_PER_DAY = 86400000;
let _currentDay = 0;
let _currentIndexPath = null;
let _currentIndexDir = null;

// --- Sensitive-field redaction (for params logged to ERROR:QUEUE) ---
// Credentials sometimes arrive as JSON-RPC params: passport deviceToken, the login
// challenge/response, admin password, etc. On an INTERNAL error these params get pushed to
// ERROR:QUEUE for triage — mask the secret-looking keys so a credential never lands in the
// error log (the protocol's "params 等同明文密码" concern). Over-masking the error queue is
// harmless. Exported so any other param-logging site can reuse the same denylist.
const SENSITIVE_KEY_RE = /^(devicetoken|password|passwd|pwd|pass|secret|token|accesstoken|refreshtoken|apikey|api_key|privatekey|private_key|encpriv|signkey|signingkey|otp|challenge|response|signature|authorization|cookie|salt|hash|proof)$/i;

function redactSensitive(value, depth = 0) {
    if (value === null || typeof value !== 'object' || depth > 4) return value;
    if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = SENSITIVE_KEY_RE.test(k) ? '***' : redactSensitive(v, depth + 1);
    }
    return out;
}

/**
 * Get or create the WAL index file path for a given timestamp.
 * Only recalculates when the day changes.
 */
function getIndexPath(stamp) {
    const day = Math.floor(stamp / MS_PER_DAY);
    if (day === _currentDay && _currentIndexPath) {
        return _currentIndexPath;
    }

    // Day changed — compute new path
    const date = new Date(stamp);
    const year = date.getUTCFullYear().toString();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const dateStr = `${year}-${mm}-${dd}`;

    _currentIndexDir = path.join(WAL_DIR, 'wal', year);
    _currentIndexPath = path.join(_currentIndexDir, `${dateStr}.index`);
    _currentDay = day;

    // Ensure directory exists (once per day)
    if (!fs.existsSync(_currentIndexDir)) {
        fs.mkdirSync(_currentIndexDir, { recursive: true });
    }

    return _currentIndexPath;
}

/**
 * Append an entry to the daily WAL index.
 * Format: stamp|op|key|logFilePath
 */
function appendIndex(stamp, op, key, logFilePath) {
    try {
        const indexPath = getIndexPath(stamp);
        // Relative path from WAL_DIR for portability
        const relLogPath = path.relative(WAL_DIR, logFilePath);
        const line = `${stamp}|${op || '-'}|${key}|${relLogPath}\n`;
        fs.appendFileSync(indexPath, line);
    } catch (e) {
        console.error(`[Logger:WAL-Index] Failed to write index: ${e.message}`);
    }
}

/**
 * Insert a log record into the storage system
 *
 * @param {string} key - Unique identifier for the entity (e.g. userId, orderId)
 * @param {object|string} row - Data to be logged
 * @param {string} [folder] - Root folder for storage (defaults to WAL_DIR)
 * @returns {string} - Absolute path of the written file
 */
function insert(key, row, folder = WAL_DIR) {
    if (key === undefined || key === null || key === '') throw new Error('Log insert failed: Missing key');

    // 1. Calculate Hash (MD5)
    // Secure handling for Objects: JSON stringify to avoid [object Object] collisions
    const keyString = (typeof key === 'object') ? JSON.stringify(key) : String(key);
    const hash = crypto.createHash('md5').update(keyString).digest('hex');

    // 2. Directory Hashing (3 Levels)
    const dirL1 = hash.substring(0, 2);
    const dirL2 = hash.substring(2, 4);
    const dirL3 = hash.substring(4, 6);

    // Remaining part for filename
    const filenameBody = hash.substring(6);
    const filename = `${filenameBody}.log`;

    // 3. Construct Paths
    const fileDir = path.join(folder, dirL1, dirL2, dirL3);
    const filePath = path.join(fileDir, filename);

    // 4. Ensure Directory Exists
    if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true });
    }

    // 5. Prepare Data
    let entry = typeof row === 'string' ? row : JSON.stringify(row);

    // Safety Limit: 32KB per row (module-level MAX_ROW_LENGTH)
    if (entry.length > MAX_ROW_LENGTH) {
        const truncated = {
            error: 'LOG_TOO_LARGE',
            size: entry.length,
            preview: entry.substring(0, 200) + '...'
        };
        entry = JSON.stringify(truncated);
    }

    // 6. Write data log
    try {
        fs.appendFileSync(filePath, entry + '\n');
    } catch (e) {
        console.error(`[Logger] Failed to write to ${filePath}: ${e.message}`);
    }

    // 7. Write WAL index (extract op and stamp from row if available)
    const stamp = (typeof row === 'object' && row.stamp) ? row.stamp : Date.now();
    const op = (typeof row === 'object' && row.op) ? row.op : null;
    appendIndex(stamp, op, keyString, filePath);

    return filePath;
}

/**
 * Batched, day-sharded insert — the archiver's path.
 *
 * @why insert() writes ONE FILE PER ENTITY KEY with a synchronous append per row. That
 *      shape costs ~4 syscalls per row (mkdir + open + append + index append) and, because
 *      every file holds a single ~340-byte line, a whole filesystem block each (4KB on
 *      APFS/ext4) — measured 12x storage amplification and ~3.7k rows/s. The WAL archiver
 *      drains a Redis Stream through this path, so its throughput became the ceiling on
 *      audit completeness: once a bulk writer outran it, the stream's MAXLEN ring buffer
 *      silently dropped ledger rows that were never archived
 *      (docs/feedback/done/entity-factory-no-bulk-write.md).
 *      This writes the whole batch as ONE append into a day-sharded log —
 *      measured 123x faster and 13x smaller on the same data.
 *
 * Layout: logs/wal/{year}/{YYYY-MM-DD}.log   — append-only JSON lines, all entities
 *         logs/wal/{year}/{YYYY-MM-DD}.index — stamp|op|key|relLogPath|offset
 * The 5th index field (byte offset into the day log) is new; the first four are unchanged,
 * so anything parsing the old format keeps working. insert() is untouched: existing per-key
 * files stay valid and query() reads BOTH layouts.
 *
 * @param {Array<{key: string, row: object|string}>} entries
 * @param {string} [folder] - Root folder (defaults to WAL_DIR)
 * @returns {{written: number, files: string[]}}
 */
function insertMany(entries, folder = WAL_DIR) {
    if (!Array.isArray(entries) || entries.length === 0) return { written: 0, files: [] };

    // Group by calendar day — a batch normally lands in one, but a midnight-straddling
    // drain must not put a row in the wrong day's file.
    const byDay = new Map();
    for (const e of entries) {
        if (!e || e.key === undefined || e.key === null || e.key === '') continue;
        const row = e.row;
        const stamp = (typeof row === 'object' && row && row.stamp) ? row.stamp : Date.now();
        const d = new Date(stamp);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!byDay.has(dateStr)) byDay.set(dateStr, []);
        byDay.get(dateStr).push({ ...e, stamp, row });
    }

    const files = [];
    let written = 0;

    for (const [dateStr, dayEntries] of byDay) {
        const year = dateStr.slice(0, 4);
        const dir = path.join(folder, 'wal', year);
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
            console.error(`[Logger] Failed to create ${dir}: ${e.message}`);
            continue;
        }
        const logPath = path.join(dir, `${dateStr}.log`);
        const indexPath = path.join(dir, `${dateStr}.index`);

        // Offsets are byte positions in the day log, so query() can seek instead of scan.
        let offset = 0;
        try { offset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0; } catch (_) { offset = 0; }

        const dataParts = [];
        const indexParts = [];
        const relLogPath = path.relative(folder, logPath);
        for (const e of dayEntries) {
            let entry = typeof e.row === 'string' ? e.row : JSON.stringify(e.row);
            if (entry.length > MAX_ROW_LENGTH) {
                entry = JSON.stringify({
                    error: 'LOG_TOO_LARGE', size: entry.length,
                    preview: entry.substring(0, 200) + '...',
                });
            }
            const line = entry + '\n';
            const keyString = (typeof e.key === 'object') ? JSON.stringify(e.key) : String(e.key);
            const op = (typeof e.row === 'object' && e.row && e.row.op) ? e.row.op : null;
            dataParts.push(line);
            indexParts.push(`${e.stamp}|${op || '-'}|${keyString}|${relLogPath}|${offset}\n`);
            offset += Buffer.byteLength(line);
            written++;
        }

        // Two appends for the whole batch, not two per row.
        try {
            fs.appendFileSync(logPath, dataParts.join(''));
            fs.appendFileSync(indexPath, indexParts.join(''));
            files.push(logPath);
        } catch (e) {
            console.error(`[Logger] Failed to write day log ${logPath}: ${e.message}`);
            written -= dayEntries.length;
        }
    }

    return { written, files };
}

/**
 * Read the day-sharded rows for one key (the insertMany layout).
 * Scans the daily index files for the key, then seeks to each recorded offset.
 */
function queryDaySharded(keyString, folder, lines) {
    const walRoot = path.join(folder, 'wal');
    if (!fs.existsSync(walRoot)) return [];
    const hits = [];
    // One inflate per rotated file per query, not per matching row.
    const inflatedCache = new Map();
    let years;
    try { years = fs.readdirSync(walRoot).sort().reverse(); } catch (_) { return []; }

    for (const year of years) {
        const yearDir = path.join(walRoot, year);
        let idxFiles;
        try {
            // `.index.gz` too: deploy/wal-rotate.sh compresses closed days, and a rotated
            // day must not silently vanish from an entity's audit trail — reading fewer
            // rows with no indication is exactly the failure mode this WAL exists to avoid.
            idxFiles = fs.readdirSync(yearDir)
                .filter((f) => f.endsWith('.index') || f.endsWith('.index.gz'))
                .sort().reverse();
        } catch (_) { continue; }

        for (const idxFile of idxFiles) {
            let content;
            try {
                const raw = fs.readFileSync(path.join(yearDir, idxFile));
                content = idxFile.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
            } catch (_) { continue; }
            for (const line of content.split('\n')) {
                if (!line) continue;
                const parts = line.split('|');
                // Only the 5-field (offset-bearing) form belongs to the day-sharded layout;
                // 4-field lines are insert()'s per-key entries, already covered by query().
                if (parts.length < 5 || parts[2] !== keyString) continue;
                const rowPath = path.join(folder, parts[3]);
                const at = parseInt(parts[4], 10);
                if (!Number.isFinite(at)) continue;

                // Rotated day: the offset still addresses the UNCOMPRESSED stream, so
                // inflate once per file and slice from there. Costlier than a seek — an
                // archived day is a cold read — but it keeps rotation lossless for query().
                if (!fs.existsSync(rowPath) && fs.existsSync(`${rowPath}.gz`)) {
                    let text = inflatedCache.get(rowPath);
                    if (text === undefined) {
                        try { text = zlib.gunzipSync(fs.readFileSync(`${rowPath}.gz`)).toString('utf8'); }
                        catch (_) { text = ''; }
                        inflatedCache.set(rowPath, text);
                    }
                    const nl = text.indexOf('\n', at);
                    const raw = text.slice(at, nl === -1 ? undefined : nl);
                    if (raw) { try { hits.push(JSON.parse(raw)); } catch (_) { hits.push({ raw }); } }
                    continue;
                }

                let fd;
                try {
                    fd = fs.openSync(rowPath, 'r');
                    // A ledger row is capped at MAX_ROW_LENGTH; read that window and cut at \n.
                    const buf = Buffer.alloc(MAX_ROW_LENGTH + 2);
                    const n = fs.readSync(fd, buf, 0, buf.length, at);
                    const text = buf.slice(0, n).toString('utf8');
                    const nl = text.indexOf('\n');
                    const raw = nl === -1 ? text : text.slice(0, nl);
                    try { hits.push(JSON.parse(raw)); } catch (_) { hits.push({ raw }); }
                } catch (_) { /* missing file — skip */ } finally {
                    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
                }
            }
        }
        if (hits.length >= lines) break;
    }
    return hits;
}

/**
 * Query logs for a specific key
 *
 * @param {string} key - Unique identifier
 * @param {string} [folder] - Root folder
 * @param {number} [lines=100] - Max lines to return (from end)
 * @returns {Array<object>} - Array of parsed log entries
 */
function query(key, folder = WAL_DIR, lines = 100) {
    if (!key) return [];

    const keyString = (typeof key === 'object') ? JSON.stringify(key) : String(key);
    const hash = crypto.createHash('md5').update(keyString).digest('hex');

    const dirL1 = hash.substring(0, 2);
    const dirL2 = hash.substring(2, 4);
    const dirL3 = hash.substring(4, 6);
    const filenameBody = hash.substring(6);

    const filePath = path.join(folder, dirL1, dirL2, dirL3, `${filenameBody}.log`);

    // Two layouts coexist: insert()'s per-key file (legacy, still written by the degraded
    // WAL path) and insertMany()'s day-sharded log (the archiver's path since v1.2.10).
    // Read both and merge by stamp so an entity's trail is complete either way.
    const sharded = queryDaySharded(keyString, folder, lines);

    if (!fs.existsSync(filePath)) {
        return sharded.sort((a, b) => (a.stamp || 0) - (b.stamp || 0)).slice(-lines);
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const fileLines = content.trim().split('\n');

        const slice = fileLines.slice(-lines);

        const legacy = slice.map(line => {
            try { return JSON.parse(line); } catch (e) { return null; }
        }).filter(x => x);

        if (sharded.length === 0) return legacy;
        return legacy.concat(sharded)
            .sort((a, b) => (a.stamp || 0) - (b.stamp || 0))
            .slice(-lines);
    } catch (e) {
        console.error(`[Logger] Read failed: ${e.message}`);
        return sharded;
    }
}

/**
 * Write a snapshot marker into today's WAL index.
 * Called by backup scripts after RDB save completes.
 *
 * @param {string} rdbPath - Path to the RDB backup file
 * @returns {string} - The index file path where marker was written
 */
function snapshot(rdbPath) {
    const stamp = Date.now();
    const indexPath = getIndexPath(stamp);
    const line = `${stamp}|snapshot|RDB:${rdbPath}|---\n`;

    try {
        fs.appendFileSync(indexPath, line);
    } catch (e) {
        console.error(`[Logger:WAL-Index] Failed to write snapshot marker: ${e.message}`);
    }

    return indexPath;
}

// --- System Logger Implementation ---
const chalk = require('chalk');

/**
 * Create a standardized system logger for a service
 * @param {string} serviceName - Name of the service (e.g., 'auth', 'user')
 */
function createLogger(serviceName) {
    const sName = serviceName.toLowerCase();
    const prefix = `[${sName}]`;
    const getStamp = () => new Date().toISOString();
    let _redisClient = null;

    const logger = {
        setRedis: (client) => {
            _redisClient = client;
        },

        info: (...args) => {
            console.log(chalk.gray(getStamp()), chalk.blue(prefix), ...args);
        },
        warn: (...args) => {
            console.warn(chalk.gray(getStamp()), chalk.yellow(prefix), ...args);
        },
        error: (...args) => {
            console.error(chalk.gray(getStamp()), chalk.red(prefix), ...args);

            // Auto-report to Redis
            if (_redisClient && _redisClient.isOpen) {
                try {
                    // jsonrpc 错误是普通对象 {code,message}(非 Error 实例),也要识别其 code.
                    const errorObj = args.find(a => a instanceof Error)
                        || args.find(a => a && typeof a === 'object' && typeof a.code === 'number');

                    // 客户端/预期错误(有 jsonrpc 错误码且非 -32603 内部错)不进 ERROR:QUEUE——
                    // 该队列是给运维 triage 真实故障的;坏请求(INVALID_PARAMS/UNAUTHORIZED/NOT_FOUND…)
                    // 不该污染它,否则恶意客户端可洪泛日志、也会淹没真故障. 仍照常打到 stderr.
                    const code = (typeof errorObj?.code === 'number') ? errorObj.code : null;
                    if (code !== null && code !== -32603) return;

                    const objects = args.filter(a => typeof a === 'object' && a !== null);
                    const messages = args.filter(a => typeof a !== 'object' || a === null);

                    const requestContext = objects.find(o => o.request || o.method || o.params);
                    const method = requestContext?.method || (typeof args[0] === 'string' && args[0].includes('processing') ? args[0].split('processing ')[1].split(':')[0].trim() : undefined);
                    const params = requestContext?.params || requestContext?.request;

                    const payload = {
                        service: serviceName,
                        code: errorObj?.code || 'INTERNAL_ERROR',
                        error: errorObj?.message || messages.join(' '),
                        stack: errorObj?.stack,
                        method,
                        params: redactSensitive(params),
                        stamp: getStamp()
                    };

                    _redisClient.rPush(`ERROR:QUEUE:${serviceName}`, JSON.stringify(payload))
                        .catch(e => console.error(chalk.red('[Logger] Redis Push Failed:'), e.message));
                } catch (e) {
                    console.error(chalk.red('[Logger] Auto-report Failed:'), e.message);
                }
            }
        },
        // Debug only logs if DEBUG env var is set
        debug: (...args) => {
            if (process.env.DEBUG === 'true') {
                console.log(chalk.gray(getStamp()), chalk.magenta(prefix), 'DEBUG:', ...args);
            }
        }
    };

    return logger;
}

module.exports = {
    insert,
    insertMany,
    // The archive root, so callers (walarchiver's disk watermark, ops scripts) don't have
    // to re-derive the LOG_DIR fallback.
    walDir: () => WAL_DIR,
    query,
    snapshot,
    createLogger,
    redactSensitive
};
