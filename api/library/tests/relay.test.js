/**
 * relay.test.js — hermetic unit tests for library/relay.js, the inter-service
 * relay client (system service-account token lifecycle + Router RPC).
 *
 * Sibling coverage split: library/tests/relay-callas.test.js ALREADY covers
 *   - callAs (explicit-token transport, missing-token guard)
 *   - the request-timeout path (RPC_TIMEOUT, incl. `e instanceof RelayError` true)
 * so THIS file covers EVERYTHING ELSE: getToken/setToken, token validation,
 * auto-refresh (single + concurrent-lock paths), call() success/error/transport,
 * trace-header forwarding (walContext), status(), clear(), audit, and constructor
 * guards. Together the two files drive relay.js to 100%.
 *
 * Transport is NOT axios (the rule's axios note is inapplicable) — relay.js uses
 * Node http/https directly, so we stand up a real loopback HTTP server (no network)
 * exactly like the sibling. Redis is a Map-backed fake (relay only uses get/set/del).
 */
const http = require('http');
const { createRelay, RelayError } = require('../relay');
const { walContext } = require('../entity');

// ── constants ────────────────────────────────────────────────────────────────
const SERVICE = 'notification';
const SUB = 'system.notification';
const TOKEN_KEY = 'RELAY:TOKEN:notification';
const LOCK_KEY = 'RELAY:TOKEN:notification:LOCK';
const NOW = 1_700_000_000_000;
const HOUR = 3600 * 1000;

const stateJson = (token, expiresAt, sub = SUB) =>
    JSON.stringify({ token, expiresAt, lastRefreshAt: NOW - 1000, sub });

// ── fakes ────────────────────────────────────────────────────────────────────

// Map-backed fake redis. relay touches only get/set/del. Options:
//   tokenKey     — which key the failTokenSet hook applies to
//   lockReturn   — value an NX set returns on success (default 'OK'; pass true to
//                  exercise acquireLock's `result === true` branch)
function makeRedis(opts = {}) {
    const kv = new Map();
    let failTokenSet = false;
    return {
        _kv: kv,
        _failTokenSet(v) { failTokenSet = v; },
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v, o) {
            if (failTokenSet && k === opts.tokenKey && !(o && o.NX)) throw new Error('redis down');
            if (o && o.NX) {
                if (kv.has(k)) return null;                       // lock already held
                kv.set(k, v);
                return ('lockReturn' in opts) ? opts.lockReturn : 'OK';
            }
            kv.set(k, v);
            return 'OK';
        },
        async del(k) { return kv.delete(k) ? 1 : 0; },
    };
}

// Scripted fake redis for the concurrent-refresh (lock) paths: each get(TOKEN_KEY)
// / get(LOCK_KEY) returns the next element of its sequence (last element repeats),
// and NX set always fails (lock held by "the other refresher") so acquireLock=false.
function makeScriptedRedis({ tokenSeq, lockSeq }) {
    let ti = 0, li = 0;
    return {
        async get(k) {
            if (k === TOKEN_KEY) { const v = tokenSeq[Math.min(ti, tokenSeq.length - 1)]; ti++; return v; }
            if (k === LOCK_KEY) { const v = lockSeq[Math.min(li, lockSeq.length - 1)]; li++; return v; }
            return null;
        },
        async set(k, v, o) { if (o && o.NX) return null; return 'OK'; },
        async del() { return 1; },
    };
}

// Monotonic clock: returns start, start+step, start+2*step, … (for the refresh
// timeout / "expired during refresh" paths that need now() to advance past a deadline).
function incNow(start, step) {
    let c = start - step;
    return () => (c += step);
}

// ── shared loopback "Router" ─────────────────────────────────────────────────
let server, serverUrl, requests, responder;

