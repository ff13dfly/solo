const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const config = require('./config');
const { mountHealth } = require('../library/health');

// --- HANDLER MODULES ---
const handlers = {
    category: require('./handlers/category'),
    service: require('./handlers/service'),
    system: require('./handlers/system'),
    validator: require('./handlers/validator'),
    tasks: require('./handlers/tasks'),
    auth: require('./handlers/auth'),
    keypair: require('./handlers/keypair'),
    forward: require('./handlers/forward'),
    access: require('./handlers/access'),
    capability: require('./handlers/capability'),
    bootstrap: require('./handlers/bootstrap'),
    root: require('./handlers/root'),
    assets: require('./handlers/assets'),
    manifest: require('./handlers/manifest'),
    report:   require('./handlers/report'),
    ratelimit: require('./handlers/ratelimit'),
    events:   require('./handlers/events'),
    trace:    require('./handlers/trace')
};

// --- LOGGER SETUP ---
const loggerLib = require('../library/logger');
const { createLogger } = loggerLib;
const logger = createLogger('Router');
const jsonrpc = require('./handlers/jsonrpc');

// --- GLOBAL ERROR HANDLERS ---
process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// --- APP SETUP ---
const app = express();
const PORT = config.port;

app.use(cors());
app.use(bodyParser.json({ limit: config.bodyLimit }));

/**
 * Middleware: RPC Debug Logger
 * @why Provides visibility into incoming JSON-RPC traffic for debugging.
 */
app.use((req, res, next) => {
    logger.debug('RPCCALL:', req.method, req.originalUrl);
    next();
});

mountHealth(app, { serviceName: 'router', version: config.version, getRedis: () => redisClient });

// --- CORE STATE & CACHE INITIALIZATION ---
const SERVICES = {};
const CAPABILITY_MAP = handlers.capability.CAPABILITY_MAP;
let redisClient;
let serviceHandlers;

/**
 * Interaction Logs
 * Fixed missing logs in the System Portal by:
 * - **Permission Broadening**: Updated the Router's `isAdmin` check to include the `operator` role, ensuring users like `fuu` can access log retrieval methods.
 * - **Log Ownership**: Implemented a "view own logs" check in the retrieval logic, allowing users to see their own activity regardless of their system role.
 * - **Path Standardization**: Standardized log storage to absolute paths (`__dirname`) and improved the month partition calculation (`YYYYMM`) to use local time.
 * - **Technical Debugging**: Added granular `logger.debug` calls to the log retrieval process to trace partition keys and file paths in real-time.
 */

/**
 * Keypair Management
 * @why Enables the router to sign payloads for Level 3 security in downstream services.
 */
handlers.keypair.loadOrGenerateKeypair(config.debug);
const getKeypair = () => handlers.keypair.getKeypair();

/**
 * Capability Map Synchronization
 * @why Ensures the Router has the latest method schemas from discovered services.
 */
const updateCapabilityMap = async () => await handlers.capability.updateCapabilityMap(SERVICES, redisClient);

