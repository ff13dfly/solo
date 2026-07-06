/**
 * Hermetic unit test for library/jsonlogic.js — the shared declarative
 * predicate / param-evaluation primitives (JsonLogic).
 *
 * The module is pure: no redis, no network, no filesystem, no clock/random.
 * Every assertion below was verified against the actual module behavior
 * (json-logic-js as wrapped), so they describe what the code DOES, including
 * its quirks (e.g. arrays collapse to index-keyed objects in resolveParams,
 * and a `$`-prefixed key triggers jsonLogic.apply which throws because no
 * real JsonLogic operator starts with `$`).
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

    test('arrays are walked as objects and collapse to index keys (quirk)', () => {
        // Object.entries on an array yields string index keys, and the result
        // is a fresh plain object — this is the module's actual behavior.
        expect(L.resolveParams([1, 2], {})).toEqual({ 0: 1, 1: 2 });
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
