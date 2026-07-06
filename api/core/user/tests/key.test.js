/**
 * Per-user Ed25519 signing keys (VERSION.md §3.2) — hermetic unit test.
 *
 * Drives logic/key.js directly with an in-memory fake redis (string kv + sets +
 * INCR/EXPIRE for rate limiting). Real crypto (library/crypto PBKDF2+AES-GCM) and
 * real tweetnacl — no Redis server, no HTTP.
 *
 * Covered:
 *   - generate: creates a keypair, returns bs58 public key, password-encrypts the private key
 *   - sign: only the owner (ctx.actor === uid) can sign; signature verifies with the public key
 *   - sign: wrong password → opaque failure (no oracle), never leaks the key
 *   - sign: requires an existing key; rate-limited per uid
 *   - generate again → retires old public key to HISTORY (old signatures still verify)
 *   - getPublic / status report the right shape; revoke retires the active key
 *   - the stored doc never contains the plaintext private key
 */
const createKeyLogic = require('../logic/key');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');

function makeFakeRedis() {
    const kv = new Map();
    const sets = new Map();
    const ttls = new Map();
    return {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v) { kv.set(k, v); return 'OK'; },
        async del(k) { return kv.delete(k) ? 1 : 0; },
        async incr(k) { const n = (parseInt(kv.get(k) || '0', 10) || 0) + 1; kv.set(k, String(n)); return n; },
        async expire(k, s) { ttls.set(k, s); return 1; },
        async sAdd(k, m) { const s = sets.get(k) || new Set(); s.add(m); sets.set(k, s); return 1; },
        async sMembers(k) { return [...(sets.get(k) || [])]; },
        _kv: kv, _sets: sets, _ttls: ttls,
    };
}

const config = {
    defaultIterations: 1000,   // low for test speed (prod = 200k)
    signing: { rateLimit: 3, rateLimitWindowSec: 60 },
    redis: { signKeyPrefix: 'USER:SIGNKEY:' },
};

const DIGEST = 'a'.repeat(64);   // sha256-shaped hex

describe('§3.2 user signing keys — generate', () => {
    test('creates a keypair, returns bs58 public key, encrypts private key', async () => {
        const redis = makeFakeRedis();
        const key = createKeyLogic(redis, config);
        const res = await key.generate({ password: 'correct horse battery' }, { actor: 'uid-alice' });

        expect(res.uid).toBe('uid-alice');
        expect(typeof res.publicKey).toBe('string');
        expect(() => bs58.decode(res.publicKey)).not.toThrow();
        expect(bs58.decode(res.publicKey)).toHaveLength(32);   // Ed25519 public key

        const stored = JSON.parse(redis._kv.get('USER:SIGNKEY:uid-alice'));
        expect(stored.status).toBe('ACTIVE');
        expect(stored.encPriv).toBeTruthy();
        // the plaintext private key must NEVER be stored
        expect(JSON.stringify(stored)).not.toContain(Buffer.from(nacl.sign.keyPair().secretKey).toString('hex').slice(0, 8));
        expect(stored).not.toHaveProperty('secretKey');
        expect(stored).not.toHaveProperty('privateKey');
    });

    test('rejects short / missing password', async () => {
        const key = createKeyLogic(makeFakeRedis(), config);
        await expect(key.generate({ password: 'short' }, { actor: 'uid-x' })).rejects.toMatchObject({ code: -32602 });
        await expect(key.generate({}, { actor: 'uid-x' })).rejects.toMatchObject({ code: -32602 });
    });

    test('no actor → unauthorized', async () => {
        const key = createKeyLogic(makeFakeRedis(), config);
        await expect(key.generate({ password: 'longenough' }, {})).rejects.toMatchObject({ code: -32003 });
    });
});

