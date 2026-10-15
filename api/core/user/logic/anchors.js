/**
 * anchors.js — which strings may NOT be a passport anchor.
 *
 * @why A passport session carries `uid: <anchor>`, and the Router resolves every session uid
 *      against the SAME keyspace as internal accounts and bots: it loads `user:<uid>` and
 *      adopts that record's permit / role / tier wholesale (dropping the passport's `$owner`
 *      row isolation), and routes `system.*` uids to the bot branch. Anchors used to be
 *      accepted verbatim, so an anchor equal to an internal uid, a `system.*` bot id, or
 *      `bot:<id>` (→ `user:bot:<id>`, the bot record itself) turned a row-isolated passport
 *      into that principal — up to allow_all. With `device` issuance that needed no
 *      credential at all (docs/planning/security.md, 2026-09-27).
 * @attention Enforced at issuance (every _provision) AND at session mint (verify): the mint
 *      check is the chokepoint that also refuses entities provisioned before this existed.
 *      Real anchors are emails, phones and client-generated device ids — none contain ':'.
 */
const BOT_UID_PREFIX = 'system.';
// The prefix the ROUTER reads (`user:${uid}`, literal in router/handlers/auth.js) — deliberately
// not config-derived: what matters is the key the Router will load, and a missing/renamed config
// value must not silently turn the collision check into a no-op.
const ROUTER_USER_PREFIX = 'user:';
const ADMIN_USER_PREFIX = 'administrator:user:';
const DESTROYED_UIDS_SET = 'user:destroyed:ids';
const RESERVED_ANCHORS = new Set([
    'admin', 'anonymous', 'guest', 'system', 'router', 'administrator',
    'user', 'agent', 'nexus', 'orchestrator', 'gateway', 'ingress',
    'notification', 'storage', 'fulfillment', 'approval', 'planner', 'mcp',
]);

/** Never a valid anchor, whatever exists today: bot namespace, reserved names, or a `user:<sub>:…` path. */
function isReservedAnchorSyntax(anchor) {
    if (typeof anchor !== 'string') return true;
    const trimmed = anchor.trim();
    if (!trimmed) return true;
    return trimmed.startsWith(BOT_UID_PREFIX)
        || trimmed.includes(':')
        || RESERVED_ANCHORS.has(trimmed.toLowerCase());
}

/** Syntax, plus an internal account / admin account / destroyed account holding this id as its uid. */
async function isReservedAnchor(redisClient, anchor) {
    if (isReservedAnchorSyntax(anchor)) return true;
    if ((await redisClient.exists(`${ROUTER_USER_PREFIX}${anchor}`)) === 1) return true;
    if ((await redisClient.exists(`${ADMIN_USER_PREFIX}${anchor}`)) === 1) return true;
    if (typeof redisClient.sIsMember === 'function') {
        if (await redisClient.sIsMember(DESTROYED_UIDS_SET, anchor)) return true;
    } else if (typeof redisClient.sMembers === 'function') {
        const destroyed = await redisClient.sMembers(DESTROYED_UIDS_SET);
        if (Array.isArray(destroyed) && destroyed.includes(anchor)) return true;
    }
    return false;
}

module.exports = { BOT_UID_PREFIX, DESTROYED_UIDS_SET, RESERVED_ANCHORS, isReservedAnchorSyntax, isReservedAnchor };
