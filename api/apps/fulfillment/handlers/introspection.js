/**
 * Service Capability Registry (Introspection)
 *
 * @why Defines the service's surface area. The Router fetches this during
 *      handshake to populate its global routing and capability map.
 * @attention
 *   - `ai: true`     — method may be autonomously invoked by the LLM
 *   - `public: true` — Router bypasses RBAC permission check
 */

// --- RETURN CONTRACT VOCABULARY (returns_schema) ---
//
// `returns_schema` is the typed, machine-checkable return contract (library/contract.js
// dialect — the same flat rule-items as `params`). It is what returns-contract.test.js
// asserts the ACTUAL handler output against, and what the fulfillment profile linter
// resolves a meta_field source.pick path against. Verified against logic/instance.js,
// logic/profile.js (Entity Factory, library/entity.js), library/relay.js and the index.js
// wrappers (2026-06-18).
//
// `required: true` is set ONLY for keys present AND non-null on EVERY non-throwing path —
// checkParams (library/validate.js) treats a null value under a required rule as a
// violation, so nullable keys (prevState/createdBy at create) are typed but NOT required.
//
// ⚠ FIELD SEMANTICS (the traps these schemas document):
//   - lifecycle field is `state` (DRAFT → …), NOT `status`. An instance has NO `status`
//     key at all. A profile (Entity-Factory record) carries `status` (ACTIVE | DELETED) —
//     the record lifecycle — and NO `state`. Picking the wrong one silently mis-branches.
//   - `_tasks` (Router async-dispatch array) is present on transition/cancel/hold/override
//     but ABSENT on resume — and on create/get/update. NON-UNIFORM across siblings; see
//     codeBugsFlagged. It is declared (required) only on the four methods that emit it.
//   - profile.delete (softDelete) returns the full entity record (an `update` with
//     status=DELETED), whereas profile.destroy returns { success: true }. Different shapes.

// Instance record (logic/instance.js create()): the always-present, always-non-null core.
// prevState/createdBy are null at create → typed but not required. pending_callbacks/
// updatedAt are present-but-optional (updatedAt only after update()).
const INSTANCE_BASE = [
    { name: 'id',                type: 'string', required: true },
    { name: 'sourceId',         type: 'string', required: true },
    { name: 'profileId',        type: 'string', required: true },
    { name: 'state',            type: 'string', required: true },   // BUSINESS lifecycle (no `status` key)
    { name: 'stateChangedAt',   type: 'number', required: true },
    { name: 'createdAt',        type: 'number', required: true },
    { name: 'meta',             type: 'object', required: true },
    { name: 'history',          type: 'array',  required: true },
    { name: 'prevState',        type: 'string' },                   // null at create; set after a transition
    { name: 'createdBy',        type: 'string' },                   // req.user || null
    { name: 'pending_callbacks', type: 'array' },                   // [] at create
    { name: 'updatedAt',        type: 'number' },                   // only stamped by instance.update()
];
// transition/cancel/hold/override return advance() = { ...instance, _tasks } — _tasks is
// always at least [] on these four paths (NOT on resume).
const INSTANCE_WITH_TASKS = [
    ...INSTANCE_BASE,
    { name: '_tasks', type: 'array', required: true },
];

// Profile = Entity-Factory record (library/entity.js). create/get/update/restore/delete all
// resolve to a stored record: id + status always present; the rest stamped by create.
const PROFILE_RETURN = [
    { name: 'id',          type: 'string', required: true },
    { name: 'status',      type: 'string', required: true },   // ENTITY lifecycle: ACTIVE | DELETED (no `state` key)
    { name: 'name',        type: 'string' },
    { name: 'transitions', type: 'array'  },                   // optional create param
    { name: 'createdAt',   type: 'number' },
    { name: 'updatedAt',   type: 'number' },
];
const LIST_RETURN = [
    { name: 'items', type: 'array',  required: true },
    { name: 'total', type: 'number', required: true },
];

