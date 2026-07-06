const crypto = require('crypto');
const createEntity = require('../../../library/entity');
const clock = require('../../../library/clock');
const jsonrpc = require('../handlers/jsonrpc');

const SCHEMA_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

// Shape-check a source's dataSchema at config time (not per-delivery) — same rule-item
// dialect library/validate.js checkParams speaks (toFix.md AI-injection defense: schema
// whitelists+types the fields ingest.js forwards onto the event bus).
function validateDataSchema(schema) {
    if (schema === undefined) return;
    if (!Array.isArray(schema)) throw jsonrpc.INVALID_PARAMS('dataSchema must be an array');
    for (const item of schema) {
        if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name) {
            throw jsonrpc.INVALID_PARAMS('dataSchema items must be objects with a non-empty string "name"');
        }
        if (item.type !== undefined && !SCHEMA_TYPES.has(item.type)) {
            throw jsonrpc.INVALID_PARAMS(`dataSchema item "${item.name}" has invalid type "${item.type}"`);
        }
    }
}

/**
 * Source logic — an inbound webhook source identified by an API key.
 *
 * API key handling (deliberately NOT reversible encryption):
 *   - On create/rotate we generate a random key, return it ONCE, and store only
 *     its SHA-256 hash. The plaintext key is never persisted — standard show-once
 *     API-key practice; a DB leak can't expose keys.
 *   - Auth lookup (hot path) is O(1) via a hash→id map:  INGRESS:KEYHASH:{hash}.
 *   - The hash is not secret, so no constant-time compare is needed (we look up
 *     by hash, we never byte-compare a stored secret).
 *
 * Name uniqueness: claimed with SET NX on INGRESS:NAME:{name}; the name maps to
 * the downstream stream EVENT:WEBHOOK:{NAME_UPPER}.
 */
