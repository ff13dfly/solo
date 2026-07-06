const express = require('express');
const cors = require('cors');
const { corsOptionsFromEnv } = require('../../library/cors');
const bodyParser = require('body-parser');
const { createClient } = require('redis');
const config = require('./config');
const { mountHealth } = require('../../library/health');
const createLogic = require('./logic');
const introspectionMethods = require('./handlers/introspection');
const jsonrpc = require('./handlers/jsonrpc');

const app = express();
const PORT = config.port;

// --- Logger ---
const { createLogger } = require('../../library/logger');
const logger = createLogger(config.serviceName);

app.use(cors(corsOptionsFromEnv()));
app.use(bodyParser.json());

// Debug Middleware
app.use((req, res, next) => {
    if (config.debug) {
        logger.debug('INCOMING:', req.method, req.originalUrl);
        if (req.body) {
             logger.debug('BODY:', JSON.stringify(req.body, null, 2));
        }
    }
    next();
});

let Methods;
let redisClient;
let server;

mountHealth(app, { serviceName: config.serviceName, version: config.version, getRedis: () => redisClient });

(async () => {
    try {
        // Create Shared Redis Client
        redisClient = createClient({ url: config.redisUrl });
        redisClient.on('error', err => logger.error('Redis Client Error', err));
        await redisClient.connect();
        logger.info('Connected to Redis');
        logger.setRedis(redisClient); // Bind Redis for auto-error reporting → ERROR:QUEUE (parity with other services)

        Methods = createLogic(redisClient, config);

        // Init identity components (Challenge sweeper, etc)
        await Methods.identity.init(redisClient);

        // Start Server — capture handle so admin.self.lock can close it.
        server = app.listen(PORT, () => {
             logger.info(`Service running on port ${PORT}`);
        });
    } catch (e) {
        logger.error('Startup Failed:', e);
    }
})();

// --- LEVEL 3 SECURITY: shared Router-token middleware (library/auth) ---
// The inline pre-library fork that lived here is gone (toFix §6.x); the
// service-specific public whitelist now lives in handlers/auth.js.
const authHandlers = require('./handlers/auth');
app.use(authHandlers.middleware);

// Z-handshake endpoints (library/auth provides them for free). The Router
// auto-manages administrator (ensureAdministratorService) and never needed
// these historically — mounting them makes the service conform to the fleet
// handshake contract anyway (autocheck [Ed25519]) at zero cost.
app.get('/auth/seed', authHandlers.handleSeed);
app.post('/auth/verify', (req, res) => authHandlers.handleVerify(req, res, config.serviceName, config.version, new Date().toISOString()));

