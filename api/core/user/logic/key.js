const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { deriveKey, encrypt, decrypt, generateSalt } = require('../../../library/crypto');
const jsonrpc = require('../handlers/jsonrpc');

/**
 * Per-user Ed25519 signing keys (VERSION.md §3.2 — 审批人签名私钥).
 *
 * @why  The approval gate (§3.1) needs non-repudiable, human-conscious sign-off:
 *       "uid X 点了同意" → "X 对确切内容的密码学签名". Each approver holds an
 *       Ed25519 keypair; the PRIVATE key is encrypted with a key DERIVED from the
 *       approver's password (PBKDF2 200k + AES-256-GCM, library/crypto) and stored
 *       at USER:SIGNKEY:{uid}. The password is NEVER stored — it is supplied only
 *       at sign time, decrypts the private key in-memory, and is discarded.
 *
 * Trust model: signing is STRICTLY self-only (req.user === uid, enforced at the
 * index layer AND here) — an admin can `revoke` (force re-provision) but can NEVER
 * sign on someone's behalf, or the non-repudiation guarantee is void. Retired
 * public keys move to USER:SIGNKEY:HISTORY:{uid} so old signatures stay verifiable.
 *
 * What gets signed: a hex digest string (e.g. sha256(workflowId+version+snapshot),
 * §3.2). We sign the digest string's UTF-8 bytes; verifiers (approval service) use
 * the same rule. bs58 for publicKey/signature wire format (fleet convention).
 */
module.exports = (redis, config) => {
    const R = config.redis;
    const S = config.signing || {};
    const ITER = config.defaultIterations || 200000;
    const RATE_MAX = S.rateLimit || 10;
    const RATE_WINDOW = S.rateLimitWindowSec || 60;

    const keyKey     = (uid) => `${R.signKeyPrefix || 'USER:SIGNKEY:'}${uid}`;
    const historyKey = (uid) => `${R.signKeyPrefix || 'USER:SIGNKEY:'}HISTORY:${uid}`;

    async function load(uid) {
        const raw = await redis.get(keyKey(uid));
        return raw ? JSON.parse(raw) : null;
    }

    // Per-uid sign rate limit (anti brute-force on the password). INCR+EXPIRE.
    async function checkRate(uid) {
        const k = `RATE:SIGN:${uid}`;
        const n = await redis.incr(k);
        if (n === 1) await redis.expire(k, RATE_WINDOW);
        if (n > RATE_MAX) throw jsonrpc.FORBIDDEN(`Signing rate limit exceeded (${RATE_MAX}/${RATE_WINDOW}s)`);
    }

    return {
        /**
         * Generate (or re-provision) the caller's keypair. Self-only: uid = ctx.actor.
         * Re-generating retires the current public key to HISTORY (old signatures stay
         * verifiable) and overwrites with the new one — this is the "forgot password →
         * admin revoke → user re-generate with a new password" recovery path.
         */
        async generate({ password } = {}, ctx = {}) {
            const uid = ctx.actor;
            if (!uid) throw jsonrpc.UNAUTHORIZED();
            if (typeof password !== 'string' || password.length < 8) {
                throw jsonrpc.INVALID_PARAM('password required (min 8 chars) — encrypts the private key');
            }

            const existing = await load(uid);
            if (existing && existing.publicKey) {
                await redis.sAdd(historyKey(uid), existing.publicKey);
            }

            const kp = nacl.sign.keyPair();
            const salt = generateSalt(16);
            const dk = await deriveKey(password, salt, ITER);
            const encPriv = encrypt(Buffer.from(kp.secretKey).toString('hex'), dk);

            const doc = {
                uid,
                publicKey: bs58.encode(Buffer.from(kp.publicKey)),
                encPriv,
                salt,
                iterations: ITER,
                createdAt: Date.now(),
                status: 'ACTIVE',
            };
            await redis.set(keyKey(uid), JSON.stringify(doc));
            return { uid, publicKey: doc.publicKey, createdAt: doc.createdAt };
        },

        /**
         * Sign a hex digest with the caller's password-encrypted key. Self-only.
         * Wrong password → decrypt throws → opaque INVALID_SIGNATURE (no oracle).
         */
        async sign({ uid, digest, password } = {}, ctx = {}) {
            // Self-only: uid defaults to the caller's own session (callers needn't know
            // their own uid). An explicit uid must still match the session.
            if (!uid) uid = ctx.actor;
            if (!uid) throw jsonrpc.UNAUTHORIZED();
            if (!digest || !/^[0-9a-f]{16,128}$/i.test(digest)) {
                throw jsonrpc.INVALID_PARAM('digest must be a hex string (16-128 chars)');
            }
            if (ctx.actor !== uid) throw jsonrpc.FORBIDDEN('Can only sign as yourself');
            if (typeof password !== 'string' || !password) throw jsonrpc.MISSING_PARAM('password');

            await checkRate(uid);

            const doc = await load(uid);
            if (!doc || doc.status !== 'ACTIVE') throw jsonrpc.NOT_FOUND('Signing key (generate one first)');

            let secretKey;
            try {
                const dk = await deriveKey(password, doc.salt, doc.iterations || ITER);
                secretKey = Buffer.from(decrypt(doc.encPriv, dk), 'hex');
            } catch (_) {
                // GCM auth-tag mismatch on a wrong password — opaque, no distinguishing oracle.
                throw jsonrpc.INVALID_SIGNATURE ? jsonrpc.INVALID_SIGNATURE('Invalid password') : jsonrpc.FORBIDDEN('Invalid password');
            }

            const sig = nacl.sign.detached(Buffer.from(digest, 'utf8'), secretKey);
            return { uid, digest, signature: bs58.encode(Buffer.from(sig)), publicKey: doc.publicKey };
        },

        /** Public key + retired-key history (for verifying old signatures). Public info. */
        async getPublic({ uid } = {}) {
            if (!uid) throw jsonrpc.MISSING_PARAM('uid');
            const doc = await load(uid);
            const history = await redis.sMembers(historyKey(uid)).catch(() => []);
            return {
                uid,
                publicKey: doc ? doc.publicKey : null,
                status: doc ? doc.status : 'NONE',
                history: history || [],
            };
        },

        /** Whether the caller has a usable key (cheap pre-check for portal).
         *  uid defaults to the caller's own session — "do I have a key?". */
        async status({ uid } = {}, ctx = {}) {
            if (!uid) uid = ctx.actor;
            if (!uid) throw jsonrpc.UNAUTHORIZED();
            const doc = await load(uid);
            return { uid, hasKey: !!(doc && doc.status === 'ACTIVE'), publicKey: doc ? doc.publicKey : null };
        },

        /**
         * Admin: retire the uid's active key (forces re-provision). Old public key
         * moves to HISTORY so signatures it made stay verifiable. Used for the
         * forgot-password recovery path — the user then generate()s with a new one.
         */
        async revoke({ uid } = {}) {
            if (!uid) throw jsonrpc.MISSING_PARAM('uid');
            const doc = await load(uid);
            if (!doc) return { uid, revoked: false, reason: 'no key' };
            if (doc.publicKey) await redis.sAdd(historyKey(uid), doc.publicKey);
            await redis.del(keyKey(uid));
            return { uid, revoked: true };
        },

        // Exported for the approval service's in-process needs / tests.
        _verify(digest, signatureBs58, publicKeyBs58) {
            try {
                return nacl.sign.detached.verify(
                    Buffer.from(digest, 'utf8'),
                    bs58.decode(signatureBs58),
                    bs58.decode(publicKeyBs58),
                );
            } catch (_) { return false; }
        },
    };
};
