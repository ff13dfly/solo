const express = require('express');
const cors = require('cors');
const { corsOptionsFromEnv } = require('../../library/cors');
const bodyParser = require('body-parser');
const config = require('./config');
const { createLogger } = require('../../library/logger');
const logger_lib = require('../../library/logger');
const { createRelay } = require('../../library/relay');
const { walContext } = require('../../library/entity');

const { initializeRedis } = require('./handlers/bootstrap');
const authHandlers = require('./handlers/auth');
const introspectionMethods = require('./handlers/introspection');
const createLogic = require('./logic');
const jsonrpc = require('./handlers/jsonrpc');
const fieldmask = require('../../library/fieldmask');   // 数据级:按调用方 constraints 遮蔽字段

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
let relay;

(async () => {
    try {
        redisClient = await initializeRedis(config.serviceName);
        logger.setRedis(redisClient);
        // payment.refund verifies an approval.record by relaying approval.record.get
        // through the Router (no direct service-to-service call). Token injected by the
        // admin-only collection.token.set (harness seeds system.collection's token).
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
        const { method, params, id } = req.body;

        // 行隔离(authority.md §4.3):外部 session 带 constraints.$owner = {field, value}。
        // 服务端派生,覆盖任何客户端传入的 _scope(spread 在后 → 客户端无法注入/绕过)。
        // 内部/admin 无 $owner → scope=null → payment 逻辑行为不变。
        const scope = (req.constraints && req.constraints.$owner) || null;
        const isAdmin = req.permit === 'admin';

        try {
            const handlers = {
                'ping': () => ({ status: 'ok', service: config.serviceName, version: config.version, uptime: STARTUP_TIME }),
                'methods':  () => ({ methods: introspectionMethods, description: config.description || {} }),
                'entities': () => require('./handlers/entities'),
                'events':   () => require('./handlers/events'),

                'guide':    () => require('../../library/guide').readGuide('collection', __dirname),
                // record / settle return the business object WITH `_event`; the
                // Router strips _event from the client response and writes the stream.
                'collection.payment.record': (p) => Methods.payment.record({ ...p, _scope: scope }),
                'collection.payment.settle': (p) => Methods.payment.settle({ ...p, _scope: scope }),
                // refund is gated on a confirmed signed approval (verified via relay) — no _event.
                'collection.payment.refund': (p) => Methods.payment.refund({ ...p, _scope: scope }),
                // 数据级权限:行隔离(_scope:哪些行)+ fieldmask(哪些列)。
                // get 返回单条 → 整体 apply;list 返回 {items,total} → 只 apply items。
                'collection.payment.get':    async (p) => fieldmask.apply(await Methods.payment.get({ ...p, _scope: scope }), 'collection.payment.get', req.constraints),
                'collection.payment.list':   async (p) => {
                    const res = await Methods.payment.list({ ...p, _scope: scope });
                    return { ...res, items: fieldmask.apply(res.items, 'collection.payment.list', req.constraints) };
                },

                // Admin-only relay token lifecycle (for the outbound approval.record.get call).
                'collection.token.set':    async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); await relay.setToken(p); return { ok: true }; },
                'collection.token.status': async () => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return relay.status(); },
                'collection.token.clear':  async () => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); await relay.clear(); return { ok: true }; },
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
