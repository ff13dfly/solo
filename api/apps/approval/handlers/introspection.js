/**
 * Approval service surface area.
 *
 * @attention Declaration here MUST stay in sync with the handler registration in
 *            index.js (CLAUDE.md §5 red line). Methods, names and params are frozen;
 *            only return CONTRACTS are enriched here.
 *
 * --- RETURN CONTRACT VOCABULARY (returns_schema) ---
 *
 * `returns` (flat key list) stays as the legacy AI-discovery hint the Router advertises.
 * `returns_schema` is the typed, machine-checkable contract (library/contract.js dialect,
 * same rule-items as `params`) — what apps/approval/tests/returns-contract.test.js asserts
 * against the ACTUAL handler output. `required:true` ONLY for keys present on EVERY
 * non-throwing path; nullable/conditional keys carry a `type` but are NOT required.
 *
 * Storage note: record/gate are Entity-Factory entities, so create/update/get all return
 * the FULL persisted record (status/createdAt/updatedAt are always stamped by the factory).
 * The SAP lifecycle lives in `state`; the factory's soft-delete lifecycle lives in `status`.
 */

// --- RECORD entity (request/verify/confirm/reject/get all return the full record) -------
//   `applicant`   = ctx.actor || null  → nullable (no actor in some call paths)
//   `confirmedAt` = stamped ONLY by confirm() → conditional, present after DISPATCHED→DONE
const RECORD_RETURN = [
    { name: 'id',          type: 'string',  required: true },
    { name: 'target',      type: 'string',  required: true },
    { name: 'payload',     type: 'array',   required: true },   // Operation[] (op/field/...)
    { name: 'state',       type: 'string',  required: true },   // SAP: INIT|DISPATCHED|DONE|REJECTED
    { name: 'applicant',   type: 'string'  },                   // nullable (ctx.actor || null)
    { name: 'evidence',    type: 'array',   required: true },   // append-only attestation trail
    { name: 'confirmedAt', type: 'number'  },                   // only after confirm()
    { name: 'status',      type: 'string',  required: true },   // ENTITY lifecycle: ACTIVE|DELETED
    { name: 'createdAt',   type: 'number',  required: true },
    { name: 'updatedAt',   type: 'number',  required: true },
];

// --- GATE entity (open/reject/get return the full gate record) --------------------------
//   `submitterUid` = open() param default null → nullable
//   `approvedAt`   = null until the m-of-n threshold is reached → nullable
//   reject() additionally stamps rejectReason/rejectedBy/rejectedAt (reject-path only).
const GATE_RETURN = [
    { name: 'id',              type: 'string',  required: true },
    { name: 'subject',         type: 'string',  required: true },
    { name: 'digest',          type: 'string',  required: true },
    { name: 'requiredSigners', type: 'number',  required: true },
    { name: 'submitterUid',    type: 'string'  },               // nullable
    { name: 'signers',         type: 'array',   required: true },// { approverUid, signature, publicKey, signedAt }[]
    { name: 'state',           type: 'string',  required: true },// OPEN|APPROVED|REJECTED|EXPIRED
    { name: 'expiresAt',       type: 'number',  required: true },
    { name: 'approvedAt',      type: 'number'  },                // null until threshold
    { name: 'status',          type: 'string',  required: true },// ENTITY lifecycle: ACTIVE|DELETED
    { name: 'createdAt',       type: 'number',  required: true },
    { name: 'updatedAt',       type: 'number',  required: true },
    { name: 'rejectReason',    type: 'string'  },                // reject() path only (nullable)
    { name: 'rejectedBy',      type: 'string'  },                // reject() path only (nullable)
    { name: 'rejectedAt',      type: 'number'  },                // reject() path only
];

// gate.sign returns a SHAPED progress object (NOT the gate entity).
const GATE_SIGN_RETURN = [
    { name: 'id',       type: 'string',  required: true },
    { name: 'state',    type: 'string',  required: true },   // OPEN until threshold, then APPROVED
    { name: 'signed',   type: 'number',  required: true },   // signatures accumulated so far
    { name: 'required', type: 'number',  required: true },   // m — threshold
];

// Entity-Factory list() → { items, total } (an object, schema-able normally).
const LIST_RETURN = [
    { name: 'items', type: 'array',  required: true },
    { name: 'total', type: 'number', required: true },
];

