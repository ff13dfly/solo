/**
 * Orchestrator Service Capability Registry (Introspection)
 * 
 * @why Defines the "Surface Area" of the orchestration service.
 * @attention 
 *   - `ai: true` flags indicate methods exposed for autonomous AI intent detection.
 *   - The snapshot methods are critical for syncing global AI capabilities.
 */

// --- RETURN CONTRACT VOCABULARY (returns_schema) ---
//
// `returns` (flat key list) stays as the legacy AI-discovery hint the Router advertises.
// `returns_schema` is the typed, machine-checkable contract (library/contract.js dialect,
// same rule-items as `params`) — what the return-contract test asserts.
//
// RULE for `required`: a key is `required: true` ONLY when it is present on EVERY
// non-throwing return path of the handler. Conditional / nullable keys (idempotent
// early-returns, branch-specific fields, not-found→null) get a `type` but NOT required —
// checkParams treats a null/undefined value as absent and only flags it when required.

// The persisted workflow document (workflow.create / get / update / version-with-arg all
// return this exact shape). Fields below are written by create() unconditionally; status
// gates which lifecycle fields (deletedAt / deniedBy / gateId / effective_at …) are added
// later, so only the always-present core is marked required.
const WORKFLOW_DOC = [
    { name: 'id',                  type: 'string',  required: true },
    { name: 'name',                type: 'string',  required: true },
    { name: 'desc',                type: 'string',  required: true },
    { name: 'status',              type: 'string',  required: true },   // PENDING_REVIEW|ACTIVE|REJECTED|DEPRECATED|DELETED
    { name: 'version',             type: 'number',  required: true },
    { name: 'priority',            type: 'number',  required: true },
    { name: 'steps',               type: 'array',   required: true },
    { name: 'createdAt',           type: 'number',  required: true },
    { name: 'updatedAt',           type: 'number',  required: true },
    { name: 'category',            type: 'object' },                    // submitter-supplied; may be string in legacy docs
    { name: 'tags',                type: 'array' },
    { name: 'examples',            type: 'array' },
    { name: 'negative',            type: 'array' },
    { name: 'keywords',            type: 'array' },
    { name: 'required_inputs',     type: 'array' },
    { name: 'optional_inputs',     type: 'array' },
    { name: 'synonyms',            type: 'object' },
    { name: 'resolvers',           type: 'object' },
    { name: 'allowed_triggers',    type: 'array' },
    { name: 'event_subscriptions', type: 'array' },
    { name: 'input_schema',        type: 'array' },
    { name: 'strict_result',       type: 'boolean' },
    { name: 'require_actor_permit', type: 'boolean' },                   // C4 minimal — opt-in actor footprint pre-check
    { name: 'approvals',           type: 'array' },
    { name: 'submittedBy',         type: 'string' },                    // nullable (null for admin-injected)
    { name: 'risk_level',          type: 'string' },                    // LOW | HIGH (withRiskClassification)
    { name: 'risk_reasons',        type: 'array' },
    { name: 'approval_config',     type: 'object' },
];

// A run entity (run.get / run.abort return the persisted doc; create() writes the core,
// transitions add status-specific fields). triggerSource is copied from the run-command
// (may be undefined for a raw create) so only id/workflowId/status are guaranteed.
const RUN_DOC = [
    { name: 'id',            type: 'string', required: true },
    { name: 'workflowId',    type: 'string', required: true },
    { name: 'status',        type: 'string', required: true },   // RUNNING|DONE|FAILED|STALLED|PAUSED_AWAITING_HUMAN|RESUMING|ABORTED|DEADLETTER
    { name: 'input',         type: 'object' },
    { name: 'triggerSource', type: 'string' },                   // nullable
    { name: 'triggerId',     type: 'string' },                   // nullable
    { name: 'trace',         type: 'string' },                   // nullable
    { name: 'parentEventId', type: 'string' },                   // nullable
    { name: 'actor',         type: 'string' },                   // nullable — triggering principal (actor-claim audit)
    { name: 'actorSource',   type: 'string' },                   // nullable — Router-authenticated emitter
    { name: 'enqueuedAt',    type: 'number' },
    { name: 'attempts',      type: 'number' },
    { name: 'startedAt',     type: 'number' },
];

