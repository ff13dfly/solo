/**
 * Trace context — chain-level correlation (toFix §二.事件链 "trace 不传递").
 *
 * One rule, no entry-point enumeration: INHERIT the trace if the request carries
 * one, MINT a fresh id if it doesn't. Any request arriving without a trace is by
 * definition the start of a chain (human RPC, webhook emit, scheduler tick).
 *
 * Carriers:
 *   inbound  → Router : HTTP headers  X-Trace-Id / X-Trace-Depth
 *                       (set by library/relay.js from the service's walContext)
 *   Router → service  : X-Router-Token payload meta.trace / meta.depth
 *                       (services read req.meta — parseRouterToken already exposes it)
 *   event envelope    : trace_id propagated (events.js), depth+1 per event hop,
 *                       parent_event_id where the emitter knows it
 *
 * depth counts EVENT hops (not RPC hops): consumers carry the envelope's depth;
 * each emit increments it; events.js enforces the EVENT_MAX_DEPTH budget — the
 * cycle/storm breaker for self-feeding chains.
 *
 * Security note: trace is correlation metadata, deliberately advisory — a caller
 * spoofing X-Trace-Id only pollutes their own chain's grouping. Depth is clamped;
 * a spoofed high depth only throttles the spoofer's own emits.
 */
const crypto = require('crypto');

const TRACE_RE = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_DEPTH_VALUE = 10000;   // sanity clamp for the header value itself

function mint() {
    return crypto.randomBytes(8).toString('hex');
}

/**
 * Resolve the request's trace context from headers: inherit-or-mint.
 * @returns {{ trace: string, depth: number }}
 */
function resolve(headers = {}) {
    const raw = headers['x-trace-id'];
    const trace = (typeof raw === 'string' && TRACE_RE.test(raw)) ? raw : mint();

    let depth = parseInt(headers['x-trace-depth'], 10);
    if (!Number.isFinite(depth) || depth < 0) depth = 0;
    if (depth > MAX_DEPTH_VALUE) depth = MAX_DEPTH_VALUE;

    return { trace, depth };
}

module.exports = { resolve, mint };
