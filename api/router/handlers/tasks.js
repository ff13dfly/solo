const axios = require('axios');
const tweetnacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const config = require('../config');

// --- BACKGROUND TASK PROCESSING ---

let CACHED_WHITELIST = null;
let LAST_FETCH = 0;
const CACHE_TTL = 60000; // 60 seconds

/**
 * Validates and retrieves the task whitelist, prioritizing Redis source of truth.
 */
async function getWhitelist(redisClient) {
    const now = Date.now();
    // Use cache if fresh
    if (CACHED_WHITELIST && (now - LAST_FETCH < CACHE_TTL)) {
        return CACHED_WHITELIST;
    }

    // Try fetch from Redis
    if (redisClient && redisClient.isOpen) {
        try {
            const data = await redisClient.get(config.redis.taskWhitelistKey);
            if (data) {
                CACHED_WHITELIST = JSON.parse(data);
                LAST_FETCH = now;
                return CACHED_WHITELIST;
            }
        } catch (e) {
            console.warn('[Tasks] Failed to fetch whitelist from Redis, falling back to config/cache:', e.message);
        }
    }

    // Fallback: Use config or existing cache (stale)
    if (!CACHED_WHITELIST) {
        CACHED_WHITELIST = config.taskWhitelist || {};
    }
    return CACHED_WHITELIST;
}

const validator = require('./validator');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * POSTs one internal task RPC with bounded retry + exponential backoff. Only after
 * exhausting attempts does it persist to ERROR:QUEUE:router — already a real,
 * admin-queryable/clearable queue (administrator's error.list/listAll/clear), not a
 * new mechanism. Replaces the prior single-shot non-awaited axios.post, which could
 * silently drop a task (no retry, no trace at all if the process exited before the
 * in-flight request settled).
 */
async function postWithRetry(url, rpcBody, headers, redisClient, targetService, method) {
    const { maxAttempts, retryBaseMs } = config.tasks;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await axios.post(url, rpcBody, { headers, timeout: 5000 });
            return;
        } catch (e) {
            lastErr = e;
            console.error(`[Tasks] Execution failed for ${targetService}.${method} (attempt ${attempt}/${maxAttempts}):`, e.message);
            if (attempt < maxAttempts) await sleep(retryBaseMs * (2 ** (attempt - 1)));
        }
    }

    if (redisClient && redisClient.isOpen) {
        const errorLog = {
            code: 'TASK_ERROR',
            service: targetService,
            method,
            error: lastErr.message,
            attempts: maxAttempts,
            stamp: new Date().toISOString()
        };
        await redisClient.rPush(`${config.redis.errorQueuePrefix}router`, JSON.stringify(errorLog));
    }
}

/**
 * Executes a list of background tasks. Each task is dispatched concurrently and
 * independently (one task's retries never block another's), but this function's own
 * returned promise only resolves once every task has either succeeded or exhausted
 * its retries — see @attention 4.
 *
 * @param {Array} tasks - Array of { service, method, params } objects.
 * @param {string} username - Contextual user to associate with the task.
 * @param {boolean} isAdmin - Admin flag for the signer payload.
 * @param {object} SERVICES - Service registry for URL lookups.
 * @param {object} keypair - Router's identity for Level 3 signing.
 * @param {object} redisClient - For error persistence.
 * @param {string} sourceService - The service that originated the task request.
 * @param {object} CAPABILITY_MAP - The global capability map for schema validation.
 *
 * @why Enables downstream services to request side-effects (e.g., sending a push notice)
 *      without making the primary API request wait for those side-effects to complete.
 * @attention
 *   1. ISOLATION: Tasks are executed using an isolated Level 3 auth payload with `context: 'task'`.
 *   2. SECURITY: Strictly enforces whitelist to prevent unauthorized service calls.
 *   3. VALIDATION: Enforces schema validation on internal tasks to prevent chain OOM/logic errors.
 *   4. DELIVERY: Callers (router/index.js) still call this without awaiting it, so the
 *      primary request's response latency is unaffected — this function's internal
 *      await/retry only bounds how long a task keeps trying in the background, it does
 *      not change the overall at-most-once delivery semantics (still no durable queue).
 */
