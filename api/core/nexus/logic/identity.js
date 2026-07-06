/**
 * nexus/logic/identity.js — §1.2 per-Sentinel identity.
 *
 * @why Today every Sentinel's declarative data_fetchers ride the ONE shared
 *      `system.nexus` bot token, so a fetch is authorized against nexus's broad
 *      permit and is unattributable per-Sentinel. §1.2 gives each Sentinel its own
 *      internal bot identity: a `system.*` bot account (provisioned via user.bot.*),
 *      whose token nexus holds here and presents via relay.callAs so Router
 *      checkAccess enforces THAT Sentinel's narrow permit and the audit trail names
 *      the Sentinel.
 *
 * Provisioning is MANUAL (operator-driven, minimal scope): an admin creates the bot
 * (`user.bot.create` → `user.bot.issue.token`) and injects the token via
 * `nexus.sentinel.token.set`. This module only holds / refreshes the token and runs
 * the config-time pre-audit; it never mints bots itself (nexus is not admin).
 *
 * Binding: a Sentinel's `authorityRole` carries its bot uid. A `system.*` value
 * opts the Sentinel into scoped identity; any other value is descriptive and the
 * caller falls back to the shared nexus relay (legacy, non-breaking).
 */
const { createLogger } = require('../../../library/logger');
const jsonrpc = require('../handlers/jsonrpc');

const logger = createLogger('nexus-identity');

// Exact mirror of router/handlers/auth.js checkPermission (Phase-1 RBAC): a method
// is allowed iff the permit is allow_all, or enumerates the method's FULL name (or
// '*') under the method's service segment. Kept in lock-step with the Router so the
// pre-audit verdict matches what checkAccess will actually decide at runtime.
function permitAllows(permit, method) {
    if (!permit) return false;
    if (permit.allow_all) return true;
    if (!permit.services) return false;
    const service = String(method).split('.')[0];
    const allowed = permit.services[service];
    if (!allowed) return false;
    return allowed.includes('*') || allowed.includes(method);
}

// A `system.*` authorityRole opts a Sentinel into its own bot identity.
function isBotUid(authorityRole) {
    return typeof authorityRole === 'string' && authorityRole.startsWith('system.');
}

