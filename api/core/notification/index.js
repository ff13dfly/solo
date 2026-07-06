const express = require('express');
const cors = require('cors');
const { corsOptionsFromEnv } = require('../../library/cors');
const bodyParser = require('body-parser');
const config = require('./config');
const { createLogger } = require('../../library/logger');
const logger_lib = require('../../library/logger');
const { walContext } = require('../../library/entity');
const { createRelay } = require('../../library/relay');
const { mountHealth } = require('../../library/health');

const { initializeRedis, ensureDefaultCategories } = require('./handlers/bootstrap');
const authHandlers = require('./handlers/auth');
const introspectionMethods = require('./handlers/introspection');
const createLogic = require('./logic');
const jsonrpc = require('./handlers/jsonrpc');

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

let redisClient;
let Methods;
let relay;

mountHealth(app, {
    serviceName: config.serviceName, version: config.version, getRedis: () => redisClient,
    // toFix §6.5 — queue-depth gauges (Prometheus /metrics): pending + DLQ.
    getMetrics: async () => {
        const [pending, dead] = await Promise.all([
            redisClient.lLen(config.redis.queuePending).catch(() => -1),
            redisClient.lLen(config.redis.queueDead).catch(() => -1),
        ]);
        return [
            { name: 'solo_queue_depth', value: pending, help: 'Pending delivery queue depth', labels: { queue: 'notification_pending' } },
            { name: 'solo_dlq_depth', value: dead, help: 'Dead-letter queue depth', labels: { queue: 'notification_deadletter' } },
        ];
    },
});

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

        if (config.worker.enabled) {
            await Methods.worker.start();
        }

        app.listen(PORT, () => {
            logger.info(`Service running on port ${PORT}`);
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

        const requireAdmin = () => {
            if (req.permit !== 'admin') throw jsonrpc.UNAUTHORIZED();
        };

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

                'notification.send':       (p) => Methods.message.send(p),
                'notification.inbox.list': (p) => Methods.message.inboxList(p),
                'notification.inbox.ack':  (p) => Methods.message.inboxAck(p),
                'notification.config.set': (p) => Methods.config.set(p),
                'notification.config.get': (p) => Methods.config.get(p),

                'notification.deadletter.list':    (p) => { requireAdmin(); return Methods.deadletter.list(p); },
                'notification.deadletter.requeue': (p) => { requireAdmin(); return Methods.deadletter.requeue(p); },

                // §7.7 — admin-only token lifecycle for the internal-call relay
                'notification.token.set':    async (p) => { requireAdmin(); await relay.setToken(p); return { ok: true }; },
                'notification.token.status': async () => { requireAdmin(); return relay.status(); },
                'notification.token.clear':  async () => { requireAdmin(); await relay.clear(); return { ok: true }; },
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
