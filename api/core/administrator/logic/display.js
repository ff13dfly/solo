/**
 * logic/display.js — entity display-manifest store (Display Protocol §6, layer ②-B).
 *
 * @why operator renders entity lists/detail by configuration, not by per-project React
 *      forks. The presentation lives OUTSIDE the data services (API must not define UI);
 *      this is the deployment-level override store — a keyed document store:
 *        key   = `${service}_${entity}` (the same scope the operator's personal layer uses)
 *        value = an EntityDisplay manifest (JSON)
 *      operator boot-fetches list(), merges over its static base, personal prefs on top.
 *
 * @design A single Redis hash (SYSTEM:DISPLAY) — access is fetch-by-key + list-all only,
 *      no secondary-index queries, single-admin writes. So this deliberately does NOT use
 *      the entity factory (no WAL/optimistic-lock needed at v1; governance = lint-only).
 *      It graduates to entity.js if/when approval+audit governance lands (Display Protocol §5).
 *
 * @attention Server-side validation here is a STRUCTURAL + SAFETY guard only (shape, view
 *      whitelist, format enum, computed shape). FULL cross-service field-reference lint runs
 *      in the operator (`display.lint`), which holds the global introspection index. Keeping
 *      it client-side avoids administrator having to pull every service's schema.
 */
const jsonrpc = require('../handlers/jsonrpc');

const HASH = 'SYSTEM:DISPLAY';

const VIEW_MODES = ['table', 'card', 'gallery'];
const FORMAT_KINDS = [
    'text', 'number', 'percent', 'currency', 'bytes', 'bool',
    'datetime', 'relative-time', 'enum-badge', 'link', 'json',
];

/** Resolve the scope key from an explicit id, or service + entity. */
function scopeOf({ id, service, entity }) {
    if (id && typeof id === 'string') return id;
    if (service && entity) return `${service}_${entity}`;
    return null;
}

/**
 * Structural + safety validation. Returns { errors[], warnings[] }.
 * NOT a field-existence check — that's the operator-side lint against the live index.
 */
function validateManifest(m) {
    const errors = [];
    const warnings = [];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
        return { errors: ['manifest must be a JSON object'], warnings };
    }
    if (m.views !== undefined) {
        if (!Array.isArray(m.views) || m.views.some((v) => !VIEW_MODES.includes(v))) {
            errors.push(`views must be a subset of ${VIEW_MODES.join('/')}`);
        }
    }
    if (m.defaultView !== undefined) {
        if (!VIEW_MODES.includes(m.defaultView)) errors.push(`defaultView must be one of ${VIEW_MODES.join('/')}`);
        else if (Array.isArray(m.views) && !m.views.includes(m.defaultView)) errors.push('defaultView must be in views');
    }
    const fieldKeys = new Set();
    if (m.fields !== undefined) {
        if (!Array.isArray(m.fields)) errors.push('fields must be an array');
        else m.fields.forEach((f, i) => {
            if (!f || typeof f.key !== 'string' || !f.key) errors.push(`fields[${i}].key must be a non-empty string`);
            else fieldKeys.add(f.key);
            if (f && f.format !== undefined && !FORMAT_KINDS.includes(f.format)) {
                warnings.push(`fields[${i}].format "${f.format}" unknown — will fall back to text`);
            }
        });
    }
    if (m.computed !== undefined) {
        if (!Array.isArray(m.computed)) errors.push('computed must be an array');
        else m.computed.forEach((c, i) => {
            if (!c || typeof c.key !== 'string' || !c.key) errors.push(`computed[${i}].key must be a non-empty string`);
            else if (fieldKeys.has(c.key)) errors.push(`computed[${i}].key "${c.key}" collides with a real field`);
            if (!c || c.compute === undefined || typeof c.compute !== 'object') errors.push(`computed[${i}].compute must be a JsonLogic object`);
            if (c && c.format !== undefined && !FORMAT_KINDS.includes(c.format)) {
                warnings.push(`computed[${i}].format "${c.format}" unknown — will fall back to text`);
            }
        });
    }
    return { errors, warnings };
}

module.exports = (redis) => {
    /** One manifest by id or service+entity; null if unset. */
    async function get(params = {}) {
        const scope = scopeOf(params);
        if (!scope) throw jsonrpc.MISSING_PARAM('id (or service + entity)');
        const raw = await redis.hGet(HASH, scope);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (_) { return null; }
    }

    /** All manifests (operator boot). { items: [{ scope, manifest }] }. */
    async function list() {
        const all = (await redis.hGetAll(HASH)) || {}; // SAFE: small — one row per entity, bounded set
        const items = Object.entries(all).map(([scope, raw]) => {
            let manifest = null;
            try { manifest = JSON.parse(raw); } catch (_) { /* skip corrupt row */ }
            return { scope, manifest };
        }).filter((it) => it.manifest);
        return { items };
    }

    /** Upsert a manifest. Structural-validated; throws on errors, returns warnings. */
    async function set(params = {}) {
        if (!params.isAdmin) throw jsonrpc.UNAUTHORIZED();
        const scope = scopeOf(params);
        if (!scope) throw jsonrpc.MISSING_PARAM('id (or service + entity)');
        const manifest = params.manifest;
        if (!manifest || typeof manifest !== 'object') throw jsonrpc.INVALID_PARAM('manifest must be an object');
        const { errors, warnings } = validateManifest(manifest);
        if (errors.length) throw jsonrpc.INVALID_PARAM('manifest invalid: ' + errors.join('; '));
        await redis.hSet(HASH, scope, JSON.stringify(manifest));
        return { ok: true, scope, warnings };
    }

    /** Delete a manifest (reset that entity back to the static base). */
    async function del(params = {}) {
        if (!params.isAdmin) throw jsonrpc.UNAUTHORIZED();
        const scope = scopeOf(params);
        if (!scope) throw jsonrpc.MISSING_PARAM('id (or service + entity)');
        await redis.hDel(HASH, scope);
        return { ok: true, scope };
    }

    return { get, list, set, del, validateManifest };
};
