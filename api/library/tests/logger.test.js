/**
 * Hermetic, exhaustive test for library/logger.js — the hash-fanout WAL log store
 * (insert/query/snapshot) plus the per-service system logger (createLogger) with its
 * ERROR:QUEUE auto-report + sensitive-field redaction.
 *
 * Hermetic: LOG_DIR/WAL_DIR are redirected to a throwaway os.tmpdir() folder BEFORE the
 * module is required (WAL_DIR is captured at module-load time). No real services: redis is a
 * Map-/array-backed fake, console is spied, and fs failure paths are forced via jest.spyOn.
 * (logger.js timestamps with native `new Date()` — NOT api/library/clock.js — so there is no
 * clock to freeze; timestamps are never asserted, only that calls happened.)
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

// Redirect the WAL store to a temp dir *before* requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-logger-'));
process.env.LOG_DIR = TMP;
process.env.WAL_DIR = TMP; // not read by the module, set per test-harness convention

const logger = require('../logger');
const { insert, query, snapshot, createLogger, redactSensitive } = logger;

// A custom sub-folder to exercise the explicit `folder`/`lines` arguments (vs defaults).
const CUSTOM = path.join(TMP, 'custom-folder');

// --- helpers ---------------------------------------------------------------

// Array-backed fake redis client. rPushImpl lets a test force resolve/reject/throw.
function makeFakeRedis({ isOpen = true, rPushImpl } = {}) {
    const pushed = [];
    return {
        isOpen,
        pushed,
        rPush: rPushImpl || ((queue, val) => { pushed.push({ queue, val }); return Promise.resolve(1); }),
    };
}

// Flush the microtask/immediate queue so a promise .catch() handler has run.
const flush = () => new Promise((r) => setImmediate(r));

// The parsed payload of the most recent rPush on a fake redis.
const lastPayload = (redis) => JSON.parse(redis.pushed[redis.pushed.length - 1].val);

// Silence + capture console; restore everything (incl. fs spies) after each test.
beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    jest.restoreAllMocks();
});

// ===========================================================================
// insert() — hash fan-out write + WAL index
// ===========================================================================
describe('logger.insert — write path', () => {
    test('string key + object row → file under LOG_DIR, round-trips via query', () => {
        const p = insert('user_123', { op: 'login', stamp: 1700000000000, ok: true });
        expect(p.startsWith(TMP)).toBe(true);
        expect(p.endsWith('.log')).toBe(true);
        expect(fs.existsSync(p)).toBe(true);
        expect(query('user_123')).toEqual([{ op: 'login', stamp: 1700000000000, ok: true }]);
    });

    test('object key is JSON-stringified for hashing (no [object Object] collisions)', () => {
        insert({ a: 1 }, { v: 'A' });
        insert({ a: 2 }, { v: 'B' });
        expect(query({ a: 1 })).toEqual([{ v: 'A' }]);
        expect(query({ a: 2 })).toEqual([{ v: 'B' }]);
    });

    test('string row is written verbatim (not JSON-encoded)', () => {
        const p = insert('rawkey', 'hello-raw-line');
        const content = fs.readFileSync(p, 'utf8');
        expect(content).toBe('hello-raw-line\n');
    });

    test('appending twice to the same key hits the dir-exists branch and keeps both lines', () => {
        insert('twice', { n: 1 });
        insert('twice', { n: 2 });
        expect(query('twice')).toEqual([{ n: 1 }, { n: 2 }]);
    });

    test('explicit folder argument is honoured (vs default WAL_DIR)', () => {
        const p = insert('ck', { in: 'custom' }, CUSTOM);
        expect(p.startsWith(CUSTOM)).toBe(true);
        expect(query('ck', CUSTOM)).toEqual([{ in: 'custom' }]);
    });

    test('oversized row (>32KB) is truncated to a LOG_TOO_LARGE marker', () => {
        const big = 'x'.repeat(40 * 1024);
        insert('huge', { blob: big });
        const rows = query('huge');
        expect(rows).toHaveLength(1);
        expect(rows[0].error).toBe('LOG_TOO_LARGE');
        expect(rows[0].size).toBeGreaterThan(32 * 1024);
        expect(rows[0].preview.endsWith('...')).toBe(true);
    });

    test('WAL index line carries op + stamp from the row', () => {
        insert('wal-key', { op: 'CREATE', stamp: 1700000000000, x: 1 });
        const idxDir = path.join(TMP, 'wal', '2023');
        const file = fs.readdirSync(idxDir).find((f) => f.endsWith('.index'));
        const lines = fs.readFileSync(path.join(idxDir, file), 'utf8').trim().split('\n');
        const mine = lines.find((l) => l.includes('|CREATE|'));
        expect(mine).toBeDefined();
        expect(mine.startsWith('1700000000000|CREATE|')).toBe(true);
    });

    test('row without op/stamp defaults op to "-" in the index (and a real stamp)', () => {
        insert('no-op-key', { just: 'data' });
        // The index write uses op || '-'. Find this key's most recent index line.
        const today = new Date();
        const idxDir = path.join(TMP, 'wal', String(today.getUTCFullYear()));
        const files = fs.existsSync(idxDir) ? fs.readdirSync(idxDir) : [];
        const all = files.flatMap((f) => fs.readFileSync(path.join(idxDir, f), 'utf8').trim().split('\n'));
        const mine = all.find((l) => l.includes('no-op-key'));
        expect(mine).toBeDefined();
        expect(mine.split('|')[1]).toBe('-');
    });

    test.each([
        ['undefined', undefined],
        ['null', null],
        ['empty string', ''],
    ])('throws when key is %s', (_label, key) => {
        expect(() => insert(key, { a: 1 })).toThrow('Log insert failed: Missing key');
    });

    test('data-file write failure is caught and logged (does not throw)', () => {
        const realAppend = fs.appendFileSync;
        jest.spyOn(fs, 'appendFileSync').mockImplementation((p, data) => {
            if (String(p).endsWith('.log')) throw new Error('disk full');
            return realAppend(p, data);
        });
        let ret;
        expect(() => { ret = insert('writefail', { a: 1 }); }).not.toThrow();
        expect(ret.endsWith('.log')).toBe(true);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[Logger] Failed to write to'));
    });

    test('WAL-index write failure is caught and logged (data still written)', () => {
        const realAppend = fs.appendFileSync;
        jest.spyOn(fs, 'appendFileSync').mockImplementation((p, data) => {
            if (String(p).endsWith('.index')) throw new Error('index locked');
            return realAppend(p, data);
        });
        expect(() => insert('idxfail', { a: 1 })).not.toThrow();
        expect(query('idxfail')).toEqual([{ a: 1 }]);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[Logger:WAL-Index] Failed to write index'));
    });
});

// ===========================================================================
// getIndexPath() day/year caching — driven through insert(row.stamp)
// ===========================================================================
describe('logger WAL index path — day-change + dir caching', () => {
    test('same-day cached, new-year mkdir, prior-year dir-exists skip', () => {
        // 2026 dir already exists (earlier tests run with today's real date in 2026).
        insert('cal', { stamp: Date.UTC(2026, 0, 1, 12), n: 1 });   // 2026 → dir exists
        insert('cal', { stamp: Date.UTC(2026, 0, 1, 13), n: 2 });   // same day → cached path
        insert('cal', { stamp: Date.UTC(2027, 5, 15, 12), n: 3 });  // new year → mkdir wal/2027
        insert('cal', { stamp: Date.UTC(2026, 11, 31, 9), n: 4 });  // day change, wal/2026 exists → skip mkdir

        expect(fs.existsSync(path.join(TMP, 'wal', '2027'))).toBe(true);
        const lines2027 = fs.readFileSync(
            path.join(TMP, 'wal', '2027', '2027-06-15.index'), 'utf8',
        ).trim().split('\n');
        expect(lines2027.some((l) => l.includes('cal'))).toBe(true);
    });
});

// ===========================================================================
// query() — read path + parse tolerance
// ===========================================================================
describe('logger.query — read path', () => {
    test('returns [] for falsy key', () => {
        expect(query('')).toEqual([]);
        expect(query(undefined)).toEqual([]);
    });

    test('returns [] when no log file exists for the key', () => {
        expect(query('never-written-key-xyz')).toEqual([]);
    });

    test('object key round-trips on read', () => {
        insert({ q: 'obj' }, { ok: 1 });
        expect(query({ q: 'obj' })).toEqual([{ ok: 1 }]);
    });

    test('skips malformed (non-JSON) lines, keeps valid ones', () => {
        insert('mixed', 'this-is-not-json');   // raw string line → JSON.parse throws → dropped
        insert('mixed', { good: true });        // valid JSON line → kept
        expect(query('mixed')).toEqual([{ good: true }]);
    });

    test('honours an explicit lines limit (returns the last N)', () => {
        insert('limited', { i: 1 });
        insert('limited', { i: 2 });
        insert('limited', { i: 3 });
        expect(query('limited', undefined, 1)).toEqual([{ i: 3 }]);
        expect(query('limited', undefined, 2)).toEqual([{ i: 2 }, { i: 3 }]);
    });

    test('explicit folder argument reads from the custom store', () => {
        insert('cfk', { z: 9 }, CUSTOM);
        expect(query('cfk', CUSTOM, 5)).toEqual([{ z: 9 }]);
    });

    test('read failure is caught and logged → returns []', () => {
        insert('readfail', { a: 1 });
        jest.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('EIO'); });
        expect(query('readfail')).toEqual([]);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[Logger] Read failed'));
    });
});

// ===========================================================================
// snapshot() — backup marker
// ===========================================================================
describe('logger.snapshot', () => {
    test('writes a snapshot|RDB marker into today\'s index and returns its path', () => {
        const idxPath = snapshot('/var/backups/dump.rdb');
        expect(idxPath.endsWith('.index')).toBe(true);
        const lines = fs.readFileSync(idxPath, 'utf8').trim().split('\n');
        const mine = lines.find((l) => l.includes('snapshot|RDB:/var/backups/dump.rdb'));
        expect(mine).toBeDefined();
        expect(mine.endsWith('|---')).toBe(true);
    });

    test('append failure is caught and logged (still returns the path)', () => {
        jest.spyOn(fs, 'appendFileSync').mockImplementation((p) => {
            if (String(p).endsWith('.index')) throw new Error('ro fs');
            throw new Error('unexpected');
        });
        const idxPath = snapshot('/x.rdb');
        expect(idxPath.endsWith('.index')).toBe(true);
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('[Logger:WAL-Index] Failed to write snapshot marker'),
        );
    });
});

// ===========================================================================
// createLogger() — basic levels + debug gating
// ===========================================================================
describe('logger.createLogger — levels', () => {
    test('lowercases the service name into the prefix; info/warn route to console', () => {
        const log = createLogger('USER');
        log.info('hi', { a: 1 });
        log.warn('careful');
        // info → console.log(stamp, prefix, ...args); prefix carries the lowercased name.
        const infoArgs = console.log.mock.calls[0];
        expect(infoArgs).toContain('hi');
        expect(infoArgs.some((a) => typeof a === 'string' && a.includes('[user]'))).toBe(true);
        const warnArgs = console.warn.mock.calls[0];
        expect(warnArgs).toContain('careful');
    });

    test('debug logs only when DEBUG === "true"', () => {
        const log = createLogger('svc');
        const prev = process.env.DEBUG;

        process.env.DEBUG = 'false';
        log.debug('hidden');
        expect(console.log).not.toHaveBeenCalled();

        process.env.DEBUG = 'true';
        log.debug('shown', 42);
        expect(console.log).toHaveBeenCalledTimes(1);
        expect(console.log.mock.calls[0]).toContain('DEBUG:');
        expect(console.log.mock.calls[0]).toContain('shown');

        if (prev === undefined) delete process.env.DEBUG; else process.env.DEBUG = prev;
    });
});

// ===========================================================================
// createLogger().error — ERROR:QUEUE auto-report
// ===========================================================================
describe('logger.createLogger.error — redis auto-report gating', () => {
    test('no redis client → logs to stderr, never pushes', () => {
        const log = createLogger('billing');
        log.error('boom', new Error('x'));
        expect(console.error).toHaveBeenCalled(); // the stderr line at minimum
    });

    test('redis present but not open → skips push', () => {
        const log = createLogger('billing');
        const redis = makeFakeRedis({ isOpen: false });
        log.setRedis(redis);
        log.error(new Error('still broken'));
        expect(redis.pushed).toHaveLength(0);
    });

    test('Error instance → pushed as INTERNAL_ERROR with stack', async () => {
        const log = createLogger('billing');
        const redis = makeFakeRedis();
        log.setRedis(redis);
        const err = new Error('kaboom');
        log.error('failure', err);
        await flush();
        expect(redis.pushed).toHaveLength(1);
        expect(redis.pushed[0].queue).toBe('ERROR:QUEUE:billing');
        const p = lastPayload(redis);
        expect(p.service).toBe('billing');
        expect(p.code).toBe('INTERNAL_ERROR');
        expect(p.error).toBe('kaboom');
        expect(typeof p.stack).toBe('string');
    });

    test('plain {code:-32603} object → treated as internal, pushed (no stack)', async () => {
        const log = createLogger('svc');
        const redis = makeFakeRedis();
        log.setRedis(redis);
        log.error({ code: -32603, message: 'internal-ish' });
        await flush();
        expect(redis.pushed).toHaveLength(1);
        const p = lastPayload(redis);
        expect(p.code).toBe(-32603);
        expect(p.error).toBe('internal-ish');
        expect(p.stack).toBeUndefined();
    });

    test('client-error code (e.g. -32602) → NOT pushed to ERROR:QUEUE', () => {
        const log = createLogger('svc');
        const redis = makeFakeRedis();
        log.setRedis(redis);
        log.error('bad request', { code: -32602, message: 'Invalid params' });
        expect(redis.pushed).toHaveLength(0);
        expect(console.error).toHaveBeenCalled(); // still hits stderr
    });

    test('null arg + non-error object are filtered without crashing; pushes generic INTERNAL_ERROR', async () => {
        const log = createLogger('svc');
        const redis = makeFakeRedis();
        log.setRedis(redis);
        // null → falsy operand in finds/filters; {foo} → object w/o numeric code
        log.error('text-msg', null, { foo: 1 });
        await flush();
        expect(redis.pushed).toHaveLength(1);
        const p = lastPayload(redis);
        expect(p.code).toBe('INTERNAL_ERROR');
        expect(p.error).toBe('text-msg '); // ['text-msg', null].join(' ') → null stringifies to ''
        expect(p.method).toBeUndefined();
    });

    test('request context with method + params → method captured, params redacted', async () => {
        const log = createLogger('svc');
        const redis = makeFakeRedis();
        log.setRedis(redis);
        log.error({ method: 'user.account.login', params: { anchor: 'a@x', password: 'p', token: 't' } });
        await flush();
        const p = lastPayload(redis);
        expect(p.method).toBe('user.account.login');
        expect(p.params.anchor).toBe('a@x');
        expect(p.params.password).toBe('***');
        expect(p.params.token).toBe('***');
    });

    test('request context via .request (no params) → params sourced from request, redacted', async () => {
        const log = createLogger('svc');
        const redis = makeFakeRedis();
        log.setRedis(redis);
        log.error({ request: { deviceToken: 'dt', anchor: 'a' } });
        await flush();
        const p = lastPayload(redis);
        expect(p.params.deviceToken).toBe('***');
        expect(p.params.anchor).toBe('a');
    });

    test('request context with only params (no method/request) → found via params operand', async () => {
        const log = createLogger('svc');
        const redis = makeFakeRedis();
        log.setRedis(redis);
        log.error({ params: { secret: 's', visible: 'v' } });
        await flush();
        const p = lastPayload(redis);
        expect(p.method).toBeUndefined();
        expect(p.params.secret).toBe('***');
        expect(p.params.visible).toBe('v');
    });

    test('method-only context → params resolves to undefined (ternary alternate)', async () => {
        const log = createLogger('svc');
        const redis = makeFakeRedis();
        log.setRedis(redis);
        log.error({ method: 'only.method' });
        await flush();
        const p = lastPayload(redis);
        expect(p.method).toBe('only.method');
        expect(p.params).toBeUndefined();
    });

    test('method parsed from a "processing X:" message when no context object', async () => {
        const log = createLogger('svc');
        const redis = makeFakeRedis();
        log.setRedis(redis);
        log.error('Error processing user.account.create: kaboom', new Error('kaboom'));
        await flush();
        const p = lastPayload(redis);
        expect(p.method).toBe('user.account.create');
    });

    test('string first-arg without "processing" → method stays undefined', async () => {
        const log = createLogger('svc');
        const redis = makeFakeRedis();
        log.setRedis(redis);
        log.error('just a plain message', { code: -32603, message: 'm' });
        await flush();
        const p = lastPayload(redis);
        expect(p.method).toBeUndefined();
    });

    test('no error-like arg at all → code null path proceeds, error from joined messages', async () => {
        const log = createLogger('svc');
        const redis = makeFakeRedis();
        log.setRedis(redis);
        log.error('plain', 'words');
        await flush();
        const p = lastPayload(redis);
        expect(p.code).toBe('INTERNAL_ERROR');
        expect(p.error).toBe('plain words');
    });

    test('rPush rejection is caught and logged (does not throw)', async () => {
        const log = createLogger('svc');
        const redis = makeFakeRedis({ rPushImpl: () => Promise.reject(new Error('redis down')) });
        log.setRedis(redis);
        log.error(new Error('boom'));
        await flush();
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Redis Push Failed'), 'redis down');
    });

    test('synchronous throw inside auto-report is caught (outer catch)', async () => {
        const log = createLogger('svc');
        const redis = makeFakeRedis({ rPushImpl: () => { throw new Error('sync-boom'); } });
        log.setRedis(redis);
        log.error(new Error('boom'));
        await flush();
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Auto-report Failed'), 'sync-boom');
    });
});

// ===========================================================================
// redactSensitive() — supplement the existing logger-redact.test.js edge cases
// ===========================================================================
describe('logger.redactSensitive — depth + array branches', () => {
    test('stops recursing past depth 4 (deep secret left intact)', () => {
        // depth: 0(root)>1>2>3>4>5(here the guard returns value as-is)
        const deep = { l1: { l2: { l3: { l4: { l5: { token: 'deep-secret' } } } } } };
        const out = redactSensitive(deep);
        // l5.token sits at depth 5 → returned untouched (NOT masked)
        expect(out.l1.l2.l3.l4.l5.token).toBe('deep-secret');
    });

    test('arrays of scalars pass through, nested sensitive keys masked', () => {
        const out = redactSensitive({ list: [1, 'two', { apikey: 'k' }] });
        expect(out.list[0]).toBe(1);
        expect(out.list[1]).toBe('two');
        expect(out.list[2].apikey).toBe('***');
    });
});
