const express = require('express');
const cors = require('cors');
const { corsOptionsFromEnv } = require('../../library/cors');
const bodyParser = require('body-parser');
const config = require('./config');
const { createLogger } = require('../../library/logger');
const { walContext } = require('../../library/entity');

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

let redisClient;
let Methods;

(async () => {
    try {
        redisClient = await initializeRedis(config.serviceName);
        logger.setRedis(redisClient);
        Methods = createLogic(redisClient, { config });
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
        const { method, params, id } = req.body;

        try {
            const handlers = {
                'ping': () => ({ status: 'ok', service: config.serviceName, version: config.version, uptime: STARTUP_TIME }),
                'methods':  () => ({ methods: introspectionMethods, description: config.description || {} }),
                'entities': () => require('./handlers/entities'),
                'events':   () => require('./handlers/events'),

                // create / ship return the business object WITH `_event`; the Router
                // strips _event from the client response and writes the stream.
                'market.shipment.create': (p) => Methods.shipment.create(p),
                'market.shipment.ship':   (p) => Methods.shipment.ship(p),
                'market.shipment.get':    (p) => Methods.shipment.get(p),
                'market.shipment.list':   (p) => Methods.shipment.list(p),

                // order: PLACED → PAID → CONFIRMED | HELD. Advanced by fulfillment _tasks
                // (pay/confirm/hold are state-guarded + idempotent); no _event piggyback.
                'market.order.create':  (p) => Methods.order.create(p),
                'market.order.pay':     (p) => Methods.order.pay(p),
                'market.order.confirm': (p) => Methods.order.confirm(p),
                'market.order.hold':    (p) => Methods.order.hold(p),
                'market.order.get':     (p) => Methods.order.get(p),
                'market.order.list':    (p) => Methods.order.list(p),
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
