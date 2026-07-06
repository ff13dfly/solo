/**
 * seed_bot.js — local-dev helper: provision the orchestrator's service bot.
 *
 * The async run-queue worker (logic/worker.js) executes workflows under a bot
 * identity (event.md §8 / D2). In production this is done via admin RPCs
 * (user.bot.create → user.bot.issue.token → orchestrator.token.set). For local
 * development this script writes the three Redis keys directly so you can run
 * the worker without booting the full mesh:
 *
 *   bot:system.orchestrator            the bot account (user service schema)
 *   session:<token>                    the session the token resolves to
 *   RELAY:TOKEN:orchestrator           relay state so relay.getToken() works
 *
 * Usage:
 *   node core/orchestrator/scripts/seed_bot.js
 *   REDIS_URL=redis://localhost:6699 node core/orchestrator/scripts/seed_bot.js
 *
 * The seeded permit is intentionally MINIMAL (no methods). A workflow whose
 * footprint exceeds it will be blocked by H6 — which is exactly where the
 * human-in-the-loop grant (event.md §9, not yet built) will later intervene.
 * Edit PERMIT below, or use user.bot.update at runtime, to widen it.
 */
const crypto = require('crypto');
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6699';
const BOT_UID = 'system.orchestrator';
const SERVICE_NAME = 'orchestrator';

// Minimal by design — enumerate methods explicitly (allow_all is rejected by the
// user service's assertPermitSafe). Widen as needed for local testing.
const PERMIT = { allow_all: false, services: {} };

// Far-future expiry: bot session tokens themselves never expire, but the relay
// state requires a numeric expiresAt to avoid treating the token as stale.
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

async function main() {
    const client = createClient({ url: REDIS_URL });
    client.on('error', (err) => console.error('[seed_bot] redis error:', err.message));
    await client.connect();

    const now = Date.now();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = now + TEN_YEARS_MS;

    // 1) bot account (mirrors core/user/logic/bot.js create())
    const bot = {
        uid: BOT_UID,
        permit: PERMIT,
        desc: 'orchestrator async-execution service bot (seeded for local dev)',
        createdAt: now,
        updatedAt: now,
        status: 'ACTIVE',
    };
    await client.set('bot:' + BOT_UID, JSON.stringify(bot));

    // 2) session the token resolves to (mirrors issueSession())
    const session = { uid: BOT_UID, permit: PERMIT, issuedAt: now };
    await client.set('session:' + token, JSON.stringify(session));

    // 3) relay state so relay.getToken() returns this token (library/relay.js schema)
    const relayState = {
        token,
        expiresAt,
        lastRefreshAt: now,
        sub: `system.${SERVICE_NAME}`,
    };
    await client.set('RELAY:TOKEN:' + SERVICE_NAME, JSON.stringify(relayState));

    await client.quit();

    console.log('[seed_bot] seeded OK');
    console.log('  redis     :', REDIS_URL);
    console.log('  bot uid   :', BOT_UID);
    console.log('  permit    :', JSON.stringify(PERMIT));
    console.log('  token     :', token.slice(0, 12) + '… (session:' + token.slice(0, 12) + '…)');
    console.log('  relay key : RELAY:TOKEN:' + SERVICE_NAME, '(expiresAt ' + new Date(expiresAt).toISOString() + ')');
}

main().catch((e) => {
    console.error('[seed_bot] FAILED:', e.message);
    process.exit(1);
});
