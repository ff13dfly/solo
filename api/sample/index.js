const express = require('express');
const cors = require('cors');
const { corsOptionsFromEnv } = require('../library/cors');
const bodyParser = require('body-parser');
const config = require('./config');
const { createLogger } = require('../library/logger');
const { walContext } = require('../library/entity');

const { initializeRedis, ensureDefaultCategories } = require('./handlers/bootstrap');
const authHandlers = require('./handlers/auth');
const introspectionMethods = require('./handlers/introspection');
const createLogic = require('./logic');
const jsonrpc = require('./handlers/jsonrpc');
const { createIndexer } = require('../library/indexer');

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
 * @why Provides visibility into incoming traffic during development.
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
let indexer;

/**
 * Initializes the service dependencies and starts the HTTP server.
 * @process
 *   1. Connect to Redis.
 *   2. Ensure default categories are registered.
 *   3. Initialize business logic with dependencies.
 *   4. Start listening on the configured port.
 */
(async () => {
    try {
        redisClient = await initializeRedis(config.serviceName);
        logger.setRedis(redisClient);

        await ensureDefaultCategories(redisClient, config.serviceName);
        Methods = createLogic(redisClient, { config });

        // Initialize RediSearch indexer (Redis override > config.indexes fallback)
        indexer = createIndexer(redisClient, config.serviceName, config.indexes || {});
        if (Object.keys(config.indexes || {}).length > 0) {
            await indexer.ensureAll();
            logger.info('RediSearch indexes ready');
        }

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

/**
 * Z-Handshake Endpoints
 * @why Enables the Router to establish a secure link with this service.
 */
app.get('/auth/seed', authHandlers.handleSeed);
app.post('/auth/verify', (req, res) => authHandlers.handleVerify(req, res, config.serviceName, config.version || '1.0.0', STARTUP_TIME));

// --- JSON-RPC ENDPOINT ---

/**
 * Main RPC Entry Point
 * @why Implements the JSON-RPC 2.0 protocol for all service interactions.
 * @attention All business methods must be prefixed with the service name (e.g., `sample.echo`).
 */
app.post('/jsonrpc', authHandlers.middleware, async (req, res) => {
    if (!Methods) return res.status(503).json({ error: 'Service not ready' });

    // WAL context: inject user uid for audit logging
    await walContext.run({ uid: req.user || null, trace: req.meta?.trace || null, depth: req.meta?.depth ?? 0 }, async () => {

    const { jsonrpc: jsonrpc_version, method, params, id } = req.body;

    // ── Auth context ──────────────────────────────────────────────────────
    // req.user  = payload.user  → uid 字符串（e.g. "abc123"）
    // req.permit = payload.permit → 'admin' | 'user'
    //
    // ✅ 正确：用 req.permit 判断管理员身份
    // ❌ 错误：req.user?.permit?.allow_all（req.user 是字符串，无 permit 属性）
    const uid     = req.user || null;
    const isAdmin = req.permit === 'admin';

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

            // Index Management (via library/indexer)
            // @why Enables Portal UI to trigger hot index rebuild without service restart.
            'sample.index.rebuild': (p) => {
                if (!indexer) throw jsonrpc.INTERNAL_ERROR('Indexer not initialized (no indexes configured)');
                return indexer.rebuild(p?.entity);
            },
            'sample.index.schemas': () => {
                if (!indexer) return {};
                return indexer.schemas();
            },
        };

        let result;

        if (handlers[method]) {
            result = await handlers[method](params);
        } else if (method.startsWith('sample.category.')) {
            // Federated Category Handlers
            const catHandlers = {
                'sample.category.create': (p) => Methods.category.create(p),
                'sample.category.update': (p) => Methods.category.update(p),
                'sample.category.delete': (p) => Methods.category.delete(p),
                'sample.category.list': (p) => Methods.category.list(p),
                'sample.category.get': (p) => Methods.category.get(p),
                'sample.category.item.add': (p) => Methods.category.addItem(p),
                'sample.category.item.get': (p) => Methods.category.getItem(p),
                'sample.category.item.update': (p) => Methods.category.updateItem(p),
                'sample.category.item.remove': (p) => Methods.category.removeItem(p)
            };
            if (catHandlers[method]) {
                result = await catHandlers[method](params);
            }
        } else if (method.startsWith('sample.item.')) {
            // Item CRUD Handlers (via Entity Factory)
            const itemHandlers = {
                'sample.item.create': (p) => Methods.item.create(p),
                'sample.item.get': (p) => Methods.item.get(p),
                'sample.item.update': (p) => Methods.item.update(p),
                'sample.item.delete': (p) => Methods.item.delete(p),
                'sample.item.restore': (p) => Methods.item.restore(p),
                'sample.item.status': (p) => Methods.item.setStatus(p),
                'sample.item.list': (p) => Methods.item.list(p),
                // Admin-only example: use isAdmin from req.permit, not req.user.permit
                'sample.item.purgeable': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.item.purgeable(p);
                },
                'sample.item.destroy': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.item.destroy(p);
                }
            };
            if (itemHandlers[method]) {
                result = await itemHandlers[method](params);
            }
        }

        if (result === undefined) {
            return jsonrpc.error(res, jsonrpc.METHOD_NOT_FOUND(method), id, 404);
        }

        jsonrpc.success(res, result, id);
    } catch (err) {
        // Auto-reported to Redis via logger
        logger.error(`Error processing ${method}:`, err, { request: params });

        jsonrpc.error(res, err.code ? err : jsonrpc.INTERNAL_ERROR(err.message), id);
    }

    }); // walContext.run
});
