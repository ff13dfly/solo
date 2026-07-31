/**
 * Map-backed fake Redis with the Entity-Factory command surface (string storage).
 *
 * Shared by the gateway hermetic suites so the fake lives in ONE place: gateway entities
 * (smtp / email_template / sms_template) are string-storage, so no RedisJSON is needed,
 * and no xAdd → library/logger falls back to its best-effort WAL file path.
 */
function makeFakeRedis() {
    const kv = new Map();
    const sets = new Map();
    const zsets = new Map();
    const counters = new Map();
    const getSet = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));
    const getZset = (k) => (zsets.has(k) ? zsets.get(k) : zsets.set(k, new Map()).get(k));
    const apply = {
        set: (k, v, opts) => { if (opts && opts.NX && kv.has(k)) return null; kv.set(k, v); return 'OK'; },
        sAdd: (k, m) => { const s = getSet(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        del: (k) => { const had = kv.delete(k); sets.delete(k); return had ? 1 : 0; },
        sRem: (k, m) => { const s = sets.get(k); return s && s.delete(m) ? 1 : 0; },
        zAdd: (k, { score, value }) => { getZset(k).set(value, score); return 1; },
        zRem: (k, m) => { const z = zsets.get(k); return z && z.delete(m) ? 1 : 0; },
    };
    return {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v, opts) { return apply.set(k, v, opts); },
        async del(k) { return apply.del(k); },
        async mGet(keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
        async sAdd(k, m) { return apply.sAdd(k, m); },
        async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
        async sRem(k, m) { return apply.sRem(k, m); },
        async sIsMember(k, m) { return sets.has(k) && sets.get(k).has(m) ? 1 : 0; },
        async sCard(k) { return sets.has(k) ? sets.get(k).size : 0; },
        async incr(k) { const n = (counters.get(k) || 0) + 1; counters.set(k, n); return n; },
        async zAdd(k, entry) { return apply.zAdd(k, entry); },
        async zRem(k, m) { return apply.zRem(k, m); },
        async zCard(k) { return zsets.has(k) ? zsets.get(k).size : 0; },
        multi() {
            const ops = [];
            const chain = {
                set(k, v, opts) { ops.push(['set', k, v, opts]); return chain; },
                sAdd(k, m) { ops.push(['sAdd', k, m]); return chain; },
                del(k) { ops.push(['del', k]); return chain; },
                sRem(k, m) { ops.push(['sRem', k, m]); return chain; },
                zAdd(k, entry) { ops.push(['zAdd', k, entry]); return chain; },
                zRem(k, m) { ops.push(['zRem', k, m]); return chain; },
                async exec() { return ops.map(([op, ...args]) => apply[op](...args)); },
            };
            return chain;
        },
    };
}

/** Silent logger — the send paths call logger.info/warn. */
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, setRedis() {} };

module.exports = { makeFakeRedis, silentLogger };
