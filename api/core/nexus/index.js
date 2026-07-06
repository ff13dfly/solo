const express = require('express');
const cors = require('cors');
const { corsOptionsFromEnv } = require('../../library/cors');
const bodyParser = require('body-parser');
const config = require('./config');
const { createLogger } = require('../../library/logger');
const { walContext } = require('../../library/entity');

const { initializeRedis, ensureDefaultCategories } = require('./handlers/bootstrap');
const authHandlers = require('./handlers/auth');
const introspectionMethods = require('./handlers/introspection');
const createLogic = require('./logic');
const jsonrpc = require('./handlers/jsonrpc');
const logger_lib = require('../../library/logger');
const { createRelay } = require('../../library/relay');
const { mountHealth } = require('../../library/health');

const STARTUP_TIME = new Date().toISOString();
const logger = createLogger(config.serviceName);

const app = express();
const PORT = config.port;

app.use(cors(corsOptionsFromEnv()));
app.use(bodyParser.json({ limit: '10mb' }));

app.use((req, res, next) => {
    if (config.debug) logger.debug('INCOMING:', req.method, req.originalUrl);
    next();
});

mountHealth(app, {
    serviceName: config.serviceName, version: config.version, getRedis: () => redisClient,
    // toFix §6.5 — DLQ depth gauge (NEXUS:DLQ is a stream; XLEN = parked entries).
    getMetrics: async () => ([
        {
            name: 'solo_dlq_depth',
            value: await redisClient.xLen(config.redis.dlqStream).catch(() => -1),
            help: 'Dead-letter queue depth',
            labels: { queue: 'nexus_dlq' },
        },
    ]),
});

let redisClient;
let Methods;
let relay;

(async () => {
    try {
        redisClient = await initializeRedis(config.serviceName);
        logger.setRedis(redisClient);

        await ensureDefaultCategories(redisClient, config.serviceName);

        // §7.7 — internal cross-service calls must go through the shared relay.
        relay = createRelay({
            redis: redisClient,
            serviceName: config.serviceName,
            routerUrl: `${config.routerUrl}/jsonrpc`,
            walLogger: (key, data) => logger_lib.insert(key, data),
        });

        Methods = createLogic(redisClient, { config, relay });

        if (config.consumer.enabled) {
            await Methods.stream.start();
        }

        app.listen(PORT, () => {
            logger.info(`Service running on port ${PORT}`);
            // event.md §6.2 — time-driven scheduler (D6: same-process setInterval).
            if (config.scheduler.enabled && Methods.scheduler) {
                Methods.scheduler.start().catch(err =>
                    logger.error('Scheduler failed to start:', err.message));
            }
            logger.info('Ready to accept connections.');
        });
    } catch (e) {
        logger.error('Startup Failed:', e);
        process.exit(1);
    }
})();

app.get('/auth/seed', authHandlers.handleSeed);
app.post('/auth/verify', (req, res) =>
    authHandlers.handleVerify(req, res, config.serviceName, config.version, STARTUP_TIME));

app.post('/jsonrpc', authHandlers.middleware, async (req, res) => {
    if (!Methods) return jsonrpc.error(res, jsonrpc.SERVICE_NOT_READY(), null, 503);

    await walContext.run({ uid: req.user || null, trace: req.meta?.trace || null, depth: req.meta?.depth ?? 0 }, async () => {
        const { jsonrpc: jsonrpc_version, method, params, id } = req.body;
        const isAdmin = req.permit === 'admin';

        try {
            const handlers = {
                'ping': () => ({
                    status: 'ok',
                    service: config.serviceName,
                    version: config.version,
                    uptime: STARTUP_TIME
                }),
                'methods':  () => ({ methods: introspectionMethods, description: config.description || {} }),
                'entities': () => require('./handlers/entities'),
                'events':   () => require('./handlers/events'),

                'nexus.sentinel.create': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.sentinel.create(p);
                },
                'nexus.sentinel.update': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.sentinel.update(p);
                },
                'nexus.sentinel.list':      (p) => Methods.sentinel.list(p),
                'nexus.sentinel.get':       (p) => Methods.sentinel.get(p),
                'nexus.sentinel.disable':   (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.sentinel.disable(p);
                },
                'nexus.sentinel.enable':    (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.sentinel.enable(p);
                },
                'nexus.sentinel.delete':    (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.sentinel.remove(p);
                },
                'nexus.sentinel.heartbeat': (p) => Methods.sentinel.heartbeat(p),
                'nexus.sentinel.resolve':   (p) => Methods.sentinel.resolve(p),
                'nexus.sentinel.broadcast': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.sentinel.broadcast(p);
                },
                // §1.2 — admin injects a per-Sentinel bot token (manual provisioning).
                'nexus.sentinel.token.set': async (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.identity.setToken(p);
                },

                // §7.7 — admin-only token lifecycle for internal-call relay
                'nexus.token.set':    async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); await relay.setToken(p); return { ok: true }; },
                'nexus.token.status': async () => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return relay.status(); },
                'nexus.token.clear':  async () => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); await relay.clear(); return { ok: true }; },

                // Runtime auto↔manual pause (stream consumer + scheduler loops). Admin-only.
                'nexus.control.pause':  async () => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.control.pause(); },
                'nexus.control.resume': async () => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.control.resume(); },
                'nexus.control.status': async () => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.control.status(); },

                // event.md §6.2 / §11.2 — schedule CRUD (admin-only, nexus management area)
                'nexus.schedule.create': async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.schedule.create(p); },
                'nexus.schedule.get':    async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.schedule.get(p && p.schedule_id); },
                'nexus.schedule.list':   async ()  => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.schedule.list(); },
                'nexus.schedule.update': async (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    const { schedule_id, ...changes } = p || {};
                    return Methods.schedule.update(schedule_id, changes);
                },
                'nexus.schedule.delete': async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.schedule.delete(p && p.schedule_id); },

                // context.md §7.3 — dead-letter inspection / retry (admin-only).
                'nexus.dlq.list':  async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.dlq.list(p); },
                'nexus.dlq.retry': async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.dlq.retry(p); },

                // Event-bus read-only observability (portal STREAM LOG tab). Admin-only.
                'nexus.event.streams': async ()  => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.events.streams(); },
                'nexus.event.recent':  async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.events.recent(p); },
                'nexus.trace.get':     async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.events.byTrace(p); },
            };

            if (!handlers[method]) {
                return jsonrpc.error(res, jsonrpc.METHOD_NOT_FOUND(method), id, 404);
            }
            const result = await handlers[method](params);
            jsonrpc.success(res, result, id);
        } catch (err) {
            logger.error(`Error processing ${method}:`, err, { request: params });
            jsonrpc.error(res, err.code ? err : jsonrpc.INTERNAL_ERROR(err.message), id);
        }
    });
});