module.exports = (redis, config, { relay, now = Date.now } = {}) => {
    const R = config.redis;
    const rotateBeforeMs = (config.identity && config.identity.rotateBeforeMs) || 2 * 60 * 60 * 1000;
    const key = (uid) => R.sentinelTokenPrefix + uid;

    // Admin injects a freshly-issued (user.bot.issue.token) token for a Sentinel bot.
    async function setToken({ authorityRole, token, expiresAt } = {}) {
        if (!isBotUid(authorityRole)) throw jsonrpc.INVALID_PARAMS('authorityRole must be a system.* bot uid');
        if (!token || typeof token !== 'string') throw jsonrpc.INVALID_PARAMS('token must be a string');
        if (!expiresAt || typeof expiresAt !== 'number') throw jsonrpc.INVALID_PARAMS('expiresAt must be a number');
        if (expiresAt <= now()) throw jsonrpc.INVALID_PARAMS('token is already expired');
        await redis.set(key(authorityRole), JSON.stringify({ token, expiresAt }));
        return { ok: true };
    }

    // Soft revoke: nexus forgets the token so it stops acting on the Sentinel's
    // behalf. HARD revocation (killing the live session) needs admin and is done
    // out-of-band via user.token.revoke (portal admin) — see sentinel.disable.
    async function dropToken(authorityRole) {
        if (!isBotUid(authorityRole)) return { dropped: false };
        const n = await redis.del(key(authorityRole));
        return { dropped: n > 0 };
    }

    async function hasToken(authorityRole) {
        if (!isBotUid(authorityRole)) return false;
        return (await redis.exists(key(authorityRole))) === 1;
    }

    // Richer read for visibility surfaces: presence + expiry in one verdict. hasToken
    // alone is expiry-blind (EXISTS), which let the UI show ● for a token that
    // getToken would reject at runtime — "configured but dead" was invisible.
    async function tokenState(authorityRole) {
        if (!isBotUid(authorityRole)) return { hasToken: false, expiresAt: null, expired: false };
        const raw = await redis.get(key(authorityRole));
        if (!raw) return { hasToken: false, expiresAt: null, expired: false };
        try {
            const st = JSON.parse(raw);
            const expiresAt = Number(st.expiresAt) || null;
            return { hasToken: true, expiresAt, expired: !!expiresAt && expiresAt <= now() };
        } catch (_) {
            return { hasToken: true, expiresAt: null, expired: false };
        }
    }

    // Returns a currently-valid token for the Sentinel bot, self-refreshing in place
    // when near expiry (user.token.refresh keys off the presented token's sub, so the
    // bot rotates its own token). Throws if none is provisioned or it has expired.
    async function getToken(authorityRole) {
        if (!isBotUid(authorityRole)) throw jsonrpc.INVALID_PARAMS('authorityRole must be a system.* bot uid');
        const raw = await redis.get(key(authorityRole));
        if (!raw) throw jsonrpc.INVALID_PARAMS(`no token provisioned for sentinel bot ${authorityRole}`);
        let st;
        try { st = JSON.parse(raw); } catch (_) { throw jsonrpc.INTERNAL_ERROR('stored sentinel token is corrupt'); }
        if (now() >= st.expiresAt) {
            await redis.del(key(authorityRole));
            throw jsonrpc.INVALID_PARAMS(`token for sentinel bot ${authorityRole} has expired; re-provision via nexus.sentinel.token.set`);
        }
        if ((st.expiresAt - now()) < rotateBeforeMs && relay) {
            try {
                const r = await relay.callAs(st.token, 'user.token.refresh', {});
                if (r && r.token && r.expiresAt) {
                    st = { token: r.token, expiresAt: r.expiresAt };
                    await redis.set(key(authorityRole), JSON.stringify(st));
                }
            } catch (err) {
                // A blip refreshing must not break a still-valid token — keep the current one.
                logger.warn('sentinel.token.refresh.failed', { authorityRole, message: err.message });
            }
        }
        return st.token;
    }

    // Config-time pre-audit (create/update): every declared method must be within the
    // Sentinel bot's own permit, read via callAs self-read (user.permit.get allows a
    // principal to read its own permit). A mis-scoped fetcher fails fast with
    // INVALID_PARAMS instead of surfacing as a FORBIDDEN at runtime. Generic over a
    // method list so the later emit-event action verbs reuse the same gate.
    async function preauditMethods(authorityRole, methods) {
        if (!methods || !methods.length) return;
        if (!relay) return;
        // Read the bot's own permit via self-read. BEST-EFFORT: a least-privilege bot
        // may not be granted user.permit.get (it shouldn't need to be), in which case
        // the Router forbids the self-read — we must NOT block create on that. The
        // runtime checkAccess on each callAs fetch is the real gate; pre-audit is just
        // a fail-fast when the permit IS readable. (Grant the bot user.permit.get to
        // opt into config-time pre-audit.)
        let permit;
        try {
            const token = await getToken(authorityRole);
            const res = await relay.callAs(token, 'user.permit.get', { uid: authorityRole });
            permit = res && res.permit;
        } catch (err) {
            logger.warn('sentinel.preaudit.skipped', { authorityRole, reason: err.message });
            return;
        }
        for (const m of methods) {
            if (!permitAllows(permit, m)) {
                throw jsonrpc.INVALID_PARAMS(`sentinel bot ${authorityRole} permit does not allow method "${m}" — grant it (user.bot.update) or remove the fetcher`);
            }
        }
    }

    return { setToken, dropToken, hasToken, tokenState, getToken, preauditMethods, isBotUid, permitAllows };
};
