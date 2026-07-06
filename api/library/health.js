/**
 * library/health.js — shared liveness / readiness / metrics HTTP endpoints.
 *
 * @why Every service exposed only the JSON-RPC `ping` method; there was no plain
 *      HTTP health probe for load balancers / orchestrators / uptime checks.
 *
 *   GET /health  — LIVENESS: the process is up + serving HTTP. Always 200 if reachable.
 *   GET /readyz   — READINESS: dependencies are usable (Redis reachable). 200 or 503.
 *   GET /metrics  — Prometheus text format (toFix §6.5). Always exposes process
 *                   gauges (uptime / heap / rss); services with queues pass a
 *                   `getMetrics` thunk returning extra gauges, e.g. DLQ depth:
 *                     getMetrics: async () => [
 *                       { name: 'solo_dlq_depth', value: 3, help: 'dead-letter depth',
 *                         labels: { queue: 'notification' } },
 *                     ]
 *                   getMetrics failures degrade to the base gauges (a broken
 *                   collector must not take the probe surface down with it).
 *
 * Mount once per service, right after the Express app is created:
 *   const { mountHealth } = require('../../library/health');
 *   mountHealth(app, { serviceName: config.serviceName, version: config.version,
 *                      getRedis: () => redisClient });
 *
 * getRedis is a THUNK (not the client) because the Redis client is usually created
 * asynchronously after the routes are mounted — resolve it lazily, per request.
 */

// Render one gauge line set in Prometheus exposition format.
function renderMetric({ name, value, help, type = 'gauge', labels = {} }, defaults) {
    const all = { ...defaults, ...labels };
    const labelStr = Object.entries(all).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',');
    const head = `# HELP ${name} ${help || name}\n# TYPE ${name} ${type}\n`;
    return head + `${name}{${labelStr}} ${value}\n`;
}

function mountHealth(app, { serviceName, version, getRedis, getMetrics } = {}) {
    app.get('/health', (req, res) => {
        res.json({ status: 'ok', service: serviceName, version, ts: Date.now() });
    });

    app.get('/readyz', async (req, res) => {
        const checks = {};
        let ready = true;
        try {
            const redis = typeof getRedis === 'function' ? getRedis() : null;
            if (redis && typeof redis.ping === 'function') {
                await redis.ping();
                checks.redis = 'ok';
            } else {
                checks.redis = 'unconfigured';   // no redis client yet → not ready
                ready = false;
            }
        } catch (e) {
            checks.redis = 'down';
            ready = false;
        }
        res.status(ready ? 200 : 503).json({
            status: ready ? 'ready' : 'not_ready',
            service: serviceName,
            checks,
            ts: Date.now(),
        });
    });

    app.get('/metrics', async (req, res) => {
        const defaults = { service: serviceName || 'unknown' };
        const mem = process.memoryUsage();
        const base = [
            { name: 'solo_process_uptime_seconds', value: process.uptime(), help: 'Process uptime in seconds' },
            { name: 'solo_process_heap_used_bytes', value: mem.heapUsed, help: 'V8 heap used' },
            { name: 'solo_process_rss_bytes', value: mem.rss, help: 'Resident set size' },
        ];
        let extra = [];
        if (typeof getMetrics === 'function') {
            try {
                extra = (await getMetrics()) || [];
            } catch (e) {
                extra = [{ name: 'solo_metrics_collector_errors', value: 1, help: 'getMetrics threw; service gauges missing this scrape' }];
            }
        }
        res.set('Content-Type', 'text/plain; version=0.0.4');
        res.send([...base, ...extra].map(m => renderMetric(m, defaults)).join(''));
    });

    return app;
}

module.exports = { mountHealth };
