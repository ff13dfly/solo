/**
 * library/permit.js — Permit interpretation SDK (pure functions, no I/O).
 *
 * @why Two distinct concerns were being conflated under the name "permit":
 *      - ENFORCEMENT (deny a request) lives in the Router: `handlers/access.js`
 *        (`checkAccess`) + `handlers/auth.js` (`checkPermission`). Already done.
 *      - INTERPRETATION (judge what a permit object covers) had no shared home —
 *        each service hand-rolled `req.permit === 'admin'`, and orchestrator's
 *        footprint pre-check (AUDIT H6) has nowhere to ask "does this permit
 *        cover ALL these methods". This module is that home.
 *
 *      access = enforce (block requests) · permit = interpret (judge coverage).
 *      See docs/protocol/zh/governance.md §1.
 *
 * @contract The full-object matchers below MUST stay byte-for-byte equivalent to
 *      the Router's `checkPermission` (api/router/handlers/auth.js). If they
 *      diverge, the orchestrator footprint pre-check could pass a workflow that
 *      the Router would then reject mid-execution (or vice-versa). The shared
 *      rule, for a permit object and a fully-qualified method `svc.entity.action`:
 *        !permit              → false
 *        permit.allow_all     → true
 *        !permit.services     → false
 *        services[svc] missing→ false
 *        services[svc] has '*'→ true   (service-level wildcard)
 *        services[svc] has m  → true
 *        else                 → false
 *
 * @whoFeedsWhat
 *      - Downstream services receive a COMPRESSED permit: Router forwards only the
 *        string 'admin' | 'user' (+ constraints), NOT the method-level `services`
 *        map (token-size reasons; see router/handlers/forward.js). So services use
 *        the STRING-path helpers: isAdmin(req), getConstraints(req).
 *      - orchestrator footprint pre-check needs the FULL permit object; it must
 *        fetch it on demand via `user.permit.get(callerUid)` and use the
 *        OBJECT-path helpers: hasPermit(permitObj, method), coversAll(...).
 *
 * @structure permit object = { allow_all: bool, services: { [svc]: [method|'*'] }, constraints: {} }
 */

// ── Method-name parsing ──────────────────────────────────────────────────────

/**
 * Extract the service segment from a fully-qualified RPC method name.
 * `services` is keyed by service name ('erp'), while footprints carry
 * fully-qualified methods ('erp.stock.query'). This bridges the two.
 *
 * @param {string} method - e.g. 'erp.stock.query'
 * @returns {string|null} service segment ('erp'), or null if unparseable.
 */
function serviceOf(method) {
    if (typeof method !== 'string' || method.length === 0) return null;
    const dot = method.indexOf('.');
    if (dot <= 0) return null; // no prefix, or leading dot → not a valid svc.method
    return method.slice(0, dot);
}

// ── OBJECT path (full permit object; for orchestrator footprint pre-check) ─────

/**
 * Does this full permit object grant the given fully-qualified method?
 *
 * Mirrors Router's checkPermission exactly (see @contract above). `method` is
 * fully-qualified ('svc.entity.action'); the service segment is derived here.
 *
 * @param {object} permit - Full permit object from user.permit.get.
 * @param {string} method - Fully-qualified method, e.g. 'ledger.transfer'.
 * @returns {boolean}
 */
function hasPermit(permit, method) {
    if (!permit) return false;
    if (permit.allow_all) return true;
    if (!permit.services) return false;

    const svc = serviceOf(method);
    if (!svc) return false;

    const allowed = permit.services[svc];
    if (!allowed) return false;

    if (allowed.includes('*')) return true;
    if (allowed.includes(method)) return true;

    return false;
}

/**
 * Does this permit object cover EVERY method in the footprint? (fail-fast AND)
 *
 * This is the core of orchestrator footprint pre-check (AUDIT H6): a workflow's
 * footprint = ∪ steps[].method ∪ resolvers[].method; the caller may run it only
 * if their permit covers all of them.
 *
 * @param {object} permit  - Full permit object.
 * @param {string[]} methods - Fully-qualified methods. Empty array → true (vacuous).
 * @returns {boolean} true iff every method is granted.
 */
function coversAll(permit, methods) {
    if (!Array.isArray(methods)) return false;
    if (permit && permit.allow_all) return true; // short-circuit admin
    for (const m of methods) {
        if (!hasPermit(permit, m)) return false;
    }
    return true;
}

/**
 * Which methods in the footprint are NOT covered? (for actionable 403 messages)
 *
 * @param {object} permit  - Full permit object.
 * @param {string[]} methods - Fully-qualified methods.
 * @returns {string[]} the subset of `methods` the permit does not grant
 *                     (de-duplicated, order-preserving). Non-array → [].
 */
function missingMethods(permit, methods) {
    if (!Array.isArray(methods)) return [];
    if (permit && permit.allow_all) return [];
    const seen = new Set();
    const missing = [];
    for (const m of methods) {
        if (seen.has(m)) continue;
        seen.add(m);
        if (!hasPermit(permit, m)) missing.push(m);
    }
    return missing;
}

// ── STRING path (compressed permit forwarded to downstream services) ──────────

/**
 * Is the request from an admin caller?
 *
 * Reads what the Router forwards. Router compresses permit to the string
 * 'admin' | 'user' on `req.permit` (forward.js). Also tolerates the full object
 * form ({ allow_all: true }) in case a caller is invoked with an un-compressed
 * permit (e.g. internal/local paths), so this is safe everywhere.
 *
 * Replaces the hand-written `req.permit === 'admin'` scattered across services.
 *
 * @param {object} req - Express request (uses req.permit).
 * @returns {boolean}
 */
function isAdmin(req) {
    if (!req) return false;
    const p = req.permit;
    if (p === 'admin') return true;
    if (p && typeof p === 'object' && p.allow_all === true) return true;
    return false;
}

/**
 * Data-level constraints the Router forwarded (for fieldmask / row scoping).
 * Always returns an object (never undefined) so callers can index safely.
 *
 * @param {object} req - Express request (uses req.constraints).
 * @returns {object}
 */
function getConstraints(req) {
    return (req && req.constraints) ? req.constraints : {};
}

module.exports = {
    // object path (full permit — orchestrator footprint pre-check)
    hasPermit,
    coversAll,
    missingMethods,
    // string path (compressed permit — downstream services)
    isAdmin,
    getConstraints,
    // helper
    serviceOf,
};