beforeAll((done) => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let parsed = {};
            try { parsed = JSON.parse(body); } catch (_) { /* leave {} */ }
            requests.push({
                auth: req.headers['authorization'],
                traceId: req.headers['x-trace-id'],
                traceDepth: req.headers['x-trace-depth'],
                method: parsed.method,
                params: parsed.params,
                id: parsed.id,
            });
            const out = responder(parsed) || {};
            res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
            if (out.text !== undefined) return res.end(out.text);
            if (out.json !== undefined) return res.end(JSON.stringify(out.json));
            return res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true, method: parsed.method } }));
        });
    });
    server.listen(0, () => { serverUrl = `http://127.0.0.1:${server.address().port}/jsonrpc`; done(); });
});

afterAll(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
}));

beforeEach(() => {
    requests = [];
    responder = () => ({});   // default: 200 JSON-RPC success echo
});

// Build a relay over a fresh fake redis, optionally seeding a stored token state.
function makeRelay(overrides = {}, redisOpts = {}) {
    const redis = makeRedis({ tokenKey: TOKEN_KEY, ...redisOpts });
    const relay = createRelay({
        redis,
        serviceName: SERVICE,
        routerUrl: serverUrl,
        now: () => NOW,
        ...overrides,
    });
    return { relay, redis };
}

// ── constructor guards ───────────────────────────────────────────────────────
describe('createRelay — required options', () => {
    test('no options object at all → throws redis-required (options || {} default branch)', () => {
        expect(() => createRelay()).toThrow('[relay] redis client is required');
    });
    test('missing redis throws', () => {
        expect(() => createRelay({ serviceName: SERVICE, routerUrl: serverUrl }))
            .toThrow('[relay] redis client is required');
    });
    test('missing serviceName throws', () => {
        expect(() => createRelay({ redis: {}, routerUrl: serverUrl }))
            .toThrow('[relay] serviceName is required');
    });
    test('missing routerUrl throws', () => {
        expect(() => createRelay({ redis: {}, serviceName: SERVICE }))
            .toThrow('[relay] routerUrl is required');
    });
    test('exposes the documented public surface', () => {
        const { relay } = makeRelay();
        expect(Object.keys(relay).sort()).toEqual(['call', 'callAs', 'clear', 'getToken', 'setToken', 'status'].sort());
    });
});

// ── setToken ─────────────────────────────────────────────────────────────────
describe('setToken — validation + persistence', () => {
    test('persists a valid token as RELAY:TOKEN:<svc> with the canonical sub', async () => {
        const { relay, redis } = makeRelay();
        await relay.setToken({ token: 'TKN', expiresAt: NOW + 1e9 });
        const stored = JSON.parse(redis._kv.get(TOKEN_KEY));
        expect(stored).toMatchObject({ token: 'TKN', expiresAt: NOW + 1e9, sub: SUB, lastRefreshAt: NOW });
    });

    test('accepts a matching explicit sub (sub && sub!==expectedSub → false branch)', async () => {
        const { relay, redis } = makeRelay();
        await relay.setToken({ token: 'TKN', expiresAt: NOW + 1e9, sub: SUB });
        expect(JSON.parse(redis._kv.get(TOKEN_KEY)).sub).toBe(SUB);
    });

    test('rejects falsy token (!token)', async () => {
        const { relay } = makeRelay();
        await expect(relay.setToken({ token: '', expiresAt: NOW + 1e9 }))
            .rejects.toMatchObject({ code: 'INVALID_TOKEN', message: expect.stringContaining('token must be a string') });
    });
    test('rejects non-string token (typeof guard)', async () => {
        const { relay } = makeRelay();
        await expect(relay.setToken({ token: 123, expiresAt: NOW + 1e9 }))
            .rejects.toMatchObject({ code: 'INVALID_TOKEN', message: expect.stringContaining('token must be a string') });
    });
    test('rejects missing expiresAt (!expiresAt)', async () => {
        const { relay } = makeRelay();
        await expect(relay.setToken({ token: 'TKN' }))
            .rejects.toMatchObject({ code: 'INVALID_TOKEN', message: expect.stringContaining('expiresAt must be a number') });
    });
    test('rejects non-number expiresAt (typeof guard)', async () => {
        const { relay } = makeRelay();
        await expect(relay.setToken({ token: 'TKN', expiresAt: '123' }))
            .rejects.toMatchObject({ code: 'INVALID_TOKEN', message: expect.stringContaining('expiresAt must be a number') });
    });
    test('rejects an already-expired expiresAt', async () => {
        const { relay } = makeRelay();
        await expect(relay.setToken({ token: 'TKN', expiresAt: NOW - 1 }))
            .rejects.toMatchObject({ code: 'INVALID_TOKEN', message: expect.stringContaining('already expired') });
    });
    test('rejects a sub that does not match the service (SUB_MISMATCH)', async () => {
        const { relay } = makeRelay();
        await expect(relay.setToken({ token: 'TKN', expiresAt: NOW + 1e9, sub: 'system.other' }))
            .rejects.toMatchObject({ code: 'SUB_MISMATCH' });
    });

    test('uses Date.now when no clock injected (default now param)', async () => {
        const redis = makeRedis({ tokenKey: TOKEN_KEY });
        const relay = createRelay({ redis, serviceName: SERVICE, routerUrl: serverUrl });
        await relay.setToken({ token: 'TKN', expiresAt: Date.now() + 1e9 });
        expect((await relay.status()).hasToken).toBe(true);
    });
});

