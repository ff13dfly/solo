/**
 * Hermetic unit test for library/clock.js — the injectable, test-controllable
 * time source.
 *
 * The hard part: `const TEST_MODE = process.env.CLOCK_TEST_MODE === 'true'` is
 * captured ONCE at require time, and `frozenAt` / `offsetMs` are module-level
 * singleton state. So to exercise BOTH the production-safety path (throws) and
 * the test-mode path (freeze/fastForward/...) we must jest.resetModules() and
 * re-require the module with the env var set appropriately. `freshClock()` does
 * exactly that, and gives every test a pristine module (frozenAt=null,
 * offsetMs=0). The original env value is restored in afterAll.
 */

const ORIGINAL_ENV = process.env.CLOCK_TEST_MODE;

/**
 * Re-require clock.js with CLOCK_TEST_MODE forced to `mode`.
 * @param {string|undefined} mode  undefined → delete the var; otherwise set it.
 */
function freshClock(mode) {
    jest.resetModules();
    if (mode === undefined) delete process.env.CLOCK_TEST_MODE;
    else process.env.CLOCK_TEST_MODE = mode;
    return require('../clock');
}

afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CLOCK_TEST_MODE;
    else process.env.CLOCK_TEST_MODE = ORIGINAL_ENV;
    jest.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
