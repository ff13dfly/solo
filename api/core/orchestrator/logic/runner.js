const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

const jsonLogic = require('json-logic-js');

const jsonrpc = require('../handlers/jsonrpc');
const config = require('../config');
const { coversAll, missingMethods } = require('../../../library/permit');
const { checkParams } = require('../../../library/validate');
const { NeedsGrantError } = require('./NeedsGrantError');
const { createLogger } = require('../../../library/logger');

const logger = createLogger('orchestrator-runner');

function msgId() {
    return crypto.randomBytes(8).toString('hex');
}

/**
 * Workflow Runner
 * @why Decouples the execution engine from the HTTP framework, allowing it to 
 *      be tested or run in different contexts.
 * @attention All external calls are routed through the central Router.
 */
module.exports = (redis, { serviceName, routerUrl, traceAudit }) => ({
    // --- CORE EXECUTION ENGINE ---
    /**
     * Execute a workflow
     * 
     * @why Powers the multi-step automation logic. It handles the orchestration 
     *      between different microservices (e.g., fetch data from 'user', then send 'gateway' email).
     * @attention 
     *   1. VARIABLE RESOLUTION: $ variables are resolved JUST-IN-TIME before each step execution.
     *   2. PRE-EXECUTION RESOLVERS: Handles mapping of human names to internal IDs 
     *      (e.g., "Bedroom" -> "room_123") before starting the actual steps.
     *   3. ATOMICITY: Workflows are NOT atomic. If step 3 fails, steps 1 and 2 are 
     *      NOT rolled back. Use 'ignore_error' for non-critical steps.
     *   4. RETRY: Implements exponential backoff for network-related failures.
     * @side_effects Modifies the shared context and produces a execution trace in the response.
     */
    async run({ workflowId, input = {}, triggerSource = 'sync', triggerId = null, runId = null, oneTimeGrant = null, onStepCommit = null, actorClaim = null, compensationProgress = null, onCompensationCommit = null }, headers = {}, callerUid = null) {
        if (!workflowId) throw jsonrpc.MISSING_PARAM('workflowId');


        // 1. Load workflow
        const workflow = await redis.json.get(`${config.redis.workflowPrefix}${workflowId}`);
        if (!workflow) throw jsonrpc.NOT_FOUND('Workflow');
        // C2: only ACTIVE workflows may execute — PENDING_REVIEW / REJECTED / DELETED are all blocked
        if (workflow.status !== 'ACTIVE') throw jsonrpc.FORBIDDEN(`Workflow cannot run in status: ${workflow.status}`);

        // §3.1 — high-risk cooling period: a multi-sig-approved workflow cannot run until
        // its effective_at, giving a window to catch a bad/coerced approval before damage.
        if (workflow.effective_at && Date.now() < workflow.effective_at) {
            throw jsonrpc.FORBIDDEN(`Workflow in cooling period until ${new Date(workflow.effective_at).toISOString()}`);
        }

        // 2.0 allowed_triggers gate (event.md §7)
        // A workflow must explicitly declare which trigger sources may run it.
        // The trigger kind is the part before ':' (sync / event / cron / webhook).
        // Default ['sync'] keeps existing sync-only workflows working unchanged.
        // Empty array would block everything — treat as 'sync only' too.
        const triggerKind = String(triggerSource).split(':')[0];
        const allowedTriggers = (Array.isArray(workflow.allowed_triggers) && workflow.allowed_triggers.length > 0)
            ? workflow.allowed_triggers
            : ['sync'];
        if (!allowedTriggers.includes(triggerKind)) {
            throw jsonrpc.FORBIDDEN(`Trigger '${triggerKind}' not allowed for this workflow (allowed: ${allowedTriggers.join(', ')})`);
        }


        // 2. Validate required inputs
        const missingInputs = [];
        for (const reqInput of workflow.required_inputs || []) {
            if (input[reqInput] === undefined) {
                missingInputs.push(reqInput);
            }
        }
        if (missingInputs.length > 0) {
            throw jsonrpc.INVALID_PARAMS(`Missing required inputs: ${missingInputs.join(', ')}`);
        }

        // 2.1 input_schema enforcement (toFix §6.3) — fail-closed, BEFORE the footprint
        // pre-check. Event-triggered runs feed untyped external payloads (ingress
        // webhooks) straight into $input; a static, human-vetted workflow is only as
        // safe as what reaches its step params. Flat dialect shared with the Router
        // perimeter validator: [{ name, required?, type?, pattern?, minLength?, maxLength? }].
        // required_inputs (above) stays for legacy workflows that declare no schema.
        if (Array.isArray(workflow.input_schema) && workflow.input_schema.length > 0) {
            const schemaErrors = checkParams(workflow.input_schema, input);
            if (schemaErrors.length > 0) {
                throw jsonrpc.INVALID_PARAMS(`input_schema violation: ${schemaErrors.join('; ')}`);
            }
        }


        // 2.5 Footprint pre-check (AUDIT H6)
        // Router's checkAccess only verified "can the caller invoke workflow.run".
        // It cannot see inside the workflow — so a caller could borrow the
        // orchestrator to invoke methods they have no direct permit for.
        // We fetch the full permit here (Router only forwards a compressed
        // 'admin'|'user' string, not the services map) and verify the caller's
        // permit covers EVERY method in the workflow's footprint before any step
        // executes. Fail-fast: if one method is missing, 403 with the list.
        // Skipped when callerUid is absent (Router already blocked unauthenticated).
        // Footprint = all method names this workflow can invoke: steps + resolvers
        // (all branches, richer is safer). Shared by H6 below and the actor
        // pre-check (2.6) — pure computation, no I/O.
        const footprint = [
            ...(workflow.steps || []).map(s => s.method),
            ...Object.values(workflow.resolvers || {}).map(r => r.method),
        ].filter(m => typeof m === 'string' && m.length > 0);

        if (callerUid) {
            const rpcUrl = routerUrl || process.env.ROUTER_URL;
            if (!rpcUrl) throw jsonrpc.INTERNAL_ERROR('ROUTER_URL not configured');

            if (footprint.length > 0) {
                const permitRes = await makeRpcCall(rpcUrl, 'user.permit.get', { uid: callerUid }, headers);
                if (permitRes.error) {
                    throw jsonrpc.INTERNAL_ERROR(`Footprint pre-check: failed to fetch permit — ${permitRes.error.message}`);
                }
                // user.permit.get returns { uid, permit }; unwrap to the bare permit
                // object that missingMethods/hasPermit expect ({ allow_all, services }).
                // Fall back to the raw result for callers/mocks that already return bare.
                const callerPermit = permitRes.result?.permit || permitRes.result;
                // Subtract methods covered by the one-shot grant (event.md §9 — resume path).
                let uncovered = missingMethods(callerPermit, footprint);
                if (oneTimeGrant && Array.isArray(oneTimeGrant.methods)) {
                    uncovered = uncovered.filter(m => !oneTimeGrant.methods.includes(m));
                }
                if (uncovered.length > 0) {
                    // D7: throw typed signal — callers decide sync→403 or async→pause.
                    throw new NeedsGrantError(uncovered);
                }
            }
        }

        // 2.6 Actor-claim pre-check (governance.md §4 / AUDIT C4 — minimal tier).
        // H6 above checked the EXECUTING identity's permit — on the async path that
        // is the shared service bot, whose wide permit passes trivially. It never
        // asked whether the principal that CAUSED the triggering event could do any
        // of this itself (confused deputy: whoever can emit into a subscribed
        // stream borrows the bot's authority). A workflow that opts in with
        // require_actor_permit:true additionally demands that the trigger actor's
        // OWN permit covers the full footprint. Fail-closed: a missing actor claim
        // or a non-resolvable provenance label ('sentinel:{id}', 'cron:{id}',
        // 'anonymous' — no permit exists for those) is rejected, not waived.
        // Deliberately a plain FORBIDDEN, never NeedsGrantError: an operator grant
        // covers the bot's permit gap, it must not launder the actor's.
        // Sync runs skip this — there the caller IS the actor and H6 already
        // checked exactly that permit. Default (flag absent) = advisory tier: the
        // claim is threaded + audited on the run entity, nothing is enforced.
        if (workflow.require_actor_permit === true && triggerKind !== 'sync' && footprint.length > 0) {
            const rpcUrl = routerUrl || process.env.ROUTER_URL;
            if (!rpcUrl) throw jsonrpc.INTERNAL_ERROR('ROUTER_URL not configured');

            const actor = actorClaim && typeof actorClaim.actor === 'string' ? actorClaim.actor : null;
            if (!actor) {
                throw jsonrpc.FORBIDDEN('require_actor_permit: trigger carries no actor claim');
            }
            if (actor.includes(':') || actor === 'anonymous') {
                throw jsonrpc.FORBIDDEN(`require_actor_permit: actor '${actor}' is not a resolvable identity (needs a user/bot uid)`);
            }

            const actorRes = await makeRpcCall(rpcUrl, 'user.permit.get', { uid: actor }, headers);
            if (actorRes.error) {
                // Transient downstream fault → retryable; anything else (USER_NOT_FOUND,
                // malformed uid) is a permanent policy rejection.
                if (actorRes.error.code === -32603) {
                    throw jsonrpc.INTERNAL_ERROR(`Actor pre-check: failed to fetch permit — ${actorRes.error.message}`);
                }
                throw jsonrpc.FORBIDDEN(`require_actor_permit: cannot resolve actor '${actor}' — ${actorRes.error.message}`);
            }
            const actorPermit = actorRes.result?.permit || actorRes.result;
            const actorMissing = missingMethods(actorPermit, footprint);
            if (actorMissing.length > 0) {
                throw jsonrpc.FORBIDDEN(`require_actor_permit: actor '${actor}' lacks footprint methods: ${actorMissing.join(', ')}`);
            }
        }


        // 3. Initialize context
        // NOTE: process.env is intentionally excluded — $env variables in workflow
        // params would otherwise leak server secrets (REDIS_URL, API keys, etc.)
        // $context.* exposes trigger provenance (read-only, for log/payload
        // composition only — NEVER an authorization input). See event.md §6 vars.
        const context = {
            input: { ...input },
            config: { ...workflow.defaults, ...input },
            step: {},
            context: {
                actor: callerUid || null,
                // Trigger provenance (actor-claim thread): who CAUSED the triggering
                // event — distinct from `actor` above (who EXECUTES: the caller/bot).
                // Read-only, for log/payload composition — NEVER an authorization input.
                trigger_actor: (actorClaim && actorClaim.actor) || null,
                trigger_source: triggerSource,
                trigger_id: triggerId,
            },
        };

        // Pre-initialize step structure in context for variables
        for (const step of workflow.steps) {
            context.step[step.id] = { params: { ...step.params }, result: null };
        }

        // 3.5 Resolve pre-execution resolvers (mapping names to IDs, etc.)
        if (workflow.resolvers && Object.keys(workflow.resolvers).length > 0) {
            logger.info(`Resolving ${Object.keys(workflow.resolvers).length} pre-execution resolvers...`);
            for (const [key, resolver] of Object.entries(workflow.resolvers)) {
                logger.info(`Resolver "${key}": method=${resolver.method}, source=${resolver.source}`);
                try {
                    // Resolve params for the resolver method call
                    const paramsToResolve = resolver.method_params || resolver.params;
                    logger.info(`Resolver "${key}" raw params:`, JSON.stringify(paramsToResolve));

                    const resolvedParams = resolveVariables(paramsToResolve, context);
                    logger.info(`Resolver "${key}" resolved params:`, JSON.stringify(resolvedParams));

                    const actualRpcUrl = routerUrl || process.env.ROUTER_URL;
                    if (!actualRpcUrl) throw jsonrpc.INTERNAL_ERROR('ROUTER_URL not configured');

                    const res = await makeRpcCall(actualRpcUrl, resolver.method, resolvedParams, headers);
                    if (res.error) {
                        logger.warn(`Resolver ${key} failed:`, res.error.message);
                        continue;
                    }

                    // Extract value from result path (e.g., "[0].id")
                    const value = extractPath(res.result, resolver.extract);
                    if (value !== undefined) {
                        // Map to the target source path
                        const targetPath = resolver.source.substring(1); // Remove leading $
                        setPath(context, targetPath, value);
                        logger.info(`Resolver ${key} resolved to:`, value);

                        // SYNC: If target is step.ID.params.VAR, also update input.VAR
                        const parts = targetPath.split('.');
                        if (parts[0] === 'step' && parts.length >= 4 && parts[2] === 'params') {
                            const varName = parts[parts.length - 1];
                            context.input[varName] = value;
                            logger.info(`SYNC: Updated context.input.${varName} to:`, value);
                        }
                    }
                } catch (e) {
                    logger.warn(`Resolver ${key} error:`, e.message);
                }
            }
        }

        // 4. Execute steps
        const trace = [];
        const rpcUrl = routerUrl || process.env.ROUTER_URL;
        if (!rpcUrl) throw jsonrpc.INTERNAL_ERROR('ROUTER_URL not configured');

        // Idempotency anchor for this run (toFix §6.2 / event.md at-least-once). The engine
        // is at-least-once: an in-step retry (the retry loop below re-sends the same call) or
        // a re-delivered event must reuse the SAME key per step so an idempotency-aware
        // downstream dedups instead of double-committing. This was documented (README step
        // field `idempotency_key`) but never actually forwarded — wiring it here closes the
        // live double-execution hole. Async triggers carry a stable trigger_id (also stable
        // across event re-delivery); a sync run with no trigger_id gets a per-invocation
        // anchor, so only in-step retries within one run() dedup — a fresh caller retry is a
        // new logical run (callers wanting cross-call safety pass a stable triggerId).
        const runKey = `wf:${workflowId}:${triggerId || msgId()}`;

        // Steps that are some other step's `compensate` target are COMPENSATION-ONLY: they
        // must not run in the forward pass (they'd undo a step that just succeeded). They run
        // only on failure, in reverse order (§7). They stay in the footprint/digest (real steps).
        const compensationTargets = new Set((workflow.steps || []).map((s) => s && s.compensate).filter(Boolean));

        for (const step of workflow.steps) {
            if (compensationTargets.has(step.id)) continue;   // compensation-only — runs on failure, not forward

            const stepTrace = {
                id: step.id,
                service: step.service,
                method: step.method,
                startedAt: Date.now(),
                status: 'pending'
            };

            try {
                // Check condition
                if (step.condition) {
                    const conditionMet = evaluateCondition(step.condition, context);
                    if (!conditionMet) {
                        stepTrace.status = 'skipped';
                        stepTrace.reason = 'condition not met';
                        stepTrace.endedAt = Date.now();
                        trace.push(stepTrace);
                        continue;
                    }
                }

                // Resolve params, stamp the stable idempotency key, and invoke with retry.
                // Extracted into executeCall so Saga compensation runs through the exact same
                // path (idempotency + retry/backoff). Throws the last error if all attempts fail.
                const { result, resolvedParams } = await executeCall(step, context, { rpcUrl, headers, runKey });
                stepTrace.params = resolvedParams;
                stepTrace.idempotency_key = resolvedParams ? resolvedParams.idempotency_key : undefined;

                // result_schema check (toFix §6.3③) — warning tier by default so a
                // drifting downstream doesn't kill an already-live workflow; a workflow
                // that opts in with strict_result:true escalates violations to step
                // failure (caught by the outer failure path like any step error).
                if (Array.isArray(step.result_schema) && step.result_schema.length > 0) {
                    const violations = checkParams(step.result_schema, result.result);
                    if (violations.length > 0) {
                        stepTrace.result_schema_violations = violations;
                        if (workflow.strict_result) {
                            throw jsonrpc.INTERNAL_ERROR(`result_schema violation at step '${step.id}': ${violations.join('; ')}`);
                        }
                        logger.warn(`result_schema violation (warning) at step ${step.id}:`, violations.join('; '));
                    }
                }

                // Store result in context
                context.step[step.id] = { result: result.result };
                stepTrace.result = result.result;
                stepTrace.status = 'success';

                // Lightweight checkpoint (async runs only — sync passes no callback). Records the
                // committed step so a STALLED run's alert lists progress, AND resets the run's
                // stall timer so a long, legitimately-progressing run isn't false-flagged.
                // Best-effort + isolated: a checkpoint failure must never fail an already-committed step.
                if (onStepCommit) { try { await onStepCommit(step.id); } catch (_) { /* best-effort */ } }

            } catch (e) {
                stepTrace.error = e.message;
                stepTrace.status = 'failed';

                if (!step.ignore_error) {
                    stepTrace.endedAt = Date.now();
                    trace.push(stepTrace);

                    // cleanup_manifest (toFix §6.1③ — compensation, disclosure tier):
                    // committed side-effects of the steps that DID succeed, plus their
                    // declared (but NOT auto-executed) compensate hints. The worker
                    // persists this on the run entity and ships it in the ops alert so
                    // a human can clean up from a list instead of forensics.
                    const cleanupManifest = buildCleanupManifest(trace, workflow.steps);

                    // Saga compensation (README §7): undo the COMMITTED steps in REVERSE order
                    // by running each one's declared `compensate` step. A compensation that
                    // itself fails marks the run compensation_failed and emits
                    // EVENT:WORKFLOW:DEAD_LETTER — never silently swallowed (§7.2). Compensate
                    // steps go through executeCall, so they carry a stable idempotency key and
                    // a re-drive dedups instead of double-undoing.
                    // Durability (v1-implementation-plan.md P2, 2026-07-03): compensationProgress
                    // (loaded from the run doc by worker.js, absent on the sync path) is this
                    // run's cursor from a PRIOR round — already-'success' entries are skipped, not
                    // re-executed, and a step whose attempt count is at config.worker.
                    // compensationMaxAttempts stops being retried (status 'exhausted') instead of
                    // looping forever across restarts. onCompensationCommit persists each attempt
                    // (before AND after executing) so a crash mid-compensation still leaves the
                    // cursor + attempt count intact for the next round.
                    const compensation = await runCompensations(trace, workflow, context, { rpcUrl, headers, runKey, compensationProgress, onCompensationCommit });

                    const result = {
                        workflowId,
                        workflowVersion: workflow.version || null,
                        status: 'failed',
                        failedStep: step.id,
                        error: e.message,
                        cleanup_manifest: cleanupManifest,
                        compensation,                            // { ran, failed, entries:[...] }
                        compensation_failed: compensation.failed,
                        trace
                    };

                    if (compensation.failed) {
                        redis.xAdd('EVENT:WORKFLOW:DEAD_LETTER', '*', {
                            type:       'workflow.compensation.failed',
                            source:     'orchestrator',
                            actor:      (triggerSource && triggerSource !== 'sync') ? triggerSource : (callerUid || 'system'),
                            trace_id:   msgId(),
                            event_id:   msgId(),
                            emitted_at: String(Date.now()),
                            payload:    JSON.stringify({ workflow_id: workflowId, failed_step: step.id, compensations: compensation.entries.length, compensation_failures: compensation.entries.filter((c) => c.status === 'failed').length }),
                        }).catch(err => logger.warn('XADD EVENT:WORKFLOW:DEAD_LETTER failed:', err.message));
                    }

                    redis.xAdd('EVENT:WORKFLOW:STATUS', '*', {
                        type:       'workflow.run.failed',
                        source:     'orchestrator',
                        actor:      (triggerSource && triggerSource !== 'sync') ? triggerSource : (callerUid || 'system'),
                        trace_id:   msgId(),
                        event_id:   msgId(),
                        emitted_at: String(Date.now()),
                        payload:    JSON.stringify({ workflow_id: workflowId, status: 'failed', failed_step: step.id, error: e.message, committed_steps: cleanupManifest.length, compensated: compensation.ran, compensation_failed: compensation.failed, compensation_order: compensation.entries.map((c) => c.forStep) }),
                    }).catch(err => logger.warn('XADD EVENT:WORKFLOW:STATUS failed:', err.message));

                    // toFix.md "执行轨迹持久化" — the full step trace never survived past this
                    // return value before (worker.js only kept cleanup_manifest); log it now,
                    // regardless of caller (sync RPC or async worker).
                    if (traceAudit) {
                        traceAudit.append({
                            runId, workflowId, workflowVersion: workflow.version || null, runKey,
                            triggerSource, triggerId, status: result.status, failedStep: result.failedStep,
                            trace: result.trace,
                        });
                    }

                    return result;
                }
            }

            stepTrace.endedAt = Date.now();
            trace.push(stepTrace);
        }

        const result = {
            workflowId,
            workflowVersion: workflow.version || null,
            status: 'completed',
            trace
        };

        redis.xAdd('EVENT:WORKFLOW:RESULT', '*', {
            type:       'workflow.run.completed',
            source:     'orchestrator',
            actor:      (triggerSource && triggerSource !== 'sync') ? triggerSource : (callerUid || 'system'),
            trace_id:   msgId(),
            event_id:   msgId(),
            emitted_at: String(Date.now()),
            payload:    JSON.stringify({ workflow_id: workflowId, status: 'completed' }),
        }).catch(err => logger.warn('XADD EVENT:WORKFLOW:RESULT failed:', err.message));

        if (traceAudit) {
            traceAudit.append({
                runId, workflowId, workflowVersion: workflow.version || null, runKey,
                triggerSource, triggerId, status: result.status, failedStep: null,
                trace: result.trace,
            });
        }

        return result;
    }
});

