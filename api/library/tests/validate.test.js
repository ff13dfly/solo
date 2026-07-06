/**
 * Hermetic unit test for library/validate.js — the shared param-string primitives.
 * No I/O, no redis. Control chars are built via String.fromCharCode so the source
 * file stays free of literal control bytes.
 */
const V = require('../validate');

const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7f);
const ESC = String.fromCharCode(0x1b);

describe('validate — control chars', () => {
    test('plain strings pass; tab/newline/cr stay legal', () => {
        expect(V.hasControlChars('hello world')).toBe(false);
        expect(V.hasControlChars('a\tb\nc\rd')).toBe(false);   // free-text fields unaffected
    });
    test('NUL / DEL / ESC are rejected', () => {
        expect(V.hasControlChars('a' + NUL + 'b')).toBe(true);
        expect(V.hasControlChars('a' + DEL)).toBe(true);
        expect(V.hasControlChars('a' + ESC)).toBe(true);
    });
    test('non-string tolerated', () => {
        expect(V.hasControlChars(42)).toBe(false);
        expect(V.hasControlChars(null)).toBe(false);
    });
});

describe('validate — isBlank / normalizeString', () => {
    test('blank detection', () => {
        expect(V.isBlank('   ')).toBe(true);
        expect(V.isBlank('')).toBe(true);
        expect(V.isBlank(undefined)).toBe(true);
        expect(V.isBlank('x')).toBe(false);
    });
    test('normalize trims + NFC, passes non-strings through', () => {
        expect(V.normalizeString('  hi  ')).toBe('hi');
        expect(V.normalizeString(7)).toBe(7);
    });
});

describe('validate — PATTERNS', () => {
    test('id accepts real base58 ids, rejects spaces/punctuation', () => {
        expect(V.PATTERNS.id.test('evxB7jrrL92c1nPg')).toBe(true);   // a real uid from this repo
        expect(V.PATTERNS.id.test('bad id!')).toBe(false);
        expect(V.PATTERNS.id.test('')).toBe(false);
    });
    test('username permits human names incl. CJK + space', () => {
        expect(V.PATTERNS.username.test('fuu')).toBe(true);
        expect(V.PATTERNS.username.test('张三 A.b-c')).toBe(true);  // 张三 A.b-c
        expect(V.PATTERNS.username.test('x'.repeat(65))).toBe(false);
    });
    test('email basic shape', () => {
        expect(V.PATTERNS.email.test('a@b.com')).toBe(true);
        expect(V.PATTERNS.email.test('nope')).toBe(false);
    });
    test('slug is lowercase-hyphen', () => {
        expect(V.PATTERNS.slug.test('operator')).toBe(true);
        expect(V.PATTERNS.slug.test('Has Caps')).toBe(false);
    });
});

describe('validate — checkString composite', () => {
    test('valid value returns null', () => {
        expect(V.checkString('ok', { name: 'n', required: true, maxLength: 5 })).toBeNull();
    });
    test('blank required → message', () => {
        expect(V.checkString('  ', { name: 'n', required: true })).toMatch(/must not be blank/);
    });
    test('over maxLength → message', () => {
        expect(V.checkString('toolong', { name: 'n', maxLength: 3 })).toMatch(/exceeds maximum length of 3/);
    });
    test('pattern mismatch → message', () => {
        expect(V.checkString('a b', { name: 'n', pattern: 'id' })).toMatch(/invalid format \(expected id\)/);
    });
    test('control char caught even without other rules', () => {
        expect(V.checkString('a' + NUL, { name: 'n' })).toMatch(/control characters/);
    });
    test('non-string ignored (type enforced elsewhere)', () => {
        expect(V.checkString(42, { name: 'n', required: true })).toBeNull();
    });
    test('defaults: no rule arg → null; nameless rule → label falls back to "value"', () => {
        expect(V.checkString('anything')).toBeNull();                                  // rule = {} default param
        expect(V.checkString('a b', { pattern: 'id' })).toMatch(/^'value' has invalid format/);  // rule.name || 'value'
    });
});

describe('validate — checkParams flat schema (toFix §6.3)', () => {
    test('no schema / non-array schema → no errors', () => {
        expect(V.checkParams(null, { a: 1 })).toEqual([]);
        expect(V.checkParams(undefined, {})).toEqual([]);
        expect(V.checkParams('not-an-array', {})).toEqual([]);
    });

    test('invalid schema items (null / nameless / non-string name) are skipped', () => {
        expect(V.checkParams([null, undefined, {}, { name: '' }, { name: 42 }], { a: 1 })).toEqual([]);
    });

    test('required field missing or null → error; optional missing → fine', () => {
        const schema = [{ name: 'uid', required: true }, { name: 'note' }];
        expect(V.checkParams(schema, {})).toEqual(["'uid' is required"]);
        expect(V.checkParams(schema, { uid: null })).toEqual(["'uid' is required"]);
        expect(V.checkParams(schema, { uid: 'u1' })).toEqual([]);
    });

    test('type enforcement: string/number/boolean/object/array', () => {
        const schema = [
            { name: 's', type: 'string' }, { name: 'n', type: 'number' },
            { name: 'b', type: 'boolean' }, { name: 'o', type: 'object' }, { name: 'a', type: 'array' },
        ];
        expect(V.checkParams(schema, { s: 'x', n: 1, b: true, o: {}, a: [] })).toEqual([]);
        expect(V.checkParams(schema, { n: '1' })).toEqual(["'n' must be number (got string)"]);
        expect(V.checkParams(schema, { o: [] })).toEqual(["'o' must be object (got array)"]);
        expect(V.checkParams(schema, { a: {} })).toEqual(["'a' must be array (got object)"]);
    });

    test('string rules compose: pattern / minLength / control floor', () => {
        const schema = [{ name: 'uid', type: 'string', pattern: 'id' }, { name: 'pin', type: 'string', minLength: 4 }];
        expect(V.checkParams(schema, { uid: 'ok_id-1' })).toEqual([]);
        expect(V.checkParams(schema, { uid: 'has space' })[0]).toMatch(/invalid format/);
        expect(V.checkParams(schema, { pin: '12' })[0]).toMatch(/shorter than minimum/);
        expect(V.checkParams(schema, { uid: 'a' + NUL + 'b' })[0]).toMatch(/control characters/);
    });

    test('unknown extra params are NOT rejected (additive payloads stay legal)', () => {
        expect(V.checkParams([{ name: 'uid', required: true }], { uid: 'u', extra: 'fine' })).toEqual([]);
    });

    test('non-object params treated as empty (required fields all error)', () => {
        expect(V.checkParams([{ name: 'uid', required: true }], null)).toEqual(["'uid' is required"]);
        expect(V.checkParams([{ name: 'uid', required: true }], 'oops')).toEqual(["'uid' is required"]);
    });

    test('multiple violations all reported', () => {
        const schema = [{ name: 'a', required: true }, { name: 'b', type: 'number' }];
        const errors = V.checkParams(schema, { b: 'NaN' });
        expect(errors).toHaveLength(2);
    });
});
