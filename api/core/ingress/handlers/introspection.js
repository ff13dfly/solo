/**
 * Service Capability Registry (Introspection)
 *
 * @attention Declaration here MUST stay in sync with the handler registration
 *            in index.js (CLAUDE.md §5 red line). All management methods are
 *            admin-only; the inbound /ingest endpoint is NOT an RPC method
 *            (raw HTTP, authenticated by per-source API key) and is not listed.
 */

// --- RETURN CONTRACT VOCABULARY (returns_schema) ---
//
// `returns` (flat key list) stays as the legacy AI-discovery hint the Router advertises.
// `returns_schema` is the typed, machine-checkable contract (library/contract.js dialect,
// same rule-items as `params`). `required:true` is set ONLY for keys present on EVERY
// non-throwing path; nullable / branch-conditional keys carry a type but are NOT required.
//
// SOURCE_RETURN — the shape of a presented source entity (logic/source.js present()):
// the Entity-Factory record (id/status/createdAt/updatedAt + declared fields) with keyHash
// STRIPPED and a derived `stream` ATTACHED. Used by create/update/enable/disable/get.
// NOTE: get()/update()/enable()/disable() NEVER return null — entity.get throws NOT_FOUND on a
// missing record (so a not-found is a THROW, not a non-throwing path). Every success object
// therefore carries the full Entity-Factory record, so the always-set keys are required.
// `lastFiredAt` is declared-but-nullable (null until first fire — present as a key, null value,
// so NOT required: checkParams rejects null on a required key). `healthUrl` is fully optional
// (only present when the source was created/updated with one).
const SOURCE_RETURN = [
    { name: 'id',          type: 'string',  required: true },
    { name: 'name',        type: 'string',  required: true },   // unique source name
    { name: 'enabled',     type: 'boolean', required: true },   // toggle
    { name: 'dedupTtlSec', type: 'number',  required: true },   // dedup window seconds
    { name: 'status',      type: 'string',  required: true },   // ENTITY lifecycle: ACTIVE (softDelete=false → no DELETED)
    { name: 'hitCount',    type: 'number',  required: true },   // accepted deliveries
    { name: 'dupCount',    type: 'number',  required: true },   // dropped duplicates
    { name: 'rejectCount', type: 'number',  required: true },   // dataSchema violations, held for review
    { name: 'createdAt',   type: 'number',  required: true },
    { name: 'updatedAt',   type: 'number',  required: true },
    { name: 'stream',      type: 'string',  required: true },   // derived EVENT:WEBHOOK:{NAME_UPPER}
    { name: 'lastFiredAt', type: 'number' },                    // null until first fire (declared-but-nullable)
    { name: 'healthUrl',   type: 'string' },                    // optional; only present when set
    { name: 'dataSchema',  type: 'array' },                     // optional; checkParams dialect, whitelists+types data fields
];

