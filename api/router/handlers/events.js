/**
 * _event production-side symmetry (event.md §4, §13 step ⑥).
 *
 * Mirrors the _tasks pipeline but for event publishing:
 *   extractEvents(response)  — pull _event array from result (sanitize before client)
 *   processEvents(events, …) — validate registry → stamp envelope → xAdd to stream
 *   checkRegistry(…)         — pure registry lookup (exported for tests)
 *
 * Two call paths (event.md §4.5):
 *   A. _event in response: service piggybacks events on an RPC response.
 *      Router extracts them after forwarding; source = the service that responded.
 *   B. event.emit RPC: background loops (worker/scheduler) actively emit events
 *      when there's no response to piggyback on; source = caller's bot identity.
 *   Both paths converge here with the same registry check + stamp + xAdd.
 *
 * Standard event envelope written to the stream (event.md §4.3):
 *   { type, source, actor, trace_id, event_id, parent_event_id, depth, emitted_at, payload }
 *   All fields are strings (Redis stream requirement); payload is JSON-encoded.
 *
 * Chain linkage (toFix §二.事件链):
 *   trace_id        — PROPAGATED from the caller's trace context (handlers/trace.js),
 *                     minted only when the chain starts here. No longer per-hop random.
 *   depth           — event-hop counter: caller's context depth + 1. Events beyond
 *                     EVENT_MAX_DEPTH (env, default 16) are BLOCKED — this is the
 *                     runaway-chain / cycle breaker.
 *   parent_event_id — exact causal edge. Only trusted from the event.emit path
 *                     (trustEventActor, same rule as actor): the consumer that
 *                     processed the parent event is the one who knows its id.
 *
 * Registry format (config.eventRegistry / Redis SYSTEM:CONFIG:EVENT_REGISTRY):
 *   { [source]: { [stream]: ['type1', 'type2', '*'] } }
 *   '*' in the types array means any type is allowed for that stream.
 */
const crypto = require('crypto');
const config  = require('../config');
const trace   = require('./trace');

// Event-hop budget: the chain breaker. Legit chains today are ≤5 hops; 16 leaves
// headroom while stopping self-feeding loops (sentinel→workflow→event→sentinel…)
// after a bounded number of LLM calls instead of never.
const EVENT_MAX_DEPTH = (() => {
    const n = parseInt(process.env.EVENT_MAX_DEPTH, 10);
    return Number.isFinite(n) && n > 0 ? n : 16;
})();

// Client-supplied event_id idempotency: a retrying background loop that emitted
// successfully but crashed before acking re-sends the SAME event_id → the SETNX
// guard suppresses the duplicate instead of double-delivering to every consumer.
// Suppress-only semantics: a forged/guessed id can only ever drop its own emit,
// never alter someone else's — and ids are caller-random, not enumerable.
const EVENT_DEDUP_TTL_SEC = (() => {
    const n = parseInt(process.env.EVENT_DEDUP_TTL_SEC, 10);
    return Number.isFinite(n) && n > 0 ? n : 3600;
})();
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ── Registry cache — mirrors task-whitelist cache pattern ─────────────────────

let CACHED_REGISTRY = null;
let LAST_FETCH = 0;
const CACHE_TTL = 60_000; // 60 s

async function getRegistry(redisClient) {
    const now = Date.now();
    if (CACHED_REGISTRY && now - LAST_FETCH < CACHE_TTL) return CACHED_REGISTRY;

    if (redisClient && redisClient.isOpen) {
        try {
            const data = await redisClient.get(config.redis.eventRegistryKey);
            if (data) {
                CACHED_REGISTRY = JSON.parse(data);
                LAST_FETCH = now;
                return CACHED_REGISTRY;
            }
        } catch (e) {
            console.warn('[Events] Failed to fetch registry from Redis:', e.message);
        }
    }

    if (!CACHED_REGISTRY) CACHED_REGISTRY = config.eventRegistry || {};
    return CACHED_REGISTRY;
}

// ── Core helpers ───────────────────────────────────────────────────────────────

// Pure function — exported for unit testing.
// Stream key matching: exact first, then a trailing-'*' prefix glob
// (e.g. 'EVENT:WEBHOOK:*' matches 'EVENT:WEBHOOK:GITHUB'). The glob lets a
// source emit to a whole namespace of dynamically-named streams (ingress
// creates EVENT:WEBHOOK:{source} at runtime) without per-stream registry edits.
function checkRegistry(registry, source, stream, type) {
    const sourceRules = registry[source];
    if (!sourceRules) return false;
    let allowedTypes = sourceRules[stream];
    if (!allowedTypes) {
        for (const pattern of Object.keys(sourceRules)) {
            if (pattern.endsWith('*') && stream.startsWith(pattern.slice(0, -1))) {
                allowedTypes = sourceRules[pattern];
                break;
            }
        }
    }
    if (!allowedTypes) return false;
    return allowedTypes.includes('*') || allowedTypes.includes(type);
}

