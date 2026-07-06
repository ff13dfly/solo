#!/usr/bin/env node
/**
 * deploy/seed-registry.js
 *
 * Pre-seeds the Router's service registry in Redis from solo-services.json
 * (Solo internal services) + services.json (private apps), so every service is
 * known to the Router on a fresh `run.sh` — without manually adding each one via
 * the system portal (system.service.add).
 *
 * Why this is needed: the Router boots knowing only the administrator service.
 * It reads `active_services` from Redis at startup and, ~2 s later, its
 * updateCapabilityMap() introspects each registered URL to fill in
 * methods/entities/events. Without a seeded registry, every method like
 * `user.register` returns -32601 (Method not found) until registered.
 *
 * Writes stub entries (url + port, methods=[]); the Router fills the rest.
 * Run BEFORE the bundle starts — run.sh calls this right after Redis is ready.
 *
 * Usage: REDIS_URL=... node deploy/seed-registry.js
 */
const path = require('path');
const fs = require('fs');
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const ACTIVE_SERVICES_KEY = 'active_services';
const DEPLOY_DIR = __dirname;
const HOST = process.env.SERVICE_HOST || 'localhost';

function loadList(file) {
    try {
        return JSON.parse(fs.readFileSync(path.join(DEPLOY_DIR, file), 'utf8'));
    } catch {
        return []; // missing/malformed → contribute nothing
    }
}

async function main() {
    // Solo internal services + private apps. router excluded (it doesn't register itself).
    const services = [...loadList('solo-services.json'), ...loadList('services.json')];
    if (!services.length) {
        console.log('  [seed-registry] no services to seed');
        return;
    }

    const redis = createClient({ url: REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();

    const raw = await redis.get(ACTIVE_SERVICES_KEY);
    const registry = raw ? JSON.parse(raw) : {};

    let added = 0;
    for (const svc of services) {
        if (!svc || !svc.name || svc.name === 'router') continue; // router doesn't register itself
        if (registry[svc.name]) continue;                         // already registered — don't overwrite
        registry[svc.name] = {
            url: `http://${HOST}:${svc.port}/jsonrpc`,
            methods: [],
            entities: {},
            events: null,
            available: true,
            version: 'pending',
            lastLink: Date.now(),
        };
        console.log(`  [seed-registry] + ${svc.name}  →  http://${HOST}:${svc.port}/jsonrpc`);
        added++;
    }

    if (added > 0) await redis.set(ACTIVE_SERVICES_KEY, JSON.stringify(registry));
    else console.log('  [seed-registry] registry already complete, nothing to add');

    await redis.disconnect();
}

main().catch((e) => {
    console.error('[seed-registry] fatal:', e.message);
    process.exit(1);
});
