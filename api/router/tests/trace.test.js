/**
 * Trace propagation tests (toFix §二.事件链 "trace 不传递" fix).
 *
 *   handlers/trace.js   — inherit-or-mint resolution from HTTP headers
 *   handlers/events.js  — envelope trace_id propagation, depth+1, parent_event_id
 *                         trust rules, EVENT_MAX_DEPTH chain breaker
 *   handlers/forward.js — trace/depth threaded into the signed token's meta
 *
 * All hermetic: no real Redis, no network (forwardRequest is not invoked; we only
 * verify payload construction via the events/trace surface it shares).
 */
const trace = require('../handlers/trace');
const { processEvents } = require('../handlers/events');

// ── Fake Redis (same shape as events.test.js, + SETNX for the dedup guard) ────
function makeRedis(registryJson = null) {
    const streams = {};
    const errors = [];
    const kv = new Map();
    return {
        isOpen: true,
        async get() { return registryJson; },
        async set(k, v, opts = {}) {
            if (opts.NX && kv.has(k)) return null;   // node-redis: NX miss → null
            kv.set(k, v);
            return 'OK';
        },
        async xAdd(stream, id, fields) {
            (streams[stream] ||= []).push(fields);
            return '1-0';
        },
        rPush(key, val) { errors.push(JSON.parse(val)); return Promise.resolve(1); },
        _streams: streams,
        _errors: errors,
        _kv: kv,
    };
}

