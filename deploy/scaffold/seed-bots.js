#!/usr/bin/env node
/**
 * deploy/seed-bots.js — Relay bot token seeder (Production RPC + Dev fallback)
 *
 * Seeds all `system.*` relay bots defined in `deploy/bot-permits.js` (single source
 * of truth shared with `e2e/harness/setup.js`), ensuring transitive relay dependencies
 * (such as `system.approval` reading `user.key.public` when `workflow.approve` signs
 * an approval gate) are never accidentally omitted.
 *
 * Modes:
 *   1. Production RPC mode (zero direct Redis access):
 *      - Pass `ADMIN_TOKEN=<bearer>` (or `SEED_BOT_TOKEN=<bearer>`), OR
 *      - Pass `ADMIN_PASSWORD=<pwd>` (and optional `ADMIN_USERNAME`, default `admin`)
 *        to perform Z-Login (`admin.login.request` + `admin.login.verify`) via Router.
 *      - Calls `user.bot.create` → `user.bot.update` → `user.bot.issue.token` → `<svc>.token.set`
 *        purely over JSON-RPC.
 *   2. Dev fallback mode (used by `dev.sh` when no admin credentials are provided):
 *      - Writes a temporary dev session (`solo-dev-admin`) to Redis, waits for Router,
 *        issues bot tokens via RPC, and calls `<svc>.token.set` (with Redis fallback).
 *
 * Safe to re-run: `user.bot.create` + `user.bot.update` + `<svc>.token.set` are idempotent.
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { BOT_PERMITS } = require('./bot-permits');

const REDIS_URL      = process.env.REDIS_URL      || 'redis://127.0.0.1:6699';
const ROUTER_URL     = process.env.ROUTER_URL     || 'http://127.0.0.1:8600';
const RPC_URL        = `${ROUTER_URL.replace(/\/+$/, '')}/jsonrpc`;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const EXPLICIT_TOKEN = process.env.SEED_BOT_TOKEN || process.env.ADMIN_TOKEN || '';
const DEV_TOKEN      = 'solo-dev-admin';

const BOTS = BOT_PERMITS;

// ── helpers ───────────────────────────────────────────────────────────────────

function loadRedisCreateClient() {
    try {
        return require('redis').createClient;
    } catch {
        return require('../api/node_modules/redis').createClient;
    }
}

function post(body, token) {
    return new Promise((resolve, reject) => {
        const raw = JSON.stringify(body);
        const parsed = new URL(RPC_URL);
        const transport = parsed.protocol === 'https:' ? https : http;
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(raw),
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const req = transport.request(parsed, { method: 'POST', headers }, (res) => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => {
                try { resolve(JSON.parse(d)); } catch { resolve(d); }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(raw);
        req.end();
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function loginAdminViaRpc(username, password) {
    const chRes = await post({
        jsonrpc: '2.0',
        method: 'admin.login.request',
        params: { username },
        id: 'seed-login-req',
    });
    const { challenge, salt, iterations } = (chRes && chRes.result) || {};
    if (!challenge || !salt || !iterations) {
        throw new Error(`admin.login.request failed: ${chRes?.error?.message || JSON.stringify(chRes)}`);
    }
    const loginHash = crypto.pbkdf2Sync(
        password + username,
        Buffer.from(salt, 'hex'),
        iterations,
        32,
        'sha256'
    ).toString('hex');
    const response = crypto.createHash('sha256')
        .update(challenge + loginHash)
        .digest('hex');

    const vfRes = await post({
        jsonrpc: '2.0',
        method: 'admin.login.verify',
        params: { username, challenge, response },
        id: 'seed-login-verify',
    });
    const token = vfRes?.result?.token;
    if (!token) {
        throw new Error(`admin.login.verify failed: ${vfRes?.error?.message || JSON.stringify(vfRes)}`);
    }
    return token;
}

async function waitForRouter(token, maxWaitMs = 60_000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        try {
            const r = await post({ jsonrpc: '2.0', method: 'user.bot.list', params: {}, id: 'seed-probe' }, token);
            if (r && r.result) return true;
            const msg = (r && r.error && r.error.message) || '';
            if (msg && !/not found/i.test(msg)) return true;
        } catch (_) {}
        await sleep(2000);
    }
    return false;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    const isProdAuth = Boolean(EXPLICIT_TOKEN || ADMIN_PASSWORD);
    if (!isProdAuth && process.env.NODE_ENV === 'production') {
        throw new Error(
            'Refusing dev-session Redis seeding when NODE_ENV=production. ' +
            'Pass ADMIN_PASSWORD=<pwd> (or SEED_BOT_TOKEN=<token>) to seed bots via Router RPC.'
        );
    }

    let adminToken = EXPLICIT_TOKEN;

    if (!isProdAuth) {
        // Dev fallback: seed temporary admin session in Redis
        const createClient = loadRedisCreateClient();
        const redis = createClient({ url: REDIS_URL });
        redis.on('error', () => {});
        await redis.connect();
        await redis.set(
            `session:${DEV_TOKEN}`,
            JSON.stringify({ uid: 'dev-admin', username: 'dev-admin', role: 'admin', permit: { allow_all: true, services: {} } }),
            { EX: 24 * 3600 },
        );
        await redis.quit();
        adminToken = DEV_TOKEN;
    }

    console.log(`  [seed-bots] waiting for Router (${ROUTER_URL})...`);
    const ready = await waitForRouter(adminToken || DEV_TOKEN, 90_000);
    if (!ready) {
        console.error('  [seed-bots] Router did not come up within 90 s — skipping bot seeding');
        process.exit(isProdAuth ? 1 : 0);
    }

    if (!adminToken && ADMIN_PASSWORD) {
        adminToken = await loginAdminViaRpc(ADMIN_USERNAME, ADMIN_PASSWORD);
        console.log(`  [seed-bots] authenticated as ${ADMIN_USERNAME} via admin.login.verify`);
    }
    console.log('  [seed-bots] Router ready');

    let redisFallback = null;
    if (!isProdAuth) {
        const createClient = loadRedisCreateClient();
        redisFallback = createClient({ url: REDIS_URL });
        redisFallback.on('error', () => {});
        await redisFallback.connect();
    }

    for (const [uid, services] of Object.entries(BOTS)) {
        const svc = uid.split('.')[1];
        const permit = { allow_all: false, services };

        await post({ jsonrpc: '2.0', method: 'user.bot.create', params: { uid, permit }, id: `bot-${uid}` }, adminToken);
        await post({ jsonrpc: '2.0', method: 'user.bot.update', params: { uid, permit }, id: `botup-${uid}` }, adminToken);

        const issued = await post({ jsonrpc: '2.0', method: 'user.bot.issue.token', params: { uid }, id: `tok-${uid}` }, adminToken);
        const { token, expiresAt } = issued.result || {};
        if (!token) {
            console.warn(`  [seed-bots] ${uid}: issue.token failed (${issued.error?.message || '?'})`);
            continue;
        }

        // First try standard RPC `<svc>.token.set` (production path, no Redis needed).
        const setRes = await post({
            jsonrpc: '2.0',
            method: `${svc}.token.set`,
            params: { token, expiresAt, sub: uid },
            id: `set-${uid}`,
        }, adminToken);

        if (setRes && setRes.result) {
            console.log(`  [seed-bots] ✓ ${uid} relay token seeded via ${svc}.token.set`);
        } else if (redisFallback) {
            const relayState = { token, expiresAt, lastRefreshAt: Date.now(), sub: uid };
            await redisFallback.set(`RELAY:TOKEN:${svc}`, JSON.stringify(relayState));
            console.log(`  [seed-bots] ✓ ${uid} relay token seeded (RELAY:TOKEN:${svc})`);
        } else {
            console.warn(`  [seed-bots] ⚠ ${svc}.token.set skipped/failed (${setRes?.error?.message || 'service not mounted'})`);
        }
    }

    if (redisFallback) await redisFallback.quit();
}

main().catch(e => {
    console.error('[seed-bots] fatal:', e.message);
    process.exit(process.env.ADMIN_PASSWORD || process.env.SEED_BOT_TOKEN || process.env.ADMIN_TOKEN ? 1 : 0);
});
