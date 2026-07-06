// --- RETURN CONTRACT VOCABULARY (returns_schema) ---
//
// `returns` (flat key list) stays as the legacy AI-discovery hint the Router advertises.
// `returns_schema` is the typed, machine-checkable contract (library/contract.js dialect,
// same rule-items as `params`) — what the return-contract test asserts. `required:true`
// marks keys present on EVERY non-throwing path; nullable/conditional keys carry a type
// but are NOT required.
//
// A Sentinel PROFILE (returned whole by update/get) — these keys are written on create
// (defaulting to null where optional) and persist, so they're present on every profile
// path. get() additionally decorates with online/identity/activity (below).
const SENTINEL_PROFILE = [
    { name: 'id',                 type: 'string',  required: true },
    { name: 'name',               type: 'string',  required: true },
    { name: 'status',             type: 'string',  required: true },   // ACTIVE | DISABLED
    { name: 'authorityRole',      type: 'string',  required: true },
    { name: 'track',              type: 'string',  required: true },   // defaults 'internal'
    { name: 'eventSubscriptions', type: 'array',   required: true },   // defaults []
    { name: 'createdAt',          type: 'number',  required: true },
    { name: 'description',        type: 'string'  },                   // nullable
    { name: 'reachability',       type: 'string'  },                   // nullable
    { name: 'webhookUrl',         type: 'string'  },                   // nullable
    { name: 'context',            type: 'object'  },                   // nullable
    { name: 'lastSeenAt',         type: 'number'  },                   // null until first heartbeat
];

