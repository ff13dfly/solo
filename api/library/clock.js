/**
 * Clock - injectable time source for testability.
 *
 * @why  E2E tests for time-sensitive logic (SLA countdowns, multi-year
 *       retention, periodic recurring jobs) need to advance time without
 *       waiting wall-clock. Code that calls clock.now() instead of
 *       Date.now() lets tests fast-forward without touching system time.
 *
 * @attention All time-manipulation methods (freeze / unfreeze / fastForward /
 *            reset) throw unless CLOCK_TEST_MODE=true is set in env. This
 *            prevents test-mode utilities from accidentally drifting time
 *            in a production process.
 *
 * @scope    Singleton per process (module-level state via Node's require
 *           cache). Multi-process E2E tests must control each service's
 *           clock independently — typically via a dedicated admin RPC that
 *           wraps these methods. Do NOT try to synchronize clocks across
 *           processes from a single test invocation; it will desync.
 *
 * @example
 *   const clock = require('./library/clock');
 *   const ts = clock.now();              // production: same as Date.now()
 *
 *   // in tests (with CLOCK_TEST_MODE=true):
 *   clock.freeze('2026-06-01T00:00:00Z');
 *   clock.fastForward(24 * 60 * 60 * 1000);  // +1 day
 *   clock.now();                              // → 2026-06-02T00:00:00Z
 *   clock.reset();                            // back to real time
 */

const TEST_MODE = process.env.CLOCK_TEST_MODE === 'true';

// Module-level state. null frozenAt means "follow real time".
let frozenAt = null;
let offsetMs = 0;

function assertTestMode(method) {
    if (!TEST_MODE) {
        throw new Error(
            `clock.${method}() refused: CLOCK_TEST_MODE is not enabled. ` +
            `Time manipulation outside tests is a payment-system hazard.`
        );
    }
}

function toMs(input) {
    if (typeof input === 'number') return input;
    if (input instanceof Date)     return input.getTime();
    if (typeof input === 'string') {
        const ms = Date.parse(input);
        if (Number.isNaN(ms)) {
            throw new Error(`clock: cannot parse "${input}" as a date`);
        }
        return ms;
    }
    throw new Error(`clock: unsupported time input type "${typeof input}"`);
}

module.exports = {
    /**
     * Current epoch ms. Drop-in replacement for Date.now() across services.
     */
    now() {
        const base = frozenAt !== null ? frozenAt : Date.now();
        return base + offsetMs;
    },

    /**
     * Current as Date object. Convenience for callers needing Date semantics.
     */
    nowDate() {
        return new Date(this.now());
    },

    // ─── Test-only controls (throw outside CLOCK_TEST_MODE) ────────────

    /**
     * Pin the clock to a specific moment. After freeze(), now() ignores
     * system time and returns frozenAt + accumulated offset.
     *
     * @param {number|string|Date} [at] absolute moment; defaults to real now()
     */
    freeze(at) {
        assertTestMode('freeze');
        frozenAt = at !== undefined ? toMs(at) : Date.now();
        offsetMs = 0;
    },

    /**
     * Release the clock back to real time. Clears frozen anchor AND offset.
     */
    unfreeze() {
        assertTestMode('unfreeze');
        frozenAt = null;
        offsetMs = 0;
    },

    /**
     * Advance time by ms. Works in both frozen and unfrozen modes:
     *   - unfrozen: now() returns real_now() + accumulated offset
     *   - frozen:   now() returns frozenAt + accumulated offset
     *
     * @param {number} ms milliseconds to advance (non-negative)
     */
    fastForward(ms) {
        assertTestMode('fastForward');
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
            throw new Error(`clock.fastForward expects a non-negative finite number, got ${ms}`);
        }
        offsetMs += ms;
    },

    /**
     * Full reset: unfreeze + clear offset. Use in test teardown to guarantee
     * a clean state for the next test.
     */
    reset() {
        assertTestMode('reset');
        frozenAt = null;
        offsetMs = 0;
    },

    // ─── Introspection (always safe to call) ───────────────────────────

    isFrozen() {
        return frozenAt !== null;
    },

    isTestMode() {
        return TEST_MODE;
    }
};