// ── getToken / call happy path + state validation ────────────────────────────
describe('getToken / call — stored-token read + validation', () => {
    test('getToken returns the stored token when valid and not near expiry', async () => {
        const { relay } = makeRelay();
        await relay.setToken({ token: 'GOOD', expiresAt: NOW + 1e9 });
        expect(await relay.getToken()).toBe('GOOD');
    });

    test('NO_TOKEN when nothing stored (call + getToken)', async () => {
        const { relay } = makeRelay();
        await expect(relay.getToken()).rejects.toMatchObject({ code: 'NO_TOKEN' });
        await expect(relay.call('gateway.email.send', {})).rejects.toMatchObject({ code: 'NO_TOKEN' });
    });

    test('readState surfaces corrupt JSON as INVALID_TOKEN', async () => {
        const { relay, redis } = makeRelay();
        redis._kv.set(TOKEN_KEY, 'this-is-not-json');
        await expect(relay.status()).rejects.toMatchObject({
            code: 'INVALID_TOKEN', message: expect.stringContaining('not valid JSON'),
        });
    });

    test('validateState rejects a state missing the token field', async () => {
        const { relay, redis } = makeRelay();
        redis._kv.set(TOKEN_KEY, JSON.stringify({ expiresAt: NOW + 1e9, sub: SUB }));
        await expect(relay.getToken()).rejects.toMatchObject({
            code: 'INVALID_TOKEN', message: expect.stringContaining('missing token or expiresAt'),
        });
    });
    test('validateState rejects a state missing expiresAt', async () => {
        const { relay, redis } = makeRelay();
        redis._kv.set(TOKEN_KEY, JSON.stringify({ token: 'T', sub: SUB }));
        await expect(relay.getToken()).rejects.toMatchObject({
            code: 'INVALID_TOKEN', message: expect.stringContaining('missing token or expiresAt'),
        });
    });
    test('validateState rejects a sub that does not match the service', async () => {
        const { relay, redis } = makeRelay();
        redis._kv.set(TOKEN_KEY, JSON.stringify({ token: 'T', expiresAt: NOW + 1e9, sub: 'system.evil' }));
        await expect(relay.getToken()).rejects.toMatchObject({ code: 'SUB_MISMATCH' });
    });

    test('expired stored token → TOKEN_EXPIRED and the key is cleared', async () => {
        const { relay, redis } = makeRelay();
        redis._kv.set(TOKEN_KEY, stateJson('OLD', NOW - 5000));   // seeded directly (setToken would reject)
        await expect(relay.getToken()).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
        expect(redis._kv.has(TOKEN_KEY)).toBe(false);
    });
});