const REGISTRY = JSON.stringify({
    'system.nexus': { 'EVENT:E2E:*': ['*'] },
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. trace.resolve — inherit or mint
// ─────────────────────────────────────────────────────────────────────────────
describe('trace.resolve', () => {
    test('inherits a valid X-Trace-Id and depth', () => {
        const ctx = trace.resolve({ 'x-trace-id': 'abc123def456', 'x-trace-depth': '3' });
        expect(ctx.trace).toBe('abc123def456');
        expect(ctx.depth).toBe(3);
    });

    test('mints when header absent (chain start) — 16-hex, depth 0', () => {
        const ctx = trace.resolve({});
        expect(ctx.trace).toMatch(/^[0-9a-f]{16}$/);
        expect(ctx.depth).toBe(0);
    });

    test('rejects malformed ids (injection/garbage) and mints instead', () => {
        for (const bad of ['', 'a b c', 'x'.repeat(65), '☃☃☃☃', 'a;rm -rf', 'ab\ncd']) {
            const ctx = trace.resolve({ 'x-trace-id': bad });
            expect(ctx.trace).toMatch(/^[0-9a-f]{16}$/);
        }
    });

    test('sanitizes depth: NaN/negative → 0, huge → clamped', () => {
        expect(trace.resolve({ 'x-trace-depth': 'banana' }).depth).toBe(0);
        expect(trace.resolve({ 'x-trace-depth': '-5' }).depth).toBe(0);
        expect(trace.resolve({ 'x-trace-depth': '99999999' }).depth).toBe(10000);
    });

    test('two mints differ (no id reuse across chains)', () => {
        expect(trace.resolve({}).trace).not.toBe(trace.resolve({}).trace);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. envelope propagation
// ─────────────────────────────────────────────────────────────────────────────
describe('processEvents — chain fields on the envelope', () => {
    const base = { stream: 'EVENT:E2E:T', type: 'x', payload: { a: 1 } };

    test('propagates traceCtx.trace and stamps depth = ctx.depth + 1', async () => {
        const redis = makeRedis(REGISTRY);
        await processEvents([{ ...base }], {
            source: 'system.nexus', actor: 'system.nexus', redisClient: redis,
            traceCtx: { trace: 'chain-aaaa', depth: 2 },
        });
        const [env] = redis._streams['EVENT:E2E:T'];
        expect(env.trace_id).toBe('chain-aaaa');
        expect(env.depth).toBe('3');
        expect(env.event_id).toMatch(/^[0-9a-f]{16}$/);
    });

    test('without traceCtx: mints a trace (chain starts at the emit), depth 1', async () => {
        const redis = makeRedis(REGISTRY);
        await processEvents([{ ...base }], { source: 'system.nexus', actor: 'a', redisClient: redis });
        const [env] = redis._streams['EVENT:E2E:T'];
        expect(env.trace_id).toMatch(/^[0-9a-f]{16}$/);
        expect(env.depth).toBe('1');
    });

    test('parent_event_id: trusted on the emit path, stripped on piggyback', async () => {
        const redis = makeRedis(REGISTRY);
        await processEvents([{ ...base, parent_event_id: 'parent-1' }], {
            source: 'system.nexus', actor: 'a', redisClient: redis, trustEventActor: true,
        });
        await processEvents([{ ...base, parent_event_id: 'forged-1' }], {
            source: 'system.nexus', actor: 'a', redisClient: redis, trustEventActor: false,
        });
        const [trusted, piggyback] = redis._streams['EVENT:E2E:T'];
        expect(trusted.parent_event_id).toBe('parent-1');
        expect(piggyback.parent_event_id).toBe('');
    });

    test('same batch shares trace; each event gets its own event_id', async () => {
        const redis = makeRedis(REGISTRY);
        await processEvents([{ ...base }, { ...base }], {
            source: 'system.nexus', actor: 'a', redisClient: redis,
            traceCtx: { trace: 'chain-bbbb', depth: 0 },
        });
        const [e1, e2] = redis._streams['EVENT:E2E:T'];
        expect(e1.trace_id).toBe('chain-bbbb');
        expect(e2.trace_id).toBe('chain-bbbb');
        expect(e1.event_id).not.toBe(e2.event_id);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2b. event_id idempotency — retry-after-crash duplicates are suppressed
// ─────────────────────────────────────────────────────────────────────────────
describe('processEvents — client event_id dedup', () => {
    const base = { stream: 'EVENT:E2E:T', type: 'x', payload: { a: 1 } };

    test('same event_id re-sent → second emit suppressed, envelope keeps client id', async () => {
        const redis = makeRedis(REGISTRY);
        const first = await processEvents([{ ...base, event_id: 'retry-safe-001' }],
            { source: 'system.nexus', actor: 'a', redisClient: redis });
        const second = await processEvents([{ ...base, event_id: 'retry-safe-001' }],
            { source: 'system.nexus', actor: 'a', redisClient: redis });

        expect(first.written).toBe(1);
        expect(second.written).toBe(0);
        expect(second.deduped).toBe(1);
        expect(redis._streams['EVENT:E2E:T']).toHaveLength(1);
        expect(redis._streams['EVENT:E2E:T'][0].event_id).toBe('retry-safe-001');
    });

    test('invalid event_id format is ignored (random id minted, no dedup claim)', async () => {
        const redis = makeRedis(REGISTRY);
        await processEvents([{ ...base, event_id: 'x y;!' }],
            { source: 'system.nexus', actor: 'a', redisClient: redis });
        const [env] = redis._streams['EVENT:E2E:T'];
        expect(env.event_id).toMatch(/^[0-9a-f]{16}$/);
        expect(redis._kv.size).toBe(0);   // no dedup slot claimed for garbage ids
    });

    test('distinct event_ids both write', async () => {
        const redis = makeRedis(REGISTRY);
        await processEvents([{ ...base, event_id: 'id-aaaa-01' }, { ...base, event_id: 'id-bbbb-02' }],
            { source: 'system.nexus', actor: 'a', redisClient: redis });
        expect(redis._streams['EVENT:E2E:T']).toHaveLength(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. depth budget — the chain breaker
// ─────────────────────────────────────────────────────────────────────────────
describe('processEvents — EVENT_MAX_DEPTH breaker', () => {
    const base = { stream: 'EVENT:E2E:T', type: 'x', payload: {} };

    test('at the budget edge (depth 15 → 16) still writes', async () => {
        const redis = makeRedis(REGISTRY);
        const stats = await processEvents([{ ...base }], {
            source: 'system.nexus', actor: 'a', redisClient: redis,
            traceCtx: { trace: 't-edge', depth: 15 },
        });
        expect(stats.written).toBe(1);
        expect(redis._streams['EVENT:E2E:T'][0].depth).toBe('16');
    });

    test('over budget (depth 16 → 17): blocked, nothing written, error queued', async () => {
        const redis = makeRedis(REGISTRY);
        const stats = await processEvents([{ ...base }], {
            source: 'system.nexus', actor: 'a', redisClient: redis,
            traceCtx: { trace: 't-loop', depth: 16 },
        });
        expect(stats.written).toBe(0);
        expect(stats.blocked).toBe(1);
        expect(redis._streams['EVENT:E2E:T']).toBeUndefined();
        expect(redis._errors[0].code).toBe('EVENT_DEPTH_EXCEEDED');
        expect(redis._errors[0].trace_id).toBe('t-loop');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. forward token meta carries the chain
// ─────────────────────────────────────────────────────────────────────────────
describe('forward token meta', () => {
    test('authPayload.meta gains trace/depth (decode the signed token)', async () => {
        const tweetnacl = require('tweetnacl');
        const bs58 = require('bs58').default || require('bs58');
        const { forwardRequest } = require('../handlers/forward');

        // Intercept the HTTP call: axios.post is the only network touchpoint.
        const axios = require('axios');
        const spy = jest.spyOn(axios, 'post').mockResolvedValue({ data: { jsonrpc: '2.0', result: {}, id: 1 } });

        const keypair = tweetnacl.sign.keyPair();
        await forwardRequest({
            targetService: { url: 'http://localhost:1/x' },
            method: 'svc.thing.do', params: {}, jsonrpc: '2.0', id: 1,
            sessionUser: { uid: 'uid-1' }, isAdmin: false,
            keypair: { secretKey: keypair.secretKey },
            debug: false, sourceHeaders: {},
            traceCtx: { trace: 'chain-cccc', depth: 4 },
        });

        const headers = spy.mock.calls[0][2].headers;
        const payload = JSON.parse(Buffer.from(bs58.decode(headers['X-Router-Token'])).toString('utf8'));
        expect(payload.meta.trace).toBe('chain-cccc');
        expect(payload.meta.depth).toBe(4);
        expect(payload.user).toBe('uid-1');
        spy.mockRestore();
    });
});
