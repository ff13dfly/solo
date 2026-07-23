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

const { initializeRedis } = require('./handlers/bootstrap');
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

mountHealth(app, { serviceName: config.serviceName, version: config.version, getRedis: () => redisClient });

let redisClient;
let Methods;
let relay;

(async () => {
    try {
        redisClient = await initializeRedis(config.serviceName);
        logger.setRedis(redisClient);

        // security.md §7.7 — internal cross-service calls (event.emit) via shared relay bot.
        relay = createRelay({
            redis: redisClient,
            serviceName: config.serviceName,
            routerUrl: `${config.routerUrl}/jsonrpc`,
            walLogger: (key, data) => logger_lib.insert(key, data),
        });

        Methods = createLogic(redisClient, { config, relay });

        app.listen(PORT, () => {
            logger.info(`Service running on port ${PORT}`);
            logger.info('Ready to accept connections.');
        });
    } catch (e) {
        logger.error('Startup Failed:', e);
        process.exit(1);
    }
})();

// --- AUTH / DISCOVERY HANDSHAKE ---
app.get('/auth/seed', authHandlers.handleSeed);
app.post('/auth/verify', (req, res) =>
    authHandlers.handleVerify(req, res, config.serviceName, config.version, STARTUP_TIME));

// Inbound auth: the per-source API key, carried in the Authorization header.
// The listener sends `Authorization: ApiKey <key>` to the Router, which forwards
// the authorization header through to ingress (router/handlers/forward.js). The
// key thus never appears in RPC params, so it stays out of Router audit logs.
function extractApiKey(req) {
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('ApiKey ')) return auth.slice(7).trim();
    return req.headers['x-api-key'] || null;
}

// --- JSON-RPC FACE: management (admin) + public inbound (ingress.ingest), via Router ---
app.post('/jsonrpc', authHandlers.middleware, async (req, res) => {
    if (!Methods) return jsonrpc.error(res, jsonrpc.SERVICE_NOT_READY(), null, 503);

    await walContext.run({ uid: req.user || null, trace: req.meta?.trace || null, depth: req.meta?.depth ?? 0 }, async () => {
        const { method, params, id } = req.body;
        const isAdmin = req.permit === 'admin';
        const needAdmin = () => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); };

        try {
            const handlers = {
                'ping': () => ({ status: 'ok', service: config.serviceName, version: config.version, uptime: STARTUP_TIME }),
                'methods':  () => ({ methods: introspectionMethods, description: config.description || {} }),
                'entities': () => require('./handlers/entities'),
                'events':   () => require('./handlers/events'),

                'guide':    () => require('../../library/guide').readGuide('ingress', __dirname),
                // Inbound (public): listener → Router → here. API key from the
                // forwarded Authorization header; params = { request_id, data }.
                'ingress.ingest': async (p) => {
                    const result = await Methods.ingest.handle(extractApiKey(req), p);
                    return result.body;
                },

                // Source management (admin)
                'ingress.source.create':     (p) => { needAdmin(); return Methods.source.create(p); },
                'ingress.source.get':        (p) => { needAdmin(); return Methods.source.get(p); },
                'ingress.source.list':       (p) => { needAdmin(); return Methods.source.list(p); },
                'ingress.source.update':     (p) => { needAdmin(); return Methods.source.update(p); },
                'ingress.source.enable':     (p) => { needAdmin(); return Methods.source.enable(p); },
                'ingress.source.disable':    (p) => { needAdmin(); return Methods.source.disable(p); },
                'ingress.source.key.rotate': (p) => { needAdmin(); return Methods.source.rotateKey(p); },
                'ingress.source.delete':     (p) => { needAdmin(); return Methods.source.delete(p); },
                'ingress.source.test':       (p) => { needAdmin(); return Methods.ingest.testFire(p); },

                // Delivery audit log (admin)
                'ingress.log.recent':        (p) => { needAdmin(); return Methods.audit.recent(p || {}); },

                // dataSchema-rejected deliveries, held for human review (admin)
                'ingress.review.list':    (p) => { needAdmin(); return Methods.review.list(p || {}); },
                'ingress.review.approve': (p) => { needAdmin(); return Methods.review.approve(p); },
                'ingress.review.discard': (p) => { needAdmin(); return Methods.review.discard(p); },

                // Relay token lifecycle (admin) — security.md §7.7
                'ingress.token.set':    async (p) => { needAdmin(); await relay.setToken(p); return { ok: true }; },
                'ingress.token.status': async () => { needAdmin(); return relay.status(); },
                'ingress.token.clear':  async () => { needAdmin(); await relay.clear(); return { ok: true }; },
            };

            if (!handlers[method]) return jsonrpc.error(res, jsonrpc.METHOD_NOT_FOUND(method), id, 404);

            const result = await handlers[method](params);
            jsonrpc.success(res, result, id);
        } catch (err) {
            logger.error(`Error processing ${method}:`, err, { request: params });
            jsonrpc.error(res, err.code ? err : jsonrpc.INTERNAL_ERROR(err.message), id);
        }
    });
});
