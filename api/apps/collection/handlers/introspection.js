/**
 * Collection service surface area.
 *
 * @attention Declaration here MUST stay in sync with the handler registration in
 *            index.js (CLAUDE.md §5 red line).
 *
 * record / settle emit EVENT:PAYMENT:* via the _event piggyback path — the Router
 * extracts `_event` from the response and writes it to the stream. This is the
 * SECOND event-production path (the inbound ingress uses event.emit instead), and
 * the driver for multi-hop event choreography.
 */

// --- PARAM DESCRIPTOR VOCABULARY ---
//
// Strengthened param schemas: every string param declares a length cap, and identifier-ish
// params declare a named `pattern` from library/validate.js's registry. The Router enforces
// these (warn-mode by default; flip PARAM_VALIDATION=enforce to reject). Declare here.
//   maxLength — hard length cap (in addition to the global 5MB OOM shield)
//   pattern   — named format from library/validate PATTERNS ('id' | 'slug' | …)
const ID          = { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' };       // lookup/mutation key
const ORDER_ID    = { name: 'orderId', type: 'string', maxLength: 64, pattern: 'id' };                  // foreign key
const SOURCE      = { name: 'source', type: 'string', maxLength: 64 };                                  // enum-ish key
const CURRENCY    = { name: 'currency', type: 'string', maxLength: 64 };                                // enum-ish key (ISO code)
const EXTERNAL_REF= { name: 'externalRef', type: 'string', maxLength: 512 };                            // opaque external reference
const STATE_OPT   = { name: 'state', type: 'string', maxLength: 64 };                                   // business-state filter (RECEIVED|SETTLED|REFUNDED) — matches logic list({ state })

// --- RETURN CONTRACT VOCABULARY (returns_schema) ---
//
// `returns` (flat key list) stays as the legacy AI-discovery hint the Router advertises.
// `returns_schema` is the typed, machine-checkable contract (library/contract.js dialect,
// same rule-items as `params`) — what the return-contract test asserts and what the
// fulfillment profile linter resolves meta_field source.pick paths against.
//
// ⚠ FIELD SEMANTICS (the trap this schema documents): a payment carries TWO status-like
// fields. `state` is the BUSINESS lifecycle (RECEIVED → SETTLED) — this is what a
// fulfillment condition wants. `status` is the Entity-Factory record lifecycle
// (ACTIVE/DELETED). The legacy `returns` lists `status` (always 'ACTIVE' for a live
// payment) but NOT `state`; a profile that picks `status` expecting payment progress gets
// the wrong value silently. Both are declared below so the contract is unambiguous.
// Verified against logic/payment.js + library/entity.js create/get/update results
// (2026-06-18). entity.create returns { status, ...params, id, createdAt, updatedAt };
// record/settle add an `_event` piggyback that the Router strips BEFORE the client sees
// it (index.js), so `_event` is NOT a client-facing key and is deliberately absent here.
// On every non-throwing path id/state/amount are always present (create requires amount>0;
// get/settle read a stored payment that already carries them) → required. The nullable
// foreign/optional fields are stamped `|| null` so they are present-but-null (not required;
// checkParams skips null typed-non-required keys). status/receivedAt/createdAt/updatedAt are
// always present too but left non-required to keep the contract loose where it costs nothing.
const PAYMENT_RETURN = [
    { name: 'id',          type: 'string', required: true },
    { name: 'state',       type: 'string', required: true },   // BUSINESS: RECEIVED | SETTLED
    { name: 'amount',      type: 'number', required: true },
    { name: 'status',      type: 'string' },                   // ENTITY lifecycle: ACTIVE | DELETED
    { name: 'orderId',     type: 'string' },                   // nullable foreign key
    { name: 'currency',    type: 'string' },                   // nullable
    { name: 'source',      type: 'string' },                   // nullable
    { name: 'externalRef', type: 'string' },                   // nullable
    { name: 'receivedAt',  type: 'number' },                   // set at record time
    { name: 'settledAt',   type: 'number' },                   // null until settled
    { name: 'refundedAt',  type: 'number' },                   // set at refund time
    { name: 'approvalId',  type: 'string' },                   // the approval that authorised the refund
    { name: 'createdAt',   type: 'number' },
    { name: 'updatedAt',   type: 'number' },                   // entity-factory stamp (always present)
];

const methods = [
    // legacy `returns` now surfaces the BUSINESS `state` (RECEIVED|SETTLED) — not just the
    // entity-lifecycle `status` (always 'ACTIVE' for a live payment) the audit flagged as the
    // misleading discovery hint. All listed keys are present on every non-throwing path and ⊆ PAYMENT_RETURN.
    { name: 'collection.payment.record', params: [SOURCE, ORDER_ID, { name: 'amount', type: 'number', required: true }, CURRENCY, EXTERNAL_REF, { name: 'idempotency_key', type: 'string', maxLength: 128 }], returns: ['id', 'state', 'status', 'amount'], returns_schema: PAYMENT_RETURN, description: 'Record an incoming payment; emits EVENT:PAYMENT:RECEIVED. Honors idempotency_key for safe _task replay.', ai: true },
    { name: 'collection.payment.settle', params: [ID], returns: ['id', 'state', 'status', 'settledAt'], returns_schema: PAYMENT_RETURN, description: 'Settle a payment; emits EVENT:PAYMENT:SETTLED', ai: true },
    // GATED: refund requires `approvalId` referencing a DONE, signed 3-party approval.record
    // that targets `collection-payment-{id}`. Verified via the Router (approval.record.get).
    { name: 'collection.payment.refund', params: [ID, { name: 'approvalId', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id', 'state', 'status', 'refundedAt'], returns_schema: PAYMENT_RETURN, description: 'Refund a payment — requires a confirmed, signed approval (approval.record DONE) targeting this payment', ai: true },
    { name: 'collection.payment.get',    params: [ID], returns: ['id', 'state', 'status', 'amount'], returns_schema: PAYMENT_RETURN, description: 'Get a payment', ai: true },
    { name: 'collection.payment.list',   params: [STATE_OPT, { name: 'page', type: 'number' }, { name: 'pageSize', type: 'number' }], returns: ['items', 'total'], returns_schema: [{ name: 'items', type: 'array', required: true }, { name: 'total', type: 'number', required: true }], description: 'List payments', ai: true },

    // Admin-only relay token lifecycle (outbound approval.record.get for refund gating).
    { name: 'collection.token.set',    params: [{ name: 'token', type: 'string', required: true, maxLength: 512 }, { name: 'expiresAt', type: 'number' }, { name: 'sub', type: 'string', maxLength: 64 }], returns_schema: [{ name: 'ok', type: 'boolean', required: true }], description: 'Set relay bot token (admin)', ai: false },
    { name: 'collection.token.status', params: [], returns_schema: [{ name: 'hasToken', type: 'boolean', required: true }], description: 'Relay token status (admin)', ai: false },
    { name: 'collection.token.clear',  params: [], returns_schema: [{ name: 'ok', type: 'boolean', required: true }], description: 'Clear relay bot token (admin)', ai: false },

    { name: 'ping',     params: [], returns: ['status', 'version', 'uptime'], description: 'Health check', ai: true },
    { name: 'methods',  params: [], description: 'Get surface area definition', ai: false },
    { name: 'entities', params: [], description: 'Get entity definitions', ai: false }
];

module.exports = methods;
