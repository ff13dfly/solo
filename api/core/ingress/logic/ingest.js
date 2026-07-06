const crypto = require('crypto');
const clock = require('../../../library/clock');
const { checkParams } = require('../../../library/validate');
const { scanDeclaredStrings } = require('../../../library/injection-detect');

/**
 * Ingest — the inbound hot path (via Router method ingress.ingest) + test-fire.
 *
 * Pipeline (event.md §6.3, core/ingress/README §0):
 *   API key → resolve source → enabled? → basic structure check → dedup →
 *   dataSchema (if configured) → emit ...and an audit line per outcome
 *   (accepted/duplicate/unauthorized/disabled/invalid/schema_rejected).
 *
 * Dumb pipe by default: only STRUCTURAL validation (valid JSON, request_id +
 * data present). No domain interpretation — downstream consumers classify.
 * A source MAY opt into `dataSchema` (checkParams flat dialect) to whitelist+type
 * the fields it forwards — toFix.md's AI-injection defense direction: fields not
 * declared, or declared fields with the wrong type/pattern, never reach the event
 * bus (and therefore never reach a downstream decision prompt). Declared `type:'string'`
 * field VALUES additionally pass a lightweight heuristic injection-pattern scan
 * (library/injection-detect.js — v1-implementation-plan.md P1, 2026-07-03): schema
 * whitelisting alone can't catch a malicious payload hiding inside a legitimately-typed
 * free-text field. A violation (of either kind) holds the WHOLE delivery in the review
 * queue (logic/review.js) instead of forwarding it or silently dropping just the bad
 * field — a human decides via ingress.review.approve/discard.
 *
 * Emit goes through Router event.emit (relay bot). Provenance lives in the
 * envelope `actor` (= webhook:{source}); payload carries the upstream request_id
 * (correlation / reverse-trace) plus the raw normalized data.
 */
