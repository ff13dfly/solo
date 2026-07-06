const crypto = require('crypto');
const Passport = require('../../../library/passport');
const jsonrpc = require('../handlers/jsonrpc');

/**
 * External-principal bridge + registry (authority.md §4.1) — lives in `user`, NOT a
 * separate microservice. The external user is a first-class, MANAGEABLE entity keyed
 * by its anchor (mirrors how `bot` is the manageable machine principal):
 *
 *   USER:PASSPORT:{anchor}   JSON { id:anchor, role, name, meta, status, createdAt, ... }
 *   USER:PASSPORT:IDS        set of anchors (for list)
 *   (role permit lives in the unified role store USER:ROLE:{role} — see role.js)
 *   PASSPORT:SALT:{anchor}   anchor salt (server-only)        — credential
 *   PASSPORT:PROOFS:{anchor} hash deviceId -> { proof }       — devices (a user may have many)
 *   SESSION:{token} / USER:SESSIONS:{anchor}  minted session + revocation index
 *
 * Role is BOUND to the entity at register-time; verify() reads it from the entity and
 * never trusts a client-supplied role. Disabling the entity blocks future verify AND
 * revokes its live sessions.
 */
const EXTERNAL_TOKEN_TTL_SEC = 24 * 60 * 60; // 24h