// Extract _event array from responseData.result, deleting it to keep the
// client response clean. Returns null if absent or not an array.
function extractEvents(responseData) {
    if (!responseData || !responseData.result) return null;
    const events = responseData.result._event;
    if (!events) return null;
    delete responseData.result._event;
    return Array.isArray(events) ? events : null;
}

// ── Process events ─────────────────────────────────────────────────────────────

// `source` is always Router-authenticated and unforgeable. `actor` (provenance —
// "what principal caused this") defaults to the batch-level actor, but the
// event.emit path (trustEventActor=true) lets a background loop declare a more
// specific origin per event — e.g. the nexus scheduler asserting actor=cron:{id}.
// The _event piggyback path must NOT trust a per-event actor (a downstream
// service could forge it), so it stays false and actor stays = authenticated user.
async function processEvents(events, { source, actor, redisClient, trustEventActor = false, traceCtx = null }) {
    if (!events || events.length === 0) return { written: 0, blocked: 0 };

    const registry = await getRegistry(redisClient);

    // Chain linkage: inherit the caller's trace, mint only at chain start.
    // depth = caller's event-hop depth + 1; over budget → the whole batch is the
    // runaway hop, block it (the breaker for self-feeding event loops).
    const chainTrace = (traceCtx && traceCtx.trace) || trace.mint();
    const depth = ((traceCtx && Number.isFinite(traceCtx.depth)) ? traceCtx.depth : 0) + 1;
    const overBudget = depth > EVENT_MAX_DEPTH;

    let written = 0;
    let blocked = 0;
    let deduped = 0;

    for (const event of events) {
        try {
            const { stream, type, payload } = event || {};

            if (!stream || typeof stream !== 'string') {
                console.warn('[Events] Skipping: missing/invalid stream field', { event });
                blocked++;
                continue;
            }
            if (!type || typeof type !== 'string') {
                console.warn('[Events] Skipping: missing/invalid type field', { stream });
                blocked++;
                continue;
            }

            if (overBudget) {
                console.error(`[Events] BLOCKED (${source}, ${stream}, ${type}) — chain depth ${depth} exceeds EVENT_MAX_DEPTH=${EVENT_MAX_DEPTH} (trace ${chainTrace}); likely an event loop`);
                if (redisClient && redisClient.isOpen) {
                    redisClient.rPush(`${config.redis.errorQueuePrefix}router`, JSON.stringify({
                        code: 'EVENT_DEPTH_EXCEEDED',
                        source, stream, type,
                        trace_id: chainTrace, depth,
                        stamp: new Date().toISOString(),
                    })).catch(() => {});
                }
                blocked++;
                continue;
            }

            if (!checkRegistry(registry, source, stream, type)) {
                console.warn(`[Events] BLOCKED (${source}, ${stream}, ${type}) — not in registry`);
                blocked++;
                continue;
            }

            const resolvedActor = (trustEventActor && event.actor && typeof event.actor === 'string')
                ? event.actor
                : (actor || 'anonymous');

            // Idempotency: caller-supplied event_id claims a dedup slot; a re-send of
            // the same id within the TTL is a retry-after-crash duplicate → suppress.
            let eventId = crypto.randomBytes(8).toString('hex');
            if (typeof event.event_id === 'string' && EVENT_ID_RE.test(event.event_id)) {
                if (redisClient && redisClient.isOpen) {
                    const claimed = await redisClient.set(
                        `EVENT:DEDUP:${event.event_id}`, '1',
                        { NX: true, EX: EVENT_DEDUP_TTL_SEC }
                    );
                    if (claimed === null) {
                        console.warn(`[Events] DEDUPED (${source}, ${stream}, ${type}) — event_id ${event.event_id} already emitted`);
                        deduped++;
                        continue;
                    }
                }
                eventId = event.event_id;
            }

            // parent_event_id: only the emitter knows which event it was reacting to —
            // trusted on the event.emit path only (same trust rule as actor); the
            // _event piggyback path must not let a downstream forge causal edges.
            const parentEventId = (trustEventActor && typeof event.parent_event_id === 'string')
                ? event.parent_event_id
                : '';

            // Stamp the standard envelope. All values must be strings for Redis streams.
            const envelope = {
                type,
                source,
                actor: resolvedActor,
                trace_id:        chainTrace,
                event_id:        eventId,
                parent_event_id: parentEventId,
                depth:           String(depth),
                emitted_at:      String(Date.now()),
                payload:    payload && typeof payload === 'object'
                    ? JSON.stringify(payload)
                    : (typeof payload === 'string' ? payload : '{}'),
            };

            if (redisClient && redisClient.isOpen) {
                await redisClient.xAdd(stream, '*', envelope);
                written++;
            }
        } catch (err) {
            console.error('[Events] processEvents error:', err.message);
        }
    }
    return { written, blocked, deduped };
}

module.exports = { extractEvents, processEvents, checkRegistry };
