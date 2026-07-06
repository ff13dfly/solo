/**
 * E2E globalSetup — injects admin session, waits for Router.
 *
 * Prerequisites: run `bash deploy/run.sh` before executing tests.
 * REDIS_URL env var overrides the default (read from deploy/.env or fallback).
 * ROUTER_URL env var overrides auto-discovery from deploy/solo-services.json.
 *
 * What this does:
 *   1. Connects to Redis and injects an allow_all admin session token
 *   2. Waits for the Router to respond to a ping
 *   3. Writes a context file that suites read for routerUrl / redisUrl
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { createClient } = require('redis');
const { ADMIN_TOKEN } = require('./identity');
const ctxFile = require('../lib/context');

// ── config ──────────────────────────────────────────────────────────────────

function loadEnvFile() {
    const envPath = path.join(__dirname, '../../.env');
    const vars = {};
    try {
        fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
            const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
            if (m) vars[m[1]] = m[2].trim();
        });
    } catch { /* .env optional */ }
    return vars;
}

function getRouterPort() {
    const svcPath = path.join(__dirname, '../../deploy/solo-services.json');
    try {
        const svcs = JSON.parse(fs.readFileSync(svcPath, 'utf8'));
        const router = svcs.find((s) => s.name === 'router');
        return router ? router.port : 8600;
    } catch { return 8600; }
}

// Solo internal services + private apps — used to register them with the Router.
function getServices() {
    const all = [];
    for (const f of ['../../deploy/solo-services.json', '../../deploy/services.json']) {
        try {
            const list = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
            if (Array.isArray(list)) all.push(...list);
        } catch { /* optional */ }
    }
    return all;
}

const envFile = loadEnvFile();
const REDIS_URL = process.env.REDIS_URL || envFile.REDIS_URL || 'redis://localhost:6699';
const ROUTER_PORT = getRouterPort();
const ROUTER_URL = process.env.ROUTER_URL || `http://localhost:${ROUTER_PORT}/`;

// ── helpers ──────────────────────────────────────────────────────────────────

function pingRpc(url) {
    return new Promise((resolve) => {
        const raw = JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {}, id: 1 });
        const req = http.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
        }, (res) => { res.resume(); resolve(res.statusCode === 200); });
        req.setTimeout(3000, () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
        req.write(raw);
        req.end();
    });
}

// Authenticated JSON-RPC POST (admin Bearer) — used for system.service.add.
function rpc(url, method, params, token) {
    return new Promise((resolve) => {
        const raw = JSON.stringify({ jsonrpc: '2.0', method, params: params || {}, id: 'harness' });
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) };
        if (token) headers.Authorization = `Bearer ${token}`;
        const req = http.request(url, { method: 'POST', headers }, (res) => {
            let d = ''; res.on('data', (c) => (d += c));
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        });
        req.setTimeout(5000, () => { req.destroy(); resolve({}); });
        req.on('error', () => resolve({}));
        req.write(raw);
        req.end();
    });
}

async function waitFor(label, probe, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await probe()) return;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`[E2E] ${label} not ready within ${timeoutMs}ms — is deploy/run.sh running?`);
}

// ── main ────────────────────────────────────────────────────────────────────

module.exports = async function globalSetup() {
    console.log(`\n[E2E] setup — redis=${REDIS_URL}  router=${ROUTER_URL}`);

    // 1. Wait for Router
    await waitFor(`router (${ROUTER_URL})`, () => pingRpc(ROUTER_URL));
    console.log('[E2E] Router ready.');

    // 2. Inject allow_all admin session directly into Redis
    //    (bypasses normal auth — for test harness only, never use in prod)
    const redis = createClient({
        url: REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 3000 },
    });
    redis.on('error', () => {});
    try {
        await redis.connect();
        await redis.set(
            `session:${ADMIN_TOKEN}`,
            JSON.stringify({ uid: 'e2e-admin', username: 'e2e-admin', role: 'admin', permit: { allow_all: true, services: {} } }),
            { EX: 6 * 3600 },
        );
        // clear any stale error queues from boot noise
        for await (const k of redis.scanIterator({ MATCH: 'ERROR:QUEUE:*', COUNT: 200 })) {
            await redis.del(Array.isArray(k) ? k[0] : k);
        }
        console.log('[E2E] Admin session injected. Stack ready.\n');
    } finally {
        await redis.quit().catch(() => {});
    }

    // 2.5 Register services with the Router (idempotent; synchronous handshake).
    //     The Router boots knowing only `administrator`; every other method returns
    //     -32601 until its service is registered. run.sh's seed-registry.js covers
    //     normal runs — doing it here too keeps the harness self-contained and free
    //     of the ~2 s capability-introspection race.
    const services = getServices().filter(
        (s) => s && s.name && s.name !== 'router' && s.name !== 'administrator',
    );
    for (const svc of services) {
        const r = await rpc(ROUTER_URL, 'system.service.add', { url: `http://localhost:${svc.port}` }, ADMIN_TOKEN);
        if (r.error) console.warn(`[E2E] register ${svc.name}: ${r.error.message}`);
    }
    console.log(`[E2E] Registered ${services.length} service(s) with Router.\n`);

    // 3. Write context for suites
    ctxFile.write({ redisUrl: REDIS_URL, routerUrl: ROUTER_URL, adminToken: ADMIN_TOKEN });
};
