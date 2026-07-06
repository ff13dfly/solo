/**
 * Hermetic unit test for library/crypto.js — PBKDF2 key derivation + AES-256-GCM.
 * Pure: no redis, no network, no filesystem. The module uses crypto.randomBytes
 * for IV/salt, but every assertion here is about DETERMINISTIC properties
 * (same-input-same-key, encrypt/decrypt round-trip, tamper detection, lengths),
 * never about a specific random value, so the test is stable.
 */
const C = require('../crypto');

// A fixed 32-byte (256-bit) key so AES assertions don't depend on deriveKey randomness.
const KEY = Buffer.alloc(32, 7);          // 32 bytes of 0x07
const OTHER_KEY = Buffer.alloc(32, 9);    // a different 256-bit key

describe('crypto — exports & constants', () => {
    test('exposes the documented surface', () => {
        expect(typeof C.deriveKey).toBe('function');
        expect(typeof C.encrypt).toBe('function');
        expect(typeof C.decrypt).toBe('function');
        expect(typeof C.generateSalt).toBe('function');
        expect(C.DEFAULT_ITERATIONS).toBe(200000);
    });
});

describe('crypto — deriveKey (PBKDF2)', () => {
    test('returns a 32-byte (256-bit) Buffer', async () => {
        const key = await C.deriveKey('password', 'salt', 1000);
        expect(Buffer.isBuffer(key)).toBe(true);
        expect(key.length).toBe(32);
    });

    test('is deterministic — same password+salt+iterations give the same key', async () => {
        const a = await C.deriveKey('hunter2', 'NaCl', 1000);
        const b = await C.deriveKey('hunter2', 'NaCl', 1000);
        expect(a.equals(b)).toBe(true);
    });

    test('different password → different key', async () => {
        const a = await C.deriveKey('hunter2', 'NaCl', 1000);
        const b = await C.deriveKey('hunter3', 'NaCl', 1000);
        expect(a.equals(b)).toBe(false);
    });

    test('different salt → different key', async () => {
        const a = await C.deriveKey('hunter2', 'saltA', 1000);
        const b = await C.deriveKey('hunter2', 'saltB', 1000);
        expect(a.equals(b)).toBe(false);
    });

    test('different iteration count → different key', async () => {
        const a = await C.deriveKey('hunter2', 'NaCl', 1000);
        const b = await C.deriveKey('hunter2', 'NaCl', 2000);
        expect(a.equals(b)).toBe(false);
    });

    test('matches a known PBKDF2-SHA256 vector (RFC-style, 256-bit slice)', async () => {
        // Reproduce Node's own pbkdf2 to confirm deriveKey is a faithful wrapper.
        const nodeCrypto = require('crypto');
        const expected = nodeCrypto.pbkdf2Sync('passwd', 'salt', 1000, 32, 'sha256');
        const got = await C.deriveKey('passwd', 'salt', 1000);
        expect(got.equals(expected)).toBe(true);
    });

    test('empty password/salt still derive a 32-byte key', async () => {
        const key = await C.deriveKey('', '', 1000);
        expect(key.length).toBe(32);
    });

    test('a derived key is directly usable for encrypt/decrypt', async () => {
        const key = await C.deriveKey('correct horse', 'battery staple', 1000);
        const blob = C.encrypt('hello', key);
        expect(C.decrypt(blob, key)).toBe('hello');
    });
});

describe('crypto — encrypt / decrypt (AES-256-GCM round-trip)', () => {
    test('round-trips arbitrary utf8 text', () => {
        const msg = 'the quick brown fox';
        expect(C.decrypt(C.encrypt(msg, KEY), KEY)).toBe(msg);
    });

    test('round-trips unicode / CJK / emoji', () => {
        const msg = '张三 — café — 🦊';
        expect(C.decrypt(C.encrypt(msg, KEY), KEY)).toBe(msg);
    });

    test('round-trips the empty string', () => {
        const blob = C.encrypt('', KEY);
        expect(C.decrypt(blob, KEY)).toBe('');
    });

    test('output is a hex string with iv(24) + authTag(32) framing', () => {
        const blob = C.encrypt('x', KEY);
        expect(typeof blob).toBe('string');
        expect(/^[0-9a-f]+$/.test(blob)).toBe(true);
        // 12-byte IV = 24 hex, 16-byte tag = 32 hex, then at least some ciphertext.
        expect(blob.length).toBeGreaterThanOrEqual(24 + 32);
    });

    test('IV is random — two encryptions of the same plaintext differ', () => {
        const a = C.encrypt('same', KEY);
        const b = C.encrypt('same', KEY);
        expect(a).not.toBe(b);
        // ...yet both decrypt back to the original.
        expect(C.decrypt(a, KEY)).toBe('same');
        expect(C.decrypt(b, KEY)).toBe('same');
    });
});

