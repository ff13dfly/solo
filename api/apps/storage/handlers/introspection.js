/**
 * Storage Service Capability Registry (Introspection)
 * @why Defines the reachable methods for the Router.
 *
 * RETURN CONTRACTS (returns_schema) — the typed, machine-checkable contract
 * (library/contract.js dialect, same rule-items as `params`). What the
 * return-contract test asserts and what orchestration/AI binds output shapes to.
 * `returns` (flat string array) stays as the legacy AI-discovery hint the Router
 * advertises; it is kept ⊆ returns_schema (the well-formedness sweep enforces no drift).
 *
 * Verified against logic/asset.js + index.js (2026-06-18). Key facts the schemas encode:
 *  - upload returns { ...metadata, url, thumbnails } on BOTH the dedup short-circuit
 *    (line 243) and the fresh-mint path (line 294). metadata = { id, originalName,
 *    mimeType, sha256, size, key, path, owner, visibility, createdAt }. `url` is always
 *    a string (store.resolveUrl). `thumbnails` is `undefined` unless thumbnails.mode is
 *    'pregenerate' AND the asset is an image → present-but-conditional, NOT required.
 *    `owner` is a UID string OR null (unowned/legacy) → typed, NOT required.
 *    `createdAt` is an ISO-8601 STRING here (new Date().toISOString()), not a number.
 *  - get returns the raw stored metadata object (no url/thumbnails decoration). LEGACY
 *    records may carry only a subset (the authz suite seeds { id, sha256, key }), so only
 *    id + sha256 are guaranteed across every stored record → required; the rest are typed
 *    but not required (honest about thin legacy rows).
 *  - resolve → { url } always. delete → { deleted } (the id string) always.
 *  - list → { items, total } on BOTH the fast path and the applySearch path (search.js
 *    returns the same shape). multi → { items } (array of { id, url } | { id, url, error }).
 *  - thumbnail.rebuild → { processed, skipped, failed, total, errors } always (throws
 *    early if sharp missing or mode!='pregenerate', so on any RETURNING path all 5 present).
 */

// Stored asset metadata shape, reused by get. Only id+sha256 are guaranteed on a raw
// stored record (legacy rows can be thinner); the rest are typed-but-not-required.
const ASSET_META = [
    { name: 'id',           type: 'string', required: true },
    { name: 'sha256',       type: 'string', required: true },
    { name: 'originalName', type: 'string' },
    { name: 'mimeType',     type: 'string' },
    { name: 'size',         type: 'number' },
    { name: 'key',          type: 'string' },
    { name: 'path',         type: 'string' },   // back-compat duplicate of key
    { name: 'owner',        type: 'string' },   // UID string OR null (unowned/legacy) — not required
    { name: 'visibility',   type: 'string' },   // 'public' | 'internal' | 'private' (legacy rows may omit)
    { name: 'createdAt',    type: 'string' },   // ISO-8601 string (not a number)
];

// upload result = freshly-minted (or deduped) metadata, decorated with url/thumbnails.
// id/sha256/size/url are present on every non-throwing path; the rest are structural
// metadata always written at birth, but owner is nullable and thumbnails is conditional.
const ASSET_UPLOAD = [
    { name: 'id',           type: 'string', required: true },
    { name: 'sha256',       type: 'string', required: true },
    { name: 'size',         type: 'number', required: true },
    { name: 'url',          type: 'string', required: true },   // store.resolveUrl(key) — always a string
    { name: 'originalName', type: 'string' },
    { name: 'mimeType',     type: 'string' },
    { name: 'key',          type: 'string' },
    { name: 'path',         type: 'string' },
    { name: 'owner',        type: 'string' },   // null when unowned → typed, not required
    { name: 'visibility',   type: 'string' },
    { name: 'createdAt',    type: 'string' },   // ISO-8601 string
    { name: 'thumbnails',   type: 'object' },   // undefined unless mode='pregenerate' + image → not required
];

