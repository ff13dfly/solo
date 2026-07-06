const createEntity = require('../../../library/entity');
const clock = require('../../../library/clock');
const jsonrpc = require('../handlers/jsonrpc');

/**
 * Order logic.
 *
 * A market order that must be PAID, then AML-cleared, before it advances:
 *   PLACED ──pay──▶ PAID ──confirm──▶ CONFIRMED
 *                      └────hold────▶ HELD
 *
 * `state` is the BUSINESS lifecycle, kept separate from the Entity-Factory record
 * `status` (ACTIVE/DELETED; this entity is softDelete:false so it stays 'ACTIVE').
 *
 * Unlike shipment, order methods do NOT emit EVENT:ORDER:* — nothing in the AML
 * pipeline consumes them; the order is advanced by fulfillment `_tasks`
 * (market.order.pay/confirm/hold) and observed via get/list. Each transition is
 * state-guarded + idempotent so a replayed _task (same transition_id → same
 * idempotency_key) is safe and never double-advances or moves the order backwards.
 */
module.exports = (redis, { config }) => {
    const entity = createEntity(redis, {
        serviceName: config.serviceName,
        entityName: 'order',
        idLength: config.idLengths.order,
        softDelete: false,
        searchFields: ['orderRef'],
    });

    async function create({ orderRef, amount, currency, idempotency_key } = {}) {
        // Idempotency contract: a replayed create with the same key returns the cached
        // object (stored WITHOUT mutation) instead of creating a second order.
        if (idempotency_key) {
            const cached = await redis.get(`MARKET:ORDERDEDUP:${idempotency_key}`);
            if (cached) return JSON.parse(cached);
        }
        const o = await entity.create({
            orderRef: orderRef || null,
            amount: (typeof amount === 'number') ? amount : null,
            currency: currency || null,
            state: 'PLACED',
            paidAt: null,
            confirmedAt: null,
            heldAt: null,
            holdReason: null,
        });
        if (idempotency_key) await redis.set(`MARKET:ORDERDEDUP:${idempotency_key}`, JSON.stringify(o), { EX: 604800 });
        return o;
    }

    // PLACED → PAID. Idempotent: a replay (state already PAID or beyond) returns the
    // current record unchanged — never moves the order backwards to PAID.
    async function pay({ id } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const cur = await entity.get({ id });
        if (!cur) throw jsonrpc.NOT_FOUND('order');
        if (cur.state !== 'PLACED') return cur;
        return entity.update({ id, state: 'PAID', paidAt: clock.now() });
    }

    // PAID → CONFIRMED (AML cleared). Idempotent on CONFIRMED; rejects from any state
    // other than PAID so an out-of-order/illegal advance is loud, not silent.
    async function confirm({ id } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const cur = await entity.get({ id });
        if (!cur) throw jsonrpc.NOT_FOUND('order');
        if (cur.state === 'CONFIRMED') return cur;
        if (cur.state !== 'PAID') throw jsonrpc.INVALID_PARAMS(`order ${id} is ${cur.state}, cannot confirm (must be PAID)`);
        return entity.update({ id, state: 'CONFIRMED', confirmedAt: clock.now() });
    }

    // PAID → HELD (AML flagged). Idempotent on HELD; rejects from any non-PAID state.
    async function hold({ id, reason } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const cur = await entity.get({ id });
        if (!cur) throw jsonrpc.NOT_FOUND('order');
        if (cur.state === 'HELD') return cur;
        if (cur.state !== 'PAID') throw jsonrpc.INVALID_PARAMS(`order ${id} is ${cur.state}, cannot hold (must be PAID)`);
        return entity.update({ id, state: 'HELD', heldAt: clock.now(), holdReason: reason || 'AML hold' });
    }

    async function get({ id } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        return entity.get({ id });
    }

    async function list({ state, page = 1, pageSize = config.pageSize } = {}) {
        const limit = Math.max(1, pageSize);
        const offset = Math.max(0, (Math.max(1, page) - 1) * limit);
        const filter = state ? (item) => item.state === state : undefined;
        return entity.list({ limit, offset, filter });
    }

    return { create, pay, confirm, hold, get, list };
};
