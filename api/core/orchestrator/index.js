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
const logger_lib = require('../../library/logger');
const { createRelay } = require('../../library/relay');
const { isAdmin: permitIsAdmin } = require('../../library/permit');
const { NeedsGrantError } = require('./logic/NeedsGrantError');
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
app.use(bodyParser.json({ limit: '10mb' }));

/**
 * Request Logger
 * @why Provides visibility into orchestrated workflow requests during development.
 */
app.use((req, res, next) => {
    if (config.debug) {
        logger.debug(`INCOMING: ${req.method} ${req.originalUrl}`);
    }
    next();
});

// --- BOOTSTRAP ---

let redisClient;
let Methods;
let relay;

// --- HEALTH ENDPOINTS — public (mounted BEFORE router-auth so LB/uptime probes need no token) ---
mountHealth(app, {
    serviceName: config.serviceName, version: config.version, getRedis: () => redisClient,
    // toFix §6.5 — run-queue + run-state gauges. FAILED/STALLED counts give an
    // operator "is anything waiting on a human" at a glance (and an alert hook).
    getMetrics: async () => {
        const R = config.redis;
        const [pending, dead] = await Promise.all([
            redisClient.lLen(R.runQueuePending).catch(() => -1),
            redisClient.lLen(R.runQueueDeadletter).catch(() => -1),
        ]);
        const counts = { RUNNING: 0, FAILED: 0, STALLED: 0, PAUSED_AWAITING_HUMAN: 0 };
        try {
            const ids = await redisClient.sMembers(R.runIndex);
            for (const id of ids) {
                const r = await redisClient.json.get(`${R.runPrefix}${id}`).catch(() => null);
                if (r && counts[r.status] !== undefined) counts[r.status]++;
            }
        } catch (_) { /* run gauges degrade to 0 — queue gauges still emitted */ }
        return [
            { name: 'solo_queue_depth', value: pending, help: 'Async run-queue depth', labels: { queue: 'orchestrator_pending' } },
            { name: 'solo_dlq_depth', value: dead, help: 'Dead-letter queue depth', labels: { queue: 'orchestrator_deadletter' } },
            ...Object.entries(counts).map(([status, value]) => (
                { name: 'solo_runs', value, help: 'Workflow runs by status', labels: { status: status.toLowerCase() } }
            )),
        ];
    },
});

/**
 * Middleware: Level 3 Security (Router Auth)
 * @why Protects workflow orchestration from unauthorized access.
 */
app.use(authHandlers.middleware);

/**
 * Service Initialization
 * @process
 *   1. Connect to Redis.
 *   2. Bind Redis for error telemetry.
 *   3. Seed system categories.
 *   4. Start periodic workflow engine ticks.
 */
