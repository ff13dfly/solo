#!/usr/bin/env node
/**
 * deploy/seed-bots.js — dev-only bot token seeder
 *
 * Mirrors what e2e harness setup.js seedBots() does, so the same relay-bot
 * paths that work in e2e full-profile also work in the live dev environment
 * (e.g. ingress TEST button, nexus emit_event, fulfillment state transitions).
 *
 * Flow:
 *   1. Write a dev-only admin session to Redis (allow_all, no real login needed)
 *   2. Poll the Router until it's accepting requests
 *   3. For each bot: create/update → issue.token → <svc>.token.set
 *
 * Called by dev.sh in the background; retries until Router is ready.
 * Safe to re-run: bot.create is idempotent (update overwrites permit on 2nd run).
 */
const http = require('http');
const { createClient } = require('../api/node_modules/redis');
const { BOT_PERMITS } = require('./bot-permits');

const REDIS_URL  = process.env.REDIS_URL  || 'redis://127.0.0.1:6699';
const ROUTER_URL = process.env.ROUTER_URL || 'http://127.0.0.1:8600';
const RPC_URL    = `${ROUTER_URL}/jsonrpc`;
const DEV_TOKEN  = 'solo-dev-admin';

// Bots to seed: uid → permit — 单一真源 deploy/bot-permits.js(e2e harness seedBots 共用同一份;
// 加新 relay bot 只改那一处,不再两处手工同步)。此文件只保留 dev 环境的 seeding 流程。
const BOTS = BOT_PERMITS;

// ── helpers ───────────────────────────────────────────────────────────────────

function post(body, token) {
    return new Promise((resolve, reject) => {
        const raw = JSON.stringify(body);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(raw),
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const req = http.request(RPC_URL, { method: 'POST', headers }, (res) => {
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

async function waitForRouter(maxWaitMs = 60_000) {
    // "Router answers HTTP" is NOT enough: at boot the Router accepts requests
    // before the downstream services finish their Z-handshake, so user.bot.* is
    // not routable yet and every seeding RPC dies with "Method not found" — the
    // dev.sh boot race that leaves all RELAY:TOKEN:* rows missing. Probe the
    // actual dependency instead: user.bot.list with the seeder's own session
    // (seeded in main() step 1, before this runs). Proceed once the reply stops
    // being "not found" — any other answer proves the user service registered
    // and the bot methods are routable. (system.capability.list can't be the
    // probe: its default map is filtered to ai/public methods, which the
    // admin-only user.bot.* are not.)
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        try {
            const r = await post({ jsonrpc: '2.0', method: 'user.bot.list', params: {}, id: 'seed-probe' }, DEV_TOKEN);
            if (r.result) return true;
            const msg = (r.error && r.error.message) || '';
            if (msg && !/not found/i.test(msg)) return true;
        } catch (_) {}
        await sleep(2000);
    }
    return false;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    // 1. Seed dev admin session directly in Redis (same pattern as e2e harness).
    const redis = createClient({ url: REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();
    await redis.set(
        `session:${DEV_TOKEN}`,
        JSON.stringify({ uid: 'dev-admin', username: 'dev-admin', role: 'admin', permit: { allow_all: true, services: {} } }),
        { EX: 24 * 3600 },
    );
    await redis.quit();

    // 2. Wait for Router.
    console.log('  [seed-bots] waiting for Router...');
    const ready = await waitForRouter(90_000);
    if (!ready) {
        console.error('  [seed-bots] Router did not come up within 90 s — skipping bot seeding');
        process.exit(0);
    }
    console.log('  [seed-bots] Router ready');

    // 3. Create/update each bot, issue token, write relay token directly to Redis.
    // NOTE: {svc}.token.set via RPC fails when Router's capability map hasn't loaded
    // the method yet. Writing RELAY:TOKEN:{svc} directly mirrors what
    // api/core/orchestrator/scripts/seed_bot.js and api/library/relay.js writeState() do.
    const redis2 = createClient({ url: REDIS_URL });
    redis2.on('error', () => {});
    await redis2.connect();

    for (const [uid, services] of Object.entries(BOTS)) {
        const svc = uid.split('.')[1];
        const permit = { allow_all: false, services };

        await post({ jsonrpc: '2.0', method: 'user.bot.create', params: { uid, permit }, id: `bot-${uid}` }, DEV_TOKEN);
        await post({ jsonrpc: '2.0', method: 'user.bot.update', params: { uid, permit }, id: `botup-${uid}` }, DEV_TOKEN);

        const issued = await post({ jsonrpc: '2.0', method: 'user.bot.issue.token', params: { uid }, id: `tok-${uid}` }, DEV_TOKEN);
        const { token, expiresAt } = issued.result || {};
        if (!token) {
            console.warn(`  [seed-bots] ${uid}: issue.token failed (${issued.error?.message || '?'})`);
            continue;
        }

        // Write relay state directly — same format as relay.js writeState()
        const relayState = { token, expiresAt, lastRefreshAt: Date.now(), sub: uid };
        await redis2.set(`RELAY:TOKEN:${svc}`, JSON.stringify(relayState));
        console.log(`  [seed-bots] ✓ ${uid} relay token seeded (RELAY:TOKEN:${svc})`);
    }

    await redis2.quit();
}

main().catch(e => {
    console.error('[seed-bots] fatal:', e.message);
    process.exit(0);  // non-fatal: dev still starts even if bot seeding fails
});