// --- FAILURE DISCLOSURE ---

/**
 * Build the human cleanup list for a failed run: every step that committed a
 * side-effect (status success), what it called, a bounded result summary, and
 * the step's compensate declaration (informational — never auto-executed here).
 */
function buildCleanupManifest(trace, steps = []) {
    const byId = new Map((steps || []).map(s => [s.id, s]));
    return trace
        .filter(t => t.status === 'success')
        .map(t => ({
            id: t.id,
            method: t.method,
            result_summary: summarizeForManifest(t.result),
            compensate: (byId.get(t.id) || {}).compensate || null,
        }));
}

/** Bounded JSON preview — manifests live on run entities and in notifications, keep them small. */
function summarizeForManifest(value, maxLen = 256) {
    if (value === undefined || value === null) return null;
    let s;
    try { s = JSON.stringify(value); } catch (_) { s = String(value); }
    return s.length > maxLen ? s.slice(0, maxLen) + `…(+${s.length - maxLen})` : s;
}

// --- VARIABLE RESOLUTION SYSTEM ---

/**
 * Resolve $-prefixed variables in params object
 * @why Enables dynamic parameter injection based on previous steps or user input.
 */
function resolveVariables(params, context) {
    if (params === null || params === undefined) return params;
    
    if (typeof params === 'string') {
        // Check for $ variable
        if (params.startsWith('$')) {
            return resolveVariable(params, context);
        }
        return params;
    }
    
    if (Array.isArray(params)) {
        return params.map(item => resolveVariables(item, context));
    }
    
    if (typeof params === 'object') {
        const resolved = {};
        for (const [key, value] of Object.entries(params)) {
            const resolvedValue = resolveVariables(value, context);
            // PRUNE_UNDEFINED: Only add key if value is not undefined
            if (resolvedValue !== undefined) {
                resolved[key] = resolvedValue;
            }
        }
        return resolved;
    }
    
    return params;
}