describe('§3.2 user signing keys — sign', () => {
    test('owner signs; signature verifies against the public key', async () => {
        const redis = makeFakeRedis();
        const key = createKeyLogic(redis, config);
        const { publicKey } = await key.generate({ password: 'pw-alice-123' }, { actor: 'uid-alice' });

        const sig = await key.sign({ uid: 'uid-alice', digest: DIGEST, password: 'pw-alice-123' }, { actor: 'uid-alice' });
        expect(sig.publicKey).toBe(publicKey);

        const ok = nacl.sign.detached.verify(
            Buffer.from(DIGEST, 'utf8'),
            bs58.decode(sig.signature),
            bs58.decode(publicKey),
        );
        expect(ok).toBe(true);
        // the exported helper agrees
        expect(key._verify(DIGEST, sig.signature, publicKey)).toBe(true);
        // a different digest does NOT verify
        expect(key._verify('b'.repeat(64), sig.signature, publicKey)).toBe(false);
    });

    test('cannot sign as someone else (self-only)', async () => {
        const redis = makeFakeRedis();
        const key = createKeyLogic(redis, config);
        await key.generate({ password: 'pw-alice-123' }, { actor: 'uid-alice' });
        // bob's session trying to sign as alice — even admin is rejected here
        await expect(key.sign({ uid: 'uid-alice', digest: DIGEST, password: 'pw-alice-123' }, { actor: 'uid-bob', isAdmin: true }))
            .rejects.toMatchObject({ code: -32005 });
    });

    test('wrong password fails opaquely, never leaks the key', async () => {
        const redis = makeFakeRedis();
        const key = createKeyLogic(redis, config);
        await key.generate({ password: 'pw-alice-123' }, { actor: 'uid-alice' });
        await expect(key.sign({ uid: 'uid-alice', digest: DIGEST, password: 'WRONG' }, { actor: 'uid-alice' }))
            .rejects.toMatchObject({ code: -32001 });   // user jsonrpc has INVALID_SIGNATURE (-32001)
    });

    test('requires an existing key', async () => {
        const key = createKeyLogic(makeFakeRedis(), config);
        await expect(key.sign({ uid: 'uid-nokey', digest: DIGEST, password: 'whatever' }, { actor: 'uid-nokey' }))
            .rejects.toMatchObject({ code: -32002 });
    });

    test('rejects malformed digest', async () => {
        const redis = makeFakeRedis();
        const key = createKeyLogic(redis, config);
        await key.generate({ password: 'pw-alice-123' }, { actor: 'uid-alice' });
        await expect(key.sign({ uid: 'uid-alice', digest: 'not-hex!!', password: 'pw-alice-123' }, { actor: 'uid-alice' }))
            .rejects.toMatchObject({ code: -32602 });
    });

    test('rate-limited per uid', async () => {
        const redis = makeFakeRedis();
        const key = createKeyLogic(redis, config);   // rateLimit: 3
        await key.generate({ password: 'pw-alice-123' }, { actor: 'uid-alice' });
        for (let i = 0; i < 3; i++) {
            await key.sign({ uid: 'uid-alice', digest: DIGEST, password: 'pw-alice-123' }, { actor: 'uid-alice' });
        }
        await expect(key.sign({ uid: 'uid-alice', digest: DIGEST, password: 'pw-alice-123' }, { actor: 'uid-alice' }))
            .rejects.toMatchObject({ code: -32005 });
    });
});

describe('§3.2 user signing keys — lifecycle', () => {
    test('re-generate retires old public key to HISTORY (old signatures still verify)', async () => {
        const redis = makeFakeRedis();
        const key = createKeyLogic(redis, config);
        const v1 = await key.generate({ password: 'pw-1-aaaa' }, { actor: 'uid-alice' });
        const oldSig = await key.sign({ uid: 'uid-alice', digest: DIGEST, password: 'pw-1-aaaa' }, { actor: 'uid-alice' });

        const v2 = await key.generate({ password: 'pw-2-bbbb' }, { actor: 'uid-alice' });
        expect(v2.publicKey).not.toBe(v1.publicKey);

        const pub = await key.getPublic({ uid: 'uid-alice' });
        expect(pub.publicKey).toBe(v2.publicKey);     // active = new
        expect(pub.history).toContain(v1.publicKey);  // old retired but kept

        // a signature made with v1 still verifies against the retired public key
        expect(key._verify(DIGEST, oldSig.signature, v1.publicKey)).toBe(true);
    });

    test('getPublic / status report shape; revoke retires the active key', async () => {
        const redis = makeFakeRedis();
        const key = createKeyLogic(redis, config);
        expect((await key.status({ uid: 'uid-z' })).hasKey).toBe(false);

        const { publicKey } = await key.generate({ password: 'pw-z-cccc' }, { actor: 'uid-z' });
        expect((await key.status({ uid: 'uid-z' })).hasKey).toBe(true);

        const rev = await key.revoke({ uid: 'uid-z' });
        expect(rev.revoked).toBe(true);
        expect((await key.status({ uid: 'uid-z' })).hasKey).toBe(false);
        // revoked key lives on in history for verification
        expect((await key.getPublic({ uid: 'uid-z' })).history).toContain(publicKey);
    });
});