module.exports = (redisClient, config, { role, relay } = {}) => {
    const R = config.redis;
    const P = R.passport;
    const entKey   = (anchor) => `${P.prefix}${anchor}`;
    const saltKey  = (anchor) => `${P.saltPrefix}${anchor}`;
    const proofKey = (anchor) => `${P.proofPrefix}${anchor}`;
    const otpKey    = (anchor) => `${P.otpPrefix || 'USER:PASSPORT:OTP:'}${anchor}`;
    const lockKey   = (anchor) => `${P.lockPrefix || 'USER:PASSPORT:LOCK:'}${anchor}`;
    const otpReqKey = (anchor) => `${P.otpReqPrefix || 'USER:PASSPORT:OTPREQ:'}${anchor}`;
    const sessionKey      = (token) => `${R.sessionPrefix}${token}`;
    const userSessionsKey = (uid)   => `${R.userSessionsPrefix}${uid}`;

    // ── Self-service issuance policy (spec-passport-self-issuance.md §3) ───────────
    // Per-app, fail-closed: absent config → 'closed' / null defaultRole (= current behaviour).
    const POL = config.passport || {};
    const OTP = POL.otp || {};
    const otpTtlSec      = OTP.ttlSec || 300;
    const otpMaxAttempts = OTP.maxAttempts || 5;
    const otpLockoutSec  = OTP.lockoutSec || 900;
    const otpCodeLen     = OTP.codeLen || 6;
    const otpReqMax      = OTP.requestMax || 3;             // per-anchor otp.request budget per window
    const otpReqWindowSec = OTP.requestWindowSec || 60;
    const otpEcho        = OTP.echo === true;   // dev/test ONLY — default OFF (never echo a code in prod)
    const otpSmsTemplate = OTP.smsTemplateId || null;   // gateway.sms.template id (template-based SMS)
    const issuanceMode   = (app) => (app && POL.issuance?.byApp?.[app]) || POL.issuance?.default || 'closed';
    const defaultRoleFor = (app) => (app && POL.defaultRole?.byApp?.[app]) || POL.defaultRole?.default || null;
    // Authority routing (spec-passport-identity-line §2.1): a passport may route to a
    // pre-configured bot account's permit instead of a role. ownerField names the $owner
    // predicate field injected for row isolation when routing to a bot.
    const defaultBotFor  = (app) => (app && POL.defaultBot?.byApp?.[app]) || POL.defaultBot?.default || null;
    const ownerFieldName = POL.ownerField || 'ownerId';
    const botKey = (botId) => `${R.bot?.prefix || 'user:bot:'}${botId}`;

    const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
    function genCode(len) {
        const b = crypto.randomBytes(len); let s = '';
        for (let i = 0; i < len; i++) s += (b[i] % 10).toString();
        return s;
    }
    async function ensureSalt(anchor) {
        let salt = await redisClient.get(saltKey(anchor));
        if (!salt) { salt = Passport.createSalt(); await redisClient.set(saltKey(anchor), salt); }
        return salt;
    }

    async function getEntity(anchor) {
        const raw = await redisClient.get(entKey(anchor));
        return raw ? JSON.parse(raw) : null;
    }

    // Resolve a passport entity's permit (spec-passport-identity-line §2.1). Two routes:
    //   bot  → adopt a pre-configured bot account's permit (the "已配好权限的 bot account"),
    //          row-isolated to this anchor via an injected $owner. Different passport → different bot.
    //   role → unified role store (existing, unchanged). Always row-isolated by the caller's check.
    async function resolveAuthority(entity, anchor) {
        if (entity.bot) {
            const raw = await redisClient.get(botKey(entity.bot));
            if (!raw) throw jsonrpc.INTERNAL_ERROR(`passport bot "${entity.bot}" not found`);
            const bot = JSON.parse(raw);
            return {
                allow_all: false,
                services: bot.permit?.services || {},
                constraints: { ...(bot.permit?.constraints || {}), $owner: { field: ownerFieldName, value: anchor } },
            };
        }
        return role.resolve(entity.role, anchor);
    }

    // Verify + one-time-consume a pending OTP for `anchor`. Throws UNAUTHORIZED on lockout /
    // no-pending / wrong code (with attempt counting → lockout). Shared by otpVerify + upgrade.
    async function _consumeOtp(anchor, otp) {
        if (await redisClient.get(lockKey(anchor))) throw jsonrpc.UNAUTHORIZED();
        const raw = await redisClient.get(otpKey(anchor));
        if (!raw) throw jsonrpc.UNAUTHORIZED();
        const rec = JSON.parse(raw);
        const salt = await redisClient.get(saltKey(anchor));
        if (!salt || rec.hash !== sha256(otp + salt)) {
            rec.attempts = (rec.attempts || 0) + 1;
            if (rec.attempts >= otpMaxAttempts) {
                await redisClient.set(lockKey(anchor), '1', { EX: otpLockoutSec });
                await redisClient.del(otpKey(anchor));
            } else {
                const ttl = await redisClient.ttl(otpKey(anchor));
                await redisClient.set(otpKey(anchor), JSON.stringify(rec), { EX: ttl > 0 ? ttl : otpTtlSec });
            }
            throw jsonrpc.UNAUTHORIZED();
        }
        await redisClient.del(otpKey(anchor));   // one-time consume
        return rec;
    }

    // ── Passport principal management (admin) ─────────────────────────────────

    // Shared entity+salt+proof writer — admin `register` AND self-service `otpVerify` both call
    // this so the two paths can never drift. `deviceToken` optional (PENDING provisioning records
    // no device yet); `roleName` optional (PENDING binds no role until an admin elevates).
    async function _provision({ anchor, roleName, bot, app, name, meta, deviceId, deviceToken, status = 'ACTIVE' }) {
        const now = new Date().toISOString();
        const existing = await getEntity(anchor);
        const entity = existing
            ? { ...existing, role: roleName ?? existing.role, bot: bot ?? existing.bot ?? null, app: app ?? existing.app ?? null, name: name ?? existing.name, meta: meta ?? existing.meta, status, updatedAt: now }
            : { id: anchor, role: roleName || null, bot: bot || null, app: app || null, name: name || anchor, meta: meta || {}, status, createdAt: now, updatedAt: now };

        const salt = await ensureSalt(anchor);   // anchor-specific salt (server-only), created once
        const did = deviceId || Passport.issueDeviceId();

        const multi = redisClient.multi();
        multi.set(entKey(anchor), JSON.stringify(entity));
        multi.sAdd(P.idsSet, anchor);
        if (deviceToken) multi.hSet(proofKey(anchor), did, JSON.stringify(Passport.createProofEntry(deviceToken, salt)));
        await multi.exec();
        return { anchor, role: entity.role, bot: entity.bot, app: entity.app, deviceId: did, status: entity.status };
    }

    // Onboard / update an external principal AND register one of its devices (admin/operator,
    // permit-gated). `app` distinguishes which external application/tenant. The public
    // self-service counterpart that PRODUCES the deviceToken is `otpVerify` (§4.2).
    async function register({ anchor, role: roleName, app, deviceId, deviceToken, name, meta } = {}) {
        if (!anchor || !roleName || !deviceToken) throw jsonrpc.MISSING_PARAM('anchor/role/deviceToken');
        await role.get({ role: roleName });   // role must exist (binds a real permit)
        return _provision({ anchor, roleName, app, name, meta, deviceId, deviceToken, status: 'ACTIVE' });
    }

    // Optional `app` filter → distinguish principals by external application/tenant.
    async function list({ app } = {}) {
        const anchors = await redisClient.sMembers(P.idsSet);
        if (!anchors.length) return { items: [] };
        const raws = await Promise.all(anchors.map((a) => redisClient.get(entKey(a))));
        let items = raws.filter(Boolean).map(JSON.parse);
        if (app) items = items.filter((x) => x.app === app);
        items.sort((a, b) => a.id.localeCompare(b.id));
        return { items };
    }

    async function get({ anchor } = {}) {
        if (!anchor) throw jsonrpc.MISSING_PARAM('anchor');
        const entity = await getEntity(anchor);
        if (!entity) throw jsonrpc.NOT_FOUND(`passport ${anchor}`);
        const devices = await redisClient.hKeys(proofKey(anchor));   // device ids only (not secrets)
        return { ...entity, devices };
    }

    // Disable a principal: block future verify + kill its live sessions.
    async function disable({ anchor } = {}) {
        if (!anchor) throw jsonrpc.MISSING_PARAM('anchor');
        const entity = await getEntity(anchor);
        if (!entity) throw jsonrpc.NOT_FOUND(`passport ${anchor}`);
        entity.status = 'DISABLED';
        entity.updatedAt = new Date().toISOString();
        await redisClient.set(entKey(anchor), JSON.stringify(entity));

        // revoke live sessions (same reverse-index pattern as bot.revoke)
        const idxKey = userSessionsKey(anchor);
        const tokens = await redisClient.sMembers(idxKey);
        if (tokens.length) {
            const multi = redisClient.multi();
            for (const t of tokens) multi.del(sessionKey(t));
            await multi.exec();
        }
        await redisClient.del(idxKey);
        return { anchor, status: 'DISABLED', revoked: tokens.length };
    }

    // ── External authentication (public) → restricted session ─────────────────
    async function verify({ anchor, deviceId, deviceToken } = {}) {
        if (!anchor || !deviceId || !deviceToken) throw jsonrpc.MISSING_PARAM('anchor/deviceId/deviceToken');

        const entity = await getEntity(anchor);
        if (!entity || entity.status !== 'ACTIVE') throw jsonrpc.UNAUTHORIZED();   // unknown/disabled

        const salt = await redisClient.get(saltKey(anchor));
        const raw  = salt ? await redisClient.hGet(proofKey(anchor), deviceId) : null;
        if (!salt || !raw) throw jsonrpc.UNAUTHORIZED();
        if (!Passport.verify(deviceToken, salt, JSON.parse(raw)).ok) throw jsonrpc.UNAUTHORIZED();

        // Authority comes from the ENTITY (bot account OR role, bound at issuance), never from
        // the client; $owner is scoped to this anchor (row isolation).
        const permit = await resolveAuthority(entity, anchor);

        // fail-closed (passport.md §3.7): NEVER mint an external session whose permit lacks
        // row isolation. Defense-in-depth behind the config-time gate. A misconfigured
        // authority is a server-side problem (INTERNAL_ERROR), not a credential failure.
        if (permit.constraints?.$owner?.value === undefined) {
            throw jsonrpc.INTERNAL_ERROR(`passport authority for "${anchor}" is not row-isolated ($owner missing) — refusing session`);
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + EXTERNAL_TOKEN_TTL_SEC * 1000;
        const sessionData = {
            uid: anchor, name: entity.name || anchor, type: 'external', kind: 'external',
            role: 'user', permit, loginAt: new Date().toISOString(),
        };
        const multi = redisClient.multi();
        multi.setEx(sessionKey(token), EXTERNAL_TOKEN_TTL_SEC, JSON.stringify(sessionData));
        multi.sAdd(userSessionsKey(anchor), token);
        multi.expire(userSessionsKey(anchor), EXTERNAL_TOKEN_TTL_SEC);
        await multi.exec();
        return { token, expiresAt, anchor, role: entity.role, bot: entity.bot };
    }

    // Fixed-window per-anchor throttle for otp.request. INCR + EXPIRE-on-first; if the counter is
    // ever found without a TTL (crash between INCR and EXPIRE) it is repaired rather than left to
    // block forever. Throws RATE_LIMIT_EXCEEDED with retry_after once the window budget is spent.
    async function _throttleOtpRequest(anchor) {
        const key = otpReqKey(anchor);
        const n = await redisClient.incr(key);
        if (n === 1) await redisClient.expire(key, otpReqWindowSec);
        if (n > otpReqMax) {
            let ttl = await redisClient.ttl(key);
            if (ttl < 0) { await redisClient.expire(key, otpReqWindowSec); ttl = otpReqWindowSec; }
            throw jsonrpc.RATE_LIMIT_EXCEEDED(ttl);
        }
    }

    // ── Self-service issuance (PUBLIC): OTP proves anchor ownership → device token ──────────
    // spec-passport-self-issuance.md §4. fail-closed: 'closed' mode (default) rejects.
    // Anti-enumeration: otpRequest's response shape is identical whether the anchor exists or not.
    async function otpRequest({ anchor, channel, app } = {}) {
        if (!anchor || !channel) throw jsonrpc.MISSING_PARAM('anchor/channel');
        if (issuanceMode(app) === 'closed') throw jsonrpc.FORBIDDEN('self-service issuance disabled for this app');

        // Per-anchor request throttle (fixed window): blunt delivery-bombing a victim's email/phone
        // and OTP-window churn. Keyed on the caller-supplied anchor (not on existence) → does not
        // leak whether the anchor exists (anti-enumeration preserved). Placed AFTER the closed gate
        // so a disabled app rejects before spending a counter slot.
        await _throttleOtpRequest(anchor);

        const code = genCode(otpCodeLen);
        const salt = await ensureSalt(anchor);   // reuse anchor salt as the OTP pepper (server-only)
        const rec = { hash: sha256(code + salt), channel, app: app || null, attempts: 0 };
        await redisClient.set(otpKey(anchor), JSON.stringify(rec), { EX: otpTtlSec });

        // Best-effort delivery: fail-SOFT to the client (uniform response either way), fail-CLOSED
        // to issuance (no code delivered → verify can't pass). Never throws.
        //   email → free-form content (gateway.email.send accepts {to,subject,content} directly)
        //   sms   → TEMPLATE-based: providers (Aliyun TemplateCode / Twilio ContentSid) reject
        //           free-form text, so gateway.sms.send wants {phone,templateId,variables}. Without a
        //           configured smsTemplateId the SMS channel is a deliberate no-op (no template = can't send).
        if (relay) {
            try {
                if (channel === 'sms') {
                    if (otpSmsTemplate) {
                        await relay.call('gateway.sms.send', {
                            phone: anchor,
                            templateId: otpSmsTemplate,
                            variables: { code, ttl: Math.round(otpTtlSec / 60) },
                        });
                    }
                    // else: no template configured → skip (fail-soft); rely on echo (dev) or alt channel.
                } else {
                    await relay.call('gateway.email.send', { to: anchor, subject: 'Your verification code', content: `Your code is ${code} (valid ${Math.round(otpTtlSec / 60)} min).` });
                }
            } catch (e) { /* swallow — delivery is best-effort, never blocks the request */ }
        }

        const out = { status: 'pending_otp' };
        if (otpEcho) out.devCode = code;   // dev/test ONLY (config.passport.otp.echo) — never set in prod
        return out;
    }

    async function otpVerify({ anchor, otp, channel, app, name, meta } = {}) {
        if (!anchor || !otp) throw jsonrpc.MISSING_PARAM('anchor/otp');
        const mode = issuanceMode(app);
        if (mode === 'closed') throw jsonrpc.FORBIDDEN('self-service issuance disabled for this app');

        await _consumeOtp(anchor, otp);   // proves anchor ownership (lockout + one-time consume)

        if (mode === 'pending') {
            await _provision({ anchor, roleName: null, app, name, meta, status: 'PENDING' });
            return { status: 'pending_review', anchor };
        }
        // mode === 'otp' → bind the configured authority (bot OR role) + issue a device token.
        return _issueAuthority({ anchor, app, name, meta });
    }

    // Shared issuance: resolve the app's configured authority (bot account OR role), fail-closed
    // if missing / not row-isolated, provision the entity + a device, return the device credential.
    async function _issueAuthority({ anchor, app, name, meta }) {
        const bot = defaultBotFor(app);
        const roleName = bot ? null : defaultRoleFor(app);
        if (!bot && !roleName) throw jsonrpc.INTERNAL_ERROR('no defaultBot/defaultRole configured for issuance');
        const permit = await resolveAuthority({ bot, role: roleName }, anchor);
        if (permit?.constraints?.$owner?.value === undefined) {
            throw jsonrpc.INTERNAL_ERROR(`passport authority (${bot ? 'bot ' + bot : 'role ' + roleName}) is not row-isolated ($owner missing) — refusing issuance`);
        }
        const deviceToken = Passport.issueToken(32);
        const deviceId = Passport.issueDeviceId(8);
        await _provision({ anchor, roleName, bot, app, name, meta, deviceId, deviceToken, status: 'ACTIVE' });
        return { deviceToken, deviceId, anchor, role: roleName, bot };
    }

    // ── Device mode (PUBLIC, TOFU): anonymous/guest passport keyed by a device-generated anchor,
    // NO OTP. Routes to the app's configured bot/role. spec-passport-identity-line §2.2.
    async function deviceIssue({ anchor, app, name, meta } = {}) {
        if (!anchor) throw jsonrpc.MISSING_PARAM('anchor');
        if (issuanceMode(app) !== 'device') throw jsonrpc.FORBIDDEN('device issuance disabled for this app');
        return _issueAuthority({ anchor, app, name, meta });
    }

    // ── Upgrade (PUBLIC): a device-anchor (anonymous) passport → an email/phone anchor
    // (registered), carrying identity (role/bot/meta). Requires BOTH device proof AND newAnchor
    // OTP. spec-passport-identity-line §2.3.
    async function upgrade({ anchor, deviceId, deviceToken, newAnchor, otp, channel, name, meta } = {}) {
        if (!anchor || !deviceId || !deviceToken || !newAnchor || !otp) {
            throw jsonrpc.MISSING_PARAM('anchor/deviceId/deviceToken/newAnchor/otp');
        }
        if (anchor === newAnchor) throw jsonrpc.INVALID_PARAMS('newAnchor must differ from the device anchor');

        // ① prove the caller holds the device passport.
        const dev = await getEntity(anchor);
        if (!dev || dev.status !== 'ACTIVE') throw jsonrpc.UNAUTHORIZED();
        const salt  = await redisClient.get(saltKey(anchor));
        const proof = salt ? await redisClient.hGet(proofKey(anchor), deviceId) : null;
        if (!salt || !proof || !Passport.verify(deviceToken, salt, JSON.parse(proof)).ok) throw jsonrpc.UNAUTHORIZED();

        // ② prove ownership of newAnchor (OTP, one-time — caller must precede with otp.request).
        await _consumeOtp(newAnchor, otp);

        // ③ migrate identity to newAnchor (carry role/bot/meta + upgradedFrom), issue a fresh device.
        const newToken    = Passport.issueToken(32);
        const newDeviceId = Passport.issueDeviceId(8);
        const carriedMeta = { ...(dev.meta || {}), ...(meta || {}), upgradedFrom: anchor };
        await _provision({
            anchor: newAnchor, roleName: dev.role || null, bot: dev.bot || null,
            app: dev.app, name: name || dev.name, meta: carriedMeta,
            deviceId: newDeviceId, deviceToken: newToken, status: 'ACTIVE',
        });

        // ④ retire the device passport (record the link, revoke its sessions) — no reuse.
        dev.status = 'DISABLED';
        dev.upgradedTo = newAnchor;
        dev.updatedAt = new Date().toISOString();
        await redisClient.set(entKey(anchor), JSON.stringify(dev));
        const idxKey = userSessionsKey(anchor);
        const tokens = await redisClient.sMembers(idxKey);
        if (tokens.length) { const m = redisClient.multi(); for (const t of tokens) m.del(sessionKey(t)); await m.exec(); }
        await redisClient.del(idxKey);

        return { anchor: newAnchor, deviceToken: newToken, deviceId: newDeviceId, role: dev.role || null, bot: dev.bot || null, upgradedFrom: anchor };
    }

    return { register, list, get, disable, verify, otpRequest, otpVerify, deviceIssue, upgrade };
};
