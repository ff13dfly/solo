/**
 * sessions.js — the ONE place that knows how a live session is persisted and killed.
 *
 * @why Active revocation only works if EVERY minting path writes the
 *      `USER:SESSIONS:{uid}` reverse index that killSessions() reads. That invariant
 *      was held by bot.js and passport.js but silently not by the human login path,
 *      so `user.token.revoke` deleted 0 sessions and returned success for every
 *      browser account — a security switch that reports success while doing nothing
 *      (docs/feedback/account-deletion-does-not-revoke-live-sessions.md).
 *      Three private copies of the same five lines is what let the third one drift;
 *      this module exists so there is one copy to be right.
 * @attention Minting a session anywhere other than persistSession() re-opens that
 *      hole, and it re-opens it SILENTLY — the session works, only revocation misses it.
 */
module.exports = (redisClient, config) => {
    const sessionKey      = (token) => `${config.redis.sessionPrefix}${token}`;
    const userSessionsKey = (uid)   => `${config.redis.userSessionsPrefix}${uid}`;

    /**
     * Persist a session AND index it under the uid so it can be actively revoked.
     * The reverse-index set carries the same TTL (refreshed on each issue) to bound
     * growth; stale token refs are harmless — DEL on an already-expired session is a no-op.
     */
    async function persistSession(uid, token, ttlSec, sessionData) {
        const multi = redisClient.multi();
        multi.setEx(sessionKey(token), ttlSec, JSON.stringify(sessionData));
        multi.sAdd(userSessionsKey(uid), token);
        multi.expire(userSessionsKey(uid), ttlSec);
        await multi.exec();
    }

    /**
     * Kill every live session of a uid via the reverse index.
     * Shared by bot revoke/suspend, passport retirement and account remove/destroy —
     * deleting an account MUST imply revoking its sessions.
     */
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

    return { sessionKey, userSessionsKey, persistSession, killSessions };
};
