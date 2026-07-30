/**
 * Delivery ledger + idempotency + delivery events (gateway-gaps G5 / G7 / G8).
 *
 * WHY these three live together: they all hang off the same moment — "a send just
 * resolved". Before this, outbound was the only core link with no queryable record
 * (only md5-addressed local WAL files), no de-dup (the notification worker retries 5×,
 * so a provider that accepted-then-timed-out got the same message twice), and no bus
 * signal (a sentinel could not react to "nothing actually left the system").
 *
 * ── Ledger (G5) ────────────────────────────────────────────────────────────────
 * A normal Entity-Factory entity, so it inherits indexes/list/search. Writes are
 * BEST-EFFORT: an audit row must never fail a delivery that the provider accepted.
 *
 * ── Idempotency (G7) ───────────────────────────────────────────────────────────
 * Optional `idempotencyKey`, mirroring ingress's (source, request_id) de-dup in the
 * outbound direction:
 *   claim()  SET NX → IN_FLIGHT   → caller proceeds
 *            key exists, DONE     → return the FIRST result (+ deduplicated:true)
 *            key exists, IN_FLIGHT→ throw a TEMPORARY error (the retry lands on DONE)
 *   settle() DONE + result, TTL   → later duplicates replay it
 *   release() on failure          → a retry is allowed to really re-send
 *
 * ── Events (G8) ────────────────────────────────────────────────────────────────
 * Emitted via the Router `_event` piggyback (router/handlers/events.js extracts and
 * deletes `_event` from the RPC result) — no relay, no bot token, no router change.
 * @attention That mechanism only carries events on a SUCCESSFUL result, so the
 *            FAILED case is a ledger row + log only; a DELIVERY_FAILED *event* needs
 *            gateway to hold a relay token (deferred — see gateway-gaps G8).
 */
const EntityFactory = require('../../../library/entity');
const clock = require('../../../library/clock');
const jsonrpc = require('../../../library/jsonrpc');

const IDEM_PREFIX = 'GATEWAY:IDEM:';
const IDEM_TTL_SEC = 24 * 60 * 60;      // a retry window wider than any worker backoff

// Attempt outcomes (written by run()) + receipt statuses (advanced by delivery.update
// when a provider webhook flows back via ingress → a consumer calls gateway.delivery.update).
const STATUS = { SENT: 'SENT', MOCKED: 'MOCKED', FAILED: 'FAILED' };
const RECEIPT = { DELIVERED: 'DELIVERED', BOUNCED: 'BOUNCED', COMPLAINED: 'COMPLAINED' };

// Wire contract for a piggybacked event (router/handlers/events.js:143): each item needs
// { stream, type, payload } — a missing `stream` is skipped outright, and the (source,
// stream, type) triple must be in the event registry or the Router blocks it.
// Declared identically in handlers/events.js (Router builds the registry view from it).
const EVENT_STREAM = 'EVENT:GATEWAY:DELIVERY';
const EVENTS = {
    SENT: 'gateway.delivery.sent',
    MOCKED: 'gateway.delivery.mocked',
    FAILED: 'gateway.delivery.failed',   // relay event.emit path (source = system.gateway bot)
};

