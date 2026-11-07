/**
 * solo-bridge.test.js — Hermetic Cross-Box Bridge Contract Test (gateway ↔ Router validator ↔ ingress).
 *
 * Proves that two SOLO stacks can connect directly via `gateway.webhook.send({ target: 'solo' })`
 * → peer `{Router}/jsonrpc` (`ingress.ingest`) WITHOUT `WEBHOOK_ALLOW_LOOPBACK=1`, unifying:
 *   1. JSON-RPC 2.0 envelope + Router perimeter schema validation (`checkParams`)
 *   2. `Authorization: ApiKey <secret>` header (secret never placed in RPC params)
 *   3. End-to-end idempotency (`idempotencyKey` / `_tasks` `idempotency_key` ↔ `ingress` `request_id`)
 *   4. Loopback `/jsonrpc` narrow allowlist (while blocking `/other`, raw webhook loopback, & cloud metadata)
 *   5. `meta.hop` federation loop brake (`hop: 0 → 1 → 2 → 3` allowed; `hop >= 3` refused)
 *   6. Honest receipt propagation (`stream`, `duplicate: true`, `422 held` + `violations`, and error release)
 */
const os = require('os');
const path = require('path');
const http = require('http');

process.env.LOG_DIR = path.join(os.tmpdir(), `solo-bridge-contract-${process.pid}`);
process.env.GATEWAY_SECRET_KEY = process.env.GATEWAY_SECRET_KEY || 'test-gateway-secret';
// Deliberately DO NOT set WEBHOOK_ALLOW_LOOPBACK — proves same-host cross-box loopback works in production posture!
delete process.env.WEBHOOK_ALLOW_LOOPBACK;

const createGatewayLogic = require('../logic');
const gatewayIntrospection = require('../handlers/introspection');
const gatewayConfig = require('../config');
const createIngressLogic = require('../../ingress/logic');
const ingressIntrospection = require('../../ingress/handlers/introspection');
const ingressConfig = require('../../ingress/config');
const { checkParams } = require('../../../library/validate');
const { checkReturn } = require('../../../library/contract');
const { makeFakeRedis: makeGatewayRedis, silentLogger } = require('./helpers/fake-redis');

