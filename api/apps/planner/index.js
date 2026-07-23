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
const { mountHealth } = require('../../library/health');

// --- SERVICE CONSTANTS ---
const STARTUP_TIME = new Date().toISOString();

const logger = createLogger(config.serviceName);

const app = express();
const PORT = config.port;

// --- MIDDLEWARE ---

app.use(cors(corsOptionsFromEnv()));
app.use(bodyParser.json({ limit: '10mb' }));

/**
 * Request Logger
 */
app.use((req, res, next) => {
    if (config.debug) {
        logger.debug('INCOMING:', req.method, req.originalUrl);
    }
    next();
});

// --- BOOTSTRAP ---

let redisClient;
let Methods;

mountHealth(app, { serviceName: config.serviceName, version: config.version, getRedis: () => redisClient });

(async () => {
    try {
        redisClient = await initializeRedis(config.serviceName);
        logger.setRedis(redisClient);

        await ensureDefaultCategories(redisClient, config.serviceName);
        Methods = createLogic(redisClient, {
            serviceName: config.serviceName,
            routerUrl: config.routerUrl
        });

        app.listen(PORT, () => {
            logger.info(`Service running on port ${PORT}`);
            logger.info(`Ready to accept connections.`);
        });
    } catch (e) {
        logger.error(`Startup Failed:`, e);
        process.exit(1);
    }
})();

// --- AUTH ENDPOINTS ---

app.get('/auth/seed', authHandlers.handleSeed);
app.post('/auth/verify', (req, res) => authHandlers.handleVerify(req, res, config.serviceName, config.version || '1.0.0', STARTUP_TIME));

// --- JSON-RPC ENDPOINT ---

app.post('/jsonrpc', authHandlers.middleware, async (req, res) => {
    if (!Methods) return jsonrpc.error(res, jsonrpc.SERVICE_NOT_READY(), null, 503);

    // WAL context: inject user uid for audit logging
    await walContext.run({ uid: req.user || null, trace: req.meta?.trace || null, depth: req.meta?.depth ?? 0 }, async () => {
        const { jsonrpc: jsonrpc_version, method, params, id } = req.body;

        try {
            const handlers = {
                // Infrastructure Methods
                'ping': () => ({
                    status: 'ok',
                    service: config.serviceName,
                    version: config.version || '1.0.0',
                    uptime: STARTUP_TIME
                }),
                'methods': () => ({ methods: introspectionMethods, description: config.description || {} }),
                'entities': () => require('./handlers/entities'),
                'events':   () => require('./handlers/events'),

                'guide':    () => require('../../library/guide').readGuide('planner', __dirname),
                // Agenda Handlers
                'planner.agenda.create': (p) => Methods.agenda.create(p, req.user),
                'planner.agenda.get': (p) => Methods.agenda.get(p, req.user),
                'planner.agenda.update': (p) => Methods.agenda.update(p, req.user),
                'planner.agenda.delete': (p) => Methods.agenda.delete(p, req.user),
                'planner.agenda.list': (p) => Methods.agenda.list(p, req.user),
                'planner.agenda.sync': (p) => Methods.agenda.sync(p, req.user),

                // Todo Handlers
                'planner.todo.create': (p) => Methods.todo.create(p, req.user),
                'planner.todo.get': (p) => Methods.todo.get(p, req.user),
                'planner.todo.update': (p) => Methods.todo.update(p, req.user),
                'planner.todo.delete': (p) => Methods.todo.delete(p, req.user),
                'planner.todo.list': (p) => Methods.todo.list(p, req.user),
                'planner.todo.sync': (p) => Methods.todo.sync(p, req.user),

                // AI Analysis & Scheduling
                'planner.todo.analyze': (p) => {
                    return { status: 'PENDING', message: 'AI analysis logic will be integrated in Phase 2.' };
                },
                'planner.todo.schedule': (p) => {
                    return { status: 'PENDING', message: 'Auto-scheduling engine will be integrated in Phase 2.' };
                }
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
    }); // walContext.run
});
