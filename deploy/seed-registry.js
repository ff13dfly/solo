#!/usr/bin/env node
/**
 * deploy/seed-registry.js
 *
 * Pre-seeds the router's service registry in Redis from services.json +
 * services.dev.json before the router starts. This ensures all known services
 * appear in the Service Registry on every fresh dev.sh run without manual
 * re-registration via the portal.
 *
 * The router reads `active_services` from Redis on startup. By writing stub
 * entries here (url + port, methods=[]), the router's updateCapabilityMap
 * (runs 2 s after boot) fills in methods / entities / events automatically.
 *
 * Usage: called automatically by dev.sh after Redis is ready.
 */
const path = require('path');
const fs   = require('fs');
const { createClient } = require('../api/node_modules/redis');

const REDIS_URL          = process.env.REDIS_URL || 'redis://127.0.0.1:6699';
const ACTIVE_SERVICES_KEY = 'active_services';
const DEPLOY_DIR          = __dirname;
const HOST                = process.env.SERVICE_HOST || 'localhost';

async function main() {
    // ── Load service definitions ──────────────────────────────────────────────
    let services = [];
    try {
        services = JSON.parse(fs.readFileSync(path.join(DEPLOY_DIR, 'services.json'), 'utf8'));
    } catch (e) {
        console.error('[seed-registry] Cannot read services.json:', e.message);
        process.exit(1);
    }
    const devPath = path.join(DEPLOY_DIR, 'services.dev.json');
    if (fs.existsSync(devPath)) {
        try {
            services = services.concat(JSON.parse(fs.readFileSync(devPath, 'utf8')));
        } catch (e) { /* ignore malformed dev overlay */ }
    }

    // ── Connect to Redis ──────────────────────────────────────────────────────
    const redis = createClient({ url: REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();

    // ── Load existing registry ────────────────────────────────────────────────
    const raw      = await redis.get(ACTIVE_SERVICES_KEY);
    const registry = raw ? JSON.parse(raw) : {};

    let added = 0;
    for (const svc of services) {
        if (svc.name === 'router') continue;  // router doesn't register itself
        if (registry[svc.name])   continue;  // already registered — don't overwrite

        registry[svc.name] = {
            url:       `http://${HOST}:${svc.port}/jsonrpc`,
            methods:   [],
            entities:  {},
            events:    null,
            available: true,
            version:   'pending',
            lastLink:  Date.now(),
        };
        console.log(`  [seed-registry] + ${svc.name}  →  http://${HOST}:${svc.port}/jsonrpc`);
        added++;
    }

    if (added > 0) {
        await redis.set(ACTIVE_SERVICES_KEY, JSON.stringify(registry));
    } else {
        console.log('  [seed-registry] registry already complete, nothing to add');
    }

    await redis.disconnect();
}

main().catch(e => {
    console.error('[seed-registry] fatal:', e.message);
    process.exit(1);
});
