/**
 * session-migrate.js — one-shot, at user-service boot: bring sessions minted by older code
 * under the current revocation model. Guarded by a marker, so it runs once per database.
 *
 * @why Two kinds of live token predate the fixes and are otherwise out of reach until they
 *      expire — and admin/operator tokens never expire while in use (the Router slides them):
 *   1. Sessions missing from USER:SESSIONS:{uid}. Human logins were never indexed before
 *      v1.2.16, and later ones fell out when the index TTL lapsed under a sliding session.
 *      user.token.revoke cannot see them. ⇒ index them (and drop the index TTL).
 *   2. Passport sessions whose anchor is reserved (logic/anchors.js): minted before issuance
 *      refused such anchors, they resolve at the Router as the internal account or bot whose
 *      id they share. ⇒ delete them.
 *   (docs/planning/security.md, 2026-09-27)
 * @attention Never blocks boot: the caller logs a failure and the marker stays unset, so the
 *      next boot retries. Idempotent (SADD / DEL), safe with several user instances racing.
 */
const { isReservedAnchor } = require('./anchors');

const MARKER = 'USER:SESSIONS:MIGRATED:v1';

async function migrateLiveSessions(redisClient, config) {
    if (await redisClient.get(MARKER)) return null;

    const prefix = config.redis.sessionPrefix;
    const idxKey = (uid) => `${config.redis.userSessionsPrefix}${uid}`;
    let indexed = 0, purged = 0, skipped = 0;

    // node-redis v5 scanIterator yields BATCHES (arrays) of keys.
    for await (const batch of redisClient.scanIterator({ MATCH: `${prefix}*`, COUNT: 500 })) {
        for (const key of [].concat(batch)) {
            let s;
            try { s = JSON.parse(await redisClient.get(key)); } catch { skipped++; continue; }
            if (!s || typeof s.uid !== 'string' || !s.uid) { skipped++; continue; }   // e.g. administrator sessions carry no uid
            const token = key.slice(prefix.length);
            const external = s.type === 'external' || s.kind === 'external';

            if (external && await isReservedAnchor(redisClient, s.uid)) {
                await redisClient.del(key);
                purged++;
                continue;
            }
            await redisClient.sAdd(idxKey(s.uid), token);
            // Passport indexes keep their own TTL: those sessions never slide (fixed 24h).
            if (!external) await redisClient.persist(idxKey(s.uid));
            indexed++;
        }
    }

    await redisClient.set(MARKER, new Date().toISOString());
    return { indexed, purged, skipped };
}

module.exports = { migrateLiveSessions, MARKER };
