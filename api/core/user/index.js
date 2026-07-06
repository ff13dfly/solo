const express = require('express');
const cors = require('cors');
const { corsOptionsFromEnv } = require('../../library/cors');
const bodyParser = require('body-parser');
const config = require('./config');

const { initializeRedis, ensureDefaultCategories } = require('./handlers/bootstrap');
const authHandlers = require('./handlers/auth');
const introspectionMethods = require('./handlers/introspection');
const createLogic = require('./logic');
const jsonrpc = require('./handlers/jsonrpc');
const { mountHealth } = require('../../library/health');
const { createRelay } = require('../../library/relay');

const app = express();

// --- SERVICE CONSTANTS ---
const STARTUP_TIME = new Date().toISOString();
const PORT = config.port;

// --- LOGGER ---
const { createLogger } = require('../../library/logger');
const logger = createLogger(config.serviceName);

// --- MIDDLEWARE ---

app.use(cors(corsOptionsFromEnv()));
app.use(bodyParser.json());

/**
 * Debug Logger Middleware
 * @why Provides full request/response visibility during development.
 */
app.use((req, res, next) => {
    logger.debug('INCOMING:', req.method, req.originalUrl);
    if (req.body) {
        logger.debug('BODY:', JSON.stringify(req.body, null, 2));
    }

    const oldJson = res.json;
    res.json = function (data) {
        logger.debug('OUTGOING:', JSON.stringify(data, null, 2));
        return oldJson.apply(res, arguments);
    };
    next();
});

// --- HEALTH ENDPOINTS — public (mounted BEFORE router-auth so probes need no token) ---
mountHealth(app, { serviceName: config.serviceName, version: config.version, getRedis: () => redisClient });

/**
 * Middleware: Level 3 Security (Router Auth)
 * @why Ensures that only the authorized Router can interact with this service.
 */
app.use(authHandlers.middleware);

// --- BOOTSTRAP ---

let redisClient;
let Methods;

/**
 * Service Initialization
 * @process
 *   1. Connect to Redis.
 *   2. Bind Redis to logger for remote reporting.
 *   3. Seed default system categories.
 *   4. Initialize business logic.
 */
(async () => {
    try {
        redisClient = await initializeRedis(config.serviceName);
        logger.setRedis(redisClient); // Bind Redis for auto-error reporting

        await ensureDefaultCategories(redisClient, config.serviceName);

        // §7.7 — outbound relay (passport OTP delivery via gateway.email.send/sms.send).
        // Dormant until an admin provisions RELAY:TOKEN:user; OTP delivery is best-effort
        // (otpRequest swallows relay errors), so absence never blocks self-service issuance.
        const relay = createRelay({ redis: redisClient, serviceName: config.serviceName, routerUrl: config.routerUrl });
        Methods = createLogic(redisClient, config, { serviceName: config.serviceName, relay });

        // Start Server
        app.listen(PORT, () => {
            logger.info(`Service running on port ${PORT}`);
            logger.info(`Ready to accept connections.`);
        });
    } catch (e) {
        logger.error(`Startup Failed:`, e);
        process.exit(1);
    }
})();

// --- AUTH ENDPOINTS ---

/**
 * Handshake endpoints for the Router to establish a trusted link.
 */
app.get('/auth/seed', authHandlers.handleSeed);
app.post('/auth/verify', (req, res) => authHandlers.handleVerify(req, res, config.serviceName, config.version, STARTUP_TIME));

// --- JSON-RPC ENDPOINT ---

/**
 * Primary RPC Gateway
 * @why Implements the JSON-RPC 2.0 protocol for User management.
 * @attention Multi-layered authorization: 
 *   1. Router signature (Level 3) checked in middleware.
 *   2. Session-based permission checks (isAdmin) handled within the endpoint.
 */
const { walContext } = require('../../library/entity');

