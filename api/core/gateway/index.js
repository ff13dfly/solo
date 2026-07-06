const express = require('express');
const cors = require('cors');
const { corsOptionsFromEnv } = require('../../library/cors');
const bodyParser = require('body-parser');
const config = require('./config');
const { createLogger } = require('../../library/logger');
const { mountHealth } = require('../../library/health');

const { initializeRedis } = require('./handlers/bootstrap');
const authHandlers = require('./handlers/auth');
const introspectionMethods = require('./handlers/introspection');
const entityDefinitions = require('./handlers/entities');
const createLogic = require('./logic');
const jsonrpc = require('./handlers/jsonrpc');

// --- SERVICE CONSTANTS ---
const STARTUP_TIME = new Date().toISOString();
const app = express();
const PORT = config.port;

// --- LOGGER ---
const logger = createLogger(config.serviceName); 

// --- MIDDLEWARE ---

app.use(cors(corsOptionsFromEnv()));
app.use(bodyParser.json({ limit: config.bodyLimit }));

/**
 * Request Logger
 * @why Provides visibility into incoming traffic for the Gateway service.
 */
app.use((req, res, next) => {
    if (config.debug) {
        logger.debug(`INCOMING: ${req.method} ${req.originalUrl}`);
    }
    next();
});

/**
 * Middleware: Level 3 Security (Router Auth)
 * @why Ensures that only the trusted Router can access Gateway capabilities.
 */
// --- HEALTH ENDPOINTS — public (mounted BEFORE router-auth so probes need no token) ---
mountHealth(app, { serviceName: config.serviceName, version: config.version, getRedis: () => redisClient });

app.use(authHandlers.middleware);

// --- BOOTSTRAP ---
(async () => {
    try {
        redisClient = await initializeRedis(config.serviceName);
        logger.setRedis(redisClient); // Bind Redis for auto-error reporting
        
        Methods = createLogic(redisClient, { serviceName: config.serviceName, config, logger });
        
        // Start Server
        app.listen(PORT, () => {
            logger.info(`Service running on port ${PORT}`);
            logger.info(`Targeting Router at: ${config.routerUrl}`);
        });
    } catch (e) {
        logger.error(`Startup Failed:`, e);
        process.exit(1);
    }
})();

// --- AUTH ENDPOINTS ---

/**
 * Handshake endpoints for the Router to establish a trusted cryptographic link.
 */
app.get('/auth/seed', authHandlers.handleSeed);
app.post('/auth/verify', (req, res) => authHandlers.handleVerify(req, res, config.serviceName, config.version, STARTUP_TIME));

// --- JSON-RPC ENDPOINT ---

/**
 * Primary RPC Gateway
 * @why Implements the JSON-RPC 2.0 protocol for Gateway capabilities (Email, SMS, Echo).
 * @attention 
 *   - Most methods require Level 3 Router authorization.
 *   - Errors are automatically reported to the centralized telemetry system.
 */
app.post('/jsonrpc', async (req, res) => {
    if (!Methods) return jsonrpc.error(res, jsonrpc.SERVICE_NOT_READY(), null, 503);

    const { jsonrpc: jsonrpc_version, method, params, id } = req.body;
    
    try {
        const handlers = {
            // System
            'ping':    () => ({ status: 'ok', service: config.serviceName, version: config.version, uptime: STARTUP_TIME }),
            'methods': () => ({ methods: introspectionMethods, description: config.description || {} }),
            'entities': () => entityDefinitions,
            'events':   () => require('./handlers/events'),

            // Gateway
            'gateway.echo': (p) => Methods.gateway.echo(p),

            // SMTP
            'gateway.smtp.create': (p) => Methods.smtp.create(p),
            'gateway.smtp.get':    (p) => Methods.smtp.get(p),
            'gateway.smtp.list':   (p) => Methods.smtp.list(p),
            'gateway.smtp.update': (p) => Methods.smtp.update(p),
            'gateway.smtp.delete': (p) => Methods.smtp.delete(p),
            'gateway.smtp.test':   (p) => Methods.smtp.test(p),

            // Email Templates
            'gateway.email.template.create': (p) => Methods.email.template.create(p),
            'gateway.email.template.get':    (p) => Methods.email.template.get(p),
            'gateway.email.template.list':   (p) => Methods.email.template.list(p),
            'gateway.email.template.update': (p) => Methods.email.template.update(p),
            'gateway.email.template.delete': (p) => Methods.email.template.delete(p),

            // Email Send
            'gateway.email.send': (p) => Methods.email.send(p),

            // SMS Templates
            'gateway.sms.template.create': (p) => Methods.sms.template.create(p),
            'gateway.sms.template.get':    (p) => Methods.sms.template.get(p),
            'gateway.sms.template.list':   (p) => Methods.sms.template.list(p),
            'gateway.sms.template.update': (p) => Methods.sms.template.update(p),
            'gateway.sms.template.delete': (p) => Methods.sms.template.delete(p),

            // SMS Send
            'gateway.sms.send': (p) => Methods.sms.send(p),

            // Outbound Webhook Send
            'gateway.webhook.send': (p) => Methods.webhook.send(p),

            // Image Processing
            'gateway.rmbg.cutout': (p) => Methods.rmbg.cutout(p)
        };

        if (!handlers[method]) {
            return jsonrpc.error(res, jsonrpc.METHOD_NOT_FOUND(method), id, 404);
        }

        const result = await handlers[method](params);
        jsonrpc.success(res, result, id);
    } catch (err) {
        // Auto-reported to Redis via logger
        // Downgrade "Method entities not found" to warn (expected for services without entities)
        if (err.message && err.message.includes('Method entities not found')) {
            logger.warn(`Introspection:`, err.message);
        } else {
            logger.error(`Error:`, err.message, { request: params });
        }
        
        jsonrpc.error(res, err.code ? err : jsonrpc.INTERNAL_ERROR(err.message), id);
    }
});

// --- SERVER STARTUP ---

app.listen = ((original) => {
    // Wrap listen to provide standard startup logging if not handled in bootstrap
    return original;
})(app.listen);