// ── call() over the Router ───────────────────────────────────────────────────
describe('call — Router RPC success + error classification', () => {
    async function ready(overrides) {
        const made = makeRelay(overrides);
        await made.relay.setToken({ token: 'BOT', expiresAt: NOW + 1e9 });
        return made;
    }

    test('forwards method/params with the bot token and returns the JSON-RPC result', async () => {
        const { relay } = await ready();
        const r = await relay.call('gateway.email.send', { to: 'x@y.z' });
        expect(r).toEqual({ ok: true, method: 'gateway.email.send' });
        expect(requests).toHaveLength(1);
        expect(requests[0].auth).toBe('Bearer BOT');
        expect(requests[0].method).toBe('gateway.email.send');
        expect(requests[0].params).toEqual({ to: 'x@y.z' });
    });

    test('omits params default to {} on the wire', async () => {
        const { relay } = await ready();
        await relay.call('svc.thing.do');     // no params arg
        expect(requests[0].params).toEqual({});
    });

    test('downstream JSON-RPC error → RPC_FAILED carrying the rpcCode + message', async () => {
        const { relay } = await ready();
        responder = () => ({ json: { jsonrpc: '2.0', id: 'x', error: { code: -32602, message: 'bad params' } } });
        const err = await relay.call('svc.x.get', {}).catch((e) => e);
        expect(err).toBeInstanceOf(RelayError);
        expect(err.code).toBe('RPC_FAILED');
        expect(err.rpcCode).toBe(-32602);
        expect(err.message).toContain('bad params');
    });

    test('downstream error with no message falls back to "rpc error"', async () => {
        const { relay } = await ready();
        responder = () => ({ json: { jsonrpc: '2.0', id: 'x', error: { code: -32000 } } });
        const err = await relay.call('svc.x.get', {}).catch((e) => e);
        expect(err.code).toBe('RPC_FAILED');
        expect(err.message).toContain('rpc error');
    });

    test('non-2xx HTTP → RPC_FAILED carrying httpStatus + truncated body', async () => {
        const { relay } = await ready();
        responder = () => ({ status: 503, text: 'upstream exploded' });
        const err = await relay.call('svc.x.get', {}).catch((e) => e);
        expect(err.code).toBe('RPC_FAILED');
        expect(err.httpStatus).toBe(503);
        expect(err.message).toContain('upstream exploded');
    });

    test('2xx with non-JSON body → RPC_FAILED("invalid JSON response")', async () => {
        const { relay } = await ready();
        responder = () => ({ text: '<html>not json</html>' });
        await expect(relay.call('svc.x.get', {}))
            .rejects.toMatchObject({ code: 'RPC_FAILED', message: expect.stringContaining('invalid JSON response') });
    });

    test('transport error (refused, https branch) → RPC_FAILED wrapping the socket error', async () => {
        // Reserve then free a port → guaranteed ECONNREFUSED. https:// also exercises
        // the `url.protocol === 'https:' ? https : http` true branch.
        const dead = http.createServer();
        await new Promise((r) => dead.listen(0, r));
        const port = dead.address().port;
        await new Promise((r) => dead.close(r));

        const redis = makeRedis({ tokenKey: TOKEN_KEY });
        const relay = createRelay({ redis, serviceName: SERVICE, routerUrl: `https://127.0.0.1:${port}/jsonrpc`, now: () => NOW });
        await relay.setToken({ token: 'BOT', expiresAt: NOW + 1e9 });
        const err = await relay.call('svc.x.get', {}).catch((e) => e);
        expect(err).toBeInstanceOf(RelayError);
        expect(err.code).toBe('RPC_FAILED');
    });
});

// ── trace header forwarding (walContext) ─────────────────────────────────────
describe('call — X-Trace-Id / X-Trace-Depth forwarding from walContext', () => {
    async function ready() {
        const made = makeRelay();
        await made.relay.setToken({ token: 'BOT', expiresAt: NOW + 1e9 });
        return made.relay;
    }

    test('no walContext → no trace headers (default branch)', async () => {
        const relay = await ready();
        await relay.call('svc.x.do', {});
        expect(requests[0].traceId).toBeUndefined();
        expect(requests[0].traceDepth).toBeUndefined();
    });

    test('walContext with trace + finite depth → forwards both (depth verbatim)', async () => {
        const relay = await ready();
        await walContext.run({ trace: 'trace-abc', depth: 5 }, () => relay.call('svc.x.do', {}));
        expect(requests[0].traceId).toBe('trace-abc');
        expect(requests[0].traceDepth).toBe('5');
    });

    test('walContext with trace but no depth → depth defaults to "0" (Number.isFinite false)', async () => {
        const relay = await ready();
        await walContext.run({ trace: 'trace-nodepth' }, () => relay.call('svc.x.do', {}));
        expect(requests[0].traceId).toBe('trace-nodepth');
        expect(requests[0].traceDepth).toBe('0');
    });

    test('walContext present but without trace → no trace headers (store && store.trace false)', async () => {
        const relay = await ready();
        await walContext.run({ uid: 'uid-1' }, () => relay.call('svc.x.do', {}));
        expect(requests[0].traceId).toBeUndefined();
    });
});