(async () => {
    try {
        redisClient = await initializeRedis(config.serviceName);
        logger.setRedis(redisClient); // Bind Redis for auto-error reporting

        await ensureDefaultCategories(redisClient, config.serviceName);

        // §7.7 — relay for autonomous (no-caller) workflow execution paths.
        // Current user-triggered flow still propagates the caller's Authorization;
        // relay is the channel for future event/scheduled runs.
        relay = createRelay({
            redis: redisClient,
            serviceName: config.serviceName,
            routerUrl: `${config.routerUrl}/jsonrpc`,
            walLogger: (key, data) => logger_lib.insert(key, data),
        });

        Methods = createLogic(redisClient, {
            serviceName: config.serviceName,
            routerUrl: config.routerUrl,
            relay,
            config, // matcher needs config.consumer
        });

        // One-time backfill of the workflow id index from existing docs (legacy /
        // directly-injected). KEYS here runs ONCE at boot, never on the hot path;
        // the matcher/list now use SMEMBERS on this index instead of KEYS.
        if (Methods.workflow?.rebuildIndex) {
            await Methods.workflow.rebuildIndex()
                .then(n => logger.info(`Workflow index backfilled (${n} docs).`))
                .catch(err => logger.warn('Workflow index backfill failed:', err.message));
        }
        if (Methods.run?.rebuildIndex) {
            await Methods.run.rebuildIndex()
                .then(n => logger.info(`Run index backfilled (${n} docs).`))
                .catch(err => logger.warn('Run index backfill failed:', err.message));
        }


        // Start Server
        app.listen(PORT, () => {
            logger.info(`Service running on port ${PORT}`);

            // event.md §5 — async run-queue worker.
            if (config.worker.enabled && Methods.worker) {
                Methods.worker.start().catch(err =>
                    logger.error('Worker failed to start:', err.message));
            }

            // event.md §6.1 — event matcher consumer (step ④).
            // Reads EVENT:* streams, matches events to workflow event_subscriptions,
            // enqueues run-commands. Disable with ORCH_MATCHER=false.
            if (config.consumer.enabled && Methods.matcher) {
                Methods.matcher.start().catch(err =>
                    logger.error('Matcher failed to start:', err.message));
            }
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
 * @why Implements the JSON-RPC 2.0 protocol for Workflow Orchestration.
 * @attention 
 *   - `orchestrator.run` and `orchestrator.workflow.run` require header-based context extraction.
 *   - Error handling differentiates between normal "Method not found" for entities and critical failures.
 */
const { walContext } = require('../../library/entity');

app.post('/jsonrpc', async (req, res) => {
    if (!Methods) return jsonrpc.error(res, jsonrpc.SERVICE_NOT_READY(), null, 503);

    await walContext.run({ uid: req.user || null, trace: req.meta?.trace || null, depth: req.meta?.depth ?? 0 }, async () => {
        const { jsonrpc: jsonrpc_version, method, params, id } = req.body;
        const isAdmin = permitIsAdmin(req);

        try {
            const handlers = {
                // §7.7 — admin-only token lifecycle for internal-call relay
                'orchestrator.token.set':    async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); await relay.setToken(p); return { ok: true }; },
                'orchestrator.token.status': async () => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return relay.status(); },
                'orchestrator.token.clear':  async () => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); await relay.clear(); return { ok: true }; },

                // Runtime auto↔manual pause (worker + matcher loops). Admin-only.
                'orchestrator.control.pause':  async () => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.control.pause(); },
                'orchestrator.control.resume': async () => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.control.resume(); },
                'orchestrator.control.status': async () => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.control.status(); },

                // §3.4 — pass isAdmin so create() can apply the external submission quota.
                'orchestrator.workflow.create':  (p) => Methods.workflow.create(p, req.user, { isAdmin }),
                'orchestrator.workflow.approve': (p) => Methods.workflow.approve(p, req.user),
                'orchestrator.workflow.deny':    (p) => Methods.workflow.deny(p, req.user),
                'orchestrator.workflow.get': (p) => Methods.workflow.get(p),
                'orchestrator.workflow.list': (p) => Methods.workflow.list(p),
                'orchestrator.workflow.update': (p) => Methods.workflow.update(p),
                'orchestrator.workflow.delete': (p) => Methods.workflow.delete(p),
                'orchestrator.workflow.deprecate': (p) => Methods.workflow.deprecate(p, req.user),
                'orchestrator.workflow.restore': (p) => Methods.workflow.restore(p),
                'orchestrator.workflow.build': (p) => Methods.workflow.build(p),
                // §3.4 — external (non-admin) discovery sees only ACTIVE capabilities, not pending proposals.
                'orchestrator.workflow.snapshot': (p) => Methods.workflow.getSnapshot({ ...p, activeOnly: !isAdmin }),
                'orchestrator.workflow.version': (p) => Methods.workflow.getVersion(p),
                // D5: sync RPC never pauses — NeedsGrantError converts to FORBIDDEN immediately.
                'orchestrator.workflow.run': async (p) => {
                    try { return await Methods.runner.run(p, req.headers, req.user); }
                    catch (err) { if (err instanceof NeedsGrantError) throw jsonrpc.FORBIDDEN(err.message); throw err; }
                },
                'orchestrator.run': async (p) => {
                    try { return await Methods.runner.run(p, req.headers, req.user); }
                    catch (err) { if (err instanceof NeedsGrantError) throw jsonrpc.FORBIDDEN(err.message); throw err; }
                },
                // event.md §5 — enqueue a run-command for async execution (admin).
                'orchestrator.run.enqueue': async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.worker.enqueue(p); },
                // event.md §9 — human-in-the-loop run management (admin only).
                'orchestrator.run.list':  async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.run.list(p); },
                'orchestrator.run.get':   async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.run.get(p && p.id); },
                'orchestrator.run.grant': async (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    const { run: updated } = await Methods.run.grant({
                        id: p && p.id, methods: p && p.methods, grantedBy: req.user,
                    });
                    // Re-enqueue for resume (run.js stays pure; orchestration lives here).
                    // Carries the run's chain correlation + actor-claim forward: the resumed
                    // run must stay on the same trace AND face the same actor pre-check
                    // (a grant covers the BOT's missing methods, never the actor's).
                    await Methods.worker.enqueue({
                        workflowId: updated.workflowId, input: updated.input,
                        triggerSource: updated.triggerSource, triggerId: updated.triggerId,
                        runId: updated.id, attempts: updated.attempts || 0,
                        trace: updated.trace || null, parentEventId: updated.parentEventId || null,
                        actor: updated.actor || null, actorSource: updated.actorSource || null,
                    });
                    return { ok: true, runId: updated.id, status: updated.status };
                },
                'orchestrator.run.abort': async (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    return Methods.run.abort({ id: p && p.id, abortedBy: req.user, reason: p && p.reason });
                },
                // Re-drive a STALLED run (crash recovery). re-runs from the top; the preserved
                // triggerId makes committed steps dedup downstream (idempotency-safe). Admin-only.
                'orchestrator.run.retry': async (p) => {
                    if (!isAdmin) throw jsonrpc.UNAUTHORIZED();
                    const { run: updated, cmd } = await Methods.run.requeue({ id: p && p.id, byUid: req.user });
                    await Methods.worker.enqueue(cmd);   // re-enqueue with the SAME runId + triggerId
                    return { ok: true, runId: updated.id, status: updated.status };
                },
                // toFix.md "执行轨迹持久化" — per-step trace log (file-backed, trace-audit.js).
                'orchestrator.run.trace': async (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.traceAudit.recent(p || {}); },
                'orchestrator.workflow.categories': () => Methods.workflow.categories(),
                'orchestrator.category.create': (p) => Methods.category.create(p),
                'orchestrator.category.get': (p) => Methods.category.get(p),
                'orchestrator.category.list': (p) => Methods.category.list(p),
                'orchestrator.category.update': (p) => Methods.category.update(p),
                'orchestrator.category.delete': (p) => Methods.category.delete(p),
                'orchestrator.category.item.add': (p) => Methods.category.addItem(p),
                'orchestrator.category.item.get': (p) => Methods.category.getItem(p),
                'orchestrator.category.item.update': (p) => Methods.category.updateItem(p),
                'orchestrator.category.item.remove': (p) => Methods.category.removeItem(p),
                'ping': () => ({ 
                    status: 'ok', 
                    service: config.serviceName, 
                    version: config.version, 
                    uptime: STARTUP_TIME 
                }),
                'methods': () => ({ methods: introspectionMethods, description: config.description || {} }),
                'entities': () => require('./handlers/entities'),
                'events':   () => require('./handlers/events'),
                'guide':    () => require('../../library/guide').readGuide('orchestrator', __dirname),
            };

            if (!handlers[method]) {
                return jsonrpc.error(res, jsonrpc.METHOD_NOT_FOUND(method), id, 404);
            }

            const result = await handlers[method](params);
            jsonrpc.success(res, result, id);
        } catch (err) {
            // Downgrade "Method entities not found" to warn (expected for services without entities)
            if (err.message && err.message.includes('Method entities not found')) {
                logger.warn(`Introspection:`, err.message);
            } else {
                logger.error(`Error:`, err.message, { request: params });
            }
            
            jsonrpc.error(res, err.code ? err : jsonrpc.INTERNAL_ERROR(err.message), id);
        }
    });
});

