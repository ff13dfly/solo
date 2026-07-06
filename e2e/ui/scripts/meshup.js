#!/usr/bin/env node
/**
 * UI-e2e mesh launcher.
 *
 * Brings up the full 13-service mesh (via the proven api-e2e harness), seeds an
 * `admin/changeme` administrator account for the system-portal login, then stays
 * alive so the Playwright UI tests (a separate process) can run against it.
 * Writes a readiness sentinel file when up. Used by the `ui-e2e` CI job and for
 * local UI testing:
 *
 *   node e2e/ui/scripts/meshup.js &            # backgrounds the mesh
 *   until [ -f "$TMPDIR/solo-ui-mesh-ready" ]; do sleep 1; done
 *   ( cd portal/system && npx vite --port 9200 & )
 *   ( cd e2e/ui && npx playwright test --project=system )
 *
 * Reuses the api-e2e harness's mesh bring-up (services spawned from api/), so it
 * stays in lockstep with the api e2e job — no second copy of the boot logic.
 */
process.env.E2E_PROFILE = process.env.E2E_PROFILE || 'full';

const os = require('os');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const setup = require('../../harness/setup');   // e2e/harness/setup.js (globalSetup)
const redisLib = require('../../lib/redis');    // e2e/lib/redis (connect())
const { createAndLogin } = require('../../harness/identity');   // real register+login

const READY_FILE = path.join(os.tmpdir(), 'solo-ui-mesh-ready');

(async () => {
    try { fs.unlinkSync(READY_FILE); } catch (_) { /* not present */ }

    await setup();   // redis-stack + Router + 13 services + seedBots + event registry

    // Seed the administrator account the Playwright global-setup authenticates with
    // (admin.login → PBKDF2(password+username, salt)). The harness injects a session
    // but NOT a loginnable account, so we write one here.
    const redis = await redisLib.connect();
    const salt = crypto.randomBytes(16).toString('hex');
    const login_hash = crypto
        .pbkdf2Sync('changeme' + 'admin', Buffer.from(salt, 'hex'), 200000, 32, 'sha256')
        .toString('hex');
    await redis.set('administrator:user:admin', JSON.stringify({
        username: 'admin', salt, iterations: 200000, login_hash,
        role: 'admin', permit: { allow_all: true }, updatedAt: new Date().toISOString(),
    }));

    // Seed an operator-POWER user for the operator-portal Playwright project: its login
    // gates on categories.POWER === 'operator' (portal/operator Login.tsx). global-setup
    // logs in as TEST_USER/TEST_PASSWORD; register via the real RPC, then stamp POWER
    // directly on the user record (same lever as harness setPermit) — no admin-RPC guess.
    const OP_NAME = process.env.TEST_USER || 'e2e-operator';
    const OP_PASS = process.env.TEST_PASSWORD || 'changeme';
    try {
        const op = await createAndLogin({ name: OP_NAME, password: OP_PASS });
        const rawU = await redis.get(`user:${op.uid}`);
        if (rawU) {
            const rec = JSON.parse(rawU);
            rec.categories = { ...(rec.categories || {}), POWER: 'operator' };
            // Operator-portal domains: a real operator is granted these by an admin. The
            // operator specs (fulfillment-profile, profile-watchers) exercise create/list,
            // so a fresh user's empty permit would 403. Mirrors a provisioned operator.
            rec.permit = {
                allow_all: false,
                services: { fulfillment: ['*'], nexus: ['*'], collection: ['*'], storage: ['*'], planner: ['*'], approval: ['*'] },
            };
            await redis.set(`user:${op.uid}`, JSON.stringify(rec));
        }
        console.log(`[ui-meshup] operator user seeded: ${OP_NAME} (uid ${op.uid}, POWER=operator, permit=fulfillment/nexus/...)`);
    } catch (e) {
        // Idempotent re-runs: user.register fails if the name already exists (already seeded) — fine.
        console.warn(`[ui-meshup] operator user seed skipped: ${(e && e.message) || e}`);
    }

    await redis.quit();

    fs.writeFileSync(READY_FILE, 'ok');

    // HTTP readiness endpoint so Playwright's `webServer` can wait on REAL readiness
    // (mesh up + admin seeded) instead of a bare open TCP port. Started LAST → it only
    // answers 200 once everything above completed; the connection-refused before that is
    // exactly what Playwright polls through. The sentinel file is kept for the CI shell
    // script (scripts run `until [ -f $READY_FILE ]`). This http server also keeps the
    // process alive for the test run (replaces the old setInterval keep-alive).
    const READY_PORT = Number(process.env.UI_MESH_READY_PORT) || 8699;
    http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ready'); })
        .listen(READY_PORT, '127.0.0.1', () => {
            console.log(`[ui-meshup] MESH READY + admin seeded (sentinel: ${READY_FILE}, ready: http://127.0.0.1:${READY_PORT}/)`);
        });
})().catch((e) => {
    console.error('[ui-meshup] FAILED', (e && e.stack) || e);
    process.exit(1);
});