// ── token auto-refresh — single refresher (lock acquired) ────────────────────
describe('refresh — this caller holds the lock', () => {
    test('near-expiry token → user.token.refresh → stores + uses the new token', async () => {
        const { relay, redis } = makeRelay();
        await relay.setToken({ token: 'OLD', expiresAt: NOW + 1000 });   // needs rotation now
        responder = (b) => b.method === 'user.token.refresh'
            ? { json: { jsonrpc: '2.0', id: b.id, result: { token: 'NEW', expiresAt: NOW + 10 * HOUR } } }
            : {};
        const r = await relay.call('gateway.email.send', { to: 'a' });
        expect(r).toEqual({ ok: true, method: 'gateway.email.send' });
        // two hops: refresh under the OLD token, then the real method under NEW.
        expect(requests.map((q) => q.method)).toEqual(['user.token.refresh', 'gateway.email.send']);
        expect(requests[0].auth).toBe('Bearer OLD');
        expect(requests[1].auth).toBe('Bearer NEW');
        expect(JSON.parse(redis._kv.get(TOKEN_KEY))).toMatchObject({ token: 'NEW', expiresAt: NOW + 10 * HOUR });
    });

    test('acquireLock accepts a boolean-true NX result (result === true branch)', async () => {
        const { relay } = makeRelay({}, { lockReturn: true });
        await relay.setToken({ token: 'OLD', expiresAt: NOW + 1000 });
        responder = (b) => b.method === 'user.token.refresh'
            ? { json: { jsonrpc: '2.0', id: b.id, result: { token: 'NEW', expiresAt: NOW + 10 * HOUR } } }
            : {};
        await expect(relay.call('svc.x.do', {})).resolves.toEqual({ ok: true, method: 'svc.x.do' });
    });

    test('refresh response missing token → REFRESH_FAILED', async () => {
        const { relay } = makeRelay();
        await relay.setToken({ token: 'OLD', expiresAt: NOW + 1000 });
        responder = (b) => b.method === 'user.token.refresh'
            ? { json: { jsonrpc: '2.0', id: b.id, result: { expiresAt: NOW + 10 * HOUR } } }   // no token
            : {};
        await expect(relay.call('svc.x.do', {}))
            .rejects.toMatchObject({ code: 'REFRESH_FAILED', message: expect.stringContaining('missing token or expiresAt') });
    });

    test('refresh response null → REFRESH_FAILED (!response branch)', async () => {
        const { relay } = makeRelay();
        await relay.setToken({ token: 'OLD', expiresAt: NOW + 1000 });
        responder = (b) => b.method === 'user.token.refresh'
            ? { json: { jsonrpc: '2.0', id: b.id, result: null } }
            : {};
        await expect(relay.call('svc.x.do', {})).rejects.toMatchObject({ code: 'REFRESH_FAILED' });
    });

    test('refresh RPC fails while token still valid → rethrows RPC_FAILED (not TOKEN_EXPIRED)', async () => {
        const { relay } = makeRelay();   // fixed clock → state not yet expired during the catch
        await relay.setToken({ token: 'OLD', expiresAt: NOW + 1000 });
        responder = (b) => b.method === 'user.token.refresh' ? { status: 500, text: 'boom' } : {};
        const err = await relay.call('svc.x.do', {}).catch((e) => e);
        expect(err.code).toBe('RPC_FAILED');
    });

    test('refresh RPC fails AND token has since expired → TOKEN_EXPIRED + state cleared', async () => {
        const redis = makeRedis({ tokenKey: TOKEN_KEY });
        // first now() (getValidToken.isExpired) = 20000 < expiresAt(50000) → valid;
        // later now() calls advance past 50000 → catch sees it expired.
        redis._kv.set(TOKEN_KEY, JSON.stringify({ token: 'OLD', expiresAt: 50000, sub: SUB, lastRefreshAt: 0 }));
        const relay = createRelay({ redis, serviceName: SERVICE, routerUrl: serverUrl, now: incNow(20000, 20000) });
        responder = (b) => b.method === 'user.token.refresh' ? { status: 500, text: 'boom' } : {};
        await expect(relay.call('svc.x.do', {})).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
        expect(redis._kv.has(TOKEN_KEY)).toBe(false);
    });

    test('non-RelayError from the refresh body (redis write throws) → wrapped as REFRESH_FAILED', async () => {
        const redis = makeRedis({ tokenKey: TOKEN_KEY });
        redis._kv.set(TOKEN_KEY, JSON.stringify({ token: 'OLD', expiresAt: NOW + 1000, sub: SUB, lastRefreshAt: NOW }));
        const relay = createRelay({ redis, serviceName: SERVICE, routerUrl: serverUrl, now: () => NOW });
        responder = (b) => b.method === 'user.token.refresh'
            ? { json: { jsonrpc: '2.0', id: b.id, result: { token: 'NEW', expiresAt: NOW + 10 * HOUR } } }
            : {};
        redis._failTokenSet(true);   // writeState() inside performRefresh will throw a raw Error
        const err = await relay.call('svc.x.do', {}).catch((e) => e);
        expect(err.code).toBe('REFRESH_FAILED');
        expect(err.message).toContain('redis down');
    });
});

