const jsonrpc = require('../handlers/jsonrpc');

/**
 * Roles (authority.md) — a role is a NAMED PERMIT TEMPLATE, referenced by both internal
 * users and external passports. One RBAC system, all principal types.
 *
 *   USER:ROLE:{role}   JSON { id, scope, name, services, constraints:{$owner:{field}?}, ... }
 *   USER:ROLE:IDS      set of role ids
 *
 * Materialization, not runtime resolution: `assign` copies the role's permit ONTO the
 * principal (internal user.permit / external session at verify), so the request hot path
 * still just reads the principal's own permit — no role→user double lookup, zero Router
 * change. Editing a role re-applies on next assign/verify (an admin-time cost, not per request).
 */
module.exports = (redisClient, config) => {
    const R = config.redis.role;
    const roleKey = (role) => `${R.prefix}${role}`;
    const userKey = (uid)  => `${config.redis.userPrefix}${uid}`;

    async function get({ role } = {}) {
        if (!role) throw jsonrpc.MISSING_PARAM('role');
        const raw = await redisClient.get(roleKey(role));
        if (!raw) throw jsonrpc.NOT_FOUND(`role ${role}`);
        return JSON.parse(raw);
    }

    async function list() {
        const ids = await redisClient.sMembers(R.idsSet);
        if (!ids.length) return { items: [] };
        const raws = await Promise.all(ids.map((id) => redisClient.get(roleKey(id))));
        const items = raws.filter(Boolean).map(JSON.parse).sort((a, b) => a.id.localeCompare(b.id));
        return { items };
    }

    // Define/update a role. `ownerField` adds a row-isolation predicate template
    // (constraints.$owner.field); `scope` is a label (internal | external | both).
    async function set({ role, services, ownerField, constraints, scope, name } = {}) {
        if (!role) throw jsonrpc.MISSING_PARAM('role');
        if (services && typeof services !== 'object') throw jsonrpc.INVALID_PARAMS('services must be an object');
        const merged = { ...(constraints || {}) };
        if (ownerField) merged.$owner = { field: ownerField };
        const existing = JSON.parse((await redisClient.get(roleKey(role))) || 'null');
        const now = new Date().toISOString();
        const doc = {
            id: role,
            scope: scope || existing?.scope || 'both',
            name: name ?? existing?.name ?? role,
            services: services || {},
            constraints: merged,
            createdAt: existing?.createdAt || now,
            updatedAt: now,
        };
        // fail-closed (passport.md §3.6/§3.7): a scope:'external' role MUST be row-isolated
        // — it must define an ownerField (→ constraints.$owner.field). Otherwise an external
        // passport bound to it would get a session with NO row scope (cross-tenant read).
        // NOTE: set() replaces constraints, so an external-role UPDATE must re-affirm
        // ownerField rather than silently stripping isolation.
        if (doc.scope === 'external' && !doc.constraints?.$owner?.field) {
            throw jsonrpc.INVALID_PARAMS("scope:'external' role must define ownerField (row isolation) — see passport.md §3.7");
        }
        // Roles, like bots, must never be allow_all (least-privilege).
        await redisClient.set(roleKey(role), JSON.stringify(doc));
        await redisClient.sAdd(R.idsSet, role);
        return { role, scope: doc.scope };
    }

    async function remove({ role } = {}) {
        if (!role) throw jsonrpc.MISSING_PARAM('role');
        await redisClient.del(roleKey(role));
        await redisClient.sRem(R.idsSet, role);
        return { role };
    }

    // Resolve a role into a concrete permit. If the role has an owner field and an
    // ownerValue is given, inject it (row isolation scoped to this principal).
    async function resolve(role, ownerValue) {
        const r = await get({ role });
        const constraints = { ...(r.constraints || {}) };
        if (constraints.$owner && ownerValue !== undefined) {
            constraints.$owner = { ...constraints.$owner, value: ownerValue };
        }
        return { allow_all: false, services: r.services || {}, constraints };
    }

    // MATERIALIZE a role onto an INTERNAL user: copy the role's permit onto user.permit
    // (+ set user.role to the assigned role name). The Router's Scheme F reads user.permit
    // live → takes effect immediately, no role lookup at request time. Per-user exceptions:
    // use user.permit.update.
    //
    // NOTE: this is the RBAC axis — it sets `user.role` (the assigned role) + `user.permit`.
    // It deliberately does NOT touch `categories.POWER` — that is the separate TIER axis
    // (admin/operator/normal) that gates portal access (portal/operator login) + session policy.
    async function assign({ uid, role } = {}) {
        if (!uid || !role) throw jsonrpc.MISSING_PARAM('uid/role');
        const permit = await resolve(role, uid);   // ownerField (if any) scoped to the user
        const raw = await redisClient.get(userKey(uid));
        if (!raw) throw jsonrpc.NOT_FOUND(`user ${uid}`);
        const u = JSON.parse(raw);
        u.permit = permit;
        u.role = role;
        await redisClient.set(userKey(uid), JSON.stringify(u));
        return { uid, role };
    }

    return { get, list, set, remove, resolve, assign };
};