/**
 * Resolve a single $ variable
 * @path Supports: $input.x, $config.x, $step.stepId.result.x, $context.actor, $context.trigger_id
 * @note $context.* is read-only provenance for log/payload composition — must NOT
 *       be used as an authorization input (see event.md §6 / README §6 variable table).
 */
function resolveVariable(variable, context) {
    const path = variable.substring(1).split('.');
    const source = path[0];

    if (!['input', 'config', 'step', 'context'].includes(source)) {
        // Fallback for direct property access if source is not one of the main ones
        return undefined;
    }
    
    let value = context[source];
    for (let i = 1; i < path.length && value !== undefined; i++) {
        value = value[path[i]];
    }

    return value;
}

/**
 * Interpolate $-tokens embedded in a string against the context. Unlike resolveVariables
 * (which only resolves a WHOLE string that starts with "$"), this also handles templates
 * like "comp-$context.trigger_id-rollback" (the README §7 idempotency_key form). Scoped to
 * the four valid sources so a stray "$" elsewhere is left alone; unresolved tokens stay
 * literal. Used only for idempotency_key, so general param-resolution semantics are unchanged.
 */
function interpolate(template, context) {
    if (typeof template !== 'string' || template.indexOf('$') === -1) return template;
    return template.replace(/\$(?:input|config|step|context)[\w.]*/g, (tok) => {
        const v = resolveVariable(tok, context);
        return (v === undefined || v === null) ? tok : String(v);
    });
}