const methods = [
    {
        name: 'nexus.sentinel.create',
        params: [
            { name: 'name',               type: 'string', required: true, maxLength: 128 },
            { name: 'authorityRole',      type: 'string', maxLength: 64 },
            { name: 'eventSubscriptions', type: 'array',  optional: true },
            { name: 'reachability',       type: 'string', optional: true, maxLength: 64 },
            { name: 'description',        type: 'string', optional: true, maxLength: 4000 },
            { name: 'webhookUrl',         type: 'string', optional: true, maxLength: 4000 },
            { name: 'track',              type: 'string', optional: true, maxLength: 64 },
            { name: 'context',            type: 'object', optional: true }
        ],
        returns: ['id', 'name', 'authorityRole', 'status'],
        // Handler returns exactly { id, name, authorityRole, status } — a SLICE of the
        // profile, not the whole record (unlike update/get).
        returns_schema: [
            { name: 'id',            type: 'string', required: true },
            { name: 'name',          type: 'string', required: true },
            { name: 'authorityRole', type: 'string', required: true },
            { name: 'status',        type: 'string', required: true },
        ],
        description: 'Create a Sentinel (descriptive authorityRole links to a bot account; bot token is provisioned separately via user.bot.*). Optional declarative context enables context assembly (context.md).',
        ai: false
    },
    {
        name: 'nexus.sentinel.update',
        params: [
            { name: 'id',                 type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'name',               type: 'string', optional: true, maxLength: 128 },
            { name: 'authorityRole',      type: 'string', optional: true, maxLength: 64 },
            { name: 'eventSubscriptions', type: 'array',  optional: true },
            { name: 'reachability',       type: 'string', optional: true, maxLength: 64 },
            { name: 'webhookUrl',         type: 'string', optional: true, maxLength: 4000 },
            { name: 'description',        type: 'string', optional: true, maxLength: 4000 },
            { name: 'track',              type: 'string', optional: true, maxLength: 64 },
            { name: 'context',            type: 'object', optional: true }
        ],
        returns: ['id', 'name', 'status', 'eventSubscriptions'],
        // Handler returns the WHOLE profile (plus updatedAt on this path). updatedAt is
        // declared but not required (only present once a record has been updated).
        returns_schema: [
            ...SENTINEL_PROFILE,
            { name: 'updatedAt', type: 'number' }, // present on update path; not on a fresh create
        ],
        description: 'Update a Sentinel (only provided fields change). Changing eventSubscriptions re-syncs the subscription sets and establishes consumer groups on new streams.',
        ai: false
    },
    {
        name: 'nexus.sentinel.list',
        params: [
            { name: 'page',     type: 'number', optional: true },
            { name: 'pageSize', type: 'number', optional: true },
            { name: 'status',   type: 'string', optional: true, maxLength: 64 }
        ],
        returns: ['items', 'total'],
        returns_schema: [
            { name: 'items', type: 'array',  required: true },   // each item = profile + online/identity/activity
            { name: 'total', type: 'number', required: true },
        ],
        description: 'List registered Sentinels',
        ai: true
    },
    {
        name: 'nexus.sentinel.get',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        // Legacy `returns` listed only a subset; the handler returns the full profile
        // decorated with online (boolean), identity (object), activity (object|null).
        returns: ['id', 'name', 'status', 'online', 'reachability', 'eventSubscriptions'],
        returns_schema: [
            ...SENTINEL_PROFILE,
            { name: 'online',    type: 'boolean', required: true },  // exists(NEXUS:SENTINEL:ONLINE:*)
            { name: 'identity',  type: 'object',  required: true },  // { mode } or { mode:'bot', uid, hasToken, ... }
            { name: 'activity',  type: 'object'  },                  // null when redis has no hGetAll (hermetic)
            { name: 'updatedAt', type: 'number'  },                 // present only if previously updated
        ],
        description: 'Retrieve a Sentinel by id',
        ai: true
    },
    {
        name: 'nexus.sentinel.disable',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        returns: ['id', 'status'],
        returns_schema: [
            { name: 'id',     type: 'string', required: true },
            { name: 'status', type: 'string', required: true },  // DISABLED (or already-DISABLED idempotent path)
        ],
        description: 'Disable a Sentinel (stops event delivery; drops it from subscription sets + soft-revokes its held token)',
        ai: false
    },
    {
        name: 'nexus.sentinel.enable',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        returns: ['id', 'status'],
        returns_schema: [
            { name: 'id',     type: 'string', required: true },
            { name: 'status', type: 'string', required: true },  // ACTIVE (or already-ACTIVE idempotent path)
        ],
        description: 'Re-enable a DISABLED Sentinel (re-adds it to subscription sets + re-establishes consumer groups)',
        ai: false
    },
    {
        name: 'nexus.sentinel.delete',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        returns: ['id', 'deleted'],
        returns_schema: [
            { name: 'id',      type: 'string',  required: true },
            { name: 'deleted', type: 'boolean', required: true },  // always true on success (throws on not-found)
        ],
        description: 'Permanently delete a Sentinel from the registry (profile, set, subscriptions, online key, held token)',
        ai: false
    },
    {
        name: 'nexus.sentinel.heartbeat',
        params: [{ name: 'sentinelId', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        returns: ['sentinelId', 'expiresInSeconds'],
        returns_schema: [
            { name: 'sentinelId',       type: 'string', required: true },
            { name: 'expiresInSeconds', type: 'number', required: true },
        ],
        description: 'Report Sentinel liveness (writes a TTL online key)',
        ai: false
    },
    {
        name: 'nexus.sentinel.resolve',
        params: [{ name: 'event', type: 'string', maxLength: 64 }],
        returns: ['sentinels'],
        returns_schema: [
            { name: 'sentinels', type: 'array', required: true },  // [{ sentinelId, name, track, reachability }]
        ],
        description: 'Resolve active Sentinels subscribed to an event stream key',
        ai: false
    },
    {
        name: 'nexus.sentinel.broadcast',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        // Handler returns { id, broadcasted } on every path (+ conditional channel|reason);
        // it never returned the previously-declared 'ok' key. See logic/sentinel.js#broadcast.
        returns: ['id', 'broadcasted'],
        returns_schema: [
            { name: 'id',          type: 'string',  required: true },
            { name: 'broadcasted', type: 'boolean', required: true },
            { name: 'channel',     type: 'string'  },  // only on the webhook (broadcasted:true) path
            { name: 'reason',      type: 'string'  },  // only on the no-config (broadcasted:false) path
        ],
        description: 'Push a Sentinel delivery config to notification (admin-only bootstrap step)',
        ai: false
    },
    // §1.2 per-Sentinel identity — admin injects a Sentinel bot's session token.
    {
        name: 'nexus.sentinel.token.set',
        params: [
            { name: 'authorityRole', type: 'string', required: true, maxLength: 64 },
            { name: 'token',         type: 'string', required: true, maxLength: 512 },
            { name: 'expiresAt',     type: 'number', required: true }
        ],
        returns: ['ok'],
        returns_schema: [{ name: 'ok', type: 'boolean', required: true }],  // identity.setToken → { ok: true }
        description: "Admin: inject a per-Sentinel bot session token (manual provisioning, §1.2) so the Sentinel's data_fetchers run under its own least-privilege identity",
        ai: false
    },

    // §7.7 — admin-only token lifecycle for internal-call relay
    {
        name: 'nexus.token.set',
        params: [
            { name: 'token',     type: 'string', maxLength: 512 },
            { name: 'expiresAt', type: 'number' },
            { name: 'sub',       type: 'string', optional: true, maxLength: 64, pattern: 'id' }
        ],
        returns: ['ok'],
        returns_schema: [{ name: 'ok', type: 'boolean', required: true }],  // index.js returns { ok: true } after relay.setToken
        description: 'Admin: inject bot session token into relay store',
        ai: false
    },
    {
        name: 'nexus.token.status',
        params: [],
        // CONDITIONAL SHAPE (relay.status): the NO-TOKEN path returns ONLY { hasToken:false }.
        // Every other key (sub/expiresAt/ttlMs/needsRotation/expired, + lastRefreshAt which
        // legacy never listed) is present ONLY when a token exists. So only hasToken is
        // required; legacy `returns` listing the rest as discovery hints is fine, but
        // narrowed here to the truly-always key + corrected to type-only conditionals.
        returns: ['hasToken'],
        returns_schema: [
            { name: 'hasToken',      type: 'boolean', required: true },
            { name: 'sub',           type: 'string'  },  // token-present path only
            { name: 'expiresAt',     type: 'number'  },  // token-present path only
            { name: 'ttlMs',         type: 'number'  },  // token-present path only
            { name: 'lastRefreshAt', type: 'number'  },  // token-present path only (was undeclared)
            { name: 'needsRotation', type: 'boolean' },  // token-present path only
            { name: 'expired',       type: 'boolean' },  // token-present path only
        ],
        description: 'Admin: inspect relay token state (does not return the token)',
        ai: false
    },
    {
        name: 'nexus.token.clear',
        params: [],
        returns: ['ok'],
        returns_schema: [{ name: 'ok', type: 'boolean', required: true }],  // index.js returns { ok: true } after relay.clear
        description: 'Admin: clear relay token (emergency revoke)',
        ai: false
    },
    // Runtime auto↔manual pause — stops the stream consumer + scheduler loops without a
    // restart so an operator can degrade to manual (manual RPCs keep working).
    {
        name: 'nexus.control.pause',
        params: [],
        returns: ['paused'],
        returns_schema: [{ name: 'paused', type: 'boolean', required: true }],
        description: 'Admin: pause automation (consumer + scheduler stop; manual RPCs unaffected)',
        ai: false
    },
    {
        name: 'nexus.control.resume',
        params: [],
        returns: ['paused'],
        returns_schema: [{ name: 'paused', type: 'boolean', required: true }],
        description: 'Admin: resume automation',
        ai: false
    },
    {
        name: 'nexus.control.status',
        params: [],
        returns: ['paused'],
        returns_schema: [{ name: 'paused', type: 'boolean', required: true }],
        description: 'Admin: report whether automation is paused',
        ai: false
    },

    // event.md §6.2 — schedule CRUD (admin, nexus management area)
    {
        name: 'nexus.schedule.create',
        params: [
            { name: 'schedule_id',   type: 'string',  required: true, maxLength: 64, pattern: 'id' },
            { name: 'fire_at',       type: 'number',  required: true },
            { name: 'recurrence_ms', type: 'number',  required: false },
            { name: 'action',        type: 'object',  required: true },
            { name: 'enabled',       type: 'boolean', required: false },
            { name: 'owner',         type: 'string',  required: false, maxLength: 64, pattern: 'id' }
        ],
        returns: ['schedule_id', 'fire_at', 'recurrence_ms', 'action', 'enabled'],
        // Handler returns the full def. recurrence_ms/owner/last_fired_at are nullable
        // but always present as keys on the create path.
        returns_schema: [
            { name: 'schedule_id',   type: 'string',  required: true },
            { name: 'fire_at',       type: 'number',  required: true },
            { name: 'action',        type: 'object',  required: true },
            { name: 'enabled',       type: 'boolean', required: true },
            { name: 'created_at',    type: 'number',  required: true },
            { name: 'recurrence_ms', type: 'number'  },  // null = one-shot
            { name: 'owner',         type: 'string'  },  // nullable
            { name: 'last_fired_at', type: 'number'  },  // null until first fire
        ],
        description: 'Create a schedule entry (admin)',
        ai: false
    },
    {
        name: 'nexus.schedule.get',
        params: [{ name: 'schedule_id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        returns: ['schedule_id', 'fire_at', 'recurrence_ms', 'action', 'enabled', 'last_fired_at'],
        // Same persisted def as create returns (RedisJSON read-back).
        returns_schema: [
            { name: 'schedule_id',   type: 'string',  required: true },
            { name: 'fire_at',       type: 'number',  required: true },
            { name: 'action',        type: 'object',  required: true },
            { name: 'enabled',       type: 'boolean', required: true },
            { name: 'created_at',    type: 'number',  required: true },
            { name: 'recurrence_ms', type: 'number'  },
            { name: 'owner',         type: 'string'  },
            { name: 'last_fired_at', type: 'number'  },
        ],
        description: 'Get a schedule entry by ID (admin)',
        ai: false
    },
    {
        name: 'nexus.schedule.list',
        params: [],
        // Handler returns a BARE ARRAY of schedule defs (sorted by fire_at) — NOT { items }.
        // The flat-key `returns` dialect can't express a top-level array, so no object-key
        // contract is declared. (Separately: portal AutomationControl reads `.items` off this
        // and silently gets 0 — a frontend bug tracked apart from this declaration fix.)
        description: 'List all schedule entries sorted by next fire_at (admin); returns a bare array',
        ai: false
    },
    {
        name: 'nexus.schedule.update',
        params: [
            { name: 'schedule_id',   type: 'string',  required: true, maxLength: 64, pattern: 'id' },
            { name: 'fire_at',       type: 'number',  required: false },
            { name: 'recurrence_ms', type: 'number',  required: false },
            { name: 'action',        type: 'object',  required: false },
            { name: 'enabled',       type: 'boolean', required: false }
        ],
        returns: ['schedule_id', 'fire_at', 'recurrence_ms', 'action', 'enabled'],
        // Returns { ...existing, ...changes, schedule_id, created_at } — the full def again.
        returns_schema: [
            { name: 'schedule_id',   type: 'string',  required: true },
            { name: 'fire_at',       type: 'number',  required: true },
            { name: 'action',        type: 'object',  required: true },
            { name: 'enabled',       type: 'boolean', required: true },
            { name: 'created_at',    type: 'number',  required: true },
            { name: 'recurrence_ms', type: 'number'  },
            { name: 'owner',         type: 'string'  },
            { name: 'last_fired_at', type: 'number'  },
        ],
        description: 'Update a schedule entry (admin)',
        ai: false
    },
    {
        name: 'nexus.schedule.delete',
        params: [{ name: 'schedule_id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        returns: ['ok'],
        returns_schema: [{ name: 'ok', type: 'boolean', required: true }],
        description: 'Delete a schedule entry (admin)',
        ai: false
    },

    // context.md §7.3 — dead-letter queue for undeliverable events (admin).
    {
        name: 'nexus.dlq.list',
        params: [
            { name: 'page',     type: 'number', optional: true },
            { name: 'pageSize', type: 'number', optional: true }
        ],
        returns: ['items', 'total'],
        returns_schema: [
            { name: 'items', type: 'array',  required: true },   // [{ id, sourceStream, sourceId, attempts, failedAt, event }]
            { name: 'total', type: 'number', required: true },
        ],
        description: 'List dead-lettered events (undeliverable after maxDeliveries) — admin',
        ai: false
    },
    {
        name: 'nexus.dlq.retry',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        returns: ['retried', 'sourceStream', 'newId'],
        returns_schema: [
            { name: 'retried',      type: 'boolean', required: true },  // always true on success (throws otherwise)
            { name: 'sourceStream', type: 'string',  required: true },
            { name: 'newId',        type: 'string',  required: true },  // re-XADD'd stream id
        ],
        description: 'Re-emit a dead-lettered event onto its source stream and drop the DLQ entry — admin',
        ai: false
    },

    {
        name: 'nexus.event.streams',
        params: [],
        returns: ['items', 'truncated'],
        returns_schema: [
            { name: 'items',     type: 'array',   required: true },   // [{ key, length, lastId, lastAt }]
            { name: 'truncated', type: 'boolean', required: true },
        ],
        description: 'List EVENT:* streams on the bus with length and last-entry recency (read-only) — admin',
        ai: false
    },
    {
        name: 'nexus.event.recent',
        params: [
            { name: 'stream', type: 'string', required: true, maxLength: 128 },
            { name: 'count',  type: 'number', required: false }
        ],
        returns: ['stream', 'entries'],
        returns_schema: [
            { name: 'stream',  type: 'string', required: true },
            { name: 'entries', type: 'array',  required: true },   // [{ id, at, ...liftedFields }]
        ],
        description: 'Read the last N entries of one EVENT:* stream, newest first (read-only) — admin',
        ai: false
    },
    {
        name: 'nexus.trace.get',
        params: [
            { name: 'traceId', type: 'string', required: true, maxLength: 128 }
        ],
        returns: ['traceId', 'events'],
        returns_schema: [
            { name: 'traceId',       type: 'string',  required: true },
            { name: 'events',        type: 'array',   required: true },   // chronological across streams; [{ stream, id, at, type, trace_id, ... }]
            { name: 'streamsScanned', type: 'number', required: true },
            { name: 'truncated',     type: 'boolean', required: true },   // a stream hit the per-stream scan budget
        ],
        description: 'Reconstruct the COMPLETE chain for one trace_id: every event across all EVENT:* streams PLUS the entity-WAL rows (which carry `trace`), full-history (not windowed), chronological (read-only) — admin. WAL is a ring buffer so only recent entity writes are covered.',
        ai: false
    },

    { name: 'ping',     params: [], returns: ['status', 'version', 'uptime'], description: 'Health check', ai: true },
    { name: 'methods',  params: [], description: 'Get surface area definition', ai: false },
    { name: 'entities', params: [], description: 'Get entity definitions', ai: false }
];

module.exports = methods;
