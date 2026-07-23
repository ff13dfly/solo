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
const authHandlers      = require('./handlers/auth');
const introspection     = require('./handlers/introspection');
const entities          = require('./handlers/entities');
const createLogic       = require('./logic');
const jsonrpc           = require('./handlers/jsonrpc');

const STARTUP_TIME = new Date().toISOString();
const logger = createLogger(config.serviceName);

const app = express();

let redisClient;
let relay;

// --- MIDDLEWARE ---

app.use(cors(corsOptionsFromEnv()));
app.use(bodyParser.json({ limit: '10mb' }));

app.use((req, res, next) => {
    if (config.debug) logger.debug('INCOMING:', req.method, req.originalUrl);
    next();
});

mountHealth(app, { serviceName: config.serviceName, version: config.version, getRedis: () => redisClient });

// --- BOOTSTRAP ---

let Methods;

(async () => {
    try {
        redisClient = await initializeRedis(config.serviceName);
        logger.setRedis(redisClient);

        relay = createRelay({
            redis: redisClient,
            serviceName: config.serviceName,
            routerUrl: `${config.routerUrl}/jsonrpc`,
            walLogger: (key, data) => logger_lib.insert(key, data),
        });

        await ensureDefaultCategories(redisClient, config.serviceName);
        Methods = createLogic(redisClient, config, { relay });

        app.listen(config.port, () => {
            logger.info(`Fulfillment service running on port ${config.port}`);
        });
    } catch (e) {
        logger.error('Startup Failed:', e);
        process.exit(1);
    }
})();

// --- AUTH ENDPOINTS ---

app.get('/auth/seed', authHandlers.handleSeed);
app.post('/auth/verify', (req, res) =>
    authHandlers.handleVerify(req, res, config.serviceName, config.version, STARTUP_TIME)
);

// --- JSON-RPC ENDPOINT ---

app.post('/jsonrpc', authHandlers.middleware, async (req, res) => {
    if (!Methods) return jsonrpc.error(res, jsonrpc.SERVICE_NOT_READY(), null, 503);

    // WAL context: inject user uid for audit logging
    await walContext.run({ uid: req.user || null, trace: req.meta?.trace || null, depth: req.meta?.depth ?? 0 }, async () => {
        const { method, params, id } = req.body;

        try {
            const isAdmin = req.permit === 'admin';

            const handlers = {
                // Infrastructure
                'ping':     () => ({ status: 'ok', service: config.serviceName, version: config.version, uptime: STARTUP_TIME }),
                'methods':  () => introspection,
                'entities': () => entities,
                'events':   () => require('./handlers/events'),

                'guide':    () => require('../../library/guide').readGuide('fulfillment', __dirname),
                // Relay bot token lifecycle (admin only)
                'fulfillment.token.set':    async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); await relay.setToken(p); return { ok: true }; },
                'fulfillment.token.status': async ()  => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return relay.status(); },
                'fulfillment.token.clear':  async ()  => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); await relay.clear(); return { ok: true }; },

                // Instance
                'fulfillment.instance.create':     (p) => Methods.instance.create(p, req),
                'fulfillment.instance.get':        (p) => Methods.instance.get(p),
                'fulfillment.instance.list':       (p) => Methods.instance.list(p),
                'fulfillment.instance.transition': (p) => Methods.instance.transition(p, req),
                'fulfillment.instance.cancel':     (p) => Methods.instance.cancel(p, req),
                'fulfillment.instance.hold':       (p) => Methods.instance.hold(p, req),
                'fulfillment.instance.resume':     (p) => Methods.instance.resume(p, req),
                'fulfillment.instance.override':   (p) => Methods.instance.override(p, req),
                'fulfillment.instance.update':     (p) => Methods.instance.update(p, req),

                // Profile
                'fulfillment.profile.create':  (p) => Methods.profile.create(p),
                'fulfillment.profile.get':     (p) => Methods.profile.get(p),
                'fulfillment.profile.list':    (p) => Methods.profile.list(p),
                'fulfillment.profile.update':  (p) => Methods.profile.update(p),
                'fulfillment.profile.delete':  (p) => Methods.profile.delete(p),
                'fulfillment.profile.restore': (p) => Methods.profile.restore(p),
                'fulfillment.profile.destroy': (p) => Methods.profile.destroy(p),
                'fulfillment.profile.generate': (p) => Methods.profile.generate(p),
                // 投稿面: submit is callable by a (narrow-permit) submitter; approve/reject are
                // admin-gated (an external submitter can propose but never self-activate).
                'fulfillment.profile.submit':  (p) => Methods.profile.submit(p, req),
                'fulfillment.profile.approve': (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.profile.approve(p, req); },
                'fulfillment.profile.reject':  (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.profile.reject(p, req); }
            };

            if (!handlers[method]) {
                return jsonrpc.error(res, jsonrpc.METHOD_NOT_FOUND(method), id, 404);
            }

            const result = await handlers[method](params);
            jsonrpc.success(res, result, id);

        } catch (err) {
            logger.error(`RPC Error [${method}]:`, err, { request: params });
            jsonrpc.error(res, err.code ? err : jsonrpc.INTERNAL_ERROR(err.message), id);
        }
    }); // walContext.run
});
