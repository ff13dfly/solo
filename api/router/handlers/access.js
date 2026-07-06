const authHandlers = require('./auth');
const { isPublicMethod } = require('./validator');
const jsonrpc = require('./jsonrpc');

// Single source for the access-denied code (-32604 ACCESS_DENIED, permission-system.md).
const ACCESS_DENIED_CODE = jsonrpc.ACCESS_DENIED().code;

// --- PERMISSION ENFORCEMENT ---

/**
 * Perform a multi-layered access control check for a given RPC request.
 * 
 * @param {object} sessionUser - The resolved user session.
 * @param {string} targetServiceName - The internal name of the downstream service.
 * @param {string} method - The RPC method being invoked.
 * @returns {object} { allowed: boolean, reason?: string }
 * 
 * @why Centralizes security logic to ensure that even if an internal endpoint is exposed, 
 *      unauthorized users cannot trigger sensitive actions.
 * @attention 
 *   1. HIERARCHY: Explicit user permits take precedence, followed by static whitelists, 
 *      and finally dynamic capability flags.
 *   2. SYSTEM METHODS: Requests without a target service (e.g., system.category.locate) 
 *      are treated as router-internal and bypassed by this specific check (assuming 
 *      they handle their own internal auth if needed).
 */
function checkAccess(sessionUser, targetServiceName, method) {
    // Phase 0: System/Router Internal Bypasses
    if (!targetServiceName) {
        return { allowed: true };
    }

    // Phase 1: Explicit User Permissions (RBAC/ACL)
    if (authHandlers.checkPermission(sessionUser.permit, targetServiceName, method)) {
        return { allowed: true };
    }

    // Phase 2: Static Public Whitelist (Hardcoded core methods)
    if (isPublicMethod(method)) {
        // SECURITY: Discovery methods are only public in DEBUG mode to prevent topology leakage.
        const DISCOVERY_METHODS = ['system.service.list', 'system.service.status', 'system.capability.list', 'methods'];
        const config = require('../config');

        if (DISCOVERY_METHODS.includes(method) && !config.debug) {
            return {
                allowed: false,
                reason: 'Forbidden: Discovery disabled in production',
                errorCode: ACCESS_DENIED_CODE
            };
        }
        return { allowed: true };
    }

    // Phase 3: Dynamic Public Flag (Introspected from downstream service)
    const capabilityHandler = require('./capability');
    const capMap = capabilityHandler.getCapabilityMap();
    if (capMap[method] && capMap[method].public) {
        return { allowed: true };
    }

    // Failure: No authority found
    const userName = sessionUser.name || sessionUser.username || 'unknown';
    console.warn(`[Security] Access Denied: ${userName} -> ${method}`);
    return {
        allowed: false,
        reason: 'Forbidden',
        errorCode: ACCESS_DENIED_CODE
    };
}

module.exports = {
    checkAccess
};
