const crypto = require('crypto');
const createEntity = require('../../../library/entity');
const clock = require('../../../library/clock');
const jsonrpc = require('../handlers/jsonrpc');

/**
 * Shipment logic.
 *
 * create / ship emit via the _event PIGGYBACK path (return the business object with
 * an `_event` array; the Router extracts it). Source = 'market' — register it in the
 * Router event registry (see README). `state` (CREATED/SHIPPED) is the business
 * lifecycle, kept separate from the factory's ACTIVE/DELETED `status`.
 */
module.exports = (redis, { config }) => {
    const EV = config.events;
    const entity = createEntity(redis, {
        serviceName: config.serviceName,
        entityName: 'shipment',
        idLength: config.idLengths.shipment,
        softDelete: false,
        searchFields: ['orderId', 'paymentId', 'trackingNo'],
    });

    function eventOf(def, s) {
        return {
            stream: def.stream,
            type: def.type,
            payload: { shipmentId: s.id, orderId: s.orderId || null, paymentId: s.paymentId || null, state: s.state, trackingNo: s.trackingNo || null },
        };
    }

    async function create({ orderId, paymentId, address, idempotency_key } = {}) {
        // Idempotency contract: a replayed _task with the same key must not create a
        // second shipment or re-emit. Cache stores the object WITHOUT _event.
        if (idempotency_key) {
            const cached = await redis.get(`MARKET:DEDUP:${idempotency_key}`);
            if (cached) return JSON.parse(cached);
        }
        const s = await entity.create({
            orderId: orderId || null,
            paymentId: paymentId || null,
            address: address || null,
            state: 'CREATED',
            trackingNo: null,
            shippedAt: null,
        });
        if (idempotency_key) await redis.set(`MARKET:DEDUP:${idempotency_key}`, JSON.stringify(s), { EX: 604800 });
        return { ...s, _event: [eventOf(EV.created, s)] };
    }

    async function ship({ id } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const current = await entity.get({ id });
        if (!current) throw jsonrpc.NOT_FOUND('shipment');
        if (current.state === 'SHIPPED') return current;   // idempotent, no re-emit
        const trackingNo = 'TRK-' + crypto.randomBytes(5).toString('hex').toUpperCase();
        const updated = await entity.update({ id, state: 'SHIPPED', trackingNo, shippedAt: clock.now() });
        return { ...updated, _event: [eventOf(EV.shipped, updated)] };
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

    return { create, ship, get, list };
};
