/**
 * Market service surface area.
 *
 * @attention Declaration here MUST stay in sync with index.js registration (CLAUDE.md §5).
 *
 * create / ship emit EVENT:SHIPMENT:* via the _event piggyback path (Router extracts
 * `_event` from the response). market sits downstream of collection: a workflow
 * subscribing to EVENT:PAYMENT:SETTLED calls market.shipment.create, continuing the
 * multi-hop event choreography.
 */
// --- RETURN CONTRACT VOCABULARY (returns_schema) ---
//
// `returns` (flat key list) stays as the legacy AI-discovery hint the Router advertises.
// `returns_schema` is the typed, machine-checkable contract (library/contract.js dialect,
// same rule-items as `params`) — what the return-contract test asserts and what an
// orchestration/AI binder resolves a source.pick path against.
//
// ⚠ FIELD SEMANTICS (the trap this schema documents): a shipment carries TWO status-like
// fields. `state` is the BUSINESS lifecycle (CREATED → SHIPPED) — this is what a workflow
// condition wants. `status` is the Entity-Factory record lifecycle (ACTIVE/DELETED; this
// entity is softDelete:false so it stays 'ACTIVE'). Both are declared so the contract is
// unambiguous.
//
// Verified against logic/shipment.js + library/entity.js create/get/update/list (2026-06-18):
//   entity.create returns { status, ...params, id, createdAt, updatedAt }; for shipment
//   params = { orderId, paymentId, address, state:'CREATED', trackingNo:null, shippedAt:null }
//   — so orderId/paymentId/address are coerced `|| null` and trackingNo/shippedAt start null.
//   create/ship add an `_event` piggyback that the Router strips BEFORE the client sees it
//   (index.js), so `_event` is NOT a client-facing key and is deliberately absent here.
//
// REQUIRED policy: checkParams fails a `required` key when its value is null OR missing
// (validate.js L97-100). So ONLY keys present-and-non-null on EVERY non-throwing path are
// `required`: id + state (and the entity-lifecycle status, always 'ACTIVE'). The nullable
// foreign/optional fields (orderId/paymentId/address/trackingNo/shippedAt) are TYPED but NOT
// required — they are legitimately null on the create path. createdAt/updatedAt are always
// present numbers but left non-required to keep the contract loose where it costs nothing.
const SHIPMENT_RETURN = [
    { name: 'id',         type: 'string', required: true },
    { name: 'state',      type: 'string', required: true },   // BUSINESS: CREATED | SHIPPED
    { name: 'status',     type: 'string', required: true },   // ENTITY lifecycle: ACTIVE | DELETED (always ACTIVE here)
    { name: 'orderId',    type: 'string' },                   // nullable foreign key (|| null on create)
    { name: 'paymentId',  type: 'string' },                   // nullable foreign key (|| null on create)
    { name: 'address',    type: 'string' },                   // nullable (|| null on create)
    { name: 'trackingNo', type: 'string' },                   // null until shipped
    { name: 'shippedAt',  type: 'number' },                   // null until shipped (clock.now() on ship)
    { name: 'createdAt',  type: 'number' },                   // entity-factory stamp (always present)
    { name: 'updatedAt',  type: 'number' },                   // entity-factory stamp (always present)
];

// order: PLACED → PAID → CONFIRMED | HELD. `state` is the business lifecycle; `status`
// is the entity-factory record lifecycle (always 'ACTIVE' here). On every non-throwing
// path id/state/status are present → required. The timestamps/refs are stamped `|| null`
// (present-but-null) → typed but NOT required (checkParams skips null typed-non-required).
const ORDER_RETURN = [
    { name: 'id',          type: 'string', required: true },
    { name: 'state',       type: 'string', required: true },   // BUSINESS: PLACED | PAID | CONFIRMED | HELD
    { name: 'status',      type: 'string', required: true },   // ENTITY lifecycle: ACTIVE | DELETED (always ACTIVE here)
    { name: 'amount',      type: 'number' },                   // nullable (|| null on create)
    { name: 'currency',    type: 'string' },                   // nullable
    { name: 'orderRef',    type: 'string' },                   // nullable external ref
    { name: 'paidAt',      type: 'number' },                   // null until paid
    { name: 'confirmedAt', type: 'number' },                   // null until confirmed
    { name: 'heldAt',      type: 'number' },                   // null unless held
    { name: 'holdReason',  type: 'string' },                   // null unless held
    { name: 'createdAt',   type: 'number' },
    { name: 'updatedAt',   type: 'number' },
];

