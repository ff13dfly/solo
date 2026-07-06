/**
 * Hermetic unit test for library/generator.js — Base58 id generation + validation.
 * The module is PURE: it only uses crypto.randomBytes (no redis, no network, no fs,
 * no clock). We assert structural invariants (length, charset, uniqueness) rather
 * than exact values, since the bytes are random.
 */
const G = require('../generator');

// Bitcoin Base58 alphabet (excludes 0, O, I, l) — every generated char must be here.
const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_SET = new Set(BASE58_CHARS.split(''));

describe('generator — generateId length', () => {
    test('default length is 8', () => {
        expect(G.generateId()).toHaveLength(8);
    });
    test('honors an explicit length', () => {
        expect(G.generateId(1)).toHaveLength(1);
        expect(G.generateId(16)).toHaveLength(16);
        expect(G.generateId(64)).toHaveLength(64);
    });
    test('length <= 0 yields empty string', () => {
        expect(G.generateId(0)).toBe('');
        expect(G.generateId(-5)).toBe('');
    });
});

describe('generator — generateId charset', () => {
    test('every character is in the Base58 alphabet (excludes 0,O,I,l)', () => {
        const id = G.generateId(200); // large sample to exercise the full alphabet
        for (const ch of id) {
            expect(BASE58_SET.has(ch)).toBe(true);
        }
        // forbidden Base58 characters must never appear
        expect(/[0OIl]/.test(id)).toBe(false);
    });
    test('passes the module own validateId', () => {
        const id = G.generateId(12);
        expect(G.validateId(id, 12)).toBe(true);
        expect(G.validateId(id)).toBe(true); // length optional
    });
});

describe('generator — generateId uniqueness', () => {
    test('distinct calls produce distinct ids (overwhelmingly likely)', () => {
        const N = 1000;
        const seen = new Set();
        for (let i = 0; i < N; i++) {
            seen.add(G.generateId(16)); // 58^16 space → collisions effectively impossible
        }
        expect(seen.size).toBe(N);
    });
    test('shape is stable across calls — always the requested length & charset', () => {
        for (let i = 0; i < 50; i++) {
            const id = G.generateId(10);
            expect(id).toHaveLength(10);
            expect([...id].every((c) => BASE58_SET.has(c))).toBe(true);
        }
    });
});

describe('generator — validateId', () => {
    test('accepts a well-formed base58 id', () => {
        expect(G.validateId('evxB7jrrL92c1nPg')).toBe(true);
    });
    test('length mismatch is rejected when length given', () => {
        expect(G.validateId('abc', 4)).toBe(false);
        expect(G.validateId('abc', 3)).toBe(true);
    });
    test('length is optional — falsy length skips the length check', () => {
        expect(G.validateId('abc')).toBe(true);
        expect(G.validateId('abc', 0)).toBe(true); // 0 is falsy → not enforced
    });
    test('rejects forbidden base58 chars 0,O,I,l', () => {
        expect(G.validateId('0bcd')).toBe(false);
        expect(G.validateId('Obcd')).toBe(false);
        expect(G.validateId('Ibcd')).toBe(false);
        expect(G.validateId('lbcd')).toBe(false);
    });
    test('rejects punctuation / spaces', () => {
        expect(G.validateId('bad id')).toBe(false);
        expect(G.validateId('has!')).toBe(false);
    });
    test('rejects empty / non-string / nullish input', () => {
        expect(G.validateId('')).toBe(false);
        expect(G.validateId(null)).toBe(false);
        expect(G.validateId(undefined)).toBe(false);
        expect(G.validateId(42)).toBe(false);
        expect(G.validateId({})).toBe(false);
    });
});

describe('generator — round trip', () => {
    test('generated ids always validate at their own length', () => {
        for (const len of [1, 4, 8, 32]) {
            const id = G.generateId(len);
            expect(G.validateId(id, len)).toBe(true);
        }
    });
});
