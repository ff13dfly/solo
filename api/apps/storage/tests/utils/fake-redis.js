/**
 * Shared in-memory fake Redis for storage's hermetic tests (asset-authz + returns-contract).
 * Extracted when both files needed the same upgrade at once: logic/asset.js's visibility
 * indexes + keyword chunking exercise zUnionStore/zScore/mGet/incr/decr/exists/expire and a
 * zRange that supports BOTH calling conventions real node-redis exposes —
 *   - rank-based:  zRange(key, start, stop, { REV })
 *   - score-based: zRange(key, min, max, { BY: 'SCORE', REV, LIMIT: { offset, count } })
 *     (note: with REV, the first bound is the score UPPER bound, second is LOWER —
 *     mirrors real Redis's ZRANGE ... BYSCORE REV wire order, verified against a live
 *     Redis before relying on it in logic/asset.js.)
 */
function makeFakeRedis() {
    const kv = new Map();
    const zsets = new Map();
    const zOf = (k) => { if (!zsets.has(k)) zsets.set(k, new Map()); return zsets.get(k); };

    function parseBound(raw) {
        if (raw === '+inf') return { val: Infinity, excl: false };
        if (raw === '-inf') return { val: -Infinity, excl: false };
        if (typeof raw === 'string' && raw.startsWith('(')) return { val: Number(raw.slice(1)), excl: true };
        return { val: Number(raw), excl: false };
    }

    return {
        async get(key) { return kv.has(key) ? kv.get(key) : null; },
        async set(key, val, opts = {}) {
            if (opts.NX && kv.has(key)) return null;
            kv.set(key, val);
            return 'OK';
        },
        async del(key) {
            const had = kv.delete(key) || zsets.delete(key);
            return had ? 1 : 0;
        },
        async exists(key) { return (kv.has(key) || zsets.has(key)) ? 1 : 0; },
        async expire() { return 1; },
        async mGet(keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
        async incr(key) { const n = (Number(kv.get(key)) || 0) + 1; kv.set(key, String(n)); return n; },
        async decr(key) { const n = (Number(kv.get(key)) || 0) - 1; kv.set(key, String(n)); return n; },

        async zAdd(key, { score, value }) { zOf(key).set(value, score); return 1; },
        async zRem(key, value) { const m = zsets.get(key); return m && m.delete(value) ? 1 : 0; },
        async zCard(key) { return (zsets.get(key) || new Map()).size; },
        async zScore(key, member) {
            const m = zsets.get(key);
            return m && m.has(member) ? m.get(member) : null;
        },

        async zRange(key, a, b, opts = {}) {
            const entries = [...(zsets.get(key) || new Map()).entries()]; // [value, score]

            if (opts.BY === 'SCORE') {
                const first = parseBound(a);
                const second = parseBound(b);
                // REV: first arg is the max bound, second is the min (real Redis wire order).
                const { min, max } = opts.REV ? { min: second, max: first } : { min: first, max: second };
                let filtered = entries.filter(([, score]) => {
                    const minOk = min.excl ? score > min.val : score >= min.val;
                    const maxOk = max.excl ? score < max.val : score <= max.val;
                    return minOk && maxOk;
                });
                filtered.sort((x, y) => x[1] - y[1]);
                if (opts.REV) filtered.reverse();
                if (opts.LIMIT) filtered = filtered.slice(opts.LIMIT.offset, opts.LIMIT.offset + opts.LIMIT.count);
                return filtered.map(([v]) => v);
            }

            // Rank-based (a/b are integer indexes, -1 means "to the end").
            let sorted = entries.slice().sort((x, y) => x[1] - y[1]).map(([v]) => v);
            if (opts.REV) sorted.reverse();
            const end = b === -1 ? sorted.length - 1 : b;
            return sorted.slice(a, end + 1);
        },

        async zUnionStore(dest, keys, opts = {}) {
            const merged = new Map();
            for (const k of keys) {
                for (const [value, score] of (zsets.get(k) || new Map()).entries()) {
                    if (!merged.has(value)) { merged.set(value, score); continue; }
                    const prev = merged.get(value);
                    const agg = opts.AGGREGATE || 'SUM';
                    merged.set(value, agg === 'MAX' ? Math.max(prev, score) : agg === 'MIN' ? Math.min(prev, score) : prev + score);
                }
            }
            zsets.set(dest, merged);
            return merged.size;
        },
    };
}

module.exports = { makeFakeRedis };