module.exports = (redis, { config, relay, source, dedup, audit, review }) => {
    const C = config.ingest;

    function logLine({ source: src, request_id, outcome, status, body }) {
        audit.append({
            source: src || 'unknown',
            request_id: request_id || null,
            outcome,
            status,
            bytes: body ? Buffer.byteLength(JSON.stringify(body)) : 0,
        });
    }

    // Fields present in `data` but not declared in `schema` — the whitelist half.
    function undeclaredKeys(schemaItems, data) {
        const declared = new Set(schemaItems.map((i) => i && i.name).filter(Boolean));
        return Object.keys(data).filter((k) => !declared.has(k));
    }

    // Project down to exactly the declared field set. By the time this runs,
    // undeclaredKeys() has already rejected any extra field — this is defense in
    // depth (never forward more than the schema says), not the primary guard.
    function extractDeclared(schemaItems, data) {
        const out = {};
        for (const item of schemaItems) {
            if (item && typeof item.name === 'string' && Object.prototype.hasOwnProperty.call(data, item.name)) {
                out[item.name] = data[item.name];
            }
        }
        return out;
    }

    // Fail-soft: an ops-notify hiccup must never block/retry the ingest response.
    async function notifyOps(entry) {
        try {
            await relay.call('notification.send', {
                targetId: config.opsInbox,
                type: 'ops.ingress_schema_rejected',
                payload: {
                    reviewId: entry.reviewId,
                    source: entry.source,
                    requestId: entry.requestId,
                    violations: entry.violations,
                    rejectedAt: entry.rejectedAt,
                },
                sourceId: 'ingress',
                ref: 'ingress_schema_rejected:' + entry.reviewId,
            });
        } catch (e) {
            console.error('[ingress:ingest] ops notify failed:', e.message);
        }
    }

    async function emit(sourceName, requestId, data) {
        await relay.call('event.emit', {
            stream:  source.streamFor(sourceName),
            type:    C.eventType,
            actor:   `webhook:${sourceName}`,
            payload: { request_id: requestId, data: data ?? {} },
        });
    }

    // Inbound handler. apiKey comes from the forwarded Authorization header;
    // rawBody is the RPC params { request_id, data }. Returns { status, body }.
    async function handle(apiKey, rawBody) {
        const reqId = rawBody && typeof rawBody === 'object' ? rawBody.request_id : null;

        const src = await source.resolveByKey(apiKey);
        if (!src) {
            logLine({ source: 'unknown', request_id: reqId, outcome: 'unauthorized', status: 401, body: rawBody });
            return { status: 401, body: { ok: false, error: 'invalid api key' } };
        }
        if (src.enabled === false) {
            logLine({ source: src.name, request_id: reqId, outcome: 'disabled', status: 403, body: rawBody });
            return { status: 403, body: { ok: false, error: 'source disabled' } };
        }

        // Structural validation only.
        const invalid = (msg) => {
            logLine({ source: src.name, request_id: reqId, outcome: 'invalid', status: 400, body: rawBody });
            return { status: 400, body: { ok: false, error: msg } };
        };
        if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) return invalid('body must be a JSON object');
        if (!reqId || typeof reqId !== 'string' || reqId.length > C.maxRequestIdLen) return invalid('request_id required (non-empty string)');
        if (rawBody.data !== undefined && (typeof rawBody.data !== 'object' || rawBody.data === null)) return invalid('data must be an object');

        const ttl = (typeof src.dedupTtlSec === 'number' && src.dedupTtlSec > 0) ? src.dedupTtlSec : C.defaultDedupTtlSec;

        const fresh = await dedup.claim(src.name, reqId, ttl);
        if (!fresh) {
            await source.recordFire(src.id, { outcome: 'duplicate' });
            logLine({ source: src.name, request_id: reqId, outcome: 'duplicate', status: 200, body: rawBody });
            return { status: 200, body: { ok: true, duplicate: true, request_id: reqId } };
        }

        let data = rawBody.data || {};
        if (Array.isArray(src.dataSchema) && src.dataSchema.length > 0) {
            const violations = [
                ...checkParams(src.dataSchema, data),
                ...undeclaredKeys(src.dataSchema, data).map((k) => `'${k}' is not declared in this source's dataSchema`),
                ...scanDeclaredStrings(src.dataSchema, data),
            ];
            if (violations.length > 0) {
                const reviewId = await review.push({ sourceId: src.id, source: src.name, requestId: reqId, data, violations });
                await source.recordFire(src.id, { outcome: 'rejected' });
                logLine({ source: src.name, request_id: reqId, outcome: 'schema_rejected', status: 422, body: rawBody });
                await notifyOps({ reviewId, source: src.name, requestId: reqId, violations, rejectedAt: clock.now() });
                return { status: 422, body: { ok: false, error: 'dataSchema violation — held for human review', violations } };
            }
            data = extractDeclared(src.dataSchema, data);
        }

        await emit(src.name, reqId, data);
        await source.recordFire(src.id, { outcome: 'accepted' });
        logLine({ source: src.name, request_id: reqId, outcome: 'accepted', status: 200, body: rawBody });
        return { status: 200, body: { ok: true, stream: source.streamFor(src.name), request_id: reqId } };
    }

    // Management test-fire (admin RPC): synthetic event, skips dedup + audit + dataSchema
    // (this IS the wiring test — a schema-violating test payload is useful signal to see
    // directly in the RPC response, not worth routing to human review for an admin's own probe).
    async function testFire({ id, data } = {}) {
        const src = await source.get({ id });
        if (!src) throw require('../handlers/jsonrpc').NOT_FOUND('source');
        const requestId = 'test_' + crypto.randomBytes(6).toString('hex') + '_' + clock.now();
        await emit(src.name, requestId, data || { _test: true });
        await source.recordFire(src.id, { outcome: 'accepted' });
        return { ok: true, stream: src.stream, request_id: requestId };
    }

    return { handle, testFire };
};
