const express = require('express');
const cors = require('cors');
const { corsOptionsFromEnv } = require('../../library/cors');
const bodyParser = require('body-parser');
const config = require('./config');
const { createLogger } = require('../../library/logger');
const logger_lib = require('../../library/logger');
const { createRelay } = require('../../library/relay');
const { walContext } = require('../../library/entity');
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

mountHealth(app, { serviceName: config.serviceName, version: config.version, getRedis: () => redisClient });

let redisClient;
let Methods;
let relay;

(async () => {
    try {
        redisClient = await initializeRedis(config.serviceName);
        logger.setRedis(redisClient);

        await ensureDefaultCategories(redisClient, config.serviceName);

        // §3.1 — the gate verifies approver signatures by relaying to user.key.getPublic.
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

app.get('/auth/seed', authHandlers.handleSeed);
app.post('/auth/verify', (req, res) =>
    authHandlers.handleVerify(req, res, config.serviceName, config.version, STARTUP_TIME));

app.post('/jsonrpc', authHandlers.middleware, async (req, res) => {
    if (!Methods) return jsonrpc.error(res, jsonrpc.SERVICE_NOT_READY(), null, 503);

    await walContext.run({ uid: req.user || null, trace: req.meta?.trace || null, depth: req.meta?.depth ?? 0 }, async () => {
        const { jsonrpc: jsonrpc_version, method, params, id } = req.body;
        // The Router already gated method-level access; we record the acting uid.
        const ctx = { actor: req.user || null, isAdmin: req.permit === 'admin' };

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

                'approval.record.request': (p) => Methods.record.request(p, ctx),
                'approval.record.verify':  (p) => Methods.record.verify(p, ctx),
                'approval.record.confirm': (p) => Methods.record.confirm(p, ctx),
                'approval.record.reject':  (p) => Methods.record.reject(p, ctx),
                'approval.record.get':     (p) => Methods.record.get(p),
                'approval.record.list':    (p) => Methods.record.list(p),

                // ── Multi-signature gate (§3.1, high-risk lane) ──────────────────
                // Driven by orchestrator (trusted infra asserts approverUid/submitterUid;
                // the signature is the proof). Router checkAccess already gated reachability.
                'approval.gate.open':   (p) => Methods.gate.open(p),
                'approval.gate.sign':   (p) => Methods.gate.sign(p),
                'approval.gate.reject': (p) => Methods.gate.reject({ ...p, byUid: ctx.actor }),
                'approval.gate.get':    (p) => Methods.gate.get(p),
                'approval.gate.list':   (p) => Methods.gate.list(p),

                // §7.7 — admin-only token lifecycle for the internal-call relay
                'approval.token.set':    async (p) => { if (!ctx.isAdmin) throw jsonrpc.UNAUTHORIZED(); await relay.setToken(p); return { ok: true }; },
                'approval.token.status': async () => { if (!ctx.isAdmin) throw jsonrpc.UNAUTHORIZED(); return relay.status(); },
                'approval.token.clear':  async () => { if (!ctx.isAdmin) throw jsonrpc.UNAUTHORIZED(); await relay.clear(); return { ok: true }; },
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
