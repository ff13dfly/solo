/**
 * sessions.js — the ONE place that knows how a live session is persisted and killed.
 *
 * @why Active revocation only works if EVERY minting path writes the
 *      `USER:SESSIONS:{uid}` reverse index that killSessions() reads. That invariant
 *      was held by bot.js and passport.js but silently not by the human login path,
 *      so `user.token.revoke` deleted 0 sessions and returned success for every
 *      browser account — a security switch that reports success while doing nothing
 *      (docs/feedback/done/account-deletion-does-not-revoke-live-sessions.md).
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
     *
     * The index carries NO TTL. It used to share the session's TTL, refreshed only when this uid
     * minted another session — but the Router slides admin/operator sessions on every request,
     * so a token in continuous use outlived its index entry after a week: token.revoke then
     * returned `revoked: 0` and the leaked admin token kept working (docs/planning/security.md,
     * 2026-09-27). PERSIST also clears a TTL left on an existing index by older code.
     *
     * Who deletes the index: killSessions (revoke / suspend / account remove & destroy) drops
     * it whole; every mint prunes members whose session is already gone, so it stays bounded
     * by the uid's live sessions. A uid that never mints again keeps one small set.
     */
    async function persistSession(uid, token, ttlSec, sessionData) {
        const multi = redisClient.multi();
        multi.setEx(sessionKey(token), ttlSec, JSON.stringify(sessionData));
        multi.sAdd(userSessionsKey(uid), token);
        multi.persist(userSessionsKey(uid));
        await multi.exec();
        await pruneIndex(uid);
    }

    /** Drop index members whose session key no longer exists (expired or deleted). */
    async function pruneIndex(uid) {
        const idxKey = userSessionsKey(uid);
        const tokens = await redisClient.sMembers(idxKey);
        if (!tokens.length) return 0;
        const multi = redisClient.multi();
        for (const t of tokens) multi.exists(sessionKey(t));
        const alive = await multi.exec();
        const dead = tokens.filter((_, i) => Number(alive[i]) === 0);
        if (dead.length) await redisClient.sRem(idxKey, dead);
        return dead.length;
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

    return { sessionKey, userSessionsKey, persistSession, pruneIndex, killSessions };
};
