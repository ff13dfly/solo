/**
 * Hermetic jest suite for api/library/passport.js (Passport Protocol v1.1.0).
 *
 * The LIBRARY passport is a *pure* crypto helper (token/deviceId/salt issuance,
 * SHA-256 proof computation, and stateless token verification). It does NOT use
 * the Entity Factory or redis — unlike the unrelated entity-backed passport at
 * api/core/user/logic/passport.js. So this suite needs no external services.
 *
 * Goal: 100% Stmts/Branch/Funcs/Lines for library/passport.js in isolation, with
 * every guard / error / default-param / short-circuit branch asserted meaningfully.
 */
const os = require('os');
// Harmless even though this module touches no entity/WAL infra — keeps any
// transitively-required infra from writing into the repo if that ever changes.
process.env.LOG_DIR = process.env.LOG_DIR || os.tmpdir();
process.env.WAL_DIR = process.env.WAL_DIR || os.tmpdir();

const crypto = require('crypto');
const Passport = require('../passport');

// Independent reference implementations to keep assertions honest.
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/; // Bitcoin alphabet (no 0,O,I,l)
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL = 90 * DAY_MS;

describe('Passport.issueToken', () => {
    test('default length is 32 base58 chars', () => {
        const t = Passport.issueToken(); // exercises the default-param branch
        expect(t).toHaveLength(32);
        expect(t).toMatch(BASE58_RE);
    });

    test('honours an explicit byte length', () => {
        const t = Passport.issueToken(16); // exercises the provided-arg branch
        expect(t).toHaveLength(16);
        expect(t).toMatch(BASE58_RE);
    });

    test('produces unique, high-entropy tokens across calls', () => {
        const tokens = new Set(Array.from({ length: 50 }, () => Passport.issueToken(32)));
        expect(tokens.size).toBe(50);
    });
});

describe('Passport.issueDeviceId', () => {
    test('default length is 8 base58 chars', () => {
        const d = Passport.issueDeviceId(); // default-param branch
        expect(d).toHaveLength(8);
        expect(d).toMatch(BASE58_RE);
    });

    test('honours an explicit byte length', () => {
        const d = Passport.issueDeviceId(12); // provided-arg branch
        expect(d).toHaveLength(12);
        expect(d).toMatch(BASE58_RE);
    });

    test('device ids are unique', () => {
        expect(Passport.issueDeviceId()).not.toBe(Passport.issueDeviceId());
    });
});

describe('Passport.createSalt', () => {
    test('returns 16 random bytes as 32 hex chars', () => {
        const s = Passport.createSalt();
        expect(s).toHaveLength(32);
        expect(s).toMatch(/^[0-9a-f]{32}$/);
    });

    test('salts are unique', () => {
        expect(Passport.createSalt()).not.toBe(Passport.createSalt());
    });
});

describe('Passport.computeProof', () => {
    test('is deterministic and equals SHA-256(token + salt)', () => {
        const a = Passport.computeProof('token-abc', 'salt-123');
        const b = Passport.computeProof('token-abc', 'salt-123');
        expect(a).toBe(b);
        expect(a).toBe(sha256hex('token-abc' + 'salt-123'));
    });

    test('matches the published v1.1.0 known-answer vector', () => {
        expect(Passport.computeProof('token-abc', 'salt-123'))
            .toBe('33ad75628db079857ad3e52d09dd6c0148a605f5022e45332811c828eefbb4dd');
    });

    test('is sensitive to the token', () => {
        expect(Passport.computeProof('token-abc', 'salt-123'))
            .not.toBe(Passport.computeProof('token-abd', 'salt-123'));
    });

    test('is sensitive to the salt', () => {
        expect(Passport.computeProof('token-abc', 'salt-123'))
            .not.toBe(Passport.computeProof('token-abc', 'salt-124'));
    });

    test('returns a 64-char lowercase hex digest', () => {
        expect(Passport.computeProof('t', 's')).toMatch(/^[0-9a-f]{64}$/);
    });

    // Guard: `if (!token || !salt)` — both short-circuit operands.
    test('throws when token is falsy (first operand)', () => {
        expect(() => Passport.computeProof(null, 'salt')).toThrow('PASSPORT_MISSING_INPUT');
        expect(() => Passport.computeProof('', 'salt')).toThrow('PASSPORT_MISSING_INPUT');
        expect(() => Passport.computeProof(undefined, 'salt')).toThrow('PASSPORT_MISSING_INPUT');
    });

    test('throws when token is present but salt is falsy (second operand)', () => {
        expect(() => Passport.computeProof('token', null)).toThrow('PASSPORT_MISSING_INPUT');
        expect(() => Passport.computeProof('token', '')).toThrow('PASSPORT_MISSING_INPUT');
    });
});

describe('Passport.createProofEntry', () => {
    test('returns { proof, issuedAt } with proof = computeProof and a fresh timestamp', () => {
        const before = Date.now();
        const entry = Passport.createProofEntry('mytoken', 'mysalt');
        const after = Date.now();

        expect(entry.proof).toBe(Passport.computeProof('mytoken', 'mysalt'));
        expect(entry.proof).toMatch(/^[0-9a-f]{64}$/);
        expect(typeof entry.issuedAt).toBe('number');
        expect(entry.issuedAt).toBeGreaterThanOrEqual(before);
        expect(entry.issuedAt).toBeLessThanOrEqual(after);
    });

    test('propagates the missing-input guard from computeProof', () => {
        expect(() => Passport.createProofEntry(null, 'mysalt')).toThrow('PASSPORT_MISSING_INPUT');
    });
});

