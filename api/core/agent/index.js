require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { corsOptionsFromEnv } = require('../../library/cors');
const bodyParser = require('body-parser');
const chalk = require('chalk');
const redis = require('redis');

const config = require('./config');
const Methods = require('./logic');
const authHandlers = require('./handlers/auth');
const introspectionMethods = require('./handlers/introspection');
const jsonrpc = require('./handlers/jsonrpc');
const tokenLogger = require('./lib/tokenLogger');
const { mountHealth } = require('../../library/health');

// --- SERVICE CONSTANTS ---
const STARTUP_TIME = new Date().toISOString();
const app = express();
const PORT = config.port;

// --- LOGGER ---
const { createLogger } = require('../../library/logger');
const logger = createLogger(config.serviceName);

// --- MIDDLEWARE ---

app.use(cors(corsOptionsFromEnv()));
app.use(bodyParser.json({ limit: config.bodyLimit }));

mountHealth(app, { serviceName: config.serviceName, version: config.version, getRedis: () => redisClient });

/**
 * Request Logger
 * @why Provides visibility into AI agent operations and LLM interactions.
 */
app.use((req, res, next) => {
    if (config.debug) {
        logger.debug('INCOMING:', req.method, req.originalUrl);
    }
    next();
});

/**
 * Middleware: Level 3 Security (Router Auth)
 * @why Protects sensitive AI capabilities from unauthorized direct access.
 */
app.use(authHandlers.middleware);

// --- BOOTSTRAP ---

/**
 * Redis State Initialization
 * @process
 *   1. Resolve Redis URI from config.
 *   2. Establish persistent connection.
 *   3. Bind Redis client to logger for telemetry.
 */
if (!config.redisUrl) {
    throw new Error('[Agent] FATAL: Redis URL not configured. Set REDIS_URL environment variable.');
}

const redisClient = redis.createClient({
    url: config.redisUrl
});

redisClient.on('error', (err) => logger.error('Redis Client Error', err));
redisClient.connect().then(() => {
    logger.info('Redis Connected');
    logger.setRedis(redisClient);
    tokenLogger.init(redisClient);
    require('./logic/model_config').init(redisClient);
});

// --- AUTH ENDPOINTS ---

/**
 * Handshake endpoints for the Router to establish a trusted cryptographic link.
 */
app.get('/auth/seed', authHandlers.handleSeed);
app.post('/auth/verify', (req, res) => authHandlers.handleVerify(req, res, config.serviceName, config.version, STARTUP_TIME));

// --- JSON-RPC ENDPOINT ---

/**
 * Primary RPC Gateway
 * @why Implements the JSON-RPC 2.0 protocol for Agent capabilities.
 * @attention 
 *   - All methods except `ping` and `methods` require Level 3 Router authorization.
 *   - Errors are automatically reported to the centralized telemetry system.
 */
const { walContext } = require('../../library/entity');

app.post('/jsonrpc', async (req, res) => {
    await walContext.run({ uid: req.user || null, trace: req.meta?.trace || null, depth: req.meta?.depth ?? 0 }, async () => {
        const { jsonrpc: jsonrpc_version, method, params, id } = req.body;

        try {
            const handlers = {
                'agent.image.parse': (p) => Methods.agent.image.parse(p),
                'agent.image.ps': (p) => Methods.agent.image.ps(p),
                'agent.image.classify': (p) => Methods.agent.image.classify(p),
                'agent.image.generate': (p) => Methods.agent.image.generate(p),
                'agent.image.process':  (p) => Methods.agent.image.process(p),
                'agent.label.scan': (p) => Methods.agent.label.scan(p),
                'agent.audio.transcribe': (p) => Methods.agent.audio.transcribe(p),
                'agent.text.parse': (p) => Methods.agent.text.parse(p),
                'agent.text.translate': (p) => Methods.agent.text.translate(p),
                'agent.chat': (p) => Methods.agent.chat(p),
                'agent.purpose': (p) => Methods.agent.purpose(p),
                'agent.focus': (p) => Methods.agent.focus(p),
                'agent.decide': (p) => Methods.agent.decide(p),
                'agent.case.generate': (p) => Methods.agent.case.generate(p),
                'agent.stats.token': () => Promise.all([
                    tokenLogger.daily(redisClient, 30),
                    tokenLogger.recent(redisClient, 10),
                ]).then(([daily, recent]) => ({ daily, recent })),
                'agent.stats.hourly': (p) => {
                    logger.info(`[Stats] Hourly request for date: ${p.date}`);
                    return tokenLogger.hourly(redisClient, p.date);
                },
                'agent.stats.range':  (p) => {
                    logger.info(`[Stats] Range request: ${p.start} to ${p.end} (step: ${p.step})`);
                    return tokenLogger.range(redisClient, p);
                },
                'agent.providers': () => {
                    const providers = [];
                    if (config.qwenApiKey)    providers.push({ id: 'qwen',    name: '千问 (Qwen)',  vision: true });
                    if (config.geminiApiKey)  providers.push({ id: 'gemini',  name: 'Gemini',      vision: true });
                    if (config.openaiApiKey)  providers.push({ id: 'openai',  name: 'OpenAI',      vision: false });
                    if (config.bitexingApiKey) providers.push({ id: 'bitexing', name: 'Bitexing',  vision: false });
                    return { providers, default: config.provider || 'qwen' };
                },
                // Per-capability model selection (admin) — gated by Router permit (agent.model.*).
                'agent.model.list':  () => require('./logic/model_config').listModels(),
                'agent.model.set':   (p) => require('./logic/model_config').setModel(p),
                'agent.model.reset': (p) => require('./logic/model_config').resetModel(p),
                'ping': () => ({
                    status: 'ok',
                    service: config.serviceName,
                    version: config.version,
                    uptime: STARTUP_TIME
                }),
                'methods': () => ({ methods: introspectionMethods, description: config.description || {} }),
                'entities': () => ({}), // agent microservice has no shared business entities
                'events':   () => require('./handlers/events'),
            };

            if (!handlers[method]) {
                return jsonrpc.error(res, jsonrpc.METHOD_NOT_FOUND(method), id, 404);
            }

            const result = await handlers[method](params);
            jsonrpc.success(res, result, id);
        } catch (err) {
            // Auto-reported to Redis via logger
            logger.error(`Error processing ${method}:`, err, { request: params });

            jsonrpc.error(res, err.code ? err : jsonrpc.INTERNAL_ERROR(err.message), id);
        }
    });
});


// --- SERVER STARTUP ---

app.listen(PORT, () => {
    logger.info(`Service running on port ${PORT}`);
    logger.info(`Ready to serve AI capabilities.`);
});