module.exports = (redis, { config }) => {
    const C = config.ingest;
    const NAME_KEY = (name) => `INGRESS:NAME:${name}`;
    const KEYHASH_KEY = (hash) => `${C.keyHashPrefix}${hash}`;
    const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

    const entity = createEntity(redis, {
        serviceName: config.serviceName,
        entityName: 'source',
        idLength: config.idLengths.source,
        softDelete: false,
    });

    function streamFor(name) { return C.streamPrefix + name.toUpperCase(); }
    function hashKey(key)     { return crypto.createHash('sha256').update(key).digest('hex'); }
    function genKey()         { return 'ingk_' + crypto.randomBytes(24).toString('hex'); }

    // Strip internal/secret fields and attach derived stream for outward responses.
    function present(item) {
        if (!item) return item;
        const { keyHash, ...rest } = item;
        return { ...rest, stream: streamFor(item.name) };
    }

    async function create({ name, dedupTtlSec, healthUrl, dataSchema } = {}) {
        if (!name || !NAME_RE.test(name))
            throw jsonrpc.INVALID_PARAMS('name required, ^[a-zA-Z0-9_-]{1,64}$');
        validateDataSchema(dataSchema);

        const claimed = await redis.set(NAME_KEY(name), 'pending', { NX: true });
        if (claimed !== 'OK') throw jsonrpc.INVALID_PARAMS(`source name "${name}" already exists`);

        try {
            const apiKey = genKey();
            const keyHash = hashKey(apiKey);
            const created = await entity.create({
                name,
                keyHash,
                enabled: true,
                dedupTtlSec: (typeof dedupTtlSec === 'number' && dedupTtlSec > 0) ? dedupTtlSec : C.defaultDedupTtlSec,
                hitCount: 0,
                dupCount: 0,
                rejectCount: 0,
                lastFiredAt: null,
                ...(healthUrl && typeof healthUrl === 'string' ? { healthUrl } : {}),
                ...(Array.isArray(dataSchema) && dataSchema.length ? { dataSchema } : {}),
            });
            await redis.set(NAME_KEY(name), created.id);           // finalize name claim → id
            await redis.set(KEYHASH_KEY(keyHash), created.id);     // auth lookup map
            // apiKey returned ONCE here, never again.
            return { ...present(created), apiKey };
        } catch (e) {
            await redis.del(NAME_KEY(name));                       // release on failure
            throw e;
        }
    }

    async function get({ id } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        return present(await entity.get({ id }));
    }

    async function list({ page = 1, pageSize = config.pageSize } = {}) {
        // entity.list paginates by limit/offset.
        const limit = Math.max(1, pageSize);
        const offset = Math.max(0, (Math.max(1, page) - 1) * limit);
        const result = await entity.list({ limit, offset });
        result.items = (result.items || []).map(present);
        return result;
    }

    async function update({ id, name, dedupTtlSec, enabled, healthUrl, dataSchema } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        validateDataSchema(dataSchema);
        const current = await entity.get({ id });
        if (!current) throw jsonrpc.NOT_FOUND('source');

        const updates = {};
        if (name !== undefined && name !== current.name) {
            if (!NAME_RE.test(name)) throw jsonrpc.INVALID_PARAMS('invalid name');
            const claimed = await redis.set(NAME_KEY(name), id, { NX: true });
            if (claimed !== 'OK') throw jsonrpc.INVALID_PARAMS(`source name "${name}" already exists`);
            await redis.del(NAME_KEY(current.name));
            updates.name = name;
        }
        if (typeof dedupTtlSec === 'number' && dedupTtlSec > 0) updates.dedupTtlSec = dedupTtlSec;
        if (typeof enabled === 'boolean') updates.enabled = enabled;
        if (healthUrl !== undefined) updates.healthUrl = healthUrl || null;  // '' clears it
        // dataSchema: [] or null clears it (reverts to opaque pass-through); non-empty array sets it.
        if (dataSchema !== undefined) updates.dataSchema = (Array.isArray(dataSchema) && dataSchema.length) ? dataSchema : null;

        return present(await entity.update({ id, ...updates }));
    }

    async function setEnabled({ id }, enabled) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        return present(await entity.update({ id, enabled }));
    }

    async function rotateKey({ id } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const current = await entity.get({ id });
        if (!current) throw jsonrpc.NOT_FOUND('source');

        const apiKey = genKey();
        const keyHash = hashKey(apiKey);
        await entity.update({ id, keyHash });
        await redis.set(KEYHASH_KEY(keyHash), id);
        if (current.keyHash) await redis.del(KEYHASH_KEY(current.keyHash));   // invalidate old key
        return { id, apiKey };
    }

    async function del({ id } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const current = await entity.get({ id });
        if (current) {
            if (current.keyHash) await redis.del(KEYHASH_KEY(current.keyHash));
            await redis.del(NAME_KEY(current.name));
        }
        await entity.delete({ id });
        return { id };
    }

    // --- internal (used by ingest.js, not exposed over RPC) ---

    // Resolve a source from a raw API key. Returns the full entity (incl keyHash)
    // or null. Hot path: single hash + single GET + single entity load.
    async function resolveByKey(apiKey) {
        if (!apiKey || typeof apiKey !== 'string') return null;
        const id = await redis.get(KEYHASH_KEY(hashKey(apiKey)));
        if (!id) return null;
        return entity.get({ id });
    }

    // Record a delivery outcome (counter + lastFiredAt). outcome: 'accepted'(default)|
    // 'duplicate'|'rejected' (dataSchema violation, held for review — toFix.md AI-injection
    // defense; a source with a climbing rejectCount signals a misconfigured/hostile sender).
    async function recordFire(id, { outcome = 'accepted' } = {}) {
        const current = await entity.get({ id });
        if (!current) return;
        let updates;
        if (outcome === 'duplicate') updates = { dupCount: (current.dupCount || 0) + 1 };
        else if (outcome === 'rejected') updates = { rejectCount: (current.rejectCount || 0) + 1 };
        else updates = { hitCount: (current.hitCount || 0) + 1, lastFiredAt: clock.now() };
        await entity.update({ id, ...updates });
    }

    return {
        create, get, list, update,
        enable:  (p) => setEnabled(p, true),
        disable: (p) => setEnabled(p, false),
        rotateKey, delete: del,
        // internal
        resolveByKey, recordFire, streamFor,
    };
};
