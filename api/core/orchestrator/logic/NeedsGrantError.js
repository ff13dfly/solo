/**
 * Thrown by runner.run() when H6 footprint pre-check finds methods not covered
 * by the caller's permit — even after applying any one-shot grant.
 *
 * Callers decide what to do (D7 — runner only signals):
 *   - Sync handler  → convert to FORBIDDEN (-32005) and return immediately (D5)
 *   - Async worker  → persist PAUSED_AWAITING_HUMAN run entity, emit NEEDS_GRANT
 *
 * This is intentionally NOT a jsonrpc error — callers that don't handle it
 * explicitly will propagate it up and it will surface as a 500, making
 * the missing catch obvious during development.
 */
class NeedsGrantError extends Error {
    constructor(missing) {
        const list = Array.isArray(missing) ? missing : [missing];
        super(`Caller permit does not cover workflow footprint. Missing: ${list.join(', ')}`);
        this.name = 'NeedsGrantError';
        this.missing = list;
    }
}

module.exports = { NeedsGrantError };
