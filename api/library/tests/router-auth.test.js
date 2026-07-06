/**
 * Hermetic unit test for library/router-auth.js — the shared X-Router-Token
 * decode + Ed25519 verify primitive (CLAUDE.md §7 contract).
 *
 * Pure module: no redis, no network, no filesystem, no clock. We generate a
 * fixed keypair in-process, sign payloads with it, and assert the parser
 * extracts user/permit/constraints/meta and rejects tampered/forged tokens.
 *
 * Determinism: bytes are derived from literal payloads we build here; nothing
 * relies on Date.now() or external randomness for the assertions (the keypair
 * is generated once but only its mathematical relationship to the signature is
 * exercised — every assertion holds for any valid keypair).
 */
const bs58 = require('bs58').default || require('bs58');
const nacl = require('tweetnacl');

const { parseRouterToken } = require('../router-auth');

// --- one keypair shared by the whole suite (the "router") ---
const ROUTER = nacl.sign.keyPair();
const ROUTER_PUB = bs58.encode(ROUTER.publicKey);

/**
 * Encode a JS payload into the { x-router-token, x-router-signature } pair.
 * A fresh iat is injected by default — replay protection rejects tokens without
 * one (fail-closed); pass an explicit iat (or iat: undefined via spread) to test
 * the freshness gate itself.
 */
function signHeaders(payloadObj, keypair = ROUTER) {
    const json = JSON.stringify({ iat: Date.now(), ...payloadObj });
    const payloadBytes = new Uint8Array(Buffer.from(json, 'utf8'));
    const sigBytes = nacl.sign.detached(payloadBytes, keypair.secretKey);
    return {
        'x-router-token': bs58.encode(payloadBytes),
        'x-router-signature': bs58.encode(sigBytes),
    };
}

describe('router-auth — happy path field extraction (CLAUDE.md §7)', () => {
    test('extracts user / permit / constraints / meta / iss / iat verbatim', () => {
        const iat = Date.now() - 1000;
        const payload = {
            iss: 'router',
            iat,
            user: 'uid-abc123',
            permit: 'admin',
            constraints: { tenantId: 't1', region: 'eu' },
            meta: { route: 'user.account.read' },
        };
        const out = parseRouterToken(signHeaders(payload), ROUTER_PUB);
        expect(out.user).toBe('uid-abc123');
        expect(out.permit).toBe('admin');
        expect(out.constraints).toEqual({ tenantId: 't1', region: 'eu' });
        expect(out.meta).toEqual({ route: 'user.account.read' });
        expect(out.iss).toBe('router');
        expect(out.iat).toBe(iat);
    });

    test('user permit is preserved as the compressed string "user"', () => {
        const out = parseRouterToken(
            signHeaders({ user: 'uid-plain', permit: 'user' }),
            ROUTER_PUB,
        );
        expect(out.permit).toBe('user');
        expect(out.user).toBe('uid-plain');
    });
});

describe('router-auth — defaults for omitted fields', () => {
    test('payload with only iat yields documented fallbacks', () => {
        const out = parseRouterToken(signHeaders({}), ROUTER_PUB);
        expect(out.iss).toBe('router');
        expect(out.user).toBe('anonymous');
        expect(out.permit).toBe('user');
        expect(out.constraints).toEqual({});
        expect(out.meta).toEqual({});
    });

    test('falsy individual fields fall back (empty user → anonymous)', () => {
        const out = parseRouterToken(
            signHeaders({ user: '', permit: '', constraints: null, meta: null }),
            ROUTER_PUB,
        );
        expect(out.user).toBe('anonymous'); // '' is falsy → default
        expect(out.permit).toBe('user');    // '' is falsy → default
        expect(out.constraints).toEqual({});
        expect(out.meta).toEqual({});
    });

    test('return object exposes exactly the six documented keys', () => {
        const out = parseRouterToken(signHeaders({ user: 'u' }), ROUTER_PUB);
        expect(Object.keys(out).sort()).toEqual(
            ['constraints', 'iat', 'iss', 'meta', 'permit', 'user'].sort(),
        );
    });
});