/**
 * Resolve a step's params, stamp a stable idempotency key, and invoke it via the Router with
 * in-step retry/backoff. Shared by the forward pass AND Saga compensation so both behave
 * identically. The idempotency key (default `${runKey}:${step.id}`, or the author's
 * step.idempotency_key / an explicit params key) is the SAME across every retry attempt — so
 * a dedup-aware downstream never double-commits. Returns { result, resolvedParams } or throws.
 */
async function executeCall(step, context, { rpcUrl, headers, runKey }) {
    const resolvedParams = resolveVariables(step.params, context);
    if (resolvedParams && typeof resolvedParams === 'object' && !Array.isArray(resolvedParams)
        && resolvedParams.idempotency_key === undefined) {
        resolvedParams.idempotency_key = step.idempotency_key
            ? interpolate(String(step.idempotency_key), context)
            : `${runKey}:${step.id}`;
    }

    const maxRetries = step.retry || 0;
    let lastError = null;
    let result = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const fullMethod = step.method.startsWith(step.service + '.') ? step.method : `${step.service}.${step.method}`;
            result = await makeRpcCall(rpcUrl, fullMethod, resolvedParams, headers);
            if (result.error) throw jsonrpc.INTERNAL_ERROR(result.error.message || 'Step failed');
            lastError = null;
            break;
        } catch (e) {
            lastError = e;
            if (attempt < maxRetries) await sleep(100 * (attempt + 1));
        }
    }
    if (lastError) throw lastError;
    return { result, resolvedParams };
}