const methods = [
    // Inbound delivery — PUBLIC (listener → Router → here). Auth is the per-source
    // API key in the forwarded Authorization header, validated inside ingress; not
    // permit-gated (public bypasses checkAccess). params = { request_id, data }.
    // Returns `result.body` of ingest.handle — a UNION over 6 paths: only `ok`
    // (boolean) is always present. `error` on reject paths (401/403/400/422); `request_id`
    // on accept+duplicate; `stream` ONLY on accept; `duplicate:true` ONLY on dedup hit;
    // `violations` ONLY on the 422 dataSchema-rejected path (held in the review queue).
    { name: 'ingress.ingest', params: [{ name: 'request_id', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'data', type: 'object' }], returns: ['ok'], returns_schema: [
        { name: 'ok',         type: 'boolean', required: true }, // true on accept/duplicate, false on reject
        { name: 'stream',     type: 'string' },   // accept path only
        { name: 'request_id', type: 'string' },   // accept + duplicate paths
        { name: 'duplicate',  type: 'boolean' },  // dedup-hit path only
        { name: 'error',      type: 'string' },   // reject paths (invalid key / disabled / invalid body / dataSchema violation)
        { name: 'violations', type: 'array' },    // 422 dataSchema-rejected path only
    ], description: 'Ingest a normalized inbound delivery from a listener (API key in Authorization header)', ai: false, public: true },

    // Source (inbound webhook) management — admin only
    // dataSchema (create/update): optional array, checkParams flat dialect
    // ({name, type?, required?, pattern?, minLength?, maxLength?}) — whitelists+types
    // the `data` fields ingest.js forwards onto the event bus (toFix.md AI-injection
    // defense). Omitted/[] = opaque pass-through (today's behavior, unchanged).
    { name: 'ingress.source.create',     params: [{ name: 'name', type: 'string', required: true, maxLength: 128 }, { name: 'dedupTtlSec', type: 'number' }, { name: 'dataSchema', type: 'array' }], returns: ['id', 'name', 'apiKey', 'stream'], returns_schema: [
        ...SOURCE_RETURN,
        { name: 'apiKey', type: 'string', required: true }, // one-time plaintext key; only create + rotate return it
    ], description: 'Register an inbound source; returns one-time API key', ai: false },
    { name: 'ingress.source.get',        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id', 'name', 'enabled', 'stream'], returns_schema: SOURCE_RETURN, description: 'Get a source (API key never returned; throws NOT_FOUND when missing)', ai: false },
    { name: 'ingress.source.list',       params: [{ name: 'page', type: 'number' }, { name: 'pageSize', type: 'number' }], returns: ['items', 'total'], returns_schema: [{ name: 'items', type: 'array', required: true }, { name: 'total', type: 'number', required: true }], description: 'List inbound sources', ai: false },
    { name: 'ingress.source.update',     params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'dataSchema', type: 'array' }], returns: ['id', 'name', 'enabled'], returns_schema: SOURCE_RETURN, description: 'Update source fields (name / dedupTtlSec / enabled / healthUrl / dataSchema)', ai: false },
    { name: 'ingress.source.enable',     params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id', 'enabled'], returns_schema: SOURCE_RETURN, description: 'Enable a source', ai: false },
    { name: 'ingress.source.disable',    params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id', 'enabled'], returns_schema: SOURCE_RETURN, description: 'Disable a source (downstream unaffected)', ai: false },
    { name: 'ingress.source.key.rotate', params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id', 'apiKey'], returns_schema: [{ name: 'id', type: 'string', required: true }, { name: 'apiKey', type: 'string', required: true }], description: 'Rotate API key; returns new key once', ai: false },
    { name: 'ingress.source.delete',     params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id'], returns_schema: [{ name: 'id', type: 'string', required: true }], description: 'Delete a source', ai: false },
    // test-fire (ingest.testFire): always { ok:true, stream, request_id } on success (throws NOT_FOUND otherwise).
    { name: 'ingress.source.test',       params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'data', type: 'object' }], returns: ['ok', 'stream', 'request_id'], returns_schema: [
        { name: 'ok',         type: 'boolean', required: true },
        { name: 'stream',     type: 'string',  required: true },
        { name: 'request_id', type: 'string',  required: true },
    ], description: 'Fire a synthetic webhook.received event (skips dedup)', ai: false },

    // Delivery audit log (admin) — daily jsonl, newest-first
    { name: 'ingress.log.recent', params: [{ name: 'limit', type: 'number' }, { name: 'source', type: 'string', maxLength: 64, pattern: 'id' }, { name: 'outcome', type: 'string', maxLength: 64 }, { name: 'days', type: 'number' }], returns: ['items', 'total'], returns_schema: [{ name: 'items', type: 'array', required: true }, { name: 'total', type: 'number', required: true }], description: 'Recent inbound delivery audit entries (admin)', ai: false },

    // dataSchema-rejected deliveries held for human review (admin) — bounded Redis
    // list, logic/review.js. Items: {reviewId, sourceId, source, requestId, data,
    // violations, rejectedAt} — untyped array here (same convention as log.recent).
    { name: 'ingress.review.list', params: [{ name: 'page', type: 'number' }, { name: 'pageSize', type: 'number' }], returns: ['items', 'total'], returns_schema: [{ name: 'items', type: 'array', required: true }, { name: 'total', type: 'number', required: true }], description: 'List deliveries held for human review (dataSchema violations)', ai: false },
    { name: 'ingress.review.approve', params: [{ name: 'reviewId', type: 'string', required: true, maxLength: 32 }], returns: ['ok', 'stream', 'request_id'], returns_schema: [
        { name: 'ok',         type: 'boolean', required: true },
        { name: 'reviewId',   type: 'string',  required: true },
        { name: 'stream',     type: 'string',  required: true },
        { name: 'request_id', type: 'string',  required: true },
    ], description: 'Human reviewed a held delivery and approved it — emits it now (bypasses dataSchema; throws NOT_FOUND if already resolved)', ai: false },
    { name: 'ingress.review.discard', params: [{ name: 'reviewId', type: 'string', required: true, maxLength: 32 }], returns: ['ok'], returns_schema: [
        { name: 'ok',       type: 'boolean', required: true },
        { name: 'reviewId', type: 'string',  required: true },
    ], description: 'Human reviewed a held delivery and discarded it — never emitted (throws NOT_FOUND if already resolved)', ai: false },

    // Relay token lifecycle (admin) — security.md §7.7
    { name: 'ingress.token.set',    params: [{ name: 'token', type: 'string', maxLength: 512 }], returns: ['ok'], returns_schema: [{ name: 'ok', type: 'boolean', required: true }], description: 'Set the relay bot token (admin)', ai: false },
    // relay.status(): { hasToken } always; sub/expiresAt/ttlMs/lastRefreshAt/needsRotation/expired only when a token exists.
    { name: 'ingress.token.status', params: [], returns: ['hasToken'], returns_schema: [
        { name: 'hasToken',      type: 'boolean', required: true },
        { name: 'sub',           type: 'string' },
        { name: 'expiresAt',     type: 'number' },
        { name: 'ttlMs',         type: 'number' },
        { name: 'lastRefreshAt', type: 'number' },
        { name: 'needsRotation', type: 'boolean' },
        { name: 'expired',       type: 'boolean' },
    ], description: 'Relay token status (admin)', ai: false },
    { name: 'ingress.token.clear',  params: [], returns: ['ok'], returns_schema: [{ name: 'ok', type: 'boolean', required: true }], description: 'Clear the relay bot token (admin)', ai: false },

    // System
    { name: 'ping',     params: [], returns: ['status', 'version', 'uptime'], description: 'Health check', ai: true },
    { name: 'methods',  params: [], description: 'Get surface area definition', ai: false },
    { name: 'entities', params: [], description: 'Get entity definitions', ai: false }
];

module.exports = methods;
