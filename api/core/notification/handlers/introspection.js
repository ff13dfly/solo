// --- RETURN CONTRACT VOCABULARY (returns_schema) ---
//
// `returns` (flat key list) stays as the legacy AI-discovery hint the Router advertises.
// `returns_schema` is the typed, machine-checkable contract (library/contract.js dialect,
// same rule-items as `params`) — asserted in tests/returns-contract.test.js against the
// ACTUAL handler output. required:true ONLY for keys present on EVERY non-throwing path;
// conditional/branch keys carry a type but NOT required.

// message.send (notification.send): BOTH the dedup early-return
//   ({ id, status:'duplicate', queued:0 }) and the normal path ({ id, status:'stored',
//   queued:N }) return all three keys — all always present.
const SEND_RETURN = [
    { name: 'id',     type: 'string',  required: true },   // existing id on duplicate, new id otherwise
    { name: 'status', type: 'string',  required: true },   // 'stored' | 'duplicate'
    { name: 'queued', type: 'number',  required: true },   // # of delivery channels enqueued (0 on duplicate)
];

// relay.status (notification.token.status): the no-token path returns ONLY { hasToken:false };
// the has-token path adds sub/expiresAt/ttlMs/lastRefreshAt/needsRotation/expired. Only
// `hasToken` is present on every path — the rest are conditional (type, no required).
const TOKEN_STATUS_RETURN = [
    { name: 'hasToken',      type: 'boolean', required: true },
    { name: 'sub',           type: 'string'  },   // present only when hasToken
    { name: 'expiresAt',     type: 'number'  },   // present only when hasToken
    { name: 'ttlMs',         type: 'number'  },   // present only when hasToken
    { name: 'lastRefreshAt', type: 'number'  },   // present only when hasToken (also returned by handler)
    { name: 'needsRotation', type: 'boolean' },   // present only when hasToken
    { name: 'expired',       type: 'boolean' },   // present only when hasToken
];

const methods = [
    {
        name: 'notification.send',
        params: [
            { name: 'targetId', type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'type',     type: 'string', maxLength: 64 },
            { name: 'payload',  type: 'object' },
            { name: 'sourceId', type: 'string', optional: true, maxLength: 64, pattern: 'id' },
            { name: 'ref',      type: 'string', optional: true, maxLength: 512 }
        ],
        returns: ['id', 'status', 'queued'],
        returns_schema: SEND_RETURN,
        description: 'Store a message, write to inbox, route delivery per config',
        ai: true
    },
    {
        name: 'notification.inbox.list',
        params: [
            { name: 'targetId',   type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'unreadOnly', type: 'boolean', optional: true },
            { name: 'page',       type: 'number',  optional: true },
            { name: 'pageSize',   type: 'number',  optional: true }
        ],
        returns: ['items', 'total'],
        returns_schema: [
            { name: 'items', type: 'array',  required: true },
            { name: 'total', type: 'number', required: true }
        ],
        description: 'List inbox messages for a target',
        ai: true
    },
    {
        name: 'notification.inbox.ack',
        params: [{ name: 'ids', type: 'array' }],
        returns: ['acked'],
        returns_schema: [{ name: 'acked', type: 'number', required: true }],
        description: 'Mark messages as read',
        ai: true
    },
    {
        name: 'notification.config.set',
        params: [
            { name: 'targetId', type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'rules',    type: 'array' }
        ],
        returns: ['targetId'],
        returns_schema: [{ name: 'targetId', type: 'string', required: true }],
        description: 'Set delivery rules for a target',
        ai: false
    },
    {
        name: 'notification.config.get',
        params: [{ name: 'targetId', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        returns: ['targetId', 'rules'],
        returns_schema: [
            { name: 'targetId', type: 'string', required: true },
            { name: 'rules',    type: 'array',  required: true }   // [] when no config stored
        ],
        description: 'Get delivery rules for a target',
        ai: false
    },

    // Dead-letter operations (admin-only): inspect and re-drive failed deliveries
    {
        name: 'notification.deadletter.list',
        params: [
            { name: 'page',     type: 'number', optional: true },
            { name: 'pageSize', type: 'number', optional: true }
        ],
        returns: ['items', 'total'],
        returns_schema: [
            { name: 'items', type: 'array',  required: true },
            { name: 'total', type: 'number', required: true }
        ],
        description: 'Admin: list failed-delivery tasks in the dead-letter queue',
        ai: false
    },
    {
        name: 'notification.deadletter.requeue',
        params: [
            { name: 'messageId', type: 'string',  optional: true, maxLength: 64, pattern: 'id' },
            { name: 'all',       type: 'boolean', optional: true }
        ],
        returns: ['requeued', 'exhausted'],
        returns_schema: [
            { name: 'requeued',  type: 'number', required: true },
            { name: 'exhausted', type: 'number', required: true }   // # left in DLQ for hitting MAX_REQUEUES
        ],
        description: 'Admin: requeue dead-letter tasks back to pending for redelivery',
        ai: false
    },

    // §7.7 — admin-only token lifecycle for internal-call relay (ai:false: not for AI discovery)
    {
        name: 'notification.token.set',
        params: [
            { name: 'token',     type: 'string', maxLength: 512 },
            { name: 'expiresAt', type: 'number' },
            { name: 'sub',       type: 'string', optional: true, maxLength: 64, pattern: 'id' }
        ],
        returns: ['ok'],
        // index.js wraps relay.setToken (which returns undefined) as { ok: true }.
        returns_schema: [{ name: 'ok', type: 'boolean', required: true }],
        description: 'Admin: inject bot session token into relay store',
        ai: false
    },
    {
        name: 'notification.token.status',
        params: [],
        returns: ['hasToken'],
        returns_schema: TOKEN_STATUS_RETURN,
        description: 'Admin: inspect relay token state (does not return the token)',
        ai: false
    },
    {
        name: 'notification.token.clear',
        params: [],
        returns: ['ok'],
        // index.js wraps relay.clear (which returns undefined) as { ok: true }.
        returns_schema: [{ name: 'ok', type: 'boolean', required: true }],
        description: 'Admin: clear relay token (emergency revoke)',
        ai: false
    },

    { name: 'ping',     params: [], returns: ['status', 'version', 'uptime'], description: 'Health check', ai: true },
    { name: 'methods',  params: [], description: 'Get surface area definition', ai: false },
    { name: 'entities', params: [], description: 'Get entity definitions', ai: false }
];

module.exports = methods;