/**
 * Saga compensation (README §7). For each COMMITTED step (status 'success') that declares a
 * `compensate` step-id, run that compensation step — in REVERSE execution order. Compensate
 * steps are real steps (full machinery + the stable idempotency key from executeCall), so a
 * re-drive dedups rather than double-undoing. Per-compensation outcomes are collected; if ANY
 * fails (or is exhausted, see below), `failed` is true so the caller dead-letters. Each
 * compensation's result is written back to context so a later compensation can reference it.
 *
 * Durability (v1-implementation-plan.md P2, 2026-07-03): `opts.compensationProgress` is this
 * run's cursor from a PRIOR round (null on the sync path, or an async run's first round — both
 * behave exactly as before this feature existed). Three cases per compensation target:
 *   - already 'success' in a prior round  → SKIP re-executing (resume-from-cursor), just re-list it.
 *   - already 'exhausted' in a prior round → STICKY: still don't retry, still counts as failed.
 *   - attempt count (persisted, NOT reset by a restart) at the configured cap → mark 'exhausted'
 *     now instead of attempting — a compensation whose failure is a genuine bug, not a transient
 *     fault, must stop being retried, or an operator/automation blindly re-driving STALLED runs
 *     turns "reboot → fail → reboot → fail" into a silent, resource-burning loop.
 *   - otherwise → fresh attempt. `opts.onCompensationCommit` (worker.js wires this to
 *     run.compensationCheckpoint) is called BEFORE executing (status:'attempting', so a crash
 *     mid-call still leaves the attempt counted) and again after with the final status.
 */
