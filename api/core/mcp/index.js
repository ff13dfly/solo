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

        // security.md §7.7 relay bot — but this service ONLY ever uses relay.callAs()
        // under the EXTERNAL caller's own bot token (logic/tools.js). Its own bot identity
        // (relay.call/setToken) is intentionally never provisioned — nothing here needs it.
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

// --- AUTH / DISCOVERY HANDSHAKE (Router registration) ---
app.get('/auth/seed', authHandlers.handleSeed);
app.post('/auth/verify', (req, res) =>
    authHandlers.handleVerify(req, res, config.serviceName, config.version, STARTUP_TIME));

// --- JSON-RPC FACE: Router-facing management surface (ping/methods/entities/events) ---
app.post('/jsonrpc', authHandlers.middleware, async (req, res) => {
    if (!Methods) return jsonrpc.error(res, jsonrpc.SERVICE_NOT_READY(), null, 503);

    await walContext.run({ uid: req.user || null, trace: req.meta?.trace || null, depth: req.meta?.depth ?? 0 }, async () => {
        const { method, params, id } = req.body;

        try {
            const handlers = {
                'ping':     () => ({ status: 'ok', service: config.serviceName, version: config.version, uptime: STARTUP_TIME }),
                'methods':  () => ({ methods: introspectionMethods, description: config.description || {} }),
                'entities': () => require('./handlers/entities'),
                'events':   () => require('./handlers/events'),
                'guide':    () => require('../../library/guide').readGuide('mcp', __dirname),
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

// --- MCP FACE: external MCP clients, POST /mcp directly (not via Router forwarding) ---
// @why Mirrors ingress's public /ingest pattern: the caller has no SOLO Router-issued
//      identity of its own — it brings a bot session token (issued out-of-band via
//      user.bot.create + user.bot.issue.token, one narrow bot per external MCP consumer,
//      see v1-implementation-plan.md P4). This adapter forwards that token as-is via
//      relay.callAs(); Router's checkAccess is the sole enforcement point.

function extractBearerToken(req) {
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    return null;
}

app.post('/mcp', async (req, res) => {
    if (!Methods) return jsonrpc.error(res, jsonrpc.SERVICE_NOT_READY(), null, 503);

    const { method, params, id } = req.body || {};
    const isNotification = (id === undefined || id === null);

    if (typeof method !== 'string') {
        if (isNotification) return res.status(202).end();
        return jsonrpc.error(res, jsonrpc.INVALID_REQUEST(), id);
    }

    try {
        if (method === 'notifications/initialized') {
            // Client->server notification, no response body expected.
            return res.status(202).end();
        }

        if (method === 'initialize') {
            return jsonrpc.success(res, {
                protocolVersion: config.mcp.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: config.mcp.serverInfo,
            }, id);
        }

        if (method === 'tools/list' || method === 'tools/call') {
            const token = extractBearerToken(req);
            if (!token) return jsonrpc.error(res, jsonrpc.AUTH_REQUIRED(), id, 401);

            const result = method === 'tools/list'
                ? await Methods.tools.list(token)
                : await Methods.tools.call(token, params || {});
            return jsonrpc.success(res, result, id);
        }

        if (isNotification) return res.status(202).end();
        return jsonrpc.error(res, jsonrpc.METHOD_NOT_FOUND(method), id, 404);
    } catch (err) {
        // Reaches here only for a malformed request (e.g. tools/call missing `name`) or an
        // upstream Router/relay failure on tools/list (RelayError — bad/expired token,
        // checkAccess denial for orchestrator.workflow.list itself). tools/call's OWN
        // downstream failures are caught inside logic/tools.js and returned as a normal
        // isError:true result, not thrown — see that module's header comment.
        logger.error(`Error processing MCP ${method}:`, err, { request: params });
        if (err && err.name === 'RelayError') {
            return jsonrpc.error(res, jsonrpc.INTERNAL_ERROR(err.message), id, 502);
        }
        // logic/tools.js throws proper jsonrpc-shaped errors (e.g. MISSING_PARAM) for
        // malformed requests — forward those as-is instead of re-wrapping them.
        jsonrpc.error(res, err && err.code ? err : jsonrpc.INVALID_PARAMS(err && err.message), id, 400);
    }
});
