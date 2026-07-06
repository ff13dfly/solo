/**
 * E2E globalTeardown — cleans up admin session from Redis.
 * Does not stop any services (those are managed by deploy/run.sh).
 */
const fs = require('fs');
const { createClient } = require('redis');
const { ADMIN_TOKEN } = require('./identity');
const ctxFile = require('../lib/context');

module.exports = async function globalTeardown() {
    const ctx = ctxFile.read();
    const redis = createClient({
        url: ctx.redisUrl || 'redis://localhost:6699',
        socket: { reconnectStrategy: false, connectTimeout: 1500 },
    });
    redis.on('error', () => {});
    try {
        await redis.connect();
        await redis.del(`session:${ADMIN_TOKEN}`);
    } catch { /* redis may not be reachable after tests */ }
    finally { await redis.quit().catch(() => {}); }

    try { fs.unlinkSync(ctxFile.CONTEXT_FILE); } catch {}
};
