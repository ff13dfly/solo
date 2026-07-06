/**
 * In-memory stand-in for the slice of node-redis (incl. RedisJSON) that the
 * orchestrator engine touches. Lets the harness run hermetically — no Redis
 * server, no RedisJSON module required.
 *
 * Supported commands (add more here as the engine starts using them):
 *   json.set(key, '$', value, { NX })   json.get(key)   json.del(key)
 *   get / set / del                     keys(pattern)    xAdd(stream, id, fields)
 *
 * Internals are exposed (_docs / _kv / streams) so tests can assert on stored
 * state and emitted stream events.
 */
function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function makeFakeRedis() {
    const docs = new Map();   // RedisJSON documents
    const kv = new Map();     // plain string keys
    const streams = {};       // stream name -> [{ id, fields }]
    const sets = new Map();   // key -> Set (SADD/SMEMBERS — workflow id index)

    function matchKeys(pattern) {
        const all = [...docs.keys(), ...kv.keys()];
        if (pattern.endsWith('*')) {
            const prefix = pattern.slice(0, -1);
            return all.filter(k => k.startsWith(prefix));
        }
        return all.filter(k => k === pattern);
    }

    return {
        // exposed for assertions
        _docs: docs,
        _kv: kv,
        _sets: sets,
        streams,

        json: {
            async set(key, _path, value, opts = {}) {
                // orchestrator only ever sets the root path ('$')
                if (opts.NX && docs.has(key)) return null;
                if (opts.XX && !docs.has(key)) return null;
                docs.set(key, clone(value));
                return 'OK';
            },
            async get(key) {
                return docs.has(key) ? clone(docs.get(key)) : null;
            },
            async del(key) {
                return docs.delete(key) ? 1 : 0;
            },
        },

        async get(key) {
            return kv.has(key) ? kv.get(key) : null;
        },
        async set(key, value) {
            kv.set(key, value);
            return 'OK';
        },
        // INCR/EXPIRE — for the §3.4 submission-quota counter (TTL not simulated).
        async incr(key) {
            const n = (parseInt(kv.get(key) || '0', 10) || 0) + 1;
            kv.set(key, String(n));
            return n;
        },
        async expire() { return 1; },
        async del(key) {
            let n = 0;
            if (docs.delete(key)) n++;
            if (kv.delete(key)) n++;
            if (sets.delete(key)) n++;
            return n;
        },
        async keys(pattern) {
            return matchKeys(pattern);
        },
        async xAdd(stream, id, fields) {
            const arr = (streams[stream] ||= []);
            const entryId = id === '*' ? `${Date.now()}-${arr.length}` : id;
            arr.push({ id: entryId, fields });
            return entryId;
        },

        // Set ops (workflow id index)
        async sAdd(key, member) {
            let s = sets.get(key);
            if (!s) { s = new Set(); sets.set(key, s); }
            const members = Array.isArray(member) ? member : [member];
            let added = 0;
            for (const m of members) if (!s.has(m)) { s.add(m); added++; }
            return added;
        },
        async sMembers(key) {
            return [...(sets.get(key) || [])];
        },
        async sRem(key, member) {
            const s = sets.get(key);
            if (!s) return 0;
            const members = Array.isArray(member) ? member : [member];
            let n = 0;
            for (const m of members) if (s.delete(m)) n++;
            return n;
        },
        async sIsMember(key, member) {
            return (sets.get(key) || new Set()).has(member);
        },
    };
}

module.exports = { makeFakeRedis, clone };