module.exports = [
    {
        name: 'storage.asset.upload',
        params: [
            { name: 'file', type: 'string', required: true, maxLength: 5242880, desc: 'Base64 encoded file content' },
            { name: 'filename', type: 'string', maxLength: 128, desc: 'Original filename' },
            { name: 'mimeType', type: 'string', maxLength: 64, desc: 'MIME type' },
            { name: 'visibility', type: 'string', maxLength: 16, desc: 'public | internal | private (default: internal)' }
        ],
        returns: ['id', 'sha256', 'size', 'url'],
        returns_schema: ASSET_UPLOAD,
        description: 'Upload file and return CAS asset ID (records owner + visibility)',
        ai: true,
        public: false   // narrowed: writes need an authenticated owner (anon upload closed)
    },
    {
        name: 'storage.asset.get',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id', desc: 'Asset ID' }
        ],
        returns: ['id', 'sha256'],
        returns_schema: ASSET_META,
        description: 'Get asset metadata',
        ai: true,
        // narrowed: anon RPC no longer reaches this. Public assets are served by the standalone
        // /file/:id route (own visibility gate), so RPC get needs no anonymous surface.
        public: false
    },
    {
        name: 'storage.asset.resolve',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id', desc: 'Asset ID' },
            { name: 'size', type: 'string', maxLength: 8, desc: 'Thumbnail size (sm|md|lg); omit for the original' }
        ],
        returns: ['url'],
        returns_schema: [
            { name: 'url', type: 'string', required: true }
        ],
        description: 'Resolve asset ID (optionally a thumbnail size) to a public object-store URL',
        ai: false,
        // narrowed: anon RPC no longer reaches this. The anonymous public path is /file/:id
        // (302 → CDN for visibility:public); RPC resolve is a session-only convenience.
        public: false
    },
    {
        name: 'storage.asset.delete',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id', desc: 'Asset ID to delete' }
        ],
        returns: ['deleted'],
        returns_schema: [
            { name: 'deleted', type: 'string', required: true }   // the deleted id string
        ],
        description: 'Delete an asset by ID (removes metadata from Redis and file from disk)',
        ai: false
    },
    {
        name: 'storage.asset.list',
        params: [
            { name: 'page', type: 'number', desc: 'Page number (1-based)' },
            { name: 'pageSize', type: 'number', desc: 'Items per page' }
        ],
        returns: ['items', 'total'],
        returns_schema: [
            { name: 'items', type: 'array',  required: true },
            { name: 'total', type: 'number', required: true }
        ],
        description: 'List all assets with pagination',
        ai: false
    },
    {
        name: 'storage.asset.multi',
        params: [
            { name: 'ids', type: 'array', required: true, desc: 'Array of Asset IDs' }
        ],
        returns: ['items'],
        returns_schema: [
            { name: 'items', type: 'array', required: true }   // [{ id, url } | { id, url:null, error }]
        ],
        description: 'Batch resolve asset IDs to URLs',
        ai: false,
        public: false   // narrowed (spec-passport-self-issuance.md §7): requires a session, not anonymous
    },
    {
        name: 'storage.thumbnail.rebuild',
        params: [
            { name: 'force', type: 'boolean', desc: 'Overwrite existing thumbnails (default: false)' },
            { name: 'id', type: 'string', maxLength: 64, pattern: 'id', desc: 'Rebuild only this asset ID (omit for all)' }
        ],
        returns: ['processed', 'skipped', 'failed', 'total', 'errors'],
        returns_schema: [
            { name: 'processed', type: 'number', required: true },
            { name: 'skipped',   type: 'number', required: true },
            { name: 'failed',    type: 'number', required: true },
            { name: 'total',     type: 'number', required: true },
            { name: 'errors',    type: 'array',  required: true }   // [{ id, size, error }]
        ],
        description: 'Rebuild thumbnails for all image assets',
        ai: false,
        public: false
    },
    {
        name: 'ping',
        params: [],
        description: 'Check service health',
        ai: false
    },
    {
        name: 'methods',
        params: [],
        description: 'Provide available method definitions',
        ai: false
    },
    {
        // The handler returns the entity-name MAP directly ({ asset: {...} }) — there is
        // NO top-level `entities` key. The legacy `returns: ['entities']` was a declaration
        // lie (checkReturn would flag a missing 'entities' key); removed. Matches how the
        // collection service declares `entities` (no `returns`). entities is exempt from
        // returns_schema per the contract convention.
        name: 'entities',
        params: [],
        description: 'Get entity definitions',
        ai: false
    }
];
