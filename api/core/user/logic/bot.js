const crypto = require('crypto');
const jsonrpc = require('../handlers/jsonrpc');
const logger = require('../../../library/logger');
const { walContext } = require('../../../library/entity');

const BOT_UID_PREFIX = 'system.';
const BOT_TOKEN_TTL_SEC = 24 * 60 * 60; // 24 hours

module.exports = (redisClient, config) => {
    const KEY = config.redis.bot;

    function botKey(uid) { return `${KEY.prefix}${uid}`; }

    async function getBot(uid) {
        const raw = await redisClient.get(botKey(uid));
        if (!raw) throw jsonrpc.USER_NOT_FOUND();
        return JSON.parse(raw);
    }

    // §7.3 Authority enforcement: bot permits must enumerate methods explicitly.
    // allow_all bypasses the minimum-privilege constraint that §7.6 risk 2 mitigation
    // depends on. Reject any attempt to set it.
    function assertPermitSafe(permit) {
        if (permit && permit.allow_all === true) {
            throw jsonrpc.INVALID_PARAMS('Bot permit must not set allow_all=true; enumerate services.method explicitly');
        }
    }

    function issueSession(uid, permit) {
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + BOT_TOKEN_TTL_SEC * 1000;
        const sessionData = {
            uid,
            name: uid,
            type: 'bot',
            permit,
            role: 'user',
            loginAt: new Date().toISOString(),
        };
        return { token, expiresAt, sessionData };
    }

    const sessionKey = (token) => `${config.redis.sessionPrefix}${token}`;
    const userSessionsKey = (uid) => `${config.redis.userSessionsPrefix}${uid}`;

    // Persist a session AND index it under the uid so it can be actively revoked.
    // The reverse-index set carries the same TTL (refreshed on each issue) to bound
    // growth; stale token refs are harmless — DEL on an already-expired session is a no-op.
    async function persistSession(uid, token, sessionData) {
        const multi = redisClient.multi();
        multi.setEx(sessionKey(token), BOT_TOKEN_TTL_SEC, JSON.stringify(sessionData));
        multi.sAdd(userSessionsKey(uid), token);
        multi.expire(userSessionsKey(uid), BOT_TOKEN_TTL_SEC);
        await multi.exec();
    }

    return {
        // ── CRUD ────────────────────────────────────────────────────────────

        async create({ uid, permit, desc }) {
            if (!uid) throw jsonrpc.MISSING_PARAM('uid');
            if (!uid.startsWith(BOT_UID_PREFIX)) {
                throw jsonrpc.INVALID_PARAMS(`Bot uid must start with "${BOT_UID_PREFIX}"`);
            }
            assertPermitSafe(permit);

            const exists = await redisClient.get(botKey(uid));
            if (exists) throw jsonrpc.INVALID_PARAMS(`Bot "${uid}" already exists`);

            const bot = {
                id: uid,
                name: uid,
                type: 'bot',
                hash: null,
                permit: permit || { allow_all: false, services: {} },
                desc: desc || '',
                createdAt: new Date().toISOString(),
                status: 'ACTIVE',
            };

            const multi = redisClient.multi();
            multi.set(botKey(uid), JSON.stringify(bot));
            multi.sAdd(KEY.idsSet, uid);
            await multi.exec();

            return { id: uid };
        },

        async list() {
            const uids = await redisClient.sMembers(KEY.idsSet);
            if (!uids.length) return { items: [] };
            const items = await Promise.all(
                uids.map(async uid => {
                    const raw = await redisClient.get(botKey(uid));
                    return raw ? JSON.parse(raw) : null;
                })
            );
            return { items: items.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id)) };
        },

        async get({ uid }) {
            if (!uid) throw jsonrpc.MISSING_PARAM('uid');
            return getBot(uid);
        },

        async update({ uid, permit, desc }) {
            if (!uid) throw jsonrpc.MISSING_PARAM('uid');
            assertPermitSafe(permit);
            const bot = await getBot(uid);
            if (permit !== undefined) bot.permit = permit;
            if (desc !== undefined) bot.desc = desc;
            bot.updatedAt = new Date().toISOString();
            await redisClient.set(botKey(uid), JSON.stringify(bot));
            return { id: uid };
        },

        async remove({ uid }) {
            if (!uid) throw jsonrpc.MISSING_PARAM('uid');
            await getBot(uid); // throws if not found
            const multi = redisClient.multi();
            multi.del(botKey(uid));
            multi.sRem(KEY.idsSet, uid);
            await multi.exec();
            return { id: uid };
        },

        // ── TOKEN OPERATIONS ─────────────────────────────────────────────────

        /**
         * Admin issues an initial token for a bot account (Bootstrap step).
         * Called from portal/system Bot Accounts page.
         */
        async issueToken({ uid }) {
            if (!uid) throw jsonrpc.MISSING_PARAM('uid');
            const bot = await getBot(uid);
            if (bot.status !== 'ACTIVE') throw jsonrpc.INVALID_PARAMS(`Bot "${uid}" is not active`);

            const { token, expiresAt, sessionData } = issueSession(uid, bot.permit);
            await persistSession(uid, token, sessionData);

            // §7.6 risk-1 mitigation: every bot token issuance is recorded so
            // anomalous frequency can be detected and individual events traced.
            // Token jti = first 12 hex chars (enough to disambiguate, not full secret).
            const issuer = walContext.getStore()?.uid || null;
            const tokenJti = token.slice(0, 12);
            try {
                logger.insert(`BOT:ISSUE_TOKEN:${uid}`, {
                    op: 'bot.issue.token',
                    bot: uid,
                    issuer,
                    tokenJti,
                    expiresAt,
                    stamp: Date.now(),
                });
            } catch (e) {
                console.error(`[bot.audit] Failed to log token issuance for ${uid}: ${e.message}`);
            }

            return { token, expiresAt };
        },

        /**
         * Bot service refreshes its own token (called by library/relay.js via Router).
         * Caller identity is enforced by Router: req.user.user === the bot's uid.
         *
         * @why Implementing caller.uid === token.sub check: Router already validates
         *      the session and injects x-router-token with the caller's uid.
         *      So req.user.user IS the token's sub — the check is structurally enforced.
         */
        async tokenRefresh(params, callerUid) {
            if (!callerUid) throw jsonrpc.UNAUTHORIZED();
            const bot = await getBot(callerUid).catch(() => null);
            if (!bot || bot.type !== 'bot') {
                throw jsonrpc.INVALID_PARAMS('token.refresh is only available to bot accounts');
            }
            if (bot.status !== 'ACTIVE') {
                throw jsonrpc.INVALID_PARAMS(`Bot "${callerUid}" is not active`);
            }

            const { token, expiresAt, sessionData } = issueSession(callerUid, bot.permit);
            await persistSession(callerUid, token, sessionData);
            return { token, expiresAt };
        },

        /**
         * Admin: revoke ALL live session tokens of a uid (leak response / deactivate a bot).
         * security.md option (b): reads the USER:SESSIONS:{uid} reverse index, DELs each
         * session:{token}, then clears the index. Any later request with those tokens
         * resolves to guest at the Router (session key gone) → rejected immediately.
         */
        async revoke({ uid }) {
            if (!uid) throw jsonrpc.MISSING_PARAM('uid');
            const revoked = await killSessions(uid);

            const issuer = walContext.getStore()?.uid || null;
            try {
                logger.insert(`BOT:REVOKE_TOKEN:${uid}`, {
                    op: 'token.revoke', target: uid, issuer, revoked, stamp: Date.now(),
                });
            } catch (e) {
                console.error(`[bot.audit] Failed to log token revoke for ${uid}: ${e.message}`);
            }
            return { uid, revoked };
        },

        // ── REVERSIBLE SUSPENSION ────────────────────────────────────────────
        // The gap this closes: stopping a bot used to mean delete (destructive) or
        // revoke (defeated by self-refresh — a still-ACTIVE bot just re-issues).
        // suspend = status gate + kill live sessions: refresh/issue are blocked by
        // the existing ACTIVE read-gates, and the Router's Scheme F lookup rejects
        // any session of a non-ACTIVE bot immediately. Fully reversible via resume.

        async suspend({ uid }) {
            if (!uid) throw jsonrpc.MISSING_PARAM('uid');
            const bot = await getBot(uid);
            if (bot.status === 'SUSPENDED') return { id: uid, status: 'SUSPENDED', revoked: 0 };

            bot.status = 'SUSPENDED';
            bot.updatedAt = new Date().toISOString();
            await redisClient.set(botKey(uid), JSON.stringify(bot));
            const revoked = await killSessions(uid);

            const issuer = walContext.getStore()?.uid || null;
            try {
                logger.insert(`BOT:SUSPEND:${uid}`, {
                    op: 'bot.suspend', target: uid, issuer, revoked, stamp: Date.now(),
                });
            } catch (e) {
                console.error(`[bot.audit] Failed to log suspend for ${uid}: ${e.message}`);
            }
            return { id: uid, status: 'SUSPENDED', revoked };
        },

        async resume({ uid }) {
            if (!uid) throw jsonrpc.MISSING_PARAM('uid');
            const bot = await getBot(uid);
            if (bot.status === 'ACTIVE') return { id: uid, status: 'ACTIVE' };

            bot.status = 'ACTIVE';
            bot.updatedAt = new Date().toISOString();
            await redisClient.set(botKey(uid), JSON.stringify(bot));

            const issuer = walContext.getStore()?.uid || null;
            try {
                logger.insert(`BOT:SUSPEND:${uid}`, {
                    op: 'bot.resume', target: uid, issuer, stamp: Date.now(),
                });
            } catch (e) {
                console.error(`[bot.audit] Failed to log resume for ${uid}: ${e.message}`);
            }
            // Sessions were revoked at suspend time — admin re-issues a token
            // (user.bot.issue.token + {svc}.token.set) to bring the bot back online.
            return { id: uid, status: 'ACTIVE' };
        },
    };

    // Kill every live session of a uid via the USER:SESSIONS reverse index.
    // Shared by revoke (leak response) and suspend (reversible stop).
    async function killSessions(uid) {
        const idxKey = userSessionsKey(uid);
        const tokens = await redisClient.sMembers(idxKey);
        let revoked = 0;
        if (tokens.length) {
            const multi = redisClient.multi();
            for (const t of tokens) multi.del(sessionKey(t));
            const res = await multi.exec();
            revoked = res.filter((r) => r === 1).length;   // count actually-live sessions killed
        }
        await redisClient.del(idxKey);
        return revoked;
    }
};
