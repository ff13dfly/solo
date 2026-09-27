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

/** Never a valid anchor, whatever exists today: bot namespace, or a `user:<sub>:…` path. */
function isReservedAnchorSyntax(anchor) {
    return typeof anchor !== 'string' || anchor.startsWith(BOT_UID_PREFIX) || anchor.includes(':');
}

/** Syntax, plus an internal account already holding this id as its uid. */
async function isReservedAnchor(redisClient, anchor) {
    if (isReservedAnchorSyntax(anchor)) return true;
    return (await redisClient.exists(`${ROUTER_USER_PREFIX}${anchor}`)) === 1;
}

module.exports = { BOT_UID_PREFIX, isReservedAnchorSyntax, isReservedAnchor };
