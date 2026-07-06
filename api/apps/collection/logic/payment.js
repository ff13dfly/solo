const createEntity = require('../../../library/entity');
const clock = require('../../../library/clock');
const jsonrpc = require('../handlers/jsonrpc');

/**
 * Payment logic.
 *
 * record / settle emit events via the _event PIGGYBACK path: the method returns
 * the business object with an `_event` array, and the Router extracts it from the
 * response and writes it to the stream (event.md §4.1). Source = 'collection'
 * (the service name) — must be registered in the Router event registry (see README).
 *
 * Note: the entity factory's `status` is the lifecycle field (ACTIVE/DELETED);
 * business lifecycle uses a separate `state` (RECEIVED/SETTLED) so factory list()
 * (which filters on status===ACTIVE) keeps working.
 */
module.exports = (redis, { config, relay } = {}) => {
    const EV = config.events;
    const entity = createEntity(redis, {
        serviceName: config.serviceName,
        entityName: 'payment',
        idLength: config.idLengths.payment,
        softDelete: false,
        searchFields: ['orderId', 'externalRef', 'source'],
    });

    function eventOf(def, p) {
        return {
            stream: def.stream,
            type: def.type,
            payload: { paymentId: p.id, orderId: p.orderId || null, amount: p.amount, currency: p.currency || null, state: p.state },
        };
    }

    // Row isolation (authority.md §4.3): when the caller's session carries an owner
    // predicate (`_scope = { field, value }`, derived from constraints.$owner by the
    // RPC handler), payments are stamped/filtered/checked by that owner. No `_scope`
    // (= internal/admin) → unchanged behaviour, so existing internal flows are untouched.
    async function record({ source, orderId, amount, currency, externalRef, idempotency_key, _scope } = {}) {
        // Idempotency contract (fulfillment §幂等契约): a replayed _task with the same
        // key must NOT create a second payment or re-emit. Cache stores the business
        // object WITHOUT _event, so a replay returns it without firing a new event.
        if (idempotency_key) {
            const cached = await redis.get(`COLLECTION:DEDUP:${idempotency_key}`);
            if (cached) return JSON.parse(cached);
        }
        if (typeof amount !== 'number' || !(amount > 0))
            throw jsonrpc.INVALID_PARAMS('amount must be a positive number');
        const fields = {
            source: source || null,
            orderId: orderId || null,
            amount,
            currency: currency || null,
            externalRef: externalRef || null,
            state: 'RECEIVED',
            receivedAt: clock.now(),
            settledAt: null,
        };
        if (_scope) fields[_scope.field] = _scope.value;   // owner stamp
        const p = await entity.create(fields);
        if (idempotency_key) await redis.set(`COLLECTION:DEDUP:${idempotency_key}`, JSON.stringify(p), { EX: 604800 });
        // _event piggyback — Router extracts and writes EVENT:PAYMENT:RECEIVED.
        return { ...p, _event: [eventOf(EV.received, p)] };
    }

    async function settle({ id, _scope } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const current = await entity.get({ id });
        if (!current || (_scope && current[_scope.field] !== _scope.value)) throw jsonrpc.NOT_FOUND('payment');
        if (current.state === 'SETTLED') return current;   // idempotent, no re-emit
        const updated = await entity.update({ id, state: 'SETTLED', settledAt: clock.now() });
        return { ...updated, _event: [eventOf(EV.settled, updated)] };
    }

    // Refund a payment — GATED on a confirmed, signed 3-party approval (governance.md §3,
    // direction 2: approval guards a business operation). This is the demonstrator that a
    // sensitive business action cannot fire on one operator's say-so: it requires a DONE
    // approval.record that (a) targets THIS payment, (b) carries the full request→verify→
    // confirm chain, (c) is signed by 3 DISTINCT actors with real Ed25519 evidence. The
    // record is fetched via the Router-mediated relay (no direct service-to-service call).
    async function refund({ id, approvalId, _scope } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        if (!approvalId) throw jsonrpc.MISSING_PARAM('approvalId');
        const current = await entity.get({ id });
        if (!current || (_scope && current[_scope.field] !== _scope.value)) throw jsonrpc.NOT_FOUND('payment');
        if (current.state === 'REFUNDED') return current;   // idempotent, no re-check
        if (current.state !== 'RECEIVED' && current.state !== 'SETTLED')
            throw jsonrpc.INVALID_PARAMS(`cannot refund a payment in state ${current.state}`);

        if (!relay) throw jsonrpc.INTERNAL_ERROR('approval verification unavailable (no relay)');
        let approval = null;
        try { approval = await relay.call('approval.record.get', { id: approvalId }); }
        catch (e) {
            // A missing approval (NOT_FOUND / 404) is a FAILED GATE, not an infra fault —
            // map it to FORBIDDEN so a bogus approvalId can't masquerade as a 500 (and so
            // it stays out of ERROR:QUEUE, which is reserved for real -32603 faults).
            if (e.rpcCode === -32002 || e.httpStatus === 404) approval = null;
            else throw jsonrpc.INTERNAL_ERROR(`approval lookup failed: ${e.message}`);
        }

        // Fail-closed gate: every condition must hold or the refund is refused.
        if (!approval || approval.state !== 'DONE')
            throw jsonrpc.FORBIDDEN('refund requires a confirmed (DONE) approval');
        // Target is the approval's free-form subject; keep it colon-free so it satisfies
        // approval.record.request's `pattern:'id'` ([A-Za-z0-9_-]) under enforce-mode too.
        if (approval.target !== `collection-payment-${id}`)
            throw jsonrpc.FORBIDDEN('approval target does not match this payment');
        const evidence = approval.evidence || [];
        const stages = new Set(evidence.map((e) => e.stage));
        if (!(stages.has('request') && stages.has('verify') && stages.has('confirm')))
            throw jsonrpc.FORBIDDEN('approval is missing a stage in the request→verify→confirm chain');
        if (!evidence.every((e) => e.method === 'solana:ed25519' && e.signature))
            throw jsonrpc.FORBIDDEN('every approval stage must be cryptographically signed');
        if (new Set(evidence.map((e) => e.actor).filter(Boolean)).size < 3)
            throw jsonrpc.FORBIDDEN('refund requires 3 distinct approvers');

        // No _event: EVENT:PAYMENT:REFUNDED is not in the production Router registry
        // (router/config.js, protected). Emitting it is a documented follow-up.
        return entity.update({ id, state: 'REFUNDED', refundedAt: clock.now(), approvalId });
    }

    async function get({ id, _scope } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const p = await entity.get({ id });
        if (p && _scope && p[_scope.field] !== _scope.value) throw jsonrpc.NOT_FOUND('payment');
        return p;
    }

    async function list({ state, page = 1, pageSize = config.pageSize, _scope } = {}) {
        const limit = Math.max(1, pageSize);
        const offset = Math.max(0, (Math.max(1, page) - 1) * limit);
        const filter = (item) =>
            (!state || item.state === state) &&
            (!_scope || item[_scope.field] === _scope.value);
        return entity.list({ limit, offset, filter });
    }

    return { record, settle, refund, get, list };
};
