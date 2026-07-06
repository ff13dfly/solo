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
const fs = require('fs');
const path = require('path');

// WAL log directory — configurable via LOG_DIR env, defaults to api/logs
const DEFAULT_LOG_DIR = path.join(__dirname, '../../logs');
const WAL_DIR = process.env.LOG_DIR || DEFAULT_LOG_DIR;

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

    // Safety Limit: 32KB per row
    const MAX_ROW_LENGTH = 32 * 1024;

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

    if (!fs.existsSync(filePath)) {
        return [];
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const fileLines = content.trim().split('\n');

        const slice = fileLines.slice(-lines);

        return slice.map(line => {
            try { return JSON.parse(line); } catch (e) { return null; }
        }).filter(x => x);
    } catch (e) {
        console.error(`[Logger] Read failed: ${e.message}`);
        return [];
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
    query,
    snapshot,
    createLogger,
    redactSensitive
};