describe('Passport.verify', () => {
    const token = 'device-token-xyz';
    const salt = 'anchor-salt-abc';
    let entry; // a fresh, valid proof entry
    beforeEach(() => {
        entry = Passport.createProofEntry(token, salt);
    });

    // --- happy path -------------------------------------------------------
    test('authenticates a correct token against a fresh entry (default TTL)', () => {
        const r = Passport.verify(token, salt, entry); // 3 args → default-param branch
        expect(r).toEqual({ ok: true });
        expect(r.reason).toBeUndefined();
    });

    // --- line 98 guard: !token || !salt || !proofEntry || typeof !== 'object' ---
    test('rejects a missing token (first operand)', () => {
        expect(Passport.verify(null, salt, entry)).toEqual({ ok: false, reason: 'INVALID_TOKEN' });
    });

    test('rejects a missing salt (second operand)', () => {
        expect(Passport.verify(token, null, entry)).toEqual({ ok: false, reason: 'INVALID_TOKEN' });
    });

    test('rejects a null proofEntry (third operand)', () => {
        expect(Passport.verify(token, salt, null)).toEqual({ ok: false, reason: 'INVALID_TOKEN' });
    });

    test('rejects a truthy non-object proofEntry (fourth operand)', () => {
        // truthy so it passes !proofEntry, but typeof !== 'object'
        expect(Passport.verify(token, salt, 'not-an-object')).toEqual({ ok: false, reason: 'INVALID_TOKEN' });
        expect(Passport.verify(token, salt, 42)).toEqual({ ok: false, reason: 'INVALID_TOKEN' });
    });

    // --- line 104 guard: !storedProof || typeof issuedAt !== 'number' -----
    test('rejects an entry with no stored proof (first operand)', () => {
        expect(Passport.verify(token, salt, { issuedAt: Date.now() }))
            .toEqual({ ok: false, reason: 'INVALID_TOKEN' });
    });

    test('rejects an entry whose issuedAt is not a number (second operand)', () => {
        expect(Passport.verify(token, salt, { proof: entry.proof, issuedAt: 'soon' }))
            .toEqual({ ok: false, reason: 'INVALID_TOKEN' });
        // missing issuedAt → undefined → typeof !== 'number'
        expect(Passport.verify(token, salt, { proof: entry.proof }))
            .toEqual({ ok: false, reason: 'INVALID_TOKEN' });
    });

    // --- line 109: expiry (tokenTtl > 0 && Date.now() - issuedAt > tokenTtl) ---
    test('rejects a token older than the default 90-day TTL', () => {
        const stale = { proof: entry.proof, issuedAt: Date.now() - (DEFAULT_TTL + 1000) };
        expect(Passport.verify(token, salt, stale)).toEqual({ ok: false, reason: 'TOKEN_EXPIRED' });
    });

    test('rejects a token older than a custom TTL (provided-arg branch)', () => {
        const aged = { proof: entry.proof, issuedAt: Date.now() - 5000 };
        expect(Passport.verify(token, salt, aged, 1000)).toEqual({ ok: false, reason: 'TOKEN_EXPIRED' });
    });

    test('accepts a token within a custom TTL (expiry-condition false branch)', () => {
        const recent = { proof: entry.proof, issuedAt: Date.now() - 100 };
        expect(Passport.verify(token, salt, recent, 10000)).toEqual({ ok: true });
    });

    test('skips expiry entirely when tokenTtl = 0 (tokenTtl > 0 false branch)', () => {
        const ancient = { proof: entry.proof, issuedAt: Date.now() - (DEFAULT_TTL * 10) };
        expect(Passport.verify(token, salt, ancient, 0)).toEqual({ ok: true });
    });

    // --- line 114: proof mismatch ----------------------------------------
    test('rejects a wrong token (proof mismatch)', () => {
        expect(Passport.verify('wrong-token', salt, entry))
            .toEqual({ ok: false, reason: 'INVALID_TOKEN' });
    });

    test('rejects a wrong salt (proof mismatch)', () => {
        expect(Passport.verify(token, 'wrong-salt', entry))
            .toEqual({ ok: false, reason: 'INVALID_TOKEN' });
    });

    test('rejects when stored proof is well-formed but does not match', () => {
        const tampered = { proof: 'f'.repeat(64), issuedAt: Date.now() };
        expect(Passport.verify(token, salt, tampered))
            .toEqual({ ok: false, reason: 'INVALID_TOKEN' });
    });

    // --- end-to-end round trip -------------------------------------------
    test('full lifecycle: issue → entry → verify round-trips', () => {
        const dt = Passport.issueToken();
        const s = Passport.createSalt();
        const e = Passport.createProofEntry(dt, s);
        expect(Passport.verify(dt, s, e)).toEqual({ ok: true });
        expect(Passport.verify(dt + 'x', s, e)).toEqual({ ok: false, reason: 'INVALID_TOKEN' });
    });
});