describe('router-auth — replay protection (iat freshness, fail-closed)', () => {
    function expectStale(headers) {
        try {
            parseRouterToken(headers, ROUTER_PUB);
            throw new Error('should have thrown');
        } catch (e) {
            expect(e.code).toBe(-32001);
            expect(e.message).toMatch(/expired.*replay/i);
        }
    }

    test('token without iat is rejected (a captured pair must not live forever)', () => {
        // signHeaders injects iat by default — build raw headers without it.
        const json = JSON.stringify({ user: 'uid-no-iat' });
        const bytes = new Uint8Array(Buffer.from(json, 'utf8'));
        const sig = nacl.sign.detached(bytes, ROUTER.secretKey);
        expectStale({ 'x-router-token': bs58.encode(bytes), 'x-router-signature': bs58.encode(sig) });
    });

    test('stale token (older than max age) is rejected', () =>
        expectStale(signHeaders({ user: 'uid-old', iat: Date.now() - 10 * 60 * 1000 })));

    test('token from the future beyond skew tolerance is rejected', () =>
        expectStale(signHeaders({ user: 'uid-future', iat: Date.now() + 5 * 60 * 1000 })));

    test('iat 0 (epoch) is rejected', () =>
        expectStale(signHeaders({ user: 'uid-epoch', iat: 0 })));

    test('non-numeric iat is rejected', () =>
        expectStale(signHeaders({ user: 'uid-strnum', iat: '12345' })));

    test('slightly-old token inside the window passes', () => {
        const out = parseRouterToken(
            signHeaders({ user: 'uid-fresh', iat: Date.now() - 60 * 1000 }),
            ROUTER_PUB,
        );
        expect(out.user).toBe('uid-fresh');
    });

    test('small future skew (clock drift) is tolerated', () => {
        const out = parseRouterToken(
            signHeaders({ user: 'uid-drift', iat: Date.now() + 30 * 1000 }),
            ROUTER_PUB,
        );
        expect(out.user).toBe('uid-drift');
    });
});

describe('router-auth — missing headers → -32001', () => {
    function expectMissing(headers) {
        try {
            parseRouterToken(headers, ROUTER_PUB);
            throw new Error('should have thrown');
        } catch (e) {
            expect(e.code).toBe(-32001);
            expect(e.rpcError).toBeDefined();
            expect(e.message).toMatch(/Missing Authorization Headers/);
        }
    }

    test('no headers at all', () => expectMissing({}));
    test('token present, signature missing', () =>
        expectMissing({ 'x-router-token': bs58.encode(Buffer.from('{}')) }));
    test('signature present, token missing', () =>
        expectMissing({ 'x-router-signature': bs58.encode(Buffer.from('x')) }));
    test('empty-string token is treated as missing', () =>
        expectMissing({ 'x-router-token': '', 'x-router-signature': 'abc' }));
});

describe('router-auth — bad signature → -32001 Invalid Router Signature', () => {
    test('signature from a DIFFERENT keypair is rejected', () => {
        const attacker = nacl.sign.keyPair();
        const headers = signHeaders({ user: 'uid-evil', permit: 'admin' }, attacker);
        try {
            parseRouterToken(headers, ROUTER_PUB); // verify against the real router key
            throw new Error('should have thrown');
        } catch (e) {
            expect(e.code).toBe(-32001);
            expect(e.message).toMatch(/Invalid Router Signature/);
        }
    });

    test('tampered payload (valid sig, mutated token) is rejected', () => {
        const good = signHeaders({ user: 'uid-good', permit: 'user' });
        // Re-encode a different payload but keep the original signature.
        const forgedToken = bs58.encode(
            new Uint8Array(Buffer.from(JSON.stringify({ user: 'uid-good', permit: 'admin' }))),
        );
        const headers = { ...good, 'x-router-token': forgedToken };
        try {
            parseRouterToken(headers, ROUTER_PUB);
            throw new Error('should have thrown');
        } catch (e) {
            expect(e.code).toBe(-32001);
            expect(e.message).toMatch(/Invalid Router Signature/);
        }
    });

    test('correct payload verified against the WRONG public key is rejected', () => {
        const headers = signHeaders({ user: 'uid-x' });
        const otherPub = bs58.encode(nacl.sign.keyPair().publicKey);
        try {
            parseRouterToken(headers, otherPub);
            throw new Error('should have thrown');
        } catch (e) {
            expect(e.code).toBe(-32001);
            expect(e.message).toMatch(/Invalid Router Signature/);
        }
    });
});

describe('router-auth — malformed inputs → -32000', () => {
    test('non-base58 garbage in token/signature → malformed', () => {
        const headers = {
            'x-router-token': '!!!not-base58!!!0OIl',
            'x-router-signature': '!!!not-base58!!!0OIl',
        };
        try {
            parseRouterToken(headers, ROUTER_PUB);
            throw new Error('should have thrown');
        } catch (e) {
            expect(e.code).toBe(-32000);
            expect(e.message).toMatch(/Malformed Auth Token/);
        }
    });

    test('invalid router public key → malformed', () => {
        const headers = signHeaders({ user: 'u' });
        try {
            parseRouterToken(headers, 'not-a-valid-pubkey');
            throw new Error('should have thrown');
        } catch (e) {
            expect(e.code).toBe(-32000);
            expect(e.message).toMatch(/Malformed Auth Token/);
        }
    });

    test('validly-signed but non-JSON payload → malformed', () => {
        // Sign raw bytes that are NOT valid JSON, so verify() passes but JSON.parse fails.
        const rawBytes = new Uint8Array(Buffer.from('this is not json {{', 'utf8'));
        const sigBytes = nacl.sign.detached(rawBytes, ROUTER.secretKey);
        const headers = {
            'x-router-token': bs58.encode(rawBytes),
            'x-router-signature': bs58.encode(sigBytes),
        };
        try {
            parseRouterToken(headers, ROUTER_PUB);
            throw new Error('should have thrown');
        } catch (e) {
            expect(e.code).toBe(-32000);
            expect(e.message).toMatch(/Malformed Auth Token/);
        }
    });
});