function makeIngressRedis() {
    const kv = new Map();
    const sets = new Map();
    const lists = new Map();
    const zsets = new Map();
    const counters = new Map();
    const getSet = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));
    const getList = (k) => (lists.has(k) ? lists.get(k) : lists.set(k, []).get(k));
    const getZset = (k) => (zsets.has(k) ? zsets.get(k) : zsets.set(k, new Map()).get(k));
    const apply = {
        set: (k, v, opts) => { if (opts && opts.NX && kv.has(k)) return null; kv.set(k, v); return 'OK'; },
        sAdd: (k, m) => { const s = getSet(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        del: (k) => { const had = kv.delete(k); sets.delete(k); return had ? 1 : 0; },
        sRem: (k, m) => { const s = sets.get(k); return s && s.delete(m) ? 1 : 0; },
        zAdd: (k, { score, value }) => { getZset(k).set(value, score); return 1; },
        zRem: (k, m) => { const z = zsets.get(k); return z && z.delete(m) ? 1 : 0; },
    };
    return {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v, opts) { return apply.set(k, v, opts); },
        async del(k) { return apply.del(k); },
        async mGet(keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
        async sAdd(k, m) { return apply.sAdd(k, m); },
        async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
        async sRem(k, m) { return apply.sRem(k, m); },
        async sIsMember(k, m) { return sets.has(k) && sets.get(k).has(m) ? 1 : 0; },
        async sCard(k) { return sets.has(k) ? sets.get(k).size : 0; },
        async incr(k) { const n = (counters.get(k) || 0) + 1; counters.set(k, n); return n; },
        async zAdd(k, entry) { return apply.zAdd(k, entry); },
        async zRem(k, m) { return apply.zRem(k, m); },
        async zCard(k) { return zsets.has(k) ? zsets.get(k).size : 0; },
        async rPush(k, v) { const l = getList(k); l.push(v); return l.length; },
        async lLen(k) { return lists.has(k) ? lists.get(k).length : 0; },
        async lRange(k, start, stop) {
            const l = getList(k);
            const end = stop === -1 ? l.length : stop + 1;
            return l.slice(start, end);
        },
        async lRem(k, count, v) {
            const l = getList(k);
            const idx = l.indexOf(v);
            if (idx === -1) return 0;
            l.splice(idx, 1);
            return 1;
        },
        async lTrim(k, start, stop) {
            const l = getList(k);
            const end = stop === -1 ? l.length : stop + 1;
            lists.set(k, l.slice(start < 0 ? Math.max(0, l.length + start) : start, end));
            return 'OK';
        },
        multi() {
            const ops = [];
            const chain = {
                set(k, v, opts) { ops.push(['set', k, v, opts]); return chain; },
                sAdd(k, m) { ops.push(['sAdd', k, m]); return chain; },
                del(k) { ops.push(['del', k]); return chain; },
                sRem(k, m) { ops.push(['sRem', k, m]); return chain; },
                zAdd(k, entry) { ops.push(['zAdd', k, entry]); return chain; },
                zRem(k, m) { ops.push(['zRem', k, m]); return chain; },
                async exec() { return ops.map(([op, ...args]) => apply[op](...args)); },
            };
            return chain;
        },
    };
}

const gwSendDecl = gatewayIntrospection.find((m) => m.name === 'gateway.webhook.send');
const ingestDecl = ingressIntrospection.find((m) => m.name === 'ingress.ingest');

describe('SOLO Cross-Box Bridge v1 — gateway.webhook.send(target="solo") ↔ ingress.ingest', () => {
    let peerServer;
    let peerPort;
    let ingress;
    let peerBusEvents;
    let emitStats;
    let lastWireHeaders;
    let lastWireBody;

    beforeEach(async () => {
        peerBusEvents = [];
        emitStats = { ok: true, count: 1, written: 1, blocked: 0, deduped: 0 };
        lastWireHeaders = null;
        lastWireBody = null;

        const ingressRelay = {
            async call(method, params) {
                if (method === 'event.emit') {
                    if (emitStats.written > 0) peerBusEvents.push(params);
                    return emitStats;
                }
                return { ok: true };
            },
        };
        ingress = createIngressLogic(makeIngressRedis(), { config: ingressConfig, relay: ingressRelay });

        peerServer = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', async () => {
                lastWireHeaders = req.headers;
                const raw = Buffer.concat(chunks).toString('utf8');
                lastWireBody = raw;
                if (req.url !== '/jsonrpc') {
                    res.statusCode = 404;
                    return res.end('not found');
                }
                const rpc = JSON.parse(raw);
                if (rpc.method !== 'ingress.ingest') {
                    res.statusCode = 200;
                    return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }));
                }
                // Enforce the exact Router perimeter validator (`checkParams` on `ingress.ingest`)!
                const paramViolations = checkParams(ingestDecl.params, rpc.params || {});
                if (paramViolations.length > 0) {
                    res.statusCode = 200;
                    return res.end(JSON.stringify({
                        jsonrpc: '2.0',
                        id: rpc.id,
                        error: { code: -32602, message: `Invalid params: ${paramViolations.join('; ')}` },
                    }));
                }
                const auth = req.headers['authorization'] || '';
                const apiKey = auth.startsWith('ApiKey ') ? auth.slice(7).trim() : null;
                const out = await ingress.ingest.handle(apiKey, rpc.params);
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: out.body }));
            });
        });
        await new Promise((r) => peerServer.listen(0, '127.0.0.1', r));
        peerPort = peerServer.address().port;
    });

    afterEach(async () => {
        if (peerServer) await new Promise((r) => peerServer.close(r));
    });

    test('delivers cross-box event over loopback /jsonrpc without WEBHOOK_ALLOW_LOOPBACK, incrementing meta.hop and keeping secret out of RPC params', async () => {
        const src = await ingress.source.create({ name: 'steward_rpa' });
        const boxA = createGatewayLogic(makeGatewayRedis(), { serviceName: 'gateway', config: gatewayConfig, logger: silentLogger });

        const res = await boxA.webhook.send({
            target: 'solo',
            url: `http://127.0.0.1:${peerPort}/jsonrpc`,
            secret: src.apiKey,
            idempotencyKey: 'fin-inv-20261107-01',
            payload: { invoiceNo: 'INV-8801', amount: 1280.5 },
            meta: { origin: 'steward', trace_id: 'tr_01' },
        });

        expect(checkReturn(gwSendDecl, res)).toEqual([]);
        expect(res).toMatchObject({
            success: true,
            status: 200,
            provider: 'solo',
            messageId: 'fin-inv-20261107-01',
            requestId: 'fin-inv-20261107-01',
            stream: 'EVENT:WEBHOOK:STEWARD_RPA',
            duplicate: false,
        });

        // Wire audit: ApiKey in header, no HMAC header, secret absent from JSON-RPC body!
        expect(lastWireHeaders['authorization']).toBe(`ApiKey ${src.apiKey}`);
        expect(lastWireHeaders['x-solo-signature']).toBeUndefined();
        expect(lastWireBody).not.toContain(src.apiKey);

        // Peer bus event carries request_id, data, and incremented meta.hop = 1
        expect(peerBusEvents).toHaveLength(1);
        expect(peerBusEvents[0]).toEqual({
            stream: 'EVENT:WEBHOOK:STEWARD_RPA',
            type: 'webhook.received',
            actor: 'webhook:steward_rpa',
            payload: {
                request_id: 'fin-inv-20261107-01',
                data: { invoiceNo: 'INV-8801', amount: 1280.5 },
                meta: { origin: 'steward', trace_id: 'tr_01', hop: 1 },
            },
        });
    });

    test('normalizes non-id idempotencyKey (e.g. notification worker or fulfillment _tasks colon key) so Router perimeter validator accepts it and peer dedupes retries', async () => {
        const src = await ingress.source.create({ name: 'fulfillment_peer' });
        const boxA1 = createGatewayLogic(makeGatewayRedis(), { serviceName: 'gateway', config: gatewayConfig, logger: silentLogger });
        const boxA2 = createGatewayLogic(makeGatewayRedis(), { serviceName: 'gateway', config: gatewayConfig, logger: silentLogger });

        const colonKey = 'FL-20261107-9001-T2:A0';
        const first = await boxA1.webhook.send({
            target: 'solo',
            url: `http://127.0.0.1:${peerPort}/jsonrpc`,
            secret: src.apiKey,
            idempotency_key: colonKey,   // snake_case alias injected by fulfillment _tasks!
            payload: { orderId: 'ORD-9001' },
        });
        expect(checkReturn(gwSendDecl, first)).toEqual([]);
        expect(first.success).toBe(true);
        expect(first.duplicate).toBe(false);
        expect(first.requestId).toMatch(/^idem_[0-9a-f]{32}$/);
        expect(peerBusEvents[0].payload.meta).toMatchObject({ hop: 1, idempotency_key: colonKey });

        // Fresh sender ledger (simulating peer replay / separate worker) hits ingress SET NX dedup!
        const second = await boxA2.webhook.send({
            target: 'solo',
            url: `http://127.0.0.1:${peerPort}/jsonrpc`,
            secret: src.apiKey,
            idempotencyKey: colonKey,
            payload: { orderId: 'ORD-9001' },
        });
        expect(checkReturn(gwSendDecl, second)).toEqual([]);
        expect(second.success).toBe(true);
        expect(second.duplicate).toBe(true);
        expect(second.stream).toBeUndefined();
        expect(peerBusEvents).toHaveLength(1);
    });

    test('surfaces 422 dataSchema / prompt-injection hold honestly (held:true + violations) and preserves meta on review.approve', async () => {
        const src = await ingress.source.create({
            name: 'guarded_peer',
            dataSchema: [{ name: 'amount', type: 'number', required: true }],
        });
        const boxA = createGatewayLogic(makeGatewayRedis(), { serviceName: 'gateway', config: gatewayConfig, logger: silentLogger });

        const held = await boxA.webhook.send({
            target: 'solo',
            url: `http://127.0.0.1:${peerPort}/jsonrpc`,
            secret: src.apiKey,
            idempotencyKey: 'hold-req-1',
            payload: { amount: 50, extra_untrusted: 'surprise' },
            meta: { origin: 'steward', hop: 1 },
        });

        expect(checkReturn(gwSendDecl, held)).toEqual([]);
        expect(held.success).toBe(false);
        expect(held.held).toBe(true);
        expect(held.status).toBe(422);
        expect(held.violations[0]).toMatch(/extra_untrusted.*not declared/);
        expect(peerBusEvents).toHaveLength(0);

        // Human approves in peer ingress → emitted event retains meta.hop = 2!
        const reviews = await ingress.review.list({});
        expect(reviews.total).toBe(1);
        await ingress.review.approve({ reviewId: reviews.items[0].reviewId });
        expect(peerBusEvents).toHaveLength(1);
        expect(peerBusEvents[0].payload.meta).toEqual({ origin: 'steward', hop: 2 });
    });

    test('rejects on invalid API key (401) and event-not-delivered (502), releasing gateway idempotencyKey so retry succeeds', async () => {
        const src = await ingress.source.create({ name: 'retry_peer' });
        const gwRedis = makeGatewayRedis();
        const boxA = createGatewayLogic(gwRedis, { serviceName: 'gateway', config: gatewayConfig, logger: silentLogger });

        // 1. Bad API key → permanent 401 failure
        await expect(boxA.webhook.send({
            target: 'solo',
            url: `http://127.0.0.1:${peerPort}/jsonrpc`,
            secret: 'ingk_wrong',
            idempotencyKey: 'retry-key-1',
            payload: { x: 1 },
        })).rejects.toMatchObject({ httpStatus: 401 });

        // 2. Peer Router blocks event.emit (502) → transient failure, releases BOTH dedup & gateway idem
        emitStats = { ok: true, count: 1, written: 0, blocked: 1, deduped: 0 };
        await expect(boxA.webhook.send({
            target: 'solo',
            url: `http://127.0.0.1:${peerPort}/jsonrpc`,
            secret: src.apiKey,
            idempotencyKey: 'retry-key-1',
            payload: { x: 1 },
        })).rejects.toMatchObject({ httpStatus: 502 });

        // 3. Peer Router recovers → retry with SAME idempotencyKey now delivers cleanly!
        emitStats = { ok: true, count: 1, written: 1, blocked: 0, deduped: 0 };
        const ok = await boxA.webhook.send({
            target: 'solo',
            url: `http://127.0.0.1:${peerPort}/jsonrpc`,
            secret: src.apiKey,
            idempotencyKey: 'retry-key-1',
            payload: { x: 1 },
        });
        expect(ok.success).toBe(true);
        expect(ok.duplicate).toBe(false);
        expect(peerBusEvents).toHaveLength(1);
    });

    test('enforces SSRF & loop-brake boundaries: blocks non-/jsonrpc loopback, raw webhook loopback, cloud metadata, and hop >= 3', async () => {
        const src = await ingress.source.create({ name: 'guard_peer' });
        const boxA = createGatewayLogic(makeGatewayRedis(), { serviceName: 'gateway', config: gatewayConfig, logger: silentLogger });

        // Raw webhook mode still blocks loopback /jsonrpc!
        await expect(boxA.webhook.send({
            url: `http://127.0.0.1:${peerPort}/jsonrpc`,
            payload: {},
        })).rejects.toThrow(/loopback/);

        // Solo mode blocks loopback when path !== '/jsonrpc'
        await expect(boxA.webhook.send({
            target: 'solo',
            url: `http://127.0.0.1:${peerPort}/admin`,
            secret: src.apiKey,
            payload: {},
        })).rejects.toThrow(/\/jsonrpc/);

        // Solo mode STILL blocks cloud metadata & unspecified addresses even on /jsonrpc!
        for (const badHost of [
            'http://169.254.169.254/jsonrpc',
            'http://100.100.100.200/jsonrpc',
            'http://metadata.google.internal/jsonrpc',
            'http://0.0.0.0:8600/jsonrpc',
        ]) {
            await expect(boxA.webhook.send({
                target: 'solo',
                url: badHost,
                secret: src.apiKey,
                payload: {},
            })).rejects.toThrow(/loopback|internal|not allowed/i);
        }

        // Hop 2 → 3 is allowed (3rd hop), Hop 3 → 4 is refused at gateway before network!
        const hop3 = await boxA.webhook.send({
            target: 'solo',
            url: `http://127.0.0.1:${peerPort}/jsonrpc`,
            secret: src.apiKey,
            idempotencyKey: 'hop-ok-3',
            payload: {},
            meta: { hop: 2 },
        });
        expect(hop3.success).toBe(true);
        expect(peerBusEvents[0].payload.meta.hop).toBe(3);

        await expect(boxA.webhook.send({
            target: 'solo',
            url: `http://127.0.0.1:${peerPort}/jsonrpc`,
            secret: src.apiKey,
            idempotencyKey: 'hop-blocked-4',
            payload: {},
            meta: { hop: 3 },
        })).rejects.toThrow(/hop limit/i);
    });
});
