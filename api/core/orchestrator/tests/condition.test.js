/**
 * H3 — condition evaluation safety tests
 *
 * Verifies that:
 *  1. Conditions are evaluated via JsonLogic (no new Function / eval).
 *  2. String conditions are rejected — they cannot be safely evaluated.
 *  3. JsonLogic uses strict equality (=== not ==), so "0" !== 0.
 *  4. Common JsonLogic operators (and, or, !, >, <) work correctly.
 *  5. Invalid / malformed conditions fail closed (return false → step skipped).
 *
 * All tests go through the real engine + MockRouter, not just the function directly.
 */
const { createHarness } = require('./utils/harness');

// Minimal two-step workflow: s1 returns data, s2 has a condition on that data.
function makeWorkflow(condition) {
    return {
        id: 'wf_cond_test_' + Math.random().toString(36).slice(2),
        category: 'test',
        name: 'condition boundary test',
        required_inputs: [],
        steps: [
            {
                id: 's1',
                service: 'data',
                method: 'data.get',
                params: {},
            },
            {
                id: 's2',
                service: 'data',
                method: 'data.action',
                params: {},
                condition,
            },
        ],
    };
}

describe('H3 — JsonLogic condition evaluation', () => {
    let h;
    beforeEach(async () => {
        h = await createHarness();
        h.mock.on('data.get', () => ({ tier: 'gold', count: 3, label: '0', zero: 0 }));
        h.mock.on('data.action', () => ({ done: true }));
    });
    afterEach(() => h.stop());

    test('JsonLogic === : matching value → step runs', async () => {
        const wf = makeWorkflow({ '===': [{ var: 'step.s1.result.tier' }, 'gold'] });
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('success');
    });

    test('JsonLogic === : non-matching value → step skipped', async () => {
        const wf = makeWorkflow({ '===': [{ var: 'step.s1.result.tier' }, 'silver'] });
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('skipped');
    });

    test('strict equality: string "0" !== number 0 (no type coercion)', async () => {
        // With loose == this would be true; strict === must return false → step skipped
        const wf = makeWorkflow({ '===': [{ var: 'step.s1.result.label' }, { var: 'step.s1.result.zero' }] });
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('skipped');
    });

    test('JsonLogic > operator works', async () => {
        const wf = makeWorkflow({ '>': [{ var: 'step.s1.result.count' }, 2] });
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('success');
    });

    test('JsonLogic and operator: all true → step runs', async () => {
        const wf = makeWorkflow({ and: [
            { '===': [{ var: 'step.s1.result.tier' }, 'gold'] },
            { '>': [{ var: 'step.s1.result.count' }, 1] },
        ]});
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('success');
    });

    test('JsonLogic and operator: one false → step skipped', async () => {
        const wf = makeWorkflow({ and: [
            { '===': [{ var: 'step.s1.result.tier' }, 'gold'] },
            { '>': [{ var: 'step.s1.result.count' }, 100] },  // false
        ]});
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('skipped');
    });

    test('string condition is rejected → step skipped (fail closed)', async () => {
        // Old format: a raw JS expression string. Must be rejected without eval.
        const wf = makeWorkflow("$step.s1.result.tier === 'gold'");
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('skipped');
        // workflow itself completes — a bad condition is not a fatal error
        expect(res.status).toBe('completed');
    });

    test('array condition is rejected → step skipped (fail closed)', async () => {
        const wf = makeWorkflow(['===', 'gold', 'gold']);
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('skipped');
    });

    // ── fail-closed on missing operands ──────────────────────────────────────
    // 2026-09-05 — docs/feedback/event-triggered-workflow-lifecycle-drops-events.md §5.1.
    //
    // These are the tests this file was MISSING, and their absence is the whole story: the
    // fail-open bug was reported from colony on 2026-08-11 and fixed in library/jsonlogic.js,
    // but runner.js called json-logic-js directly, so workflow step conditions kept the bug
    // for another three weeks. Both suites were green the entire time — library/tests asserted
    // fail-closed against the library, this file asserted operators against the raw primitive,
    // and neither knew the other existed. Two implementations of one contract, two passing
    // test suites, one live bug.
    //
    // Shape that bites: the THRESHOLD side is the one that goes missing. `var` → null → 0,
    // so "score >= threshold" becomes "score >= 0" — a gate that means "only if it clears the
    // bar" turns into "always", precisely when the bar failed to arrive.
    test('numeric gate with BOTH operands missing → step skipped (raw JsonLogic would run it)', async () => {
        const wf = makeWorkflow({ '>=': [{ var: 'step.s1.result.score' }, { var: 'step.s1.result.threshold' }] });
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('skipped');
    });

    test('numeric gate with only the THRESHOLD missing → step skipped (the colony shape)', async () => {
        // s1 returns count:3 but no `limit` — pre-fix this evaluated 3 >= 0 → ran.
        const wf = makeWorkflow({ '>=': [{ var: 'step.s1.result.count' }, { var: 'step.s1.result.limit' }] });
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('skipped');
    });

    test('an explicit default is honored — fail-closed does not break intentional fallbacks', async () => {
        const wf = makeWorkflow({ '>=': [{ var: 'step.s1.result.count' }, { var: ['step.s1.result.limit', 0] }] });
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('success');   // 3 >= 0
    });

    test('0 is a VALUE, not "missing" — a zero threshold still evaluates', async () => {
        const wf = makeWorkflow({ '>=': [{ var: 'step.s1.result.count' }, { var: 'step.s1.result.zero' }] });
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('success');   // 3 >= 0
    });

    test('equality operators are NOT touched — "not set counts as false" stays a legal idiom', async () => {
        // `{'!': {var:'…cancelled'}}` on an absent field must still mean "not cancelled".
        const wf = makeWorkflow({ '!': { var: 'step.s1.result.cancelled' } });
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('success');
    });

    test('no condition (undefined) → step always runs', async () => {
        const wf = makeWorkflow(undefined);
        // strip the condition key entirely
        delete wf.steps[1].condition;
        await h.seedWorkflow(wf);
        const res = await h.run(wf.id);
        expect(res.trace.find(t => t.id === 's2').status).toBe('success');
    });
});