async function runCompensations(trace, workflow, context, opts) {
    const { compensationProgress = null, onCompensationCommit = null } = opts;
    const maxAttempts = config.worker.compensationMaxAttempts;
    const byId = new Map((workflow.steps || []).map((s) => [s.id, s]));
    const committed = trace.filter((t) => t.status === 'success' && byId.get(t.id) && byId.get(t.id).compensate);
    const entries = [];
    let failed = false;

    async function commit(payload) {
        if (!onCompensationCommit) return;
        try { await onCompensationCommit(payload); } catch (_) { /* best-effort, mirrors onStepCommit */ }
    }

    for (let i = committed.length - 1; i >= 0; i--) {
        const forStepId = committed[i].id;
        const compId = byId.get(forStepId).compensate;
        const compStep = byId.get(compId);
        const prior = compensationProgress && compensationProgress[forStepId];
        const priorAttempts = (prior && prior.attempts) || 0;
        const method = compStep ? compStep.method : null;

        if (prior && prior.status === 'success') {
            entries.push({ forStep: forStepId, compensate: compId, method, status: 'success', attempts: priorAttempts, skipped: true });
            continue;
        }
        if ((prior && prior.status === 'exhausted') || priorAttempts >= maxAttempts) {
            const entry = { forStep: forStepId, compensate: compId, method, status: 'exhausted', attempts: priorAttempts, endedAt: Date.now() };
            entries.push(entry);
            failed = true;
            if (!prior || prior.status !== 'exhausted') await commit({ forStep: forStepId, compensate: compId, status: 'exhausted', attempts: priorAttempts });
            continue;
        }

        const attempt = priorAttempts + 1;
        const entry = { forStep: forStepId, compensate: compId, method, startedAt: Date.now(), attempts: attempt };
        if (!compStep) {
            entry.status = 'failed';
            entry.error = `compensate step '${compId}' not found`;
            failed = true;
        } else {
            await commit({ forStep: forStepId, compensate: compId, status: 'attempting', attempts: attempt });
            try {
                const { result, resolvedParams } = await executeCall(compStep, context, opts);
                entry.params = resolvedParams;
                entry.idempotency_key = resolvedParams ? resolvedParams.idempotency_key : undefined;
                entry.result = result.result;
                entry.status = 'success';
                context.step[compStep.id] = { result: result.result };
            } catch (e) {
                entry.status = 'failed';
                entry.error = e.message;
                failed = true;
            }
        }
        entry.endedAt = Date.now();
        entries.push(entry);
        await commit({ forStep: forStepId, compensate: compId, status: entry.status, attempts: attempt, error: entry.error });
    }
    return { ran: entries.length > 0, failed, entries };
}