// A persisted category document (category.get / update return this; create returns it too
// but reserves via Router first, so create is not hermetically callable).
const CATEGORY_DOC = [
    { name: 'key',       type: 'string',  required: true },
    { name: 'type',      type: 'string',  required: true },
    { name: 'scope',     type: 'string',  required: true },
    { name: 'desc',      type: 'string',  required: true },
    { name: 'status',    type: 'string',  required: true },
    { name: 'items',     type: 'array',   required: true },
    { name: 'meta',      type: 'object',  required: true },
    { name: 'createdAt', type: 'number' },                       // absent if a legacy doc predates it
    { name: 'updatedAt', type: 'number',  required: true },
];

// A category item (item.add returns the new item; item.update returns the mutated item).
const CATEGORY_ITEM = [
    { name: 'id',        type: 'string', required: true },
    { name: 'label',     type: 'object', required: true },
    { name: 'desc',      type: 'string', required: true },
    { name: 'parentId',  type: 'string' },                       // nullable
    { name: 'meta',      type: 'object' },                       // nullable
    { name: 'createdAt', type: 'number', required: true },
    { name: 'updatedAt', type: 'number' },                       // only present after an update
];

// --- REGISTERED RPC METHODS ---

const methods = [
    // 0 Dots
    { name: 'ping', params: [], returns: ['status', 'uptime'], description: 'Check service health', ai: false },

    // 1 Dot
    {
        name: 'orchestrator.workflow.run',
        params: [
            { name: 'workflowId', type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'input', type: 'object', required: false }
        ],
        // runner.run has TWO terminal returns: completed = { workflowId, workflowVersion,
        // status:'completed', trace }; failed = { …, status:'failed', failedStep, error,
        // cleanup_manifest, trace }. `status` is the branch discriminator. failedStep/error/
        // cleanup_manifest only exist on the failed branch → typed, not required.
        returns_schema: [
            { name: 'status',           type: 'string', required: true },   // 'completed' | 'failed' (branch field)
            { name: 'workflowId',       type: 'string', required: true },
            { name: 'workflowVersion',  type: 'number' },                   // null if the workflow had no version
            { name: 'trace',            type: 'array',  required: true },
            { name: 'failedStep',       type: 'string' },                   // failed branch only
            { name: 'error',            type: 'string' },                   // failed branch only
            { name: 'cleanup_manifest', type: 'array' },                    // failed branch only
        ],
        description: 'Execute a workflow with input parameters',
        ai: true
    },
    {
        name: 'orchestrator.run',
        params: [
            { name: 'workflowId', type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'input', type: 'object', required: false }
        ],
        // Alias of orchestrator.workflow.run — identical runner.run output (see above).
        returns_schema: [
            { name: 'status',           type: 'string', required: true },   // 'completed' | 'failed' (branch field)
            { name: 'workflowId',       type: 'string', required: true },
            { name: 'workflowVersion',  type: 'number' },
            { name: 'trace',            type: 'array',  required: true },
            { name: 'failedStep',       type: 'string' },
            { name: 'error',            type: 'string' },
            { name: 'cleanup_manifest', type: 'array' },
        ],
        description: 'Execute a workflow with input parameters (short alias of orchestrator.workflow.run)',
        ai: true
    },
    {
        name: 'orchestrator.run.enqueue',
        params: [
            { name: 'workflowId', type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'input', type: 'object', required: false },
            { name: 'triggerSource', type: 'string', required: false, maxLength: 64 },
            { name: 'triggerId', type: 'string', required: false, maxLength: 64, pattern: 'id' }
        ],
        // worker.enqueue returns the constructed run-command (every field defaulted there).
        returns_schema: [
            { name: 'runId',         type: 'string',  required: true },
            { name: 'workflowId',    type: 'string',  required: true },
            { name: 'input',         type: 'object',  required: true },
            { name: 'triggerSource', type: 'string',  required: true },
            { name: 'triggerId',     type: 'string' },                  // nullable
            { name: 'trace',         type: 'string' },                  // nullable
            { name: 'depth',         type: 'number',  required: true },
            { name: 'parentEventId', type: 'string' },                  // nullable
            { name: 'actor',         type: 'string' },                  // nullable — actor-claim thread
            { name: 'actorSource',   type: 'string' },                  // nullable
            { name: 'enqueuedAt',    type: 'number',  required: true },
            { name: 'attempts',      type: 'number',  required: true },
        ],
        description: 'Enqueue a run-command for async execution (admin)',
        ai: false
    },
    {
        name: 'orchestrator.run.list',
        params: [{ name: 'status', type: 'string', required: false, maxLength: 64 }],
        // NOTE: run.list returns a BARE ARRAY of run docs — not an object. The flat object-key
        // return dialect cannot express a top-level array, so no returns_schema is declared
        // (an object-key contract here would falsely fail every call). See codeBugsFlagged.
        description: 'List async run entities, optionally filtered by status (admin)',
        ai: false
    },
    {
        name: 'orchestrator.run.get',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        returns_schema: RUN_DOC,
        description: 'Get a single async run entity by ID (admin)',
        ai: false
    },
    {
        name: 'orchestrator.run.grant',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'methods', type: 'array', required: true }
        ],
        // index.js wraps run.grant: it returns a SUMMARY { ok, runId, status }, NOT the run doc.
        returns_schema: [
            { name: 'ok',     type: 'boolean', required: true },
            { name: 'runId',  type: 'string',  required: true },
            { name: 'status', type: 'string',  required: true },        // 'RESUMING' after a grant
        ],
        description: 'Grant one-shot permission to a paused run and re-enqueue it (admin)',
        ai: false
    },
    {
        name: 'orchestrator.run.abort',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'reason', type: 'string', required: false, maxLength: 4000 }
        ],
        // run.abort returns the persisted run doc, now status ABORTED (+ abortedBy/abortReason/abortedAt).
        returns_schema: RUN_DOC,
        description: 'Abort a paused run (admin)',
        ai: false
    },
    {
        name: 'orchestrator.run.retry',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }
        ],
        // index.js wraps run.requeue: returns a SUMMARY { ok, runId, status } (status RESUMING).
        returns_schema: [
            { name: 'ok',     type: 'boolean', required: true },
            { name: 'runId',  type: 'string',  required: true },
            { name: 'status', type: 'string',  required: true },
        ],
        description: 'Re-drive a STALLED run from the top — committed steps dedup via idempotency (admin)',
        ai: false
    },
    {
        name: 'orchestrator.run.trace',
        params: [
            { name: 'runId', type: 'string', maxLength: 64, pattern: 'id' },
            { name: 'workflowId', type: 'string', maxLength: 64, pattern: 'id' },
            { name: 'limit', type: 'number' },
            { name: 'days', type: 'number' },
        ],
        returns: ['items', 'total'],
        returns_schema: [
            { name: 'items', type: 'array', required: true },
            { name: 'total', type: 'number', required: true },
        ],
        description: 'Per-step execution trace for completed/failed runs (file-backed log, admin)',
        ai: false
    },
    {
        name: 'orchestrator.workflow.categories',
        params: [],
        // NOTE: returns a BARE ARRAY of category values (strings/objects) — top-level array,
        // not expressible in the flat object-key dialect. No returns_schema. See codeBugsFlagged.
        description: 'List unique workflow categories',
        ai: true
    },

    // 2 Dots
    { 
        name: 'orchestrator.workflow.create', 
        params: [
            { name: 'id', type: 'string', required: false, maxLength: 64, pattern: 'id' },
            { name: 'category', type: 'object', required: true },
            { name: 'name', type: 'string', required: true, maxLength: 128 },
            { name: 'desc', type: 'string', required: true, maxLength: 4000 },
            { name: 'steps', type: 'array', required: true },
            { name: 'priority', type: 'number', required: false },
            { name: 'tags', type: 'array', required: false },
            { name: 'examples', type: 'array', required: false },
            { name: 'negative', type: 'array', required: false },
            { name: 'required_inputs', type: 'array', required: false },
            { name: 'optional_inputs', type: 'array', required: false },
            { name: 'synonyms', type: 'object', required: false },
            { name: 'defaults', type: 'object', required: false },
            { name: 'allowed_triggers', type: 'array', required: false },
            { name: 'event_subscriptions', type: 'array', required: false },
            { name: 'input_schema', type: 'array', required: false },
            { name: 'strict_result', type: 'boolean', required: false },
            { name: 'require_actor_permit', type: 'boolean', required: false }
        ],
        returns_schema: WORKFLOW_DOC,
        description: 'Create a new workflow definition. Created workflows start in PENDING_REVIEW status and require approval before execution.',
        ai: true
    },
    {
        name: 'orchestrator.workflow.approve',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'signature', type: 'string', required: false, maxLength: 256 }],
        // FOUR return shapes (LOW C1, HIGH needs-signature, HIGH awaiting, HIGH approved).
        // Only `success` (boolean) and `lane` (string) are present on EVERY path. `status` is
        // present only on the HIGH multi-sig responses; `workflow` only on success paths;
        // gateId/digest/required/signed/effective_at are HIGH-lane only → typed, not required.
        returns_schema: [
            { name: 'success',      type: 'boolean', required: true },
            { name: 'lane',         type: 'string',  required: true },   // 'C1' | 'multisig'
            { name: 'status',       type: 'string' },                    // NEEDS_SIGNATURE | AWAITING_SIGNATURES (multisig)
            { name: 'workflow',     type: 'object' },                    // present on activation (success) paths
            { name: 'gateId',       type: 'string' },                    // multisig lane only
            { name: 'digest',       type: 'string' },                    // NEEDS_SIGNATURE only
            { name: 'required',     type: 'number' },                    // multisig lane only
            { name: 'signed',       type: 'number' },                    // AWAITING_SIGNATURES only
            { name: 'effective_at', type: 'number' },                    // multisig approved (nullable: null if no cooling)
        ],
        description: 'Approve a PENDING_REVIEW workflow. LOW-risk → ACTIVE (C1). HIGH-risk → multi-sig: call without signature to get the digest, then sign and re-call. Approver ≠ submitter.',
        ai: false
    },
    {
        name: 'orchestrator.workflow.deny',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'reason', type: 'string', required: false, maxLength: 4000 }
        ],
        returns_schema: [
            { name: 'success',  type: 'boolean', required: true },
            { name: 'workflow', type: 'object',  required: true },       // the REJECTED workflow doc
        ],
        description: 'Deny a PENDING_REVIEW workflow → REJECTED. Use workflow.restore to return it to PENDING_REVIEW for revision.',
        ai: false
    },
    {
        name: 'orchestrator.workflow.get',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        returns_schema: WORKFLOW_DOC,
        description: 'Get a workflow by ID',
        ai: true
    },
    { 
        name: 'orchestrator.workflow.list', 
        params: [
            { name: 'category', type: 'object', required: false },
            { name: 'includeDeleted', type: 'boolean', required: false },
            { name: 'limit', type: 'number', required: false },
            { name: 'offset', type: 'number', required: false }
        ], 
        returns_schema: [
            { name: 'items',  type: 'array',  required: true },
            { name: 'total',  type: 'number', required: true },
            { name: 'limit',  type: 'number', required: true },
            { name: 'offset', type: 'number', required: true },
        ],
        description: 'List workflows with optional filters',
        ai: true
    },
    {
        name: 'orchestrator.workflow.update',
        params: [
            { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' },
            { name: 'name', type: 'string', required: false, maxLength: 128 },
            { name: 'desc', type: 'string', required: false, maxLength: 4000 },
            { name: 'category', type: 'object', required: false },
            { name: 'priority', type: 'number', required: false },
            { name: 'tags', type: 'array', required: false },
            { name: 'keywords', type: 'array', required: false },
            { name: 'examples', type: 'array', required: false },
            { name: 'negative', type: 'array', required: false },
            { name: 'required_inputs', type: 'array', required: false },
            { name: 'optional_inputs', type: 'array', required: false },
            { name: 'synonyms', type: 'object', required: false },
            { name: 'steps', type: 'array', required: false },
            { name: 'resolvers', type: 'object', required: false },
            { name: 'defaults', type: 'object', required: false },
            { name: 'allowed_triggers', type: 'array', required: false },
            { name: 'event_subscriptions', type: 'array', required: false },
            { name: 'input_schema', type: 'array', required: false },
            { name: 'strict_result', type: 'boolean', required: false },
            { name: 'require_actor_permit', type: 'boolean', required: false },
            { name: 'expected_version', type: 'number', required: false }
        ],
        returns_schema: WORKFLOW_DOC,
        description: 'Update an existing workflow',
        ai: true
    },
    {
        name: 'orchestrator.workflow.delete',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        // Two paths: already-deleted early-return { success, message } and the soft-delete { success }.
        returns_schema: [
            { name: 'success', type: 'boolean', required: true },
            { name: 'message', type: 'string' },                        // only on the idempotent already-deleted path
        ],
        description: 'Soft delete a workflow',
        ai: true
    },
    {
        name: 'orchestrator.workflow.restore',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        // Two paths: already-ACTIVE/PENDING early-return { success, message } and the restore { success, workflow }.
        returns_schema: [
            { name: 'success',  type: 'boolean', required: true },
            { name: 'message',  type: 'string' },                       // only on the idempotent "already in X" path
            { name: 'workflow', type: 'object' },                       // only on the actual restore path
        ],
        description: 'Restore a workflow out of DELETED/REJECTED/DEPRECATED back to PENDING_REVIEW for full re-approval',
        ai: true
    },
    {
        name: 'orchestrator.workflow.deprecate',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }],
        returns_schema: [
            { name: 'success',  type: 'boolean', required: true },
            { name: 'workflow', type: 'object',  required: true },
        ],
        description: 'Retire an ACTIVE workflow → DEPRECATED (distinct from delete: a separate audit trail for "retired a live workflow" vs "discarded a draft"). Use workflow.restore to reactivate, which requires full re-approval.',
        ai: true
    },
    {
        name: 'orchestrator.workflow.build',
        params: [],
        returns_schema: [
            { name: 'success',   type: 'boolean', required: true },
            { name: 'count',     type: 'number',  required: true },
            { name: 'key',       type: 'string',  required: true },
            { name: 'timestamp', type: 'number',  required: true },
        ],
        description: 'Snapshot active workflows for AI recognition',
        ai: true
    },
    {
        name: 'orchestrator.workflow.snapshot',
        params: [],
        // getSnapshot: { items, timestamp } — timestamp is null when no snapshot exists yet.
        returns_schema: [
            { name: 'items',     type: 'array',  required: true },
            { name: 'timestamp', type: 'number' },                      // nullable (null before first build)
        ],
        description: 'Get current AI capability snapshot', ai: true, public: false   // narrowed: capability snapshot requires a session
    },
    {
        name: 'orchestrator.workflow.version',
        params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'version', type: 'number' }],
        // Two shapes: WITHOUT version → { id, currentVersion }; WITH version → the immutable
        // workflow snapshot (a full WORKFLOW_DOC). `id` is the only key on BOTH paths;
        // currentVersion is the no-arg path only. Snapshot-specific keys are not declared
        // required (they're absent on the no-arg summary path).
        returns_schema: [
            { name: 'id',             type: 'string', required: true },
            { name: 'currentVersion', type: 'number' },                 // no-version path only
            { name: 'status',         type: 'string' },                 // snapshot path only
            { name: 'version',        type: 'number' },                 // snapshot path only
        ],
        description: 'Get an immutable workflow version snapshot (approval-review diff)', ai: false
    },

    // category.* delegate to library/category.js. create/delete reserve/release via a Router
    // RPC (system.category.*) so they are not hermetically callable; their schema is static-derived.
    {
        name: 'orchestrator.category.create', params: [],
        returns_schema: CATEGORY_DOC,
        description: 'Create category', ai: true
    },
    {
        name: 'orchestrator.category.get', params: [],
        returns_schema: CATEGORY_DOC,
        description: 'Get category', ai: true
    },
    {
        name: 'orchestrator.category.list', params: [],
        // NOTE: category.list returns a BARE ARRAY of category docs — top-level array, not
        // expressible in the flat object-key dialect. No returns_schema. See codeBugsFlagged.
        description: 'List categories', ai: true
    },
    {
        name: 'orchestrator.category.update', params: [],
        returns_schema: CATEGORY_DOC,
        description: 'Update category', ai: true
    },
    {
        name: 'orchestrator.category.delete', params: [],
        returns_schema: [{ name: 'success', type: 'boolean', required: true }],
        description: 'Delete category', ai: true
    },
    {
        name: 'orchestrator.category.item.add', params: [],
        returns_schema: CATEGORY_ITEM,
        description: 'Add category item', ai: true
    },
    {
        name: 'orchestrator.category.item.get', params: [],
        returns_schema: CATEGORY_ITEM,
        description: 'Get a single category item', ai: true
    },
    {
        name: 'orchestrator.category.item.update', params: [],
        returns_schema: CATEGORY_ITEM,
        description: 'Update category item', ai: true
    },
    {
        name: 'orchestrator.category.item.remove', params: [],
        returns_schema: [{ name: 'success', type: 'boolean', required: true }],
        description: 'Remove category item', ai: true
    },
    // §7.7 — admin-only token lifecycle for internal-call relay
    {
        name: 'orchestrator.token.set',
        params: [
            { name: 'token',     type: 'string', required: true,  maxLength: 512 },
            { name: 'expiresAt', type: 'number', required: true },
            { name: 'sub',       type: 'string', required: false, maxLength: 64, pattern: 'id' }
        ],
        returns: ['ok'],
        // index.js hard-codes { ok: true } regardless of relay.setToken (which returns void).
        returns_schema: [{ name: 'ok', type: 'boolean', required: true }],
        description: 'Admin: inject bot session token into relay store',
        ai: false
    },
    {
        name: 'orchestrator.token.status',
        params: [],
        // FIX: the legacy `returns` listed sub/expiresAt/ttlMs/needsRotation/expired as if
        // always present — but relay.status() returns ONLY { hasToken:false } when no token is
        // set. Those keys exist only on the has-token branch (and the has-token branch ALSO
        // returns lastRefreshAt, which the legacy list omitted). Corrected: hasToken is the
        // sole guaranteed key; the rest are conditional.
        returns: ['hasToken'],
        returns_schema: [
            { name: 'hasToken',      type: 'boolean', required: true },
            { name: 'sub',           type: 'string' },                  // has-token branch only
            { name: 'expiresAt',     type: 'number' },                  // has-token branch only
            { name: 'ttlMs',         type: 'number' },                  // has-token branch only
            { name: 'lastRefreshAt', type: 'number' },                  // has-token branch only (omitted by legacy returns)
            { name: 'needsRotation', type: 'boolean' },                 // has-token branch only
            { name: 'expired',       type: 'boolean' },                 // has-token branch only
        ],
        description: 'Admin: inspect relay token state (does not return the token)',
        ai: false
    },
    {
        name: 'orchestrator.token.clear',
        params: [],
        returns: ['ok'],
        // index.js hard-codes { ok: true } regardless of relay.clear (which returns void).
        returns_schema: [{ name: 'ok', type: 'boolean', required: true }],
        description: 'Admin: clear relay token (emergency revoke)',
        ai: false
    },
    // Runtime auto↔manual pause — stops the async worker + event matcher loops without a
    // restart so an operator can degrade to manual (manual RPCs keep working).
    {
        name: 'orchestrator.control.pause',
        params: [],
        returns: ['paused'],
        returns_schema: [{ name: 'paused', type: 'boolean', required: true }],  // always true
        description: 'Admin: pause automation (worker + matcher stop draining/consuming; manual RPCs unaffected)',
        ai: false
    },
    {
        name: 'orchestrator.control.resume',
        params: [],
        returns: ['paused'],
        returns_schema: [{ name: 'paused', type: 'boolean', required: true }],  // always false
        description: 'Admin: resume automation',
        ai: false
    },
    {
        name: 'orchestrator.control.status',
        params: [],
        returns: ['paused'],
        returns_schema: [{ name: 'paused', type: 'boolean', required: true }],
        description: 'Admin: report whether automation is paused',
        ai: false
    },

    { name: 'methods', params: [], returns: ['methods', 'description'], description: 'Introspection registry', ai: false },
    { name: 'entities', params: [], returns: ['entities'], description: 'Entity schema discovery', ai: false }
];


module.exports = methods;