const methods = [
    { name: 'market.shipment.create', params: [{ name: 'orderId', type: 'string', maxLength: 64, pattern: 'id' }, { name: 'paymentId', type: 'string', maxLength: 64, pattern: 'id' }, { name: 'address', type: 'string', maxLength: 4000 }, { name: 'idempotency_key', type: 'string', maxLength: 128 }], returns: ['id', 'state', 'status'], returns_schema: SHIPMENT_RETURN, description: 'Create a shipment; emits EVENT:SHIPMENT:CREATED. Honors idempotency_key for safe _task replay.', ai: true },
    { name: 'market.shipment.ship',   params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id', 'state', 'trackingNo'], returns_schema: SHIPMENT_RETURN, description: 'Ship a shipment; emits EVENT:SHIPMENT:SHIPPED', ai: true },
    { name: 'market.shipment.get',    params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id', 'state', 'orderId', 'trackingNo'], returns_schema: SHIPMENT_RETURN, description: 'Get a shipment', ai: true },
    { name: 'market.shipment.list',   params: [{ name: 'state', type: 'string', maxLength: 64 }, { name: 'page', type: 'number' }, { name: 'pageSize', type: 'number' }], returns: ['items', 'total'], returns_schema: [{ name: 'items', type: 'array', required: true }, { name: 'total', type: 'number', required: true }], description: 'List shipments', ai: true },

    { name: 'market.order.create',  params: [{ name: 'orderRef', type: 'string', maxLength: 64 }, { name: 'amount', type: 'number' }, { name: 'currency', type: 'string', maxLength: 64 }, { name: 'idempotency_key', type: 'string', maxLength: 128 }], returns: ['id', 'state', 'status'], returns_schema: ORDER_RETURN, description: 'Place an order (state PLACED); must be paid + AML-cleared to advance. Honors idempotency_key for safe _task replay.', ai: true },
    { name: 'market.order.pay',     params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'idempotency_key', type: 'string', maxLength: 128 }], returns: ['id', 'state'], returns_schema: ORDER_RETURN, description: 'Advance a PLACED order to PAID (payment collected). Idempotent; no-op once past PLACED.', ai: true },
    { name: 'market.order.confirm', params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'idempotency_key', type: 'string', maxLength: 128 }], returns: ['id', 'state'], returns_schema: ORDER_RETURN, description: 'Confirm a PAID order (AML cleared) → CONFIRMED. Idempotent; errors if not PAID.', ai: true },
    { name: 'market.order.hold',    params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'reason', type: 'string', maxLength: 512 }, { name: 'idempotency_key', type: 'string', maxLength: 128 }], returns: ['id', 'state'], returns_schema: ORDER_RETURN, description: 'Hold a PAID order (AML flagged) → HELD. Idempotent; errors if not PAID.', ai: true },
    { name: 'market.order.get',     params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id', 'state', 'amount'], returns_schema: ORDER_RETURN, description: 'Get an order', ai: true },
    { name: 'market.order.list',    params: [{ name: 'state', type: 'string', maxLength: 64 }, { name: 'page', type: 'number' }, { name: 'pageSize', type: 'number' }], returns: ['items', 'total'], returns_schema: [{ name: 'items', type: 'array', required: true }, { name: 'total', type: 'number', required: true }], description: 'List orders', ai: true },

    { name: 'ping',     params: [], returns: ['status', 'version', 'uptime'], description: 'Health check', ai: true },
    { name: 'methods',  params: [], description: 'Get surface area definition', ai: false },
    { name: 'entities', params: [], description: 'Get entity definitions', ai: false }
];

module.exports = methods;
