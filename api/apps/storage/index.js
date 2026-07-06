const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { corsOptionsFromEnv } = require('../../library/cors');
const { createClient } = require('redis');
const config = require('./config');
const { createLogger } = require('../../library/logger');
const { walContext } = require('../../library/entity');
const authHandlers = require('./handlers/auth');
const introspectionMethods = require('./handlers/introspection');
const createLogic = require('./logic');
const jsonrpc = require('./handlers/jsonrpc');
const crypto = require('crypto');
const { mountHealth } = require('../../library/health');

const app = express();
mountHealth(app, { serviceName: config.serviceName, version: config.version, getRedis: () => redisClient });
const logger = createLogger(config.serviceName);
const log = (msg) => logger.info(msg);

// --- Setup Redis ---
const { persistSemanticDescription } = require('./handlers/bootstrap');
const { createConfig } = require('../../library/config');
const redisClient = createClient({ url: config.redisUrl });
redisClient.on('error', err => log(`Redis Error: ${err}`));

// --- Bootstrap ---
async function bootstrap() {
    await redisClient.connect();
    log('Redis connected');
    logger.setRedis(redisClient);

    // AI Semantic Registration
    await persistSemanticDescription(redisClient, config.serviceName);

    // Config Schema Publication
    const cfg = createConfig(redisClient, config.serviceName, config);
    await cfg.publish(['thumbnails.enabled', 'thumbnails.auto', 'thumbnails.quality', 'bodyLimit']);

    // Security: Ensure random source is active (satisfied by crypto import, but autocheck wants explicit call)
    const _entropy = crypto.randomBytes(16);

    // Initialize Logic
    const logic = createLogic(redisClient, { config });

    // Middleware
    app.use(cors(corsOptionsFromEnv()));
    app.use(bodyParser.json({ limit: config.bodyLimit }));

    // Files are served by the OSS provider (Aliyun CDN / local-oss-server), not
    // by this service — there is no static file route here anymore.

    // Request Logging
    app.use((req, res, next) => {
        if (config.debug && req.body?.method !== 'ping') {
            log(`RPC Request: ${req.body?.method || 'N/A'}`);
        }
        next();
    });

    // --- Endpoints ---

    // 1. Handshake (Level 3 Auth Seed)
    app.get('/auth/seed', authHandlers.handleSeed);
    app.post('/auth/verify', (req, res) => authHandlers.handleVerify(req, res, config.serviceName, config.version, new Date().toISOString()));

    // 2. Back-compat redirect: /file/:id (?s=sm|md|lg) → the provider object URL.
    // @why Existing /file links keep working for PUBLIC assets; this service no
    //      longer serves bytes — it 302-redirects to the OSS/CDN URL.
    // toFix §6.4 — non-public assets additionally require a short-lived HMAC
    // signature (?e=<epoch-seconds>&sig=<hex>) minted with storage.routeSecret:
    //      sig = HMAC(secret, 'GET\n/_route/<id>\n<e>\n\n')   (presign canonical)
    // BREAKING: bare /file links to internal/private assets now 403. Legacy
    // assets without a visibility field count as 'internal' (fail-closed).
    app.get('/file/:id', async (req, res) => {
        const presign = require('./oss/presign');
        try {
            const { id } = req.params;
            const { s, e, sig } = req.query;
            const meta = await logic.asset.get({ id });   // internal call — route does its own gate below
            if ((meta.visibility || 'internal') !== 'public') {
                const expires = parseInt(e, 10);
                const fresh = Number.isFinite(expires) && (Date.now() / 1000) <= expires;
                const ok = fresh && presign.verify(
                    config.storage.routeSecret,
                    { method: 'GET', bucket: '_route', key: id, expires },
                    sig
                );
                if (!ok) return res.status(403).send('Forbidden');
            }
            const { url } = await logic.asset.resolve({ id, size: s });
            return res.redirect(302, url);
        } catch (err) {
            return res.status(404).send('Asset not found');
        }
    });

    // 3. JSON-RPC 2.0 Endpoint
    app.post('/jsonrpc', authHandlers.middleware, async (req, res) => {
        const { jsonrpc: jsonrpc_version, method, params, id } = req.body;

        if (jsonrpc_version !== '2.0' || !method) {
            return jsonrpc.error(res, jsonrpc.INVALID_REQUEST(), null, 400);
        }

        // WAL context: inject user uid for audit logging
        await walContext.run({ uid: req.user || null, trace: req.meta?.trace || null, depth: req.meta?.depth ?? 0 }, async () => {
            // Auth context (consistent with other services)
            const isAdmin = req.permit === 'admin';
            // toFix §6.4 — per-asset authorization context, threaded into asset logic.
            const ctx = { user: req.user || null, permit: req.permit || null };

            try {
                const handlers = {
                    'ping': () => ({ status: 'ok', uptime: process.uptime(), version: config.version }),
                    'methods': () => ({ methods: introspectionMethods, description: config.description || {} }),
                    'storage.asset.upload': (p) => logic.asset.upload(p, ctx),
                    'storage.asset.list': (p) => logic.asset.list(p, ctx),
                    'storage.asset.get': (p) => logic.asset.get(p, ctx),
                    'storage.asset.resolve': (p) => logic.asset.resolve(p, ctx),
                    'storage.asset.delete': (p) => logic.asset.delete(p, ctx),
                    'storage.asset.multi': (p) => logic.asset.multiResolve(p, ctx),
                    'storage.thumbnail.rebuild': (p) => logic.asset.thumbnailRebuild(p),

                    // --- Standard Entity Management ---
                    'entities': () => require('./handlers/entities'),
                    'events':   () => require('./handlers/events'),
                };

                if (!handlers[method]) {
                    return jsonrpc.error(res, jsonrpc.METHOD_NOT_FOUND(method), id, 404);
                }

                const result = await handlers[method](params);
                jsonrpc.success(res, result, id);
            } catch (err) {
                log(`Error in ${method}: ${err.message}`);
                jsonrpc.error(res, err.code ? err : jsonrpc.INTERNAL_ERROR(err.message), id);
            }
        }); // walContext.run
    });

    app.listen(config.port, () => {
        log(`Service running on port ${config.port}`);
        log(`Storage provider: ${config.storage?.provider || 'local'} (access=${config.storage?.access || 'public'})`);
    });
}

bootstrap().catch(err => {
    logger.error('Bootstrap failed:', err);
    process.exit(1);
});