const methods = [
    {
        name: 'approval.record.request',
        params: [
            { name: 'target',  type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'payload', type: 'array' },
            { name: 'signature', type: 'string', optional: true, maxLength: 128 }   // Ed25519 (bs58) over stageDigest(target,'request',payloadHash)
        ],
        returns: ['id', 'state', 'target', 'createdAt'],
        returns_schema: RECORD_RETURN,
        description: 'File a change request; creates an INIT approval record',
        ai: true
    },
    {
        name: 'approval.record.verify',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'signature', type: 'string', optional: true, maxLength: 128 }   // Ed25519 (bs58) over stageDigest(target,'verify',payloadHash)
        ],
        returns: ['id', 'state'],
        returns_schema: RECORD_RETURN,
        description: 'Verifier approves the request content (INIT -> DISPATCHED)',
        ai: false
    },
    {
        name: 'approval.record.confirm',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'signature', type: 'string', optional: true, maxLength: 128 }   // Ed25519 (bs58) over stageDigest(target,'confirm',payloadHash)
        ],
        returns: ['id', 'state', 'confirmedAt'],
        returns_schema: RECORD_RETURN,
        description: 'Confirm physical execution of the change (DISPATCHED -> DONE)',
        ai: false
    },
    {
        name: 'approval.record.reject',
        params: [
            { name: 'id',     type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'reason', type: 'string', optional: true, maxLength: 4000 }
        ],
        returns: ['id', 'state'],
        returns_schema: RECORD_RETURN,
        description: 'Reject a request (INIT|DISPATCHED -> REJECTED)',
        ai: false
    },
    {
        name: 'approval.record.get',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        returns: ['id', 'target', 'payload', 'state', 'evidence'],
        returns_schema: RECORD_RETURN,
        description: 'Get an approval record by id',
        ai: true
    },
    {
        name: 'approval.record.list',
        params: [
            { name: 'target', type: 'string', optional: true, maxLength: 64, pattern: 'id' },
            { name: 'state',  type: 'string', optional: true, maxLength: 64 },
            { name: 'limit',  type: 'number', optional: true },
            { name: 'offset', type: 'number', optional: true }
        ],
        returns: ['items', 'total'],
        returns_schema: LIST_RETURN,
        description: 'List approval records, filter by target/state',
        ai: true
    },

    // ── Multi-signature gate (VERSION.md §3.1) — high-risk workflow approval lane ──
    {
        name: 'approval.gate.open',
        params: [
            { name: 'subject',          type: 'string', required: true, maxLength: 128 },
            { name: 'digest',           type: 'string', required: true, maxLength: 128 },
            { name: 'requiredSigners',  type: 'number', optional: true },
            { name: 'expiresInSec',     type: 'number', optional: true },
            { name: 'submitterUid',     type: 'string', optional: true, maxLength: 64 }
        ],
        returns: ['id', 'state', 'requiredSigners', 'expiresAt'],
        returns_schema: GATE_RETURN,
        description: 'Open a multi-signature approval gate (orchestrator-driven, high-risk lane)',
        ai: false
    },
    {
        name: 'approval.gate.sign',
        params: [
            { name: 'id',          type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'approverUid', type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'signature',   type: 'string', required: true, maxLength: 256 }
        ],
        returns: ['id', 'state', 'signed', 'required'],
        returns_schema: GATE_SIGN_RETURN,
        description: 'Add one approver Ed25519 signature; flips APPROVED at the m-of-n threshold',
        ai: false
    },
    {
        name: 'approval.gate.reject',
        params: [
            { name: 'id',     type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'reason', type: 'string', optional: true, maxLength: 4000 }
        ],
        returns: ['id', 'state'],
        returns_schema: GATE_RETURN,
        description: 'Reject an open approval gate',
        ai: false
    },
    {
        name: 'approval.gate.get',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        returns: ['id', 'subject', 'state', 'signers', 'requiredSigners', 'expiresAt'],
        returns_schema: GATE_RETURN,
        description: 'Get an approval gate by id',
        ai: false
    },
    {
        name: 'approval.gate.list',
        params: [
            { name: 'subject', type: 'string', optional: true, maxLength: 128 },
            { name: 'state',   type: 'string', optional: true, maxLength: 64 },
            { name: 'limit',   type: 'number', optional: true },
            { name: 'offset',  type: 'number', optional: true }
        ],
        returns: ['items', 'total'],
        returns_schema: LIST_RETURN,
        description: 'List approval gates, filter by subject/state',
        ai: false
    },

    // §7.7 — internal-call relay token lifecycle (admin)
    { name: 'approval.token.set',    params: [{ name: 'token', type: 'string', required: true, maxLength: 512 }, { name: 'expiresAt', type: 'number' }, { name: 'sub', type: 'string', maxLength: 64 }], returns_schema: [{ name: 'ok', type: 'boolean', required: true }], description: 'Set relay bot token (admin)', ai: false },
    { name: 'approval.token.status', params: [], returns_schema: [{ name: 'hasToken', type: 'boolean', required: true }], description: 'Relay token status (admin)', ai: false },
    { name: 'approval.token.clear',  params: [], returns_schema: [{ name: 'ok', type: 'boolean', required: true }], description: 'Clear relay bot token (admin)', ai: false },

    { name: 'ping',     params: [], returns: ['status', 'version', 'uptime'], description: 'Health check', ai: true },
    { name: 'methods',  params: [], description: 'Get service method list', ai: false },
    { name: 'entities', params: [], description: 'Get entity definitions', ai: false }
];

module.exports = methods;