describe('crypto — tamper / wrong-key detection', () => {
    test('decrypting with the wrong key throws (GCM auth failure)', () => {
        const blob = C.encrypt('secret', KEY);
        expect(() => C.decrypt(blob, OTHER_KEY)).toThrow();
    });

    test('flipping a ciphertext byte fails authentication', () => {
        const blob = C.encrypt('secret payload', KEY);
        // Mutate the last hex char (part of the ciphertext, past iv+tag).
        const last = blob.slice(-1);
        const swapped = last === 'a' ? 'b' : 'a';
        const tampered = blob.slice(0, -1) + swapped;
        expect(() => C.decrypt(tampered, KEY)).toThrow();
    });

    test('flipping an auth-tag byte fails authentication', () => {
        const blob = C.encrypt('secret payload', KEY);
        // Auth tag lives at hex offsets [24, 56).
        const tagChar = blob[25];
        const swapped = tagChar === 'a' ? 'b' : 'a';
        const tampered = blob.slice(0, 25) + swapped + blob.slice(26);
        expect(() => C.decrypt(tampered, KEY)).toThrow();
    });

    test('a too-short / malformed blob does not silently succeed', () => {
        expect(() => C.decrypt('deadbeef', KEY)).toThrow();
    });

    test('encrypt rejects a wrong-length key (not 256-bit)', () => {
        const shortKey = Buffer.alloc(16, 1); // 128-bit, invalid for aes-256-gcm
        expect(() => C.encrypt('hi', shortKey)).toThrow();
    });
});

describe('crypto — generateSalt', () => {
    test('default length yields 16 bytes = 32 hex chars', () => {
        const salt = C.generateSalt();
        expect(typeof salt).toBe('string');
        expect(/^[0-9a-f]+$/.test(salt)).toBe(true);
        expect(salt.length).toBe(32);
    });

    test('honors an explicit byte length', () => {
        expect(C.generateSalt(8).length).toBe(16);   // 8 bytes → 16 hex chars
        expect(C.generateSalt(32).length).toBe(64);  // 32 bytes → 64 hex chars
    });

    test('zero-length salt is the empty string', () => {
        expect(C.generateSalt(0)).toBe('');
    });

    test('successive salts differ (randomness)', () => {
        expect(C.generateSalt()).not.toBe(C.generateSalt());
    });
});

describe('crypto — deriveKey edge branches', () => {
    test('omitting iterations uses DEFAULT_ITERATIONS (default-param branch)', async () => {
        // No 3rd arg → the `iterations = DEFAULT_ITERATIONS` default must apply, so the
        // result must equal an explicit derivation at DEFAULT_ITERATIONS (and differ from
        // a low-iteration one, proving the default count — not 0/undefined — was used).
        const nodeCrypto = require('crypto');
        const viaDefault = await C.deriveKey('correct horse', 'battery staple');
        const explicitDefault = nodeCrypto.pbkdf2Sync('correct horse', 'battery staple', C.DEFAULT_ITERATIONS, 32, 'sha256');
        const lowIter = await C.deriveKey('correct horse', 'battery staple', 1000);
        expect(Buffer.isBuffer(viaDefault)).toBe(true);
        expect(viaDefault.length).toBe(32);
        expect(viaDefault.equals(explicitDefault)).toBe(true);
        expect(viaDefault.equals(lowIter)).toBe(false);
    });

    test('propagates a pbkdf2 callback error by rejecting the promise (reject branch)', async () => {
        // Every invalid input to crypto.pbkdf2 throws SYNCHRONOUSLY (verified: negative/zero/
        // NaN iterations → ERR_OUT_OF_RANGE, bad digest → ERR_CRYPTO_INVALID_DIGEST), so the
        // async err→reject path is unreachable with real inputs. Force an async callback error
        // to assert deriveKey honors its documented contract: it rejects (not resolves/throws)
        // and surfaces the underlying error unchanged.
        const nodeCrypto = require('crypto');
        const boom = new Error('pbkdf2 internal failure');
        const spy = jest.spyOn(nodeCrypto, 'pbkdf2').mockImplementation((pw, salt, iter, keylen, digest, cb) => cb(boom));
        try {
            await expect(C.deriveKey('pw', 'salt', 1)).rejects.toBe(boom);
        } finally {
            spy.mockRestore();
        }
        // Sanity: after restore, real derivation works again (spy did not leak).
        expect((await C.deriveKey('pw', 'salt', 1000)).length).toBe(32);
    });
});