const methods = [
    // --- Instance Methods ---
    {
        name: 'fulfillment.instance.create',
        params: [
            { name: 'sourceId',   type: 'string',  required: true,  maxLength: 64, pattern: 'id', description: 'Source order ID' },
            { name: 'profileId',  type: 'string',  required: true,  maxLength: 64, pattern: 'id', description: 'Fulfillment profile to apply' },
            { name: 'meta',       type: 'object',  required: false, description: 'Initial metadata' }
        ],
        description: 'Create a new fulfillment instance for an order',
        returns_schema: INSTANCE_BASE,   // fresh DRAFT instance; no _tasks
        ai: true
    },
    {
        name: 'fulfillment.instance.get',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id', description: 'Instance ID' }
        ],
        description: 'Get fulfillment instance details and state history',
        returns_schema: INSTANCE_BASE,   // stored instance; no _tasks
        ai: true,
        public: false   // narrowed: business-instance reads require a session
    },
    {
        name: 'fulfillment.instance.list',
        params: [
            { name: 'state',  type: 'string',  required: false, maxLength: 64, description: 'Filter by state' },
            { name: 'limit',  type: 'number',  required: false, description: 'Page size' },
            { name: 'offset', type: 'number',  required: false, description: 'Page offset' }
        ],
        description: 'List all fulfillment instances',
        returns_schema: LIST_RETURN,     // { items: instance[], total } — items always [] on empty
        ai: true,
        public: false   // narrowed: business-instance reads require a session
    },
    {
        name: 'fulfillment.instance.transition',
        params: [
            { name: 'id',         type: 'string', required: true,  maxLength: 64, pattern: 'id', description: 'Instance ID' },
            { name: 'event',      type: 'string', required: true,  maxLength: 64, description: 'Transition event/trigger name, defined in the applied profile transitions[].event. The engine matches (event, from=current state) and derives the target state from the matched rule\'s `to` field — the caller does NOT pass the target state.' },
            { name: 'metaUpdate', type: 'object', required: false, description: 'Metadata merged into instance.meta BEFORE the JsonLogic condition is evaluated' }
        ],
        description: 'Trigger a state transition on a fulfillment instance. Transitions must be defined in the applied profile; the engine evaluates JsonLogic conditions before applying.',
        returns_schema: INSTANCE_WITH_TASKS,   // { ...instance, _tasks } — _tasks for Router async dispatch
        ai: false
    },
    {
        name: 'fulfillment.instance.cancel',
        params: [
            { name: 'id',             type: 'string',  required: true,  maxLength: 64,  pattern: 'id', description: 'Instance ID' },
            { name: 'reason',         type: 'string',  required: true,  maxLength: 512, description: 'Cancellation reason (written to meta.cancel_reason)' },
            { name: 'notifyCustomer', type: 'boolean', required: false, description: 'Whether to notify the customer' }
        ],
        description: 'Business-semantic cancel: writes the reason to meta and fires the profile cancel_requested transition.',
        returns_schema: INSTANCE_WITH_TASKS,   // advance() → { ...instance, _tasks }
        ai: false
    },
    {
        name: 'fulfillment.instance.hold',
        params: [
            { name: 'id',             type: 'string', required: true,  maxLength: 64,  pattern: 'id', description: 'Instance ID' },
            { name: 'reason',         type: 'string', required: true,  maxLength: 512, description: 'Hold reason (written to meta.hold_reason)' },
            { name: 'expectedResume', type: 'string', required: false, maxLength: 64,  description: 'Expected resume time (ISO 8601)' }
        ],
        description: 'Pause an instance: fires the profile hold_requested transition. prevState is recorded so resume restores it.',
        returns_schema: INSTANCE_WITH_TASKS,   // advance() → { ...instance, _tasks }
        ai: false
    },
    {
        name: 'fulfillment.instance.resume',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id', description: 'Instance ID' }
        ],
        description: 'Resume a held instance back to its prevState (dynamic target; bypasses rule matching).',
        // ⚠ NON-UNIFORM: resume returns the bare instance — NO _tasks (unlike transition/cancel/
        //   hold/override, its advance() siblings). prevState is non-null here (resume requires it).
        returns_schema: INSTANCE_BASE,
        ai: false
    },
    {
        name: 'fulfillment.instance.override',
        params: [
            { name: 'id',     type: 'string', required: true, maxLength: 64,  pattern: 'id', description: 'Instance ID' },
            { name: 'event',  type: 'string', required: true, maxLength: 64,  description: 'Event to force; target state comes from the matched rule, condition is skipped' },
            { name: 'reason', type: 'string', required: true, maxLength: 512, description: 'Override justification (audited; history entry marked forced:true)' }
        ],
        description: 'Admin force-advance, skipping the JsonLogic condition. Requires admin permit.',
        returns_schema: INSTANCE_WITH_TASKS,   // advance() → { ...instance, _tasks } (history entry forced:true)
        ai: false
    },
    {
        name: 'fulfillment.instance.update',
        params: [
            { name: 'id',   type: 'string', required: true, maxLength: 64, pattern: 'id', description: 'Instance ID' },
            { name: 'meta', type: 'object', required: false, description: 'Metadata to MERGE into instance.meta (e.g. cached meta_fields.source values pulled by the frontend)' }
        ],
        description: 'Update instance metadata (merges meta). Used to cache meta_fields.source values before a transition evaluates its condition.',
        // update() always stamps updatedAt and returns the bare instance — no _tasks.
        returns_schema: [
            ...INSTANCE_BASE.filter((r) => r.name !== 'updatedAt'),
            { name: 'updatedAt', type: 'number', required: true },
        ],
        ai: false
    },

    // --- Profile Methods ---
    {
        name: 'fulfillment.profile.create',
        params: [
            { name: 'id',          type: 'string', required: true,  maxLength: 64, pattern: 'id', description: 'Profile unique key (e.g. standard_trade)' },
            { name: 'name',        type: 'string', required: true,  maxLength: 128, description: 'Human-readable profile name' },
            { name: 'transitions', type: 'array',  required: false, description: 'Transition rules array' }
        ],
        description: 'Create a fulfillment profile (state machine configuration)',
        returns_schema: PROFILE_RETURN,   // entity.create() → { status, ...params, id, createdAt, updatedAt }
        ai: false
    },
    {
        name: 'fulfillment.profile.get',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id', description: 'Profile ID' }
        ],
        description: 'Get a fulfillment profile',
        returns_schema: PROFILE_RETURN,   // stored entity record (NOT_FOUND throws, never returns null)
        ai: true
    },
    {
        name: 'fulfillment.profile.list',
        params: [],
        description: 'List all fulfillment profiles',
        returns_schema: LIST_RETURN,      // entity.list() → { items, total }
        ai: true
    },
    {
        name: 'fulfillment.profile.update',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id', description: 'Profile ID' }
        ],
        description: 'Update a fulfillment profile',
        returns_schema: PROFILE_RETURN,   // entity.update() → merged record + updatedAt
        ai: false
    },
    {
        name: 'fulfillment.profile.delete',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id', description: 'Profile ID' }
        ],
        description: 'Soft delete a fulfillment profile',
        // ⚠ softDelete=true → delete() is an update(status=DELETED) and returns the FULL entity
        //   record (status: 'DELETED'), NOT { success: true }. Differs from destroy. See codeBugsFlagged.
        returns_schema: PROFILE_RETURN,
        ai: false
    },
    {
        name: 'fulfillment.profile.restore',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id', description: 'Profile ID' }
        ],
        description: 'Restore a soft-deleted fulfillment profile',
        // returns the entity record: update(status=ACTIVE), or the existing record verbatim if
        // it was not DELETED — both are PROFILE_RETURN-shaped.
        returns_schema: PROFILE_RETURN,
        ai: false
    },
    {
        name: 'fulfillment.profile.destroy',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id', description: 'Profile ID' }
        ],
        description: 'Permanently delete a fulfillment profile',
        returns_schema: [{ name: 'success', type: 'boolean', required: true }],   // entity.destroy() → { success: true }
        ai: false
    },
    {
        name: 'fulfillment.profile.generate',
        params: [
            { name: 'requirement', type: 'string', required: true, maxLength: 4000, description: 'Natural-language description of the desired fulfillment flow' },
            { name: 'profileId',   type: 'string', required: false, maxLength: 64, description: 'Optional id to stamp onto the candidate' },
            { name: 'maxRepairs',  type: 'number', required: false, description: 'Repair round-trips after the first attempt (default 2)' }
        ],
        // Returns a CANDIDATE (not created): { profile, lintReport:{errors,warnings}, attempts, ok }.
        // ok=true ⇒ lint found 0 errors (activatable); a human reviews then calls profile.create.
        returns: ['ok'],
        returns_schema: [
            { name: 'ok',         type: 'boolean', required: true },
            { name: 'attempts',   type: 'number',  required: true },
            { name: 'profile',    type: 'object' },                  // null if no valid JSON was produced
            { name: 'lintReport', type: 'object',  required: true }, // { errors:[], warnings:[] }
        ],
        description: 'Generate a fulfillment profile CANDIDATE from a natural-language requirement (LLM → lint → bounded repair). Returns a validated candidate for human review; does NOT create it.',
        ai: false
    },
    {
        name: 'fulfillment.profile.submit',
        params: [
            { name: 'name',           type: 'string', required: false, maxLength: 128, description: 'Profile name (id derived from it if id absent)' },
            { name: 'id',             type: 'string', required: false, maxLength: 64,  description: 'Optional explicit profile id' },
            { name: 'transitions',    type: 'array',  required: false, description: 'Transition rules' },
            { name: 'meta_fields',    type: 'array',  required: false, description: 'Sourced/metaUpdate fields' },
            { name: 'allowedActions', type: 'array',  required: false, description: 'Optional action allow-list (policy/footprint pre-check)' }
        ],
        // Submit a profile for review: lint-gated → PENDING_REVIEW (NOT usable until approved).
        // ok=false ⇒ rejected at the lint gate (nothing stored); ok=true ⇒ queued for approval.
        returns: ['ok'],
        returns_schema: [
            { name: 'ok',          type: 'boolean', required: true },
            { name: 'id',          type: 'string',  required: true },
            { name: 'reviewState', type: 'string' },                  // PENDING_REVIEW when ok, null when rejected
            { name: 'lintReport',  type: 'object',  required: true },
        ],
        description: 'Submit a fulfillment profile for review (lint-gated → PENDING_REVIEW). Not usable until approved; an external submitter can propose but never self-activate.',
        ai: false
    },
    {
        name: 'fulfillment.profile.approve',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id', description: 'Profile ID' }],
        // PENDING_REVIEW → APPROVED (approver must differ from submitter). Now usable.
        returns_schema: [
            { name: 'id',          type: 'string', required: true },
            { name: 'reviewState', type: 'string', required: true },  // APPROVED
        ],
        description: 'Approve a PENDING_REVIEW profile → APPROVED (admin; approver ≠ submitter). The profile becomes usable for instances.',
        ai: false
    },
    {
        name: 'fulfillment.profile.reject',
        params: [
            { name: 'id',     type: 'string', required: true, maxLength: 64, pattern: 'id', description: 'Profile ID' },
            { name: 'reason', type: 'string', required: false, maxLength: 512, description: 'Rejection reason' }
        ],
        returns_schema: [
            { name: 'id',          type: 'string', required: true },
            { name: 'reviewState', type: 'string', required: true },  // REJECTED
        ],
        description: 'Reject a PENDING_REVIEW profile → REJECTED (admin). Stays unusable.',
        ai: false
    },

    // --- System Methods ---
    { name: 'ping',     params: [], description: 'Health check',                ai: true,  public: true },
    { name: 'methods',  params: [], description: 'Get service surface area',    ai: false, public: true },
    { name: 'entities', params: [], description: 'Get entity schema definitions', ai: false, public: true },

    // Relay bot token lifecycle — admin only
    // set/clear are wrapped in index.js to return a fixed { ok: true }. status proxies
    // relay.status(): hasToken is the only key on BOTH branches ({ hasToken: false } vs the
    // full descriptor); the rest exist only when hasToken === true → typed but not required.
    { name: 'fulfillment.token.set',    params: [{ name: 'token', type: 'string', required: true }, { name: 'expiresAt', type: 'number', required: false }, { name: 'sub', type: 'string', required: false }], returns_schema: [{ name: 'ok', type: 'boolean', required: true }], description: 'Set relay bot token (admin)', ai: false },
    { name: 'fulfillment.token.status', params: [], returns_schema: [
        { name: 'hasToken',      type: 'boolean', required: true },
        { name: 'sub',           type: 'string' },
        { name: 'expiresAt',     type: 'number' },
        { name: 'ttlMs',         type: 'number' },
        { name: 'lastRefreshAt', type: 'number' },
        { name: 'needsRotation', type: 'boolean' },
        { name: 'expired',       type: 'boolean' },
    ], description: 'Get relay bot token status (admin)', ai: false },
    { name: 'fulfillment.token.clear',  params: [], returns_schema: [{ name: 'ok', type: 'boolean', required: true }], description: 'Clear relay bot token (admin)', ai: false },
];

module.exports = methods;
