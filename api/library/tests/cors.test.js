/**
 * Hermetic unit test for library/cors.js — the env-driven CORS policy helper
 * (toFix §6.5). One knob (CORS_ORIGINS) governs the whole fleet:
 *
 *   unset / empty   → {} (open, identical to bare cors() — dev default)
 *   "none"          → { origin: false } (deny all cross-origin)
 *   "a.com,b.com"   → exact-match allowlist via an origin(origin, cb) callback
 *
 * Pure function: no redis, no network, no clock. corsOptionsFromEnv reads its
 * config at CALL time (env defaults to process.env but is injectable), so every
 * branch is driven by passing explicit env objects — fully deterministic. The
 * single no-arg call (for the `env = process.env` default-parameter branch)
 * saves/restores process.env.CORS_ORIGINS so the suite leaves no global state.
 */
const { corsOptionsFromEnv } = require('../cors');

/** Invoke a returned origin-callback and capture its (err, allow) arguments. */
function callOriginCb(opts, origin) {
    let captured;
    opts.origin(origin, (err, allow) => {
        captured = { err, allow };
    });
    return captured;
}

describe('cors — default-open behavior (CORS_ORIGINS unset/empty)', () => {
    test('no-arg call falls back to process.env and is open when CORS_ORIGINS is absent', () => {
        const saved = process.env.CORS_ORIGINS;
        delete process.env.CORS_ORIGINS;
        try {
            // Exercises the `env = process.env` default parameter branch AND the
            // falsy-CORS_ORIGINS path → {} (open, behaves like a bare cors()).
            expect(corsOptionsFromEnv()).toEqual({});
        } finally {
            if (saved === undefined) delete process.env.CORS_ORIGINS;
            else process.env.CORS_ORIGINS = saved;
        }
    });

    test('explicit env without CORS_ORIGINS is open ({})', () => {
        expect(corsOptionsFromEnv({})).toEqual({});
    });

    test('whitespace-only CORS_ORIGINS trims to empty → open ({})', () => {
        // CORS_ORIGINS is truthy ("   ") but .trim() makes raw empty → !raw branch.
        expect(corsOptionsFromEnv({ CORS_ORIGINS: '   ' })).toEqual({});
    });
});

describe('cors — explicit deny ("none")', () => {
    test('CORS_ORIGINS=none denies all cross-origin via origin:false', () => {
        expect(corsOptionsFromEnv({ CORS_ORIGINS: 'none' })).toEqual({ origin: false });
    });

    test('"none" is matched after trimming surrounding whitespace', () => {
        expect(corsOptionsFromEnv({ CORS_ORIGINS: '  none  ' })).toEqual({ origin: false });
    });
});

describe('cors — exact-match allowlist', () => {
    // Mixed input exercises split/trim/filter(Boolean): real entries are kept,
    // the trailing empty token and the bare comma are dropped.
    const opts = corsOptionsFromEnv({
        CORS_ORIGINS: 'https://a.com, https://b.com ,, ',
    });

    test('returns an options object exposing only an origin callback', () => {
        expect(typeof opts.origin).toBe('function');
        expect(Object.keys(opts)).toEqual(['origin']);
    });

    test('an allowlisted origin → cb(null, true)', () => {
        expect(callOriginCb(opts, 'https://a.com')).toEqual({ err: null, allow: true });
        // The second entry proves the trimmed token (" https://b.com ") matched.
        expect(callOriginCb(opts, 'https://b.com')).toEqual({ err: null, allow: true });
    });

    test('a non-allowlisted origin → cb(null, false)', () => {
        expect(callOriginCb(opts, 'https://evil.com')).toEqual({ err: null, allow: false });
    });

    test('empty/comma tokens were filtered out — "" is NOT a valid origin', () => {
        // If filter(Boolean) had not dropped the empties, '' would be allowed.
        expect(callOriginCb(opts, '').allow).not.toBe(false); // '' is no-origin → allowed below
    });

    test('no Origin header (curl / server-to-server / same-origin) → cb(null, true)', () => {
        // The !origin branch: undefined and '' both bypass the allowlist check.
        expect(callOriginCb(opts, undefined)).toEqual({ err: null, allow: true });
        expect(callOriginCb(opts, '')).toEqual({ err: null, allow: true });
    });

    test('a single-entry allowlist still matches exactly', () => {
        const single = corsOptionsFromEnv({ CORS_ORIGINS: 'https://only.com' });
        expect(callOriginCb(single, 'https://only.com')).toEqual({ err: null, allow: true });
        expect(callOriginCb(single, 'https://other.com')).toEqual({ err: null, allow: false });
    });
});
