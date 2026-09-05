/**
 * Hermetic unit test for library/jsonlogic.js — the shared declarative
 * predicate / param-evaluation primitives (JsonLogic).
 *
 * The module is pure: no redis, no network, no filesystem, no clock/random.
 * Every assertion below was verified against the actual module behavior
 * (json-logic-js as wrapped), so they describe what the code DOES, including
 * its quirks (e.g. a `$`-prefixed key triggers jsonLogic.apply which throws
 * because no real JsonLogic operator starts with `$`). Arrays used to collapse
 * to index-keyed objects in resolveParams — fixed 2026-08-22 (they now keep
 * array identity and resolve per-element), see
 * docs/feedback/done/runbook-browser-extension-ai-extraction-not-runnable.md §二.
 */
const L = require('../jsonlogic');

describe('jsonlogic — apply (thin JsonLogic.apply wrapper)', () => {
    test('evaluates a true condition', () => {
        expect(L.apply({ '==': [{ var: 'x' }, 1] }, { x: 1 })).toBe(true);
        expect(L.apply({ '>': [{ var: 'n' }, 5] }, { n: 10 })).toBe(true);
    });

    test('evaluates a false condition', () => {
        expect(L.apply({ '==': [{ var: 'x' }, 1] }, { x: 2 })).toBe(false);
        expect(L.apply({ '>': [{ var: 'n' }, 5] }, { n: 1 })).toBe(false);
    });

    test('resolves a var from the data context', () => {
        expect(L.apply({ var: 'x' }, { x: 42 })).toBe(42);
        expect(L.apply({ var: 'a.b' }, { a: { b: 'deep' } })).toBe('deep');
    });

    test('missing var resolves to null', () => {
        expect(L.apply({ var: 'missing' }, {})).toBeNull();
    });

    test('var default is honoured when path is missing', () => {
        expect(L.apply({ var: ['missing', 'def'] }, {})).toBe('def');
    });

    test('numeric var indexes into array data', () => {
        expect(L.apply({ var: 1 }, ['a', 'b', 'c'])).toBe('b');
    });

    test('scalar (non-rule) values pass straight through', () => {
        expect(L.apply(42, {})).toBe(42);
        expect(L.apply('lit', {})).toBe('lit');
        expect(L.apply(true, {})).toBe(true);
    });

    test('null / undefined rules are returned verbatim (no guard semantics here)', () => {
        expect(L.apply(null, {})).toBeNull();
        expect(L.apply(undefined, {})).toBeUndefined();
    });

    test('empty-object rule is returned as-is', () => {
        expect(L.apply({}, { x: 1 })).toEqual({});
    });

    test('combines boolean operators', () => {
        const rule = { and: [{ '>': [{ var: 'n' }, 0] }, { '<': [{ var: 'n' }, 10] }] };
        expect(L.apply(rule, { n: 5 })).toBe(true);
        expect(L.apply(rule, { n: 50 })).toBe(false);
    });

    test('an unrecognized operator throws', () => {
        expect(() => L.apply({ nope: [1, 2] }, {})).toThrow(/Unrecognized operation/);
    });
});

describe('jsonlogic — evaluateCondition (guard semantics: empty rule = pass)', () => {
    test('null rule short-circuits to true (no guard = allow)', () => {
        expect(L.evaluateCondition(null, {})).toBe(true);
    });

    test('undefined rule short-circuits to true', () => {
        expect(L.evaluateCondition(undefined, {})).toBe(true);
        expect(L.evaluateCondition(undefined, { x: 1 })).toBe(true);
    });

    test('a satisfied rule yields true', () => {
        expect(L.evaluateCondition({ '>': [{ var: 'n' }, 5] }, { n: 10 })).toBe(true);
    });

    test('an unsatisfied rule yields false', () => {
        expect(L.evaluateCondition({ '>': [{ var: 'n' }, 5] }, { n: 1 })).toBe(false);
    });

    test('a present-but-empty object rule is NOT treated as a missing guard', () => {
        // Only null/undefined short-circuit; {} delegates to apply, which returns {}.
        expect(L.evaluateCondition({}, {})).toEqual({});
    });

    test('falsy non-null literals delegate to apply (not the guard branch)', () => {
        expect(L.evaluateCondition(0, {})).toBe(0);
        expect(L.evaluateCondition(false, {})).toBe(false);
        expect(L.evaluateCondition('', {})).toBe('');
    });
});