app.post('/jsonrpc', async (req, res) => {
    if (!Methods) return jsonrpc.error(res, jsonrpc.SERVICE_NOT_READY(), null, 503);

    await walContext.run({ uid: req.user || null, trace: req.meta?.trace || null, depth: req.meta?.depth ?? 0 }, async () => {
        const { jsonrpc: jsonrpc_version, method, params, id } = req.body;

        // req.user = UID string, req.permit = 'admin'|'user' (set by auth middleware)
        const isAdmin = req.permit === 'admin';
        const context = { isAdmin, user: req.user };

        try {
            const handlers = {
                'user.register': (p) => Methods.user.register(p),
                'user.login.request': (p) => Methods.user.loginRequest(p),
                'user.login.verify': (p) => Methods.user.loginVerify(p),
                'user.profile': (p) => Methods.user.getProfile(p),
                'user.account.list': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.user.list(p);
                },
                'user.permit.update': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.user.updatePermit(p);
                },
                'user.permit.get': (p) => {
                    // Admin reads anyone; any caller (incl. service bots) may read its
                    // OWN permit — the orchestrator's H6 footprint pre-check depends on
                    // this self-read, else event/cron-triggered workflows can't run.
                    if (!isAdmin && req.user !== p?.uid) throw jsonrpc.UNAUTHORIZED();
                    return Methods.user.getPermit(p);
                },
                'user.permit.batch': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.user.batchPermits(p);
                },
                'user.account.status': () => Methods.user.stats(),
                'user.account.update': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.user.update(p);
                },
                'user.account.remove': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.user.remove({ id: p.id || p.uid });
                },
                'user.account.restore': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.user.restore({ id: p.id || p.uid });
                },
                'user.account.check': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.user.checkDeletable({ id: p.id || p.uid });
                },
                'user.account.destroy': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.user.destroy({ id: p.id || p.uid });
                },
                // ── Bot Account Management (admin only) ──────────────────
                'user.bot.create': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.bot.create(p);
                },
                'user.bot.list': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.bot.list(p);
                },
                'user.bot.get': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.bot.get(p);
                },
                'user.bot.update': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.bot.update(p);
                },
                'user.bot.delete': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.bot.remove(p);
                },
                'user.bot.issue.token': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.bot.issueToken(p);
                },
                // ── Reversible suspension (admin): status gate + kill live sessions ──
                'user.bot.suspend': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.bot.suspend(p);
                },
                'user.bot.resume': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.bot.resume(p);
                },
                // ── Token self-refresh (called by library/relay.js) ──────
                'user.token.refresh': (p) => {
                    // context.user IS the caller uid string (set at L116: user: req.user) —
                    // NOT an object. `context.user?.user` was always undefined → tokenRefresh
                    // always threw UNAUTHORIZED (CLAUDE.md §7: req.user is a uid, not an object).
                    const callerUid = context.user;
                    return Methods.bot.tokenRefresh(p, callerUid);
                },
                // ── Token active revocation (admin): kill all of a uid's live sessions ──
                'user.token.revoke': (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.bot.revoke(p);
                },
                // ── Roles (authority.md) — named permit templates for internal users + passports ──
                // Permit-gated by the Router's checkAccess (CLAUDE.md §5). role.set/assign are
                // high-privilege (they define/grant permits) — admin grants them deliberately.
                'user.role.set':    (p) => Methods.role.set(p),
                'user.role.list':   () => Methods.role.list(),
                'user.role.get':    (p) => Methods.role.get(p),
                'user.role.assign': (p) => Methods.role.assign(p),   // materialize role's permit onto an internal user

                // ── External principals (passport) — manageable entity + bridge (authority.md) ──
                // Permit-gated (not hard isAdmin): an operator whose permit lists user.passport.*
                // can manage external users, grantable per-method (e.g. register/list but not disable).
                'user.passport.register': (p) => Methods.passport.register(p),
                'user.passport.list': (p) => Methods.passport.list(p),
                'user.passport.get': (p) => Methods.passport.get(p),
                'user.passport.disable': (p) => Methods.passport.disable(p),
                // public: external user authenticates (device token) → minted restricted session
                'user.passport.verify': (p) => Methods.passport.verify(p),
                // public self-service issuance (spec-passport-self-issuance.md §4): OTP proves
                // anchor ownership → device token; issuance gated by config.passport (fail-closed).
                'user.passport.otp.request': (p) => Methods.passport.otpRequest(p),
                'user.passport.otp.verify':  (p) => Methods.passport.otpVerify(p),
                // identity-line convergence (spec-passport-identity-line): device-anchor TOFU
                // issuance (no OTP) + upgrade (device → email/phone, carry identity).
                'user.passport.device.issue': (p) => Methods.passport.deviceIssue(p),
                'user.passport.upgrade':      (p) => Methods.passport.upgrade(p),

                // ── Signing keys (VERSION.md §3.2) — approval sign-off ──────────────
                // generate/sign are STRICTLY self-only (sign as yourself, with your own
                // password) — an admin can NEVER sign for you, or non-repudiation is void.
                // getPublic/status are readable (public key is public); revoke is admin
                // (forgot-password recovery → user re-generates with a new password).
                'user.key.generate':  (p) => Methods.key.generate(p, { actor: req.user, isAdmin }),
                'user.key.sign':      (p) => Methods.key.sign(p, { actor: req.user, isAdmin }),
                'user.key.public': (p) => Methods.key.getPublic(p),
                'user.key.status':    (p) => Methods.key.status(p, { actor: req.user }),
                'user.key.revoke':    (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.key.revoke(p);
                },

                'ping': () => ({
                    status: 'ok',
                    service: config.serviceName,
                    version: config.version,
                    uptime: STARTUP_TIME
                }),
                'methods': () => ({ methods: introspectionMethods, description: config.description || {} }),
                'entities': () => require('./handlers/entities'),
                'events':   () => require('./handlers/events'),
            };

            let result;

            if (handlers[method]) {
                result = await handlers[method](params);
            } else if (method.startsWith('user.category.')) {
                const catHandlers = {
                    'user.category.create': (p) => Methods.category.create(p),
                    'user.category.update': (p) => Methods.category.update(p),
                    'user.category.delete': (p) => Methods.category.delete(p),
                    'user.category.list': (p) => Methods.category.list(p),
                    'user.category.get': (p) => Methods.category.get(p),
                    'user.category.item.add': (p) => Methods.category.addItem(p),
                    'user.category.item.get': (p) => Methods.category.getItem(p),
                    'user.category.item.update': (p) => Methods.category.updateItem(p),
                    'user.category.item.remove': (p) => Methods.category.removeItem(p)
                };
                if (catHandlers[method]) {
                    result = await catHandlers[method](params);
                }
            }

            if (result === undefined) {
                return jsonrpc.error(res, jsonrpc.METHOD_NOT_FOUND(method), id, 404);
            }

            jsonrpc.success(res, result, id);
        } catch (err) {
            // Auto-reported to Redis via logger
            logger.error(`Error processing ${method}:`, err, { request: params });

            jsonrpc.error(res, err.code ? err : jsonrpc.INTERNAL_ERROR(err.message), id);
        }
    });
});