// --- CONDITION EVALUATION ---

/**
 * Evaluate a step condition using JsonLogic.
 * @why JsonLogic is a sandboxed, data-driven rule format — no eval, no new Function,
 *      no code injection surface. Aligns with fulfillment's rule engine.
 *
 * condition must be a JsonLogic object, e.g. {"===": [{"var": "step.s1.result.tier"}, "gold"]}.
 * Variables resolve against the execution context ({input, step, config, context}).
 * String conditions are rejected — they cannot be safely evaluated.
 */
function evaluateCondition(condition, context) {
    if (condition === undefined || condition === null) return true;
    if (typeof condition !== 'object' || Array.isArray(condition)) {
        logger.warn('Condition rejected — must be a JsonLogic object, got:', typeof condition);
        return false;
    }
    try {
        return !!jsonLogic.apply(condition, context);
    } catch (e) {
        logger.warn('Condition evaluation failed:', e.message);
        return false;
    }
}

// --- NETWORK & COMMUNICATION ---

/**
 * Make JSON-RPC call to a service via Router
 * @why Standardizes inter-service communication through the project's Level 3 Router.
 */
function makeRpcCall(urlStr, method, params, sourceHeaders = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const client = url.protocol === 'https:' ? https : http;
        
        const headers = {
            'Content-Type': 'application/json',
        };

        // Passthrough Authorization
        if (sourceHeaders['authorization']) {
            headers['authorization'] = sourceHeaders['authorization'];
        }
        if (sourceHeaders['x-admin-token']) {
            headers['x-admin-token'] = sourceHeaders['x-admin-token'];
        }
        // Passthrough chain correlation (worker sets these from the triggering event)
        if (sourceHeaders['x-trace-id']) {
            headers['x-trace-id'] = sourceHeaders['x-trace-id'];
            headers['x-trace-depth'] = sourceHeaders['x-trace-depth'] || '0';
        }
        
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + (url.search || ''),
            method: 'POST',
            headers
        };

        const req = client.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk); // SAFE: small
            res.on('end', () => { // SAFE: small

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`RPC_HTTP_ERROR_${res.statusCode}: ${data}`));
                }
                
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('INVALID_JSON_RESPONSE'));
                }
            });
        });
        
        req.on('error', (e) => reject(e)); // SAFE: small

        
        req.write(JSON.stringify({
            jsonrpc: '2.0',
            method,
            params,
            id: Date.now()
        }));
        
        req.end();
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- UTILS & HELPERS ---