// PRODUCTION MODE: CLOCK_TEST_MODE unset → every manipulation must refuse.
// ───────────────────────────────────────────────────────────────────────────
describe('production mode (CLOCK_TEST_MODE unset)', () => {
    let clock;
    beforeEach(() => { clock = freshClock(undefined); });
    afterEach(() => { jest.restoreAllMocks(); });

    test('isTestMode() === false', () => {
        expect(clock.isTestMode()).toBe(false);
    });

    test('isFrozen() === false (never enters frozen state)', () => {
        expect(clock.isFrozen()).toBe(false);
    });

    test('now() tracks real wall-clock (bounded by Date.now() before/after)', () => {
        const before = Date.now();
        const v = clock.now();
        const after = Date.now();
        expect(typeof v).toBe('number');
        expect(v).toBeGreaterThanOrEqual(before);
        expect(v).toBeLessThanOrEqual(after);
    });

    test('nowDate() returns a Date whose time equals now()', () => {
        // Pin Date.now so now() and nowDate() observe the exact same instant.
        const FIXED = 1_700_000_123_456;
        jest.spyOn(Date, 'now').mockReturnValue(FIXED);
        const d = clock.nowDate();
        expect(d).toBeInstanceOf(Date);
        expect(d.getTime()).toBe(FIXED);
        expect(d.getTime()).toBe(clock.now());
    });

    test('freeze() refuses, message names refused + CLOCK_TEST_MODE', () => {
        expect(() => clock.freeze()).toThrow(/refused/);
        expect(() => clock.freeze()).toThrow(/CLOCK_TEST_MODE/);
        // explicit-arg form takes the same guard before ever touching toMs
        expect(() => clock.freeze(1000)).toThrow(/refused/);
    });

    test('unfreeze() refuses, message names refused + CLOCK_TEST_MODE', () => {
        expect(() => clock.unfreeze()).toThrow(/refused/);
        expect(() => clock.unfreeze()).toThrow(/CLOCK_TEST_MODE/);
    });

    test('fastForward() refuses (guard runs before number validation)', () => {
        expect(() => clock.fastForward(100)).toThrow(/refused/);
        expect(() => clock.fastForward(100)).toThrow(/CLOCK_TEST_MODE/);
        // even an invalid arg never reaches the validation branch
        expect(() => clock.fastForward('bad')).toThrow(/refused/);
    });

    test('reset() refuses, message names refused + CLOCK_TEST_MODE', () => {
        expect(() => clock.reset()).toThrow(/refused/);
        expect(() => clock.reset()).toThrow(/CLOCK_TEST_MODE/);
    });

    test('a refused manipulation leaves the clock unfrozen', () => {
        expect(() => clock.freeze(0)).toThrow();
        expect(clock.isFrozen()).toBe(false);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// CLOCK_TEST_MODE set but not exactly 'true' → still production-safe.
// (Covers the `=== 'true'` comparison's false branch with a non-empty value.)
// ───────────────────────────────────────────────────────────────────────────
describe("CLOCK_TEST_MODE='false' is treated as production (only 'true' enables)", () => {
    let clock;
    beforeEach(() => { clock = freshClock('false'); });

    test('isTestMode() === false', () => {
        expect(clock.isTestMode()).toBe(false);
    });

    test('manipulation still refuses', () => {
        expect(() => clock.freeze()).toThrow(/CLOCK_TEST_MODE/);
        expect(() => clock.fastForward(1)).toThrow(/CLOCK_TEST_MODE/);
        expect(() => clock.unfreeze()).toThrow(/CLOCK_TEST_MODE/);
        expect(() => clock.reset()).toThrow(/CLOCK_TEST_MODE/);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// TEST MODE: CLOCK_TEST_MODE='true' → manipulation enabled.
// ───────────────────────────────────────────────────────────────────────────
describe("test mode (CLOCK_TEST_MODE='true')", () => {
    let clock;
    beforeEach(() => { clock = freshClock('true'); });

    test('isTestMode() === true; starts unfrozen', () => {
        expect(clock.isTestMode()).toBe(true);
        expect(clock.isFrozen()).toBe(false);
    });

    // ── freeze() input handling (drives toMs branches) ──────────────────────

    test('freeze(number) pins now() to that epoch ms exactly (offset reset to 0)', () => {
        clock.freeze(1234);
        expect(clock.isFrozen()).toBe(true);
        expect(clock.now()).toBe(1234);
        expect(clock.nowDate().getTime()).toBe(1234);
    });

    test('freeze(ISO string) pins now() to Date.parse(string)', () => {
        const iso = '2026-06-01T00:00:00Z';
        clock.freeze(iso);
        expect(clock.now()).toBe(Date.parse(iso));
        expect(clock.nowDate().toISOString()).toBe('2026-06-01T00:00:00.000Z');
    });

    test('freeze(Date) pins now() to date.getTime()', () => {
        clock.freeze(new Date(2000));
        expect(clock.now()).toBe(2000);
    });

    test('freeze() with no arg anchors to real now and stays stable', () => {
        const before = Date.now();
        clock.freeze();
        const after = Date.now();
        expect(clock.isFrozen()).toBe(true);
        const a = clock.now();
        expect(a).toBeGreaterThanOrEqual(before);
        expect(a).toBeLessThanOrEqual(after);
        // frozen value does not drift across calls
        expect(clock.now()).toBe(a);
        expect(clock.now()).toBe(a);
    });

    test('freeze() resets any prior accumulated offset to 0', () => {
        clock.freeze(1000);
        clock.fastForward(5000);
        expect(clock.now()).toBe(6000);
        clock.freeze(1000);            // re-freeze must zero the offset
        expect(clock.now()).toBe(1000);
    });

    test('freeze(invalid string) throws "cannot parse"', () => {
        expect(() => clock.freeze('not-a-date')).toThrow(/cannot parse/);
        // clock stayed clean since the throw happened before assignment
        expect(clock.isFrozen()).toBe(false);
    });

    test('freeze(unsupported type) throws "unsupported"', () => {
        expect(() => clock.freeze({})).toThrow(/unsupported/);
        expect(() => clock.freeze(null)).toThrow(/unsupported/);     // null is typeof object, not Date
        expect(() => clock.freeze(true)).toThrow(/unsupported/);     // boolean
        expect(clock.isFrozen()).toBe(false);
    });

    // ── fastForward() in frozen mode ────────────────────────────────────────

    test('fastForward advances and accumulates while frozen', () => {
        clock.freeze(1000);
        clock.fastForward(500);
        expect(clock.now()).toBe(1500);
        clock.fastForward(250);
        expect(clock.now()).toBe(1750);   // accumulates, not replaces
    });

    // ── fastForward() in unfrozen mode ──────────────────────────────────────

    test('fastForward adds offset to real time while unfrozen', () => {
        clock.fastForward(1000);
        const before = Date.now();
        const v = clock.now();
        const after = Date.now();
        expect(v).toBeGreaterThanOrEqual(before + 1000);
        expect(v).toBeLessThanOrEqual(after + 1000);
    });

    test('fastForward(0) is a no-op-sized but valid advance', () => {
        clock.freeze(1000);
        clock.fastForward(0);
        expect(clock.now()).toBe(1000);
    });

    // ── fastForward() validation branches ───────────────────────────────────

    test('fastForward rejects a non-number (string)', () => {
        expect(() => clock.fastForward('5')).toThrow(/non-negative finite/);
    });

    test('fastForward rejects NaN', () => {
        expect(() => clock.fastForward(NaN)).toThrow(/non-negative finite/);
    });

    test('fastForward rejects Infinity', () => {
        expect(() => clock.fastForward(Infinity)).toThrow(/non-negative finite/);
    });

    test('fastForward rejects a negative number', () => {
        expect(() => clock.fastForward(-1)).toThrow(/non-negative finite/);
    });

    test('a rejected fastForward does not mutate the offset', () => {
        clock.freeze(1000);
        expect(() => clock.fastForward(-1)).toThrow();
        expect(clock.now()).toBe(1000);   // unchanged
    });

    // ── unfreeze() / reset() ────────────────────────────────────────────────

    test('unfreeze clears the frozen anchor AND the offset', () => {
        clock.freeze(1000);
        clock.fastForward(5000);
        expect(clock.now()).toBe(6000);
        clock.unfreeze();
        expect(clock.isFrozen()).toBe(false);
        const before = Date.now();
        const v = clock.now();
        const after = Date.now();
        expect(v).toBeGreaterThanOrEqual(before);   // no leftover +5000 offset
        expect(v).toBeLessThanOrEqual(after);
    });

    test('reset clears the frozen anchor AND the offset', () => {
        clock.freeze(1000);
        clock.fastForward(7000);
        expect(clock.now()).toBe(8000);
        clock.reset();
        expect(clock.isFrozen()).toBe(false);
        const before = Date.now();
        const v = clock.now();
        const after = Date.now();
        expect(v).toBeGreaterThanOrEqual(before);
        expect(v).toBeLessThanOrEqual(after);
    });

    test('isFrozen() faithfully reflects freeze → unfreeze transitions', () => {
        expect(clock.isFrozen()).toBe(false);
        clock.freeze(1);
        expect(clock.isFrozen()).toBe(true);
        clock.unfreeze();
        expect(clock.isFrozen()).toBe(false);
        clock.freeze(2);
        expect(clock.isFrozen()).toBe(true);
        clock.reset();
        expect(clock.isFrozen()).toBe(false);
    });
});