describe('jsonlogic — resolveParams (per-field template evaluation)', () => {
    test('scalar fields are preserved verbatim', () => {
        expect(L.resolveParams({ a: 1, b: 'str', c: true, d: null }, {}))
            .toEqual({ a: 1, b: 'str', c: true, d: null });
    });

    test('a {var} field is resolved against data', () => {
        expect(L.resolveParams({ a: { var: 'x' } }, { x: 9 })).toEqual({ a: 9 });
    });

    test('plain nested objects recurse', () => {
        expect(L.resolveParams({ a: { b: { var: 'x' } } }, { x: 7 }))
            .toEqual({ a: { b: 7 } });
    });

    test('mix of literals, vars and nested objects', () => {
        const out = L.resolveParams(
            { a: 1, b: { var: 'x' }, c: { d: 'lit', e: { var: 'y' } } },
            { x: 9, y: 'z' },
        );
        expect(out).toEqual({ a: 1, b: 9, c: { d: 'lit', e: 'z' } });
    });

    test('missing var inside a field resolves to null', () => {
        expect(L.resolveParams({ a: { var: 'missing' } }, {})).toEqual({ a: null });
    });

    test('empty object template yields empty object', () => {
        expect(L.resolveParams({}, { x: 1 })).toEqual({});
    });

    test('non-object templates pass through untouched', () => {
        expect(L.resolveParams('str', {})).toBe('str');
        expect(L.resolveParams(5, {})).toBe(5);
        expect(L.resolveParams(null, {})).toBeNull();
        expect(L.resolveParams(undefined, {})).toBeUndefined();
        expect(L.resolveParams(true, {})).toBe(true);
    });

    test('arrays keep array identity (top-level template)', () => {
        const out = L.resolveParams([1, 2], {});
        expect(Array.isArray(out)).toBe(true);
        expect(out).toEqual([1, 2]);
    });

    test('array-valued fields stay arrays and resolve per-element', () => {
        const out = L.resolveParams(
            { messages: [{ role: 'system', content: 'x' }, { role: 'user', content: { var: 'dom' } }] },
            { dom: '<html/>' },
        );
        expect(Array.isArray(out.messages)).toBe(true);
        expect(out.messages).toEqual([
            { role: 'system', content: 'x' },
            { role: 'user', content: '<html/>' },
        ]);
    });

    test('a {var} element directly inside an array is applied', () => {
        expect(L.resolveParams({ ids: [{ var: 'a' }, 'lit'] }, { a: 7 })).toEqual({ ids: [7, 'lit'] });
    });

    test('nested arrays recurse without losing identity', () => {
        const out = L.resolveParams({ grid: [[{ var: 'x' }], [1]] }, { x: 'v' });
        expect(out).toEqual({ grid: [['v'], [1]] });
        expect(Array.isArray(out.grid) && Array.isArray(out.grid[0])).toBe(true);
    });

    test('strings are NOT interpolated — {{...}} template syntax passes through verbatim', () => {
        // Documented contract: only whole-field { var } / $-op objects are evaluated.
        expect(L.resolveParams({ content: '页面:{{instance.meta.dom}}' }, { instance: { meta: { dom: 'real' } } }))
            .toEqual({ content: '页面:{{instance.meta.dom}}' });
    });

    // 2026-09-05 — docs/feedback/done/fulfillment-actions-have-no-business-egress.md §3.1.
    // `cat` was ADDED to the evaluated set (RESOLVE_OPS). Before this, a profile could not
    // build a string at all, so a per-instance idempotency key like "fx-<id>-publish" went
    // downstream as a literal — every instance shared one key, every dispatch after the
    // first hit the downstream idempotency check and returned the FIRST order. The call
    // chain looked successful every time while nothing was ever dispatched.
    test('cat IS evaluated, so a per-instance idempotency key can be built', () => {
        expect(L.resolveParams({ content: { cat: ['URL: ', { var: 'u' }] } }, { u: 'x' }))
            .toEqual({ content: 'URL: x' });
        expect(L.resolveParams({ requestId: { cat: ['fx-', { var: 'instance.id' }, '-publish'] } },
            { instance: { id: 'FL-7' } })).toEqual({ requestId: 'fx-FL-7-publish' });
    });

    test('cat is only an operator when it is the object\'s SOLE key — a business field named cat is untouched', () => {
        // The narrowing that keeps this additive: a literal payload field that happens to be
        // called `cat` must not start evaluating. Inner vars still resolve (plain recursion).
        expect(L.resolveParams({ content: { cat: ['a', { var: 'u' }], note: 'n' } }, { u: 'x' }))
            .toEqual({ content: { cat: ['a', 'x'], note: 'n' } });
    });

    test('operators outside RESOLVE_OPS are still NOT evaluated (only cat/+ are opened up)', () => {
        // `if` stays a plain object — opening every standard operator would silently start
        // evaluating literal fields in existing consumer profiles.
        expect(L.resolveParams({ policy: { if: [true, 'a', 'b'] } }, {}))
            .toEqual({ policy: { if: [true, 'a', 'b'] } });
    });

    // 2026-09-05 — …/event-triggered-workflow-lifecycle-drops-events.md §5.2.
    // `+` is the other half of the minimum usable set for a human-authored declarative face:
    // `cat` makes an idempotency key expressible, `+` makes a RELATIVE deadline expressible.
    // Without it an author can only bake an absolute instant, which expires the same day on
    // a machine meant to run for weeks — so the deadline moves back into code and
    // "configuration as data" is quietly given up.
    test('+ evaluates, so a relative deadline is expressible', () => {
        expect(L.resolveParams({ expireAt: { '+': [{ var: 'now' }, 7200000] } }, { now: 1_000_000 }))
            .toEqual({ expireAt: 8_200_000 });
    });

    test('isLogicNode is the shared predicate both declarative faces use', () => {
        // Exported so orchestrator's `$`-syntax param face recognises exactly the same
        // operator set — adding an operator must stay a one-line change in ONE place.
        expect(L.isLogicNode({ '+': [1, 2] })).toBe(true);
        expect(L.isLogicNode({ cat: ['a'] })).toBe(true);
        expect(L.isLogicNode({ var: 'now' })).toBe(true);
        expect(L.isLogicNode({ cat: ['a'], note: 'n' })).toBe(false);   // sole-key rule
        expect(L.isLogicNode({ if: [true, 1, 2] })).toBe(false);
        expect(L.isLogicNode('$input.x')).toBe(false);
        expect(L.isLogicNode([1, 2])).toBe(false);
        expect(L.isLogicNode(null)).toBe(false);
    });

    test('a falsy var key (empty string) is treated as a nested object, not evaluated', () => {
        // value.var === '' is falsy, so it recurses instead of applying.
        expect(L.resolveParams({ a: { var: '' } }, { x: 1 })).toEqual({ a: { var: '' } });
    });

    test('var:0 is falsy too, so it is recursed (kept verbatim) rather than applied', () => {
        expect(L.resolveParams({ a: { var: 0 } }, ['ten'])).toEqual({ a: { var: 0 } });
    });

    test('a $-prefixed operator key throws (no real JsonLogic op starts with $)', () => {
        // The $-detection branch routes to jsonLogic.apply, which rejects $weird.
        expect(() => L.resolveParams({ a: { $weird: 1 } }, {})).toThrow(/Unrecognized operation/);
    });
});