// ── token auto-refresh — another worker holds the lock (waitForOtherRefresh) ──
describe('refresh — concurrent: another worker holds the lock', () => {
    const stale = stateJson('STALE', NOW + 1000);     // needs rotation, not expired
    const fresh = stateJson('FRESH', NOW + 10 * HOUR); // healthy

    test('lock held then released, fresh token appears → uses it (no own refresh)', async () => {
        const redis = makeScriptedRedis({ tokenSeq: [stale, fresh], lockSeq: ['1', null] });
        const relay = createRelay({ redis, serviceName: SERVICE, routerUrl: serverUrl, now: () => NOW });
        const r = await relay.call('svc.x.do', {});
        expect(r).toEqual({ ok: true, method: 'svc.x.do' });
        expect(requests[0].auth).toBe('Bearer FRESH');   // the other worker's refreshed token
    });

    test('lock released but token still stale → reread yields fresh → uses it', async () => {
        const redis = makeScriptedRedis({ tokenSeq: [stale, stale, fresh], lockSeq: [null] });
        const relay = createRelay({ redis, serviceName: SERVICE, routerUrl: serverUrl, now: () => NOW });
        const r = await relay.call('svc.x.do', {});
        expect(requests[0].auth).toBe('Bearer FRESH');
        expect(r.ok).toBe(true);
    });

    test('lock released, token vanished, reread empty → REFRESH_FAILED', async () => {
        const redis = makeScriptedRedis({ tokenSeq: [stale, null, null], lockSeq: [null] });
        const relay = createRelay({ redis, serviceName: SERVICE, routerUrl: serverUrl, now: () => NOW });
        await expect(relay.call('svc.x.do', {}))
            .rejects.toMatchObject({ code: 'REFRESH_FAILED', message: expect.stringContaining('did not produce a usable token') });
    });

    test('lock released, reread still stale (needs rotation) → REFRESH_FAILED', async () => {
        const redis = makeScriptedRedis({ tokenSeq: [stale, stale, stale], lockSeq: [null] });
        const relay = createRelay({ redis, serviceName: SERVICE, routerUrl: serverUrl, now: () => NOW });
        await expect(relay.call('svc.x.do', {})).rejects.toMatchObject({ code: 'REFRESH_FAILED' });
    });

    test('lock never releases before the deadline → REFRESH_TIMEOUT', async () => {
        const redis = makeRedis({ tokenKey: TOKEN_KEY });
        redis._kv.set(TOKEN_KEY, JSON.stringify({ token: 'STALE', expiresAt: 50000, sub: SUB, lastRefreshAt: 0 }));
        redis._kv.set(LOCK_KEY, '1');                 // held → acquireLock fails
        // incrementing clock blows past the 10s wait deadline immediately (no real sleeping).
        const relay = createRelay({ redis, serviceName: SERVICE, routerUrl: serverUrl, now: incNow(20000, 20000) });
        await expect(relay.call('svc.x.do', {})).rejects.toMatchObject({ code: 'REFRESH_TIMEOUT' });
    });
});