describe('router-auth — error shape is JSON-RPC ready', () => {
    test('thrown error carries code + rpcError descriptor for the gateway', () => {
        let caught;
        try {
            parseRouterToken({}, ROUTER_PUB);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught.rpcError).toEqual({ code: -32001, message: caught.message });
    });
});

describe('router-auth — ROUTER_TOKEN_MAX_AGE_MS env override (freshness window)', () => {
    // The max-age window is computed ONCE at module load from the env var:
    //   Number.isFinite(n) && n > 0 ? n : 300_000
    // so each case re-requires the module in isolation with the env var set,
    // then asserts the parser's freshness behavior actually changed.
    function withMaxAge(value, fn) {
        const saved = process.env.ROUTER_TOKEN_MAX_AGE_MS;
        jest.resetModules();
        if (value === undefined) delete process.env.ROUTER_TOKEN_MAX_AGE_MS;
        else process.env.ROUTER_TOKEN_MAX_AGE_MS = value;
        try {
            fn(require('../router-auth').parseRouterToken);
        } finally {
            if (saved === undefined) delete process.env.ROUTER_TOKEN_MAX_AGE_MS;
            else process.env.ROUTER_TOKEN_MAX_AGE_MS = saved;
            jest.resetModules();
        }
    }

    test('a valid positive override widens the window (n > 0 → ternary true)', () => {
        // 10 min window: a token aged ~7 min would be STALE under the 300s default
        // but must pass here, proving the override (parseInt → finite, > 0) took effect.
        withMaxAge('600000', (parse) => {
            const out = parse(
                signHeaders({ user: 'uid-widened', iat: Date.now() - 7 * 60 * 1000 }),
                ROUTER_PUB,
            );
            expect(out.user).toBe('uid-widened');
        });
    });

    test('a non-positive override is ignored and falls back to the 300s default (n > 0 false)', () => {
        withMaxAge('0', (parse) => {
            // Fresh token still passes...
            expect(parse(signHeaders({ user: 'uid-ok' }), ROUTER_PUB).user).toBe('uid-ok');
            // ...but a 7-min-old one is rejected: the bogus "0" did NOT become the window.
            let caught;
            try {
                parse(signHeaders({ user: 'uid-old', iat: Date.now() - 7 * 60 * 1000 }), ROUTER_PUB);
            } catch (e) {
                caught = e;
            }
            expect(caught.code).toBe(-32001);
            expect(caught.message).toMatch(/expired.*replay/i);
        });
    });

    test('iat:0 default kicks in when an enormous window admits an epoch timestamp', () => {
        // With the window larger than the current epoch, a token bearing iat:0 passes
        // the freshness gate (age < window, age > -skew, typeof === "number"), reaching
        // the return where `payload.iat || 0` exercises the `|| 0` fallback branch.
        withMaxAge('99999999999999', (parse) => {
            const out = parse(signHeaders({ user: 'uid-epoch-ok', iat: 0 }), ROUTER_PUB);
            expect(out.user).toBe('uid-epoch-ok');
            expect(out.iat).toBe(0); // the || 0 default surfaces as 0
        });
    });
});

describe('router-auth — bs58 CJS/ESM interop fallback (line 20 guard)', () => {
    test('parser still works when bs58 exposes functions at top level (no .default)', () => {
        // router-auth.js: `require('bs58').default || require('bs58')` — handles both
        // ESM-transpiled bs58 (functions under .default) and a CJS build that exports
        // them at the top level. The installed build has .default; here we simulate the
        // CJS-style export (a module WITHOUT .default) so the `|| require('bs58')`
        // fallback is taken, and assert decode/verify still succeed end-to-end.
        jest.isolateModules(() => {
            const flatBs58 = jest.requireActual('bs58').default; // functional obj, no .default
            jest.doMock('bs58', () => flatBs58);
            const { parseRouterToken: parse } = require('../router-auth');

            const json = JSON.stringify({ iat: Date.now(), user: 'uid-interop', permit: 'admin' });
            const bytes = new Uint8Array(Buffer.from(json, 'utf8'));
            const sig = nacl.sign.detached(bytes, ROUTER.secretKey);
            const headers = {
                'x-router-token': flatBs58.encode(bytes),
                'x-router-signature': flatBs58.encode(sig),
            };
            const out = parse(headers, ROUTER_PUB);
            expect(out.user).toBe('uid-interop');
            expect(out.permit).toBe('admin');
        });
        jest.dontMock('bs58');
        jest.resetModules();
    });
});
