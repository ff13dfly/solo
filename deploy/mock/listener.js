#!/usr/bin/env node
//
// Mock webhook listener (DEV ONLY — not part of the SOLO bundle).
//
// Simulates an independently-developed external listener (core/ingress/README §1):
//   1. receives "external-shaped" JSON on POST /hook
//   2. archives the RAW original request keyed by sha256(request_id)  ← durable record
//   3. wraps into the unified envelope { request_id, data }
//   4. calls the Router (NOT ingress directly) with JSON-RPC ingress.ingest,
//      carrying the per-source API key in the Authorization header
//
// Why through the Router: it is SOLO's single entrance (CLAUDE.md §2). The Router
// forwards the Authorization header to ingress (router/handlers/forward.js), so the
// API key never lands in RPC params / audit logs. ingress.ingest is a public method.
//
// Config (env):
//   MOCK_PORT             listen port                 (default 8090)
//   ROUTER_URL            router base url              (default https://127.0.0.1:8800)
//                         8800 = dev SSL proxy → Router 8600 (needs `dev.sh --ssl`);
//                         override to http://127.0.0.1:8600 to skip TLS.
//   INGRESS_API_KEY       key from ingress.source.create   (REQUIRED)
//   SOURCE_NAME           label, for logs/archive dir  (default 'mock')
//   LISTENER_ARCHIVE_DIR  raw-request archive dir      (default <repo>/logs/listener-<source>)
//
// Usage once running:
//   curl -X POST localhost:8090/hook -H 'content-type: application/json' -d '{"hello":"world"}'
//   # same delivery twice (fixed request_id) → ingress dedup kicks in:
//   curl -X POST localhost:8090/hook -H 'x-request-id: fixed-123' -d '{"n":1}'
//   curl -X POST localhost:8090/hook -H 'x-request-id: fixed-123' -d '{"n":2}'   # → duplicate
//
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.MOCK_PORT || '8090', 10);
const ROUTER_URL = (process.env.ROUTER_URL || 'https://127.0.0.1:8800').replace(/\/$/, '');
const API_KEY = process.env.INGRESS_API_KEY;
const SOURCE_NAME = process.env.SOURCE_NAME || 'mock';
const ARCHIVE_DIR = process.env.LISTENER_ARCHIVE_DIR
    || path.join(__dirname, '..', '..', 'logs', `listener-${SOURCE_NAME}`);

if (!API_KEY) {
    console.error('✗ INGRESS_API_KEY is required.');
    console.error('  Create a source first (Portal → Ingress, or ingress.source.create) and pass its key:');
    console.error('  INGRESS_API_KEY=ingk_xxx node deploy/mock/listener.js');
    process.exit(1);
}

function readBody(req) {
    return new Promise((resolve) => {
        let buf = '';
        req.on('data', (c) => { buf += c; });
        req.on('end', () => resolve(buf));
    });
}

// Archive the raw original request, keyed by sha256(request_id) — the durable
// "what the external system actually sent" record, addressable for reverse-trace.
function archiveRaw(requestId, rawBody, headers) {
    const hash = crypto.createHash('sha256').update(requestId).digest('hex');
    try {
        if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
        const record = { request_id: requestId, received_at: Date.now(), source: SOURCE_NAME, headers, raw: rawBody };
        fs.writeFileSync(path.join(ARCHIVE_DIR, `${hash}.json`), JSON.stringify(record, null, 2));
    } catch (e) {
        console.error('✗ archive failed:', e.message);
    }
}

// Call the Router with JSON-RPC ingress.ingest; API key in the Authorization header.
function callRouter(requestId, data) {
    return new Promise((resolve, reject) => {
        const u = new URL(`${ROUTER_URL}/jsonrpc`);
        const isTls = u.protocol === 'https:';
        const client = isTls ? https : http;
        const payload = JSON.stringify({
            jsonrpc: '2.0', id: requestId, method: 'ingress.ingest',
            params: { request_id: requestId, data },
        });
        const r = client.request({
            hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
            // dev SSL proxy uses a local self-signed cert (~/.certs via mkcert);
            // accept it for the dev mock. Real listeners against a real cert drop this.
            ...(isTls ? { rejectUnauthorized: false } : {}),
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
                'authorization': `ApiKey ${API_KEY}`,
            },
        }, (resp) => {
            let body = '';
            resp.on('data', (c) => { body += c; });
            resp.on('end', () => resolve({ status: resp.statusCode, body }));
        });
        r.on('error', reject);
        r.write(payload);
        r.end();
    });
}

const START_TIME = Date.now();

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({
            status: 'ok',
            source: SOURCE_NAME,
            port: PORT,
            uptime: Math.floor((Date.now() - START_TIME) / 1000),
            router: ROUTER_URL,
        }));
    }
    if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`mock listener "${SOURCE_NAME}" → ${ROUTER_URL}/jsonrpc (ingress.ingest)\nPOST /hook with JSON to simulate an external webhook.\nGET /health for JSON health status.\n`);
    }
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
        });
        return res.end();
    }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

    res.setHeader('access-control-allow-origin', '*');
    const raw = await readBody(req);
    let data;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"body not JSON"}'); }

    // request_id: the listener decides. Honour an explicit header (lets you test
    // dedup with a fixed id), else derive a stable-ish one.
    const requestId = req.headers['x-request-id']
        || req.headers['x-delivery-id']
        || `${SOURCE_NAME}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    archiveRaw(requestId, data, req.headers);

    try {
        const result = await callRouter(requestId, data);
        console.log(`→ request_id=${requestId} → router ${result.status}: ${result.body}`);
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(result.body);
    } catch (e) {
        console.error('✗ router call failed:', e.message);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(`{"ok":false,"error":"router call failed: ${e.message}"}`);
    }
});

server.listen(PORT, () => {
    console.log(`✓ mock listener "${SOURCE_NAME}" on :${PORT}  →  ${ROUTER_URL}/jsonrpc (ingress.ingest)`);
    console.log(`  raw archive: ${ARCHIVE_DIR}/{sha256(request_id)}.json`);
    console.log(`  health:      http://localhost:${PORT}/health`);
    console.log(`  curl -X POST localhost:${PORT}/hook -H 'content-type: application/json' -d '{"hello":"world"}'`);
});

// NOTE: a 30 s "heartbeat" used to live here — it fired a synthetic `{_heartbeat:true}`
// event via ingress.ingest purely to keep the source's lastFiredAt fresh in the portal.
// But this source's stream (EVENT:WEBHOOK:MOCK-LISTENER) is subscribed by the demo workflow
// wf-mock-listener-payment, whose `record` step mandates `amount`. Heartbeats carry none, so
// EVERY ping produced a FAILED run (~one per 30 s) and flooded the orchestrator RUNS list with
// identical "missing mandatory field 'amount'" errors. The matcher filter is top-level-equality
// only and ingress hard-codes the event type, so heartbeats can't be excluded downstream — its
// cosmetic value was far below that cost. Removed. lastFiredAt now reflects real deliveries
// (POST /hook); if you want liveness, hit GET /health instead of emitting a fake webhook.