function createDeliveryLedger(redis, { logger, relay } = {}) {
    const entity = EntityFactory(redis, {
        serviceName: 'gateway',
        entityName: 'delivery',
        searchFields: ['target', 'channel', 'provider', 'status'],
    });

    const idemKey = (key) => IDEM_PREFIX + key;

    /**
     * @returns {Promise<{ok:true}|{ok:false,replay:object}>} ok:true → proceed with the send.
     * @throws  temporary error when an identical send is still in flight.
     */
    async function claim(key) {
        if (!key) return { ok: true };
        const claimed = await redis.set(
            idemKey(key),
            JSON.stringify({ state: 'IN_FLIGHT', at: clock.now() }),
            { NX: true, EX: IDEM_TTL_SEC }
        );
        if (claimed) return { ok: true };

        let prior = null;
        try { prior = JSON.parse(await redis.get(idemKey(key))); } catch (_) { /* treat as in-flight */ }

        if (prior && prior.state === 'DONE' && prior.result) {
            return { ok: false, replay: { ...prior.result, deduplicated: true } };
        }
        // Still in flight: refusing is the only safe answer — sending now is exactly the
        // double-send this key exists to prevent. No httpStatus → the caller's retry path
        // handles it, and the retry hits the DONE branch above.
        const err = new Error(`gateway: an identical send is already in flight (idempotencyKey=${key})`);
        err.code = -32603;
        err.retryable = true;
        throw err;
    }

    async function settle(key, result) {
        if (!key) return;
        try {
            await redis.set(idemKey(key), JSON.stringify({ state: 'DONE', at: clock.now(), result }), { EX: IDEM_TTL_SEC });
        } catch (e) {
            if (logger) logger.warn(`delivery.idem.settle failed: ${e.message}`);
        }
    }

    async function release(key) {
        if (!key) return;
        try { await redis.del(idemKey(key)); }
        catch (e) { if (logger) logger.warn(`delivery.idem.release failed: ${e.message}`); }
    }

    /** Best-effort ledger row. Returns the row id, or null when the write failed. */
    async function record(row) {
        try {
            const created = await entity.create({
                channel: row.channel,
                target: String(row.target ?? ''),
                provider: row.provider || null,
                deliveryStatus: row.deliveryStatus,
                templateId: row.templateId || null,
                providerMessageId: row.providerMessageId || null,
                idempotencyKey: row.idempotencyKey || null,
                error: row.error || null,
                subject: row.subject || null,
            });
            return created.id;
        } catch (e) {
            // An audit row must never fail a delivery the provider already accepted.
            if (logger) logger.warn(`delivery.record failed (${row.channel}/${row.deliveryStatus}): ${e.message}`);
            return null;
        }
    }

    /**
     * Wrap one send. Handles claim → send → ledger row → idempotency settle → `_event`.
     * @param spec {channel, target, templateId?, subject?, idempotencyKey?, send: () => Promise<result>}
     */
    async function run(spec) {
        const { channel, target, templateId, subject, idempotencyKey, send } = spec;

        const gate = await claim(idempotencyKey);
        if (!gate.ok) return gate.replay;

        let result;
        try {
            result = await send();
        } catch (err) {
            await release(idempotencyKey);
            const errText = String(err && err.message || err).slice(0, 500);
            const failId = await record({
                channel, target, templateId, subject, idempotencyKey,
                provider: null,
                deliveryStatus: STATUS.FAILED,
                error: errText,
            });
            // FAILED can't ride the `_event` piggyback (the Router only extracts events
            // from a SUCCESSFUL result), so it goes out via relay event.emit — fire and
            // forget: a bus hiccup must not delay or mask the original send error, and
            // absence of a relay token just means "ledger row only" (pre-relay behavior).
            if (relay) {
                relay.call('event.emit', {
                    stream: EVENT_STREAM,
                    type: EVENTS.FAILED,
                    actor: 'gateway',
                    payload: {
                        channel, target,
                        provider: null,
                        providerMessageId: null,
                        deliveryId: failId,
                        templateId: templateId || null,
                        status: STATUS.FAILED,
                        error: errText,
                    },
                }).catch((e) => {
                    if (logger) logger.warn(`delivery.failed event emit skipped: ${e.message}`);
                });
            }
            throw err;
        }

        const mocked = result && result.provider === 'mock';
        const deliveryStatus = mocked ? STATUS.MOCKED : STATUS.SENT;

        const deliveryId = await record({
            channel, target, templateId, subject, idempotencyKey,
            provider: result.provider,
            providerMessageId: result.messageId,
            deliveryStatus,
        });

        await settle(idempotencyKey, { ...result, ...(deliveryId ? { deliveryId } : {}) });

        return {
            ...result,
            ...(deliveryId ? { deliveryId } : {}),
            // Router strips `_event` from the result before it reaches the client.
            _event: [{
                stream: EVENT_STREAM,
                type: mocked ? EVENTS.MOCKED : EVENTS.SENT,
                payload: {
                    channel,
                    target,
                    provider: result.provider,
                    providerMessageId: result.messageId,
                    deliveryId,
                    templateId: templateId || null,
                    status: deliveryStatus,
                },
            }],
        };
    }

    /**
     * Receipt flow-back (gateway-gaps G6): a provider's bounce/delivered webhook lands in
     * ingress → EVENT:WEBHOOK:{provider} → a consumer (workflow / sentinel / ops bot) maps
     * it here. Gateway stays a dumb pipe — no stream consumer loop of its own; the DOMAIN
     * decision "which webhook means which receipt" belongs to the consumer (ingress README §1).
     *
     * Legal transitions (receipts only move rows a real provider accepted):
     *   SENT      → DELIVERED | BOUNCED | COMPLAINED
     *   DELIVERED → BOUNCED | COMPLAINED        (late bounce / complaint after delivery)
     *   MOCKED / FAILED / any receipt state → ✗ (nothing to receipt, or already terminal)
     */
    async function update({ id, deliveryStatus, detail } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const target = String(deliveryStatus || '').toUpperCase();
        if (!RECEIPT[target]) {
            throw jsonrpc.INVALID_PARAMS(
                `deliveryStatus must be one of [${Object.keys(RECEIPT).join(', ')}] (receipt statuses), got '${deliveryStatus}'`
            );
        }
        const row = await entity.get({ id });
        const from = row.deliveryStatus;
        const legal = from === STATUS.SENT || (from === RECEIPT.DELIVERED && target !== RECEIPT.DELIVERED);
        if (!legal) {
            throw jsonrpc.INVALID_PARAMS(
                `illegal receipt transition ${from} → ${target} (receipts advance SENT, or DELIVERED → BOUNCED/COMPLAINED; MOCKED/FAILED never had a provider-side message)`
            );
        }
        return entity.update({
            id,
            deliveryStatus: target,
            receiptAt: clock.now(),
            ...(detail !== undefined && detail !== null ? { receiptDetail: String(detail).slice(0, 500) } : {}),
        });
    }

    return {
        run, claim, settle, release, record, update,
        get:  async (params) => entity.get(params),
        list: async (params) => entity.list(params),
        STATUS, RECEIPT, EVENTS,
    };
}

module.exports = { createDeliveryLedger, STATUS, RECEIPT, EVENTS, EVENT_STREAM, IDEM_PREFIX, IDEM_TTL_SEC };