// JSON-RPC 2.0 Endpoint
app.post('/jsonrpc', async (req, res) => {
    if (!Methods) return jsonrpc.error(res, jsonrpc.SERVICE_NOT_READY(), null, 503);

    const { jsonrpc: jsonrpc_version, method, params, id } = req.body;
    
    if (jsonrpc_version !== '2.0') {
      return jsonrpc.error(res, jsonrpc.INVALID_REQUEST(), null, 400);
    }

    // Caller's session token (propagated by Router as Authorization or x-admin-token).
    // Required for admin.self.lock to target the correct session in Redis.
    const callerToken = req.headers['authorization']?.replace('Bearer ', '')
        || req.headers['x-admin-token']
        || null;

    try {
        const handlers = {
            'admin.log.error': (p) => Methods.error.list(redisClient, p),
            'admin.log.clear': (p) => Methods.error.clear(redisClient, p),
            'admin.login.request': (p) => Methods.identity.loginRequest(p),
            'admin.login.verify': (p) => Methods.identity.loginVerify(p),
            'admin.password.reset': (p) => Methods.identity.saveAdmin(p),
            'admin.self.lock': () => Methods.identity.lockAdmin(callerToken, () => server),
            'ping': () => ({ status: 'ok', service: config.serviceName, version: config.version, uptime: new Date().toISOString() }),
            'methods': () => ({ methods: introspectionMethods, description: config.description || {} }),
            'events':   () => require('./handlers/events'),
            'entities': () => require('./handlers/entities'),
            // toFix.md §二.administrator / coherence-debt #4: 运维面(能覆盖任意服务的 config)
            // 按团队既定政策("数据面信 Router / 运维面 handler 硬门")补 in-handler 硬门,
            // 不再纯靠 Router permit 下发——纵深防御,同 setting.automation.* 的既有写法。
            'setting.config.get': async (p) => {
                if (!p.isAdmin) throw jsonrpc.UNAUTHORIZED();
                const { service } = p;
                if (!service) throw jsonrpc.MISSING_PARAM('service');
                const overrides = await redisClient.hGetAll(`config:${service}`);
                return overrides || {};
            },
            'setting.config.set': async (p) => {
                if (!p.isAdmin) throw jsonrpc.UNAUTHORIZED();
                const { service, key, value } = p;
                if (!service || !key || value === undefined) throw jsonrpc.MISSING_PARAM('service, key, value');
                await redisClient.hSet(`config:${service}`, key, String(value));
                return { ok: true };
            },
            'setting.config.del': async (p) => {
                if (!p.isAdmin) throw jsonrpc.UNAUTHORIZED();
                const { service, key } = p;
                if (!service || !key) throw jsonrpc.MISSING_PARAM('service, key');
                await redisClient.hDel(`config:${service}`, key);
                return { ok: true };
            },
            'setting.config.list': async (p) => {
                if (!p.isAdmin) throw jsonrpc.UNAUTHORIZED();
                const keys = await redisClient.keys('config:*');
                return keys.map(k => k.replace('config:', ''));
            },
            'setting.config.schema': async (p) => {
                if (!p.isAdmin) throw jsonrpc.UNAUTHORIZED();
                const { service } = p;
                if (!service) throw jsonrpc.MISSING_PARAM('service');
                const raw = await redisClient.get(`SYSTEM:CONFIG:SCHEMA:${service}`);
                if (!raw) return null;
                return JSON.parse(raw);
            },
            'setting.index.schema': async ({ service }) => {
                if (!service) throw jsonrpc.MISSING_PARAM('service');
                const raw = await redisClient.get(`SYSTEM:INDEX_SCHEMA:${service}`);
                if (!raw) return null;
                return JSON.parse(raw);
            },

            // System-level auto↔manual control (operator seam). Flips each service's
            // runtime pause flag DIRECTLY in the shared Redis (no relay) — the nexus +
            // orchestrator loops honor it. One switch for the whole automation plane.
            'setting.automation.status': async (p) => {
                if (!p.isAdmin) throw jsonrpc.UNAUTHORIZED();
                const services = {};
                for (const { service, pausedKey } of config.automationServices) {
                    services[service] = { paused: (await redisClient.get(pausedKey)) === '1' };
                }
                const vals = Object.values(services);
                return { services, allPaused: vals.length > 0 && vals.every(s => s.paused), anyPaused: vals.some(s => s.paused) };
            },
            'setting.automation.pause': async (p) => {
                if (!p.isAdmin) throw jsonrpc.UNAUTHORIZED();
                for (const { pausedKey } of config.automationServices) await redisClient.set(pausedKey, '1');
                return { paused: true };
            },
            'setting.automation.resume': async (p) => {
                if (!p.isAdmin) throw jsonrpc.UNAUTHORIZED();
                for (const { pausedKey } of config.automationServices) await redisClient.del(pausedKey);
                return { paused: false };
            },

            // Entity display-manifest store (Display Protocol §6, layer ②-B). operator
            // boot-fetches list(); admin edits via set()/delete() (structural-validated).
            'setting.display.get':    (p) => Methods.display.get(p),
            'setting.display.list':   () => Methods.display.list(),
            'setting.display.set':    (p) => Methods.display.set(p),
            'setting.display.delete': (p) => Methods.display.del(p),
        };

        const trustedParams = { ...params };
        if (req.permit === 'admin') {
            trustedParams.isAdmin = true;
        }
        trustedParams._user = req.user;

        trustedParams._user = req.user;
        
        if (!handlers[method]) {
            return jsonrpc.error(res, jsonrpc.METHOD_NOT_FOUND(method), id, 404);
        }

        const result = await handlers[method](trustedParams);
        jsonrpc.success(res, result, id);
    } catch (err) {
        logger.error(`RPC Error [${method}]:`, err.message);
        jsonrpc.error(res, err.code ? err : jsonrpc.INTERNAL_ERROR(err.message), id);
    }
});