/**
 * Extract value from nested object using a path string like "data.items[0].id"
 */
function extractPath(obj, path) {
    if (!path || !obj) return obj;
    try {
        // Handle bracket notation like [0] by converting to .0
        const normalizedPath = path.replace(/\[(\w+)\]/g, '.$1').replace(/^\./, '');
        const parts = normalizedPath.split('.');
        let current = obj;
        for (const part of parts) {
            if (current === null || current === undefined) return undefined;
            current = current[part];
        }
        return current;
    } catch (e) {
        return undefined;
    }
}

/**
 * Set value in nested object using a path string like "step.id.params.x"
 */
function setPath(obj, path, value) {
    if (!path) return;
    const parts = path.split('.');
    
    // Special handling for $step.ID.params.VAR to also update $input.VAR
    // This is because UI often maps input.VAR to step.params.VAR
    if (parts[0] === 'step' && parts.length >= 4 && parts[2] === 'params') {
        const varName = parts[parts.length - 1];
        if (obj.input) {
            obj.input[varName] = value;
            logger.info(`Also updated context.input.${varName} to:`, value);
        }
    }

    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (current[part] === undefined || current[part] === null || typeof current[part] !== 'object') {
            current[part] = {};
        }
        current = current[part];
    }
    current[parts[parts.length - 1]] = value;
}