// 2026-09-04 — docs/feedback/fulfillment-condition-fail-open.md §一。
// json-logic-js 的比较算子走 JS 松散比较：缺失字段 → null → 0，`null >= null` 为 true，
// 数值闸门在没喂数据时无条件放行。守卫（evaluateCondition）现在对此 fail-closed；
// 裸 apply() 保持原语义，这一组测试同时把两者的差别钉住。
describe('jsonlogic — evaluateCondition fail-closed on missing operands of < <= > >=', () => {
    test('BOTH operands missing → false (raw JsonLogic says true)', () => {
        const rule = { '>=': [{ var: 'meta.x' }, { var: 'meta.y' }] };
        expect(L.apply(rule, {})).toBe(true);             // the bug, preserved in the raw primitive
        expect(L.evaluateCondition(rule, {})).toBe(false); // the guard
    });

    test('ONE operand missing → false for every comparison operator', () => {
        for (const op of ['<', '<=', '>', '>=']) {
            expect(L.evaluateCondition({ [op]: [{ var: 'meta.x' }, 5] }, { meta: {} })).toBe(false);
            expect(L.evaluateCondition({ [op]: [5, { var: 'meta.x' }] }, { meta: {} })).toBe(false);
        }
    });

    test('null and empty-string values count as missing; 0 and false do NOT', () => {
        const rule = { '>=': [{ var: 'n' }, 0] };
        expect(L.evaluateCondition(rule, { n: null })).toBe(false);
        expect(L.evaluateCondition(rule, { n: '' })).toBe(false);
        expect(L.evaluateCondition(rule, { n: 0 })).toBe(true);
        expect(L.evaluateCondition({ '<=': [{ var: 'f' }, 1] }, { f: false })).toBe(true); // false → 0 <= 1
    });

    test('between form (a < x < b) with the middle missing → false', () => {
        expect(L.evaluateCondition({ '<': [1, { var: 'x' }, 10] }, {})).toBe(false);
        expect(L.evaluateCondition({ '<': [1, { var: 'x' }, 10] }, { x: 5 })).toBe(true);
    });

    test('a var nested inside arithmetic within the comparison is covered too', () => {
        const rule = { '>=': [{ '+': [{ var: 'a' }, { var: 'b' }] }, 3] };
        expect(L.apply(rule, { a: 5 })).toBe(false);            // raw: parseFloat(null) = NaN, already false here
        expect(L.evaluateCondition(rule, { a: 5 })).toBe(false);
        expect(L.evaluateCondition(rule, { a: 5, b: 1 })).toBe(true);
    });

    test('an explicit default — {var: [path, default]} — is honoured, not treated as missing', () => {
        const rule = { '>=': [{ var: ['meta.balance', 0] }, 0] };
        expect(L.evaluateCondition(rule, {})).toBe(true);
        expect(L.evaluateCondition({ '>=': [{ var: ['meta.balance', 0] }, 1] }, {})).toBe(false); // 0 >= 1
    });

    test('comparisons nested under and / or / if / ! are rewritten as well', () => {
        expect(L.evaluateCondition({ and: [true, { '>': [{ var: 'x' }, 1] }] }, {})).toBe(false);
        expect(L.evaluateCondition({ or: [false, { '>': [{ var: 'x' }, 1] }] }, {})).toBe(false);
        expect(L.evaluateCondition({ if: [{ '>': [{ var: 'x' }, 1] }, 'yes', 'no'] }, {})).toBe('no');
        // `!` of a failed-closed comparison is true — that is the documented boolean algebra, not a leak
        expect(L.evaluateCondition({ '!': { '>': [{ var: 'x' }, 1] } }, {})).toBe(true);
    });

    test('equality / negation / truthiness operators are NOT changed (missing stays null there)', () => {
        expect(L.evaluateCondition({ '==': [{ var: 'x' }, 'A'] }, {})).toBe(false);
        expect(L.evaluateCondition({ '!=': [{ var: 'x' }, 'A'] }, {})).toBe(true);
        expect(L.evaluateCondition({ '!': { var: 'cancelled' } }, {})).toBe(true);
        expect(L.evaluateCondition({ '==': [{ var: 'x' }, { var: 'y' }] }, {})).toBe(true); // null == null, unchanged
    });

    test('satisfied comparisons still pass; literal-only comparisons untouched', () => {
        expect(L.evaluateCondition({ '>=': [{ var: 'balance' }, { var: 'threshold' }] }, { balance: 10, threshold: 5 })).toBe(true);
        expect(L.evaluateCondition({ '>': [2, 1] }, {})).toBe(true);
        expect(L.evaluateCondition({ '>': [1, 2] }, {})).toBe(false);
    });

    test('the rewrite is pure — the caller\'s rule object is not mutated', () => {
        const rule = { '>=': [{ var: 'a' }, 1] };
        const snapshot = JSON.stringify(rule);
        L.evaluateCondition(rule, {});
        expect(JSON.stringify(rule)).toBe(snapshot);
    });

    test('pass-through behaviours from the original contract are intact', () => {
        expect(L.evaluateCondition({}, {})).toEqual({});
        expect(L.evaluateCondition(0, {})).toBe(0);
        expect(L.evaluateCondition('', {})).toBe('');
    });
});