// --- STARTUP SEQUENCE ---
(async () => {
    try {
        // Step 1: Redis Connectivity & Auto-Error Binding
        redisClient = await handlers.bootstrap.initializeRedis(SERVICES, CAPABILITY_MAP, updateCapabilityMap);
        logger.setRedis(redisClient);

        // Step 2: Bootstrap Essential Services
        handlers.service.ensureAdministratorService(SERVICES, config.administratorServiceUrl);
        serviceHandlers = handlers.service.createServiceHandlers(SERVICES, CAPABILITY_MAP, redisClient);

        // Step 3: Global Asset Serving (Conditional)
        handlers.assets.setupAssets(app, config, redisClient);

        // --- HTTP ROUTES ---

        /**
         * GET /auth/key
         * @why Downstream services use this to verify payloads signed by the router.
         * @attention Secured by checking if the requester is an internal/private IP.
         */
        app.get('/auth/key', (req, res) => {
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
            // Allow localhost and basic private networks (10.*, 192.168.*, 172.16-31.*)
            const isInternal = /^(::1|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)$/.test(ip.replace(/^::ffff:/, ''));

            if (!isInternal && !config.debug) {
                return res.status(403).json({ error: 'Access denied: Internal network only' });
            }

            if (!getKeypair()) return res.status(503).json({ error: 'Keypair not loaded' });
            res.json({ publicKey: getKeypair().publicKey.toBase58() });
        });

        /**
         * GET /
         * @why Friendly entry point for human users accessing the API URL.
         */
        app.get('/', (req, res) => handlers.root.handleRoot(req, res, config));

        /**
         * POST / (JSON-RPC 2.0 Endpoint)
         * @why Logic-agnostic dispatcher that handles auth, routing, and task interception.
         */
        const rpcHandler = async (req, res) => {
            if (!req.body || typeof req.body !== 'object') {
                return jsonrpc.error(res, jsonrpc.INVALID_REQUEST(), null, 400);
            }

            const { jsonrpc: jsonrpc_version, method, params, id } = req.body;

            // --- PHASE 1: AUTH & RESOLUTION ---
            const token = handlers.auth.extractToken(req);
            const sessionUser = await handlers.auth.resolveSessionUser(token, redisClient);
            const isAdmin = handlers.auth.isAdmin(sessionUser);

            // Chain correlation: inherit X-Trace-Id/X-Trace-Depth or mint (chain start).
            // Threaded into the forward token (meta), _tasks dispatch, and event envelopes.
            const traceCtx = handlers.trace.resolve(req.headers);

            // --- PHASE 1.5: GLOBAL SANITY CHECK ---
            const globalValidationError = handlers.validator.validateGlobalConstraints(params);
            if (globalValidationError) {
                return jsonrpc.error(res, globalValidationError, id);
            }

            // --- PHASE 2: LOCAL METHOD DISPATCH ---
            const systemHandlers = handlers.system.createSystemHandlers(
                handlers.service.addService,
                isAdmin,
                __dirname,
                redisClient,
                SERVICES,
                getKeypair(),
                CAPABILITY_MAP
            );
            const categoryHandlers = handlers.category.createCategoryHandlers(redisClient, SERVICES);

            /**
             * Local System Method Dispatch Table
             *
             * @attention SECURITY: Methods defined here bypass checkAccess() entirely.
             *   They are handled before the permission gate and are NOT subject to the
             *   3-phase RBAC / public-flag / capMap checks.
             *
             *   RULE: Any method that is not intended for public access MUST include an
             *   explicit isAdmin guard. Omitting it makes the method accessible to ALL
             *   authenticated users (and potentially unauthenticated ones).
             *
             *   Correct pattern:
             *     'system.foo': (p, i, r) => {
             *         if (!isAdmin) return jsonrpc.error(r, jsonrpc.FORBIDDEN('Admin required'), i);
             *         return systemHandlers.foo(p, i, r);
             *     }
             */
            const METHODS = {
                'ping': (p, i, r) => jsonrpc.success(r, { status: 'ok', service: 'router', version: config.version }, i),

                // event.md §4.7 (D4) — active event emission channel for background loops
                // (worker/scheduler) that have no RPC response to piggyback on.
                // Security: registry check (source must be registered for stream+type).
                // Source = authenticated caller identity (bot sub / uid).
                'event.emit': async (p, i, r) => {
                    const source = sessionUser.uid || sessionUser.username || 'anonymous';
                    const events = Array.isArray(p) ? p : (p ? [p] : []);
                    // trustEventActor: a background loop may declare provenance (e.g. the
                    // scheduler asserting actor=cron:{id}); falls back to the bot source.
                    // source stays authenticated/unforgeable regardless.
                    const stats = await handlers.events.processEvents(events, { source, actor: source, redisClient, trustEventActor: true, traceCtx });
                    return jsonrpc.success(r, { ok: true, count: events.length, ...(stats || {}) }, i);
                },
                // Management & Discovery
                'system.service.status': (p, i, r) => serviceHandlers.checkServiceStatus(p, i, r),
                'system.manifest':     (p, i, r) => handlers.manifest(SERVICES)(p, i, r),
                'system.report':      (p, i, r) => handlers.report(redisClient).submit(p, i, r),
                'system.report.list': (p, i, r) => handlers.report(redisClient).list(p, i, r, isAdmin),
                'system.service.list': (p, i, r) => serviceHandlers.listServices(i, r),
                'system.service.add': (p, i, r) => {
                    const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.hostname === 'localhost';
                    if (!isAdmin && !(isLocal && config.debug)) return jsonrpc.error(r, jsonrpc.FORBIDDEN('Admin required'), i);
                    return systemHandlers.systemAddService(p, i, r);
                },
                'system.service.remove': (p, i, r) => {
                    if (!isAdmin) return jsonrpc.error(r, jsonrpc.FORBIDDEN('Admin required'), i);
                    return serviceHandlers.removeService(p, i, r);
                },
                'system.capability.list': (p, i, r) => serviceHandlers.capabilities(p, i, r, isAdmin),
                // Anonymous bootstrap doc; per-service variant self-gates in the
                // handler (auth required in production, like DISCOVERY_METHODS).
                'system.guide': (p, i, r) => systemHandlers.systemGuide(p, i, r, isAdmin, !!sessionUser.uid),

                // Auditing & Logs
                'admin.log.debug': (p, i, r) => systemHandlers.adminGetLogs(p, i, r, isAdmin),
                'admin.log.clear': (p, i, r) => systemHandlers.adminClearLogs(p, i, r, isAdmin),
                'admin.log.interaction': (p, i, r) => systemHandlers.adminGetInteractionLogs(p, i, r, isAdmin),
                'system.log.interaction': (p, i, r) => systemHandlers.adminGetInteractionLogs(p, i, r, isAdmin),
                'system.wal.stats.daily': (p, i, r) => systemHandlers.walStatsDaily(p, i, r, isAdmin),
                'system.wal.stats.range': (p, i, r) => systemHandlers.walStatsRange(p, i, r, isAdmin),

                // System Configuration (setting.*)
                'setting.task.get': (p, i, r) => systemHandlers.getTaskWhitelist(p, i, r, isAdmin),
                'setting.task.update': (p, i, r) => systemHandlers.updateTaskWhitelist(p, i, r, isAdmin),
                'setting.limit.get': (p, i, r) => systemHandlers.getRateLimits(p, i, r, isAdmin),
                'setting.limit.update': (p, i, r) => systemHandlers.updateRateLimits(p, i, r, isAdmin),
                'setting.blacklist.get': (p, i, r) => systemHandlers.getPermitBlacklist(p, i, r, isAdmin),
                'setting.blacklist.update': (p, i, r) => systemHandlers.updatePermitBlacklist(p, i, r, isAdmin),

                // Category Strategy — federated registration (toFix §一.2).
                // Internal services reserve/free category keys here, at boot, before any
                // bot token exists (user/planner have no relay). Accept a loopback
                // (same-host) caller in addition to admin: req.ip is unspoofable (no
                // trust proxy), and delete still owner-scopes in the handler
                // (data.owner !== service → DENIED). Multi-HOST deploys would instead
                // need the caller to present a service-bot token.
                'system.category.reserve': (p, i, r) => {
                    if (!isAdmin && !handlers.auth.isLoopbackRequest(req)) return jsonrpc.error(r, jsonrpc.FORBIDDEN('Admin or internal (loopback) caller required'), i);
                    return categoryHandlers.reserve(p, i, r);
                },
                'system.category.delete': (p, i, r) => {
                    if (!isAdmin && !handlers.auth.isLoopbackRequest(req)) return jsonrpc.error(r, jsonrpc.FORBIDDEN('Admin or internal (loopback) caller required'), i);
                    return categoryHandlers.delete(p, i, r);
                },
                'system.category.locate': (p, i, r) => categoryHandlers.locate(p, i, r),
                'system.category.list': (p, i, r) => categoryHandlers.list(p, i, r),

                // Dynamic Workflows
                'system.workflow.list': async (p, i, r) => {
                    try {
                        const dataStr = await redisClient.get('AGENT:WORKFLOW_SNAPSHOT');
                        const workflows = dataStr ? JSON.parse(dataStr) : [];
                        return jsonrpc.success(res, workflows, i);
                    } catch (e) {
                        return jsonrpc.error(res, jsonrpc.INTERNAL_ERROR('Failed to fetch workflows'), i);
                    }
                }
            };

            // SECURITY: unified rate-limit gate for EVERYTHING — local METHODS included.
            // Previously the local dispatch table bypassed the limiter (only
            // system.report was back-gated), leaving event.emit / system.category.* /
            // setting.* as unthrottled flood surfaces.
            if (!config.rateLimitDisabled) {
                const rlRules  = await handlers.ratelimit.getRules(redisClient);
                const rlRule   = handlers.ratelimit.resolveLimit(method, CAPABILITY_MAP, rlRules);
                const rlIp     = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
                const identity = (rlRule.by === 'user' && sessionUser.uid) ? sessionUser.uid : rlIp;
                const rlStatus = await handlers.ratelimit.checkLimit(redisClient, method, identity, rlRule);
                if (!rlStatus.allowed) {
                    return jsonrpc.error(res, jsonrpc.RATE_LIMIT_EXCEEDED(rlStatus.resetIn), id);
                }
            }

            if (Object.prototype.hasOwnProperty.call(METHODS, method)) {
                return await METHODS[method](params, id, res);
            }

            // --- PHASE 3: PERMISSION & FORWARDING ---
            const userId = sessionUser.uid || sessionUser.id || sessionUser.name || sessionUser.username || 'anonymous';
            const resolved = handlers.auth.resolveTargetService(method, SERVICES);
            let { service: targetService, serviceName: targetServiceName, methodSchema } = resolved || {};

            // 3.1 Unknown Method Guard
            if (!resolved) {
                const notFoundError = jsonrpc.METHOD_NOT_FOUND(method);
                logInteraction(userId, method, params, { jsonrpc: '2.0', error: notFoundError, id }, sessionUser);
                return jsonrpc.error(res, notFoundError, id);
            }

            // 3.2 Permission Gate
            const access = handlers.access.checkAccess(sessionUser, targetServiceName, method);
            if (!access.allowed) {
                // If user is guest, return AUTH_REQUIRED to trigger login modal on frontend
                if (sessionUser.username === 'guest' || !sessionUser.uid) {
                    const authError = jsonrpc.AUTH_REQUIRED();
                    logInteraction(userId, method, params, { jsonrpc: '2.0', error: authError, id }, sessionUser);
                    return jsonrpc.error(res, authError, id);
                }
                
                const forbiddenError = jsonrpc.FORBIDDEN(access.reason);
                logInteraction(userId, method, params, { jsonrpc: '2.0', error: forbiddenError, id }, sessionUser);
                return jsonrpc.error(res, forbiddenError, id);
            }

            // 3.3 Rate limit already applied above (unified gate before local dispatch).

            // 3.4 Dynamic Parameter Validation
            const enrichedParams = { ...params };
            if (targetService && methodSchema) {
                const validationError = handlers.validator.validateParams(enrichedParams, methodSchema);
                if (validationError) {
                    return jsonrpc.error(res, validationError, id);
                }
            }

            // 3.4 Upstream Execution
            try {
                const responseData = await handlers.forward.forwardRequest({
                    targetService,
                    method,
                    params: enrichedParams,
                    jsonrpc: jsonrpc_version,
                    id,
                    sessionUser,
                    isAdmin,
                    keypair: getKeypair(),
                    debug: config.debug,
                    sourceHeaders: req.headers,
                    traceCtx
                });

                // 3.5 Background Task Processing
                const tasks = handlers.forward.extractTasks(responseData);
                if (tasks) {
                    handlers.tasks.processTasks(tasks, userId, isAdmin, SERVICES, getKeypair(), redisClient, targetServiceName, CAPABILITY_MAP, traceCtx)
                        .catch(err => logger.error('Async Task Error:', err));
                }

                // 3.6 Event Publishing (_event, event.md §4) — fire-and-forget, like tasks.
                // source = the service that returned the response; actor = the calling user/bot.
                const events = handlers.events.extractEvents(responseData);
                if (events) {
                    handlers.events.processEvents(events, { source: targetServiceName, actor: userId, redisClient, traceCtx })
                        .catch(err => logger.error('Async Event Error:', err));
                }

                res.json(responseData);

                // interaction logging for agent methods
                if (method.startsWith('agent.')) {
                    logInteraction(userId, method, params, responseData, sessionUser);
                }
            } catch (err) {
                logger.error(`Forwarding failed [${method}] -> ${targetService.url}:`, err.message);
                const errorBody = jsonrpc.UPSTREAM_ERROR(targetServiceName || 'unknown', err.message);
                const errorResponse = { jsonrpc: '2.0', error: errorBody, id };
                jsonrpc.error(res, errorBody, id);

                if (method.startsWith('agent.')) {
                    logInteraction(userId, method, params, errorResponse, sessionUser);
                }
            }
        };

        /**
         * Interaction Audit Logger (Async)
         * @attention Records user prompts and AI responses in month-partitioned logs.
         */
        function logInteraction(userId, method, params, response, sessionUser) {
            (async () => {
                try {
                    const now = new Date();
                    // Use local date parts for month to match user perspective
                    const year = now.getFullYear();
                    const month = String(now.getMonth() + 1).padStart(2, '0');
                    const currentMonth = `${year}${month}`;

                    const effectiveUserId = userId || sessionUser.uid || sessionUser.id || 'anonymous';
                    const partitionKey = `${effectiveUserId}_${currentMonth}`;

                    let prompt = "RAW_PAYLOAD";
                    if (params.text) prompt = params.text;
                    else if (params.image) prompt = `[Image: ${(params.image.length / 1024).toFixed(2)}KB]`;
                    else if (params.audio) prompt = `[Audio: ${(params.audio.length / 1024).toFixed(2)}KB]`;
                    else if (params.user_input) prompt = params.user_input;

                    let status = "SUCCESS";
                    if (response.error) {
                        status = "ERROR";
                    } else if (response.result && response.result.type === 'fallback') {
                        status = "FALLBACK";
                    } else if (response.error && response.error.code === -32003) {
                        status = "ACCESS_DENIED";
                    }

                    const record = {
                        prompts: prompt,
                        method: method,
                        stamp: now.getTime(),
                        answer: response.result || response.error,
                        status: status
                    };

                    // Standardize to absolute path to avoid process.cwd() issues
                    const logFolder = require('path').join(__dirname, 'logs/interactions');
                    loggerLib.insert(partitionKey, record, logFolder);
                } catch (e) {
                    logger.warn(`Audit Log Error for ${sessionUser?.name || 'guest'}:`, e.message);
                }
            })();
        }

        // --- ENDPOINT REGISTRATION ---
        app.post('/', rpcHandler);
        app.post('/api/rpc', rpcHandler);
        // library/relay.js posts to `${routerUrl}/jsonrpc` (mirrors the path every
        // downstream service exposes). Without this mount, all relay-driven calls —
        // event.emit (nexus scheduler, orchestrator worker, ingress), notification.send —
        // would 404. Same handler, just an additional accepted path.
        app.post('/jsonrpc', rpcHandler);

        app.listen(PORT, () => {
            logger.info(`Solo·AI Router active on port ${PORT}`);
        });

    } catch (err) {
        logger.error('Startup Sequence FATAL:', err);
        process.exit(1);
    }
})();