// ── status() / clear() ───────────────────────────────────────────────────────
describe('status — never leaks the token', () => {
    test('no token → { hasToken: false }', async () => {
        const { relay } = makeRelay();
        expect(await relay.status()).toEqual({ hasToken: false });
    });

    test('healthy token → full status, positive ttl, no rotation, not expired', async () => {
        const { relay } = makeRelay();
        await relay.setToken({ token: 'SECRET', expiresAt: NOW + 1e9 });
        const s = await relay.status();
        expect(s).toEqual({
            hasToken: true, sub: SUB, expiresAt: NOW + 1e9,
            ttlMs: 1e9, lastRefreshAt: NOW, needsRotation: false, expired: false,
        });
        expect(JSON.stringify(s)).not.toContain('SECRET');   // token string never exposed
    });

    test('near-expiry token → needsRotation true, still positive ttl', async () => {
        const { relay, redis } = makeRelay();
        redis._kv.set(TOKEN_KEY, stateJson('T', NOW + 1000));
        const s = await relay.status();
        expect(s).toMatchObject({ needsRotation: true, expired: false, ttlMs: 1000 });
    });

    test('expired token → ttlMs clamps to 0 and expired=true', async () => {
        const { relay, redis } = makeRelay();
        redis._kv.set(TOKEN_KEY, stateJson('T', NOW - 5000));
        const s = await relay.status();
        expect(s).toMatchObject({ expired: true, ttlMs: 0, needsRotation: true });
    });
});

describe('clear — emergency reset', () => {
    test('removes the stored token (status reports none afterwards)', async () => {
        const { relay, redis } = makeRelay();
        await relay.setToken({ token: 'TKN', expiresAt: NOW + 1e9 });
        await relay.clear();
        expect(redis._kv.has(TOKEN_KEY)).toBe(false);
        expect(await relay.status()).toEqual({ hasToken: false });
    });

    test('is a no-op (no throw) when nothing is stored', async () => {
        const { relay } = makeRelay();
        await expect(relay.clear()).resolves.toBeUndefined();
    });
});

// ── audit (walLogger) ────────────────────────────────────────────────────────
describe('audit — optional walLogger', () => {
    test('invokes walLogger with the RELAY:<svc> key + event payload', async () => {
        const calls = [];
        const redis = makeRedis({ tokenKey: TOKEN_KEY });
        const relay = createRelay({
            redis, serviceName: SERVICE, routerUrl: serverUrl, now: () => NOW,
            walLogger: (k, d) => calls.push([k, d]),
        });
        await relay.setToken({ token: 'TKN', expiresAt: NOW + 1e9 });
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('RELAY:notification');
        expect(calls[0][1]).toMatchObject({ event: 'set_token', serviceName: SERVICE, ts: NOW, expiresAt: NOW + 1e9 });
    });

    test('a throwing walLogger is swallowed (audit never blocks business)', async () => {
        const redis = makeRedis({ tokenKey: TOKEN_KEY });
        const relay = createRelay({
            redis, serviceName: SERVICE, routerUrl: serverUrl, now: () => NOW,
            walLogger: () => { throw new Error('audit boom'); },
        });
        await expect(relay.setToken({ token: 'TKN', expiresAt: NOW + 1e9 })).resolves.toBeUndefined();
        expect((await relay.status()).hasToken).toBe(true);   // write still happened
    });
});
