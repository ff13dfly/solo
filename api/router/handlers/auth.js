const config = require('../config');

// --- SESSION & USER RESOLUTION ---

/**
 * Resolve session user from token.
 * 
 * @param {string} token - Auth token from headers.
 * @param {object} redisClient - Redis client instance.
 * @returns {Promise<object>} Session user with normalized permit.
 * 
 * @why Centralizes session lookup and permission normalization.
 * @attention 
 *   1. SLIDING EXPIRATION: Auto-renews sessions for admin/operator roles to 
 *      maintain active workflows without interruption.
 *   2. PERMIT NORMALIZATION: Ensures permit structure is consistent regardless 
 *      of how it's stored in Redis.
 */
async function resolveSessionUser(token, redisClient) {
    let sessionUser = { username: 'guest', permit: { allow_all: false, services: {} } };

    if (!token || !redisClient || !redisClient.isOpen) {
        return sessionUser;
    }

    const sessionStr = await redisClient.get(`${config.redis.sessionPrefix}${token}`);
    if (!sessionStr) {
        return sessionUser;
    }

    let session;
    try {
        session = JSON.parse(sessionStr);
    } catch (e) {
        console.error('[Auth] Corrupted session JSON from Redis:', e.message);
        return sessionUser;
    }
    sessionUser = session;

    // --- SCHEME F: Dynamic Permission Loading ---
    // Fetch the latest user record to ensure permissions are up-to-date.
    // This fixes the issue where session data becomes stale after a permit update.
    // Bots live under a different key (user:bot:{uid}) — without the second lookup
    // a bot kept its issuance-time permit snapshot until token TTL, i.e. permit
    // changes bit humans instantly but not machines (the higher-risk principal).
    if (sessionUser.uid) {
        try {
            const userStr = await redisClient.get(`user:${sessionUser.uid}`);
            if (userStr) {
                const userData = JSON.parse(userStr);
                if (userData.permit) {
                    sessionUser.permit = userData.permit;
                }
                if (userData.role) {
                    sessionUser.role = userData.role;   // RBAC assigned role (informational)
                }
                // POWER = account tier (admin/operator/normal) — distinct from RBAC role.
                if (userData.categories?.POWER) {
                    sessionUser.power = userData.categories.POWER;
                }
            } else if (sessionUser.uid.startsWith('system.')) {
                const botStr = await redisClient.get(`user:bot:${sessionUser.uid}`);
                if (botStr) {
                    const botData = JSON.parse(botStr);
                    // Suspension bites live sessions immediately: a non-ACTIVE bot
                    // resolves to guest even if its session token is still in Redis.
                    if (botData.status && botData.status !== 'ACTIVE') {
                        console.warn(`[Auth] Bot ${sessionUser.uid} is ${botData.status} — rejecting live session`);
                        return { username: 'guest', permit: { allow_all: false, services: {} } };
                    }
                    if (botData.permit) {
                        sessionUser.permit = botData.permit;
                    }
                }
            }
        } catch (err) {
            console.error('[Auth] Dynamic permit loading failed:', err.message);
        }
    }

    // SLIDING EXPIRATION: Auto-renew admin/operator sessions — keyed off the POWER tier
    // (fallback to legacy top-level role so the bootstrap admin, role:'admin', stays recognized).
    const adminRole = config.roles?.admin || 'admin';
    const operatorRole = config.roles?.operator || 'operator';
    const tier = sessionUser.power || sessionUser.role;

    if (redisClient.isOpen && (tier === adminRole || tier === operatorRole)) {
        // Reset TTL based on session's own policy (or default 30m)
        const ttl = sessionUser.ttl || 1800;
        redisClient.expire(`${config.redis.sessionPrefix}${token}`, ttl)
            .catch(err => console.error('[Auth] Session extend failed:', err.message));
    }

    // Normalize permit structure
    if (!sessionUser.permit) {
        sessionUser.permit = { allow_all: (tier === adminRole), services: {} };
    } else if (typeof sessionUser.permit === 'string') {
        sessionUser.permit = { allow_all: (sessionUser.permit === adminRole), services: {} };
    }

    return sessionUser;
}

/**
 * Extract auth token from request headers.
 * 
 * @param {object} req - Express request object.
 * @returns {string|null} Token string or null.
 * @why Supports both standard Bearer headers and legacy admin headers.
 */
function extractToken(req) {
    return req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-admin-token'] || null;
}

// --- PERMISSION CHECKS ---

/**
 * Determine if the resolved user has administrator privileges.
 */
function isAdmin(sessionUser) {
    return sessionUser?.permit?.allow_all === true;
}

/**
 * True if the request originates from the same host (loopback).
 *
 * @why Internal service→Router calls ride localhost (urlFor → http://localhost:PORT).
 *      Used to authorize internal-coordination methods — federated category
 *      reserve/delete (BACKLOG/toFix §一.2) — for services that have no admin
 *      permit and no provisioned bot token at boot (user/planner have no relay;
 *      ensureDefaultCategories runs before any token is injected). The Router sets
 *      no `trust proxy`, so req.ip is the real socket address and X-Forwarded-For
 *      cannot spoof it. NOTE: a multi-HOST deployment (ROUTER_URL → non-localhost)
 *      would need the caller to present a service-bot token instead.
 */
function isLoopbackRequest(req) {
    return req?.ip === '127.0.0.1' || req?.ip === '::1' || req?.hostname === 'localhost';
}

/**
 * Check permission for specific service/method.
 * 
 * @param {object} permit - User permit object.
 * @param {string} service - Target service name.
 * @param {string} method - Method name.
 * @returns {boolean} True if allowed.
 */
function checkPermission(permit, service, method) {
    if (!permit) return false;
    if (permit.allow_all) return true;
    if (!permit.services) return false;

    const allowedMethods = permit.services[service];
    if (!allowedMethods) return false;

    if (allowedMethods.includes('*')) return true;
    if (allowedMethods.includes(method)) return true;

    return false;
}

// --- SERVICE RESOLUTION ---

/**
 * Locate the target service and method schema for a given RPC method name.
 * 
 * @param {string} method - RPC method name.
 * @param {object} SERVICES - Global services registry.
 * @returns {object|null} { service, serviceName, methodSchema }.
 * @why Performs reverse lookup across all discovered services to route the request efficiently.
 */
function resolveTargetService(method, SERVICES) {
    for (const [name, svc] of Object.entries(SERVICES)) {
        const foundMethod = svc.methods && svc.methods.find(m => m.name === method);
        if (foundMethod) {
            return {
                service: svc,
                serviceName: name,
                methodSchema: foundMethod.params
            };
        }
    }
    return null;
}

module.exports = {
    resolveSessionUser,
    extractToken,
    isAdmin,
    isLoopbackRequest,
    checkPermission,
    resolveTargetService
};
