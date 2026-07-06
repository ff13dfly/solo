/**
 * In-memory stand-in for the node-redis commands the string-mode Entity Factory
 * uses: set (incl. { NX }), get, del, sAdd, sRem, sMembers, mGet, and multi().
 * Lets the approval record logic be tested hermetically (no Redis server).
 */
function makeFakeRedis() {
    const kv = new Map();
    const sets = new Map();
    const getSet = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));

    function applyOp(op) {
        if (op.t === 'set') kv.set(op.k, op.v);
        else if (op.t === 'sAdd') getSet(op.k).add(op.m);
        else if (op.t === 'del') kv.delete(op.k);
        else if (op.t === 'sRem') getSet(op.k).delete(op.m);
    }

    return {
        _kv: kv,
        _sets: sets,

        async set(k, v, opts = {}) {
            if (opts.NX && kv.has(k)) return null;
            kv.set(k, v);
            return 'OK';
        },
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async del(k) { return kv.delete(k) ? 1 : 0; },
        async sAdd(k, m) { const s = getSet(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        async sRem(k, m) { return getSet(k).delete(m) ? 1 : 0; },
        async sMembers(k) { return [...getSet(k)]; },
        async mGet(keys) { return keys.map(k => (kv.has(k) ? kv.get(k) : null)); },

        multi() {
            const ops = [];
            const chain = {
                set(k, v) { ops.push({ t: 'set', k, v }); return chain; },
                sAdd(k, m) { ops.push({ t: 'sAdd', k, m }); return chain; },
                del(k) { ops.push({ t: 'del', k }); return chain; },
                sRem(k, m) { ops.push({ t: 'sRem', k, m }); return chain; },
                async exec() { ops.forEach(applyOp); return ops.map(() => 'OK'); },
            };
            return chain;
        },
    };
}

module.exports = { makeFakeRedis };