async function processTasks(tasks, username, isAdmin, SERVICES, keypair, redisClient, sourceService, CAPABILITY_MAP, traceCtx = null) {
    if (!tasks || tasks.length === 0) return;

    console.log(`[Tasks] Dispatching ${tasks.length} background operations from ${sourceService}...`);

    async function dispatchOne(task) {
        try {
            const { service: targetService, method, params } = task;

            // --- SECURITY: WHITELIST CHECK ---
            const whitelist = await getWhitelist(redisClient);
            const rule = whitelist[targetService];

            if (!rule) {
                console.warn(`[Security] BLOCKED task: Target '${targetService}' is not in the task whitelist.`);
                return;
            }

            // Check Source Restriction
            const allowedSources = rule.allowFrom || [];
            if (!allowedSources.includes('*') && !allowedSources.includes(sourceService)) {
                console.warn(`[Security] BLOCKED task: Source '${sourceService}' is not allowed to trigger '${targetService}'.`);
                return;
            }

            // Check Method Restriction
            const allowedMethods = rule.allowMethods || [];
            if (!allowedMethods.includes('*') && !allowedMethods.includes(method)) {
                console.warn(`[Security] BLOCKED task: Method '${method}' is not allowed for '${targetService}'.`);
                return;
            }

            // --- RESOLUTION ---
            const targetSvcConfig = SERVICES[targetService];
            if (!targetSvcConfig) {
                console.warn(`[Tasks] Target service not found: ${targetService}`);
                return;
            }

            // --- VALIDATION: Internal Schema Gate ---
            // Even internal tasks must follow the contract to prevent propagation of malformed data.
            if (CAPABILITY_MAP && CAPABILITY_MAP[method]) {
                const methodSchema = CAPABILITY_MAP[method].params;
                const validationError = validator.validateParams(params, methodSchema);
                if (validationError) {
                    console.error(`[Security] BLOCKED task: Parameters for '${method}' failed schema validation:`, validationError.message);

                    if (redisClient && redisClient.isOpen) {
                        await redisClient.rPush(`${config.redis.errorQueuePrefix}router`, JSON.stringify({
                            code: 'TASK_VALIDATION_ERROR',
                            service: targetService,
                            method,
                            error: validationError.message,
                            stamp: new Date().toISOString()
                        }));
                    }
                    return;
                }
            }

            // --- EXECUTION ---
            // Generate "Task Context" Authorization
            const authPayload = {
                iss: 'router',
                iat: Date.now(),
                user: username,
                permit: isAdmin ? 'admin' : 'user',
                context: 'task',
                // Chain correlation: the async task belongs to the request's chain —
                // same trace, same depth (a _task is an RPC hop, not an event hop).
                ...(traceCtx ? { meta: { trace: traceCtx.trace, depth: traceCtx.depth } } : {})
            };

            const payloadStr = JSON.stringify(authPayload);
            const payloadBytes = new TextEncoder().encode(payloadStr);
            const signature = tweetnacl.sign.detached(payloadBytes, keypair.secretKey);

            const headers = {
                'Content-Type': 'application/json',
                'X-Router-Token': bs58.encode(Buffer.from(payloadStr)),
                'X-Router-Signature': bs58.encode(signature)
            };

            const rpcBody = {
                jsonrpc: '2.0',
                method: method,
                params: params,
                id: `task-${Date.now()}`
            };

            await postWithRetry(targetSvcConfig.url, rpcBody, headers, redisClient, targetService, method);

        } catch (e) {
            console.error(`[Tasks] Internal dispatcher error:`, e.message);
        }
    }

    await Promise.all(tasks.map(dispatchOne));
}

/**
 * Invalidate the in-process whitelist cache so the next getWhitelist() re-reads Redis
 * immediately (instead of up to CACHE_TTL later). Called by system.js right after an admin
 * whitelist write. Purely additive: the read path (getWhitelist) is unchanged and the 60s
 * TTL fallback still self-heals if this is never called.
 */
function invalidate() {
    CACHED_WHITELIST = null;
    LAST_FETCH = 0;
}

module.exports = { processTasks, invalidate };
