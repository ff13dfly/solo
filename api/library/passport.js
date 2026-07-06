const crypto = require('crypto');
const generator = require('./generator');
const { generateSalt } = require('./crypto');

/**
 * Solo Passport Helper
 * @protocol Passport Protocol v1.1.0 (docs/zh/protocol/passport.md)
 * @why Implements account-less secure access using Salted Tokens for external actors.
 *
 * Proof storage model (Redis Hash):
 *   key:   PASSPORT:PROOFS:{anchor}
 *   field: deviceId
 *   value: JSON.stringify({ proof, issuedAt })
 */

const DEFAULT_TOKEN_TTL = 90 * 24 * 60 * 60 * 1000; // 90 days in ms

class Passport {
    /**
     * Issue a new secure device token (the secret credential held by the client).
     * @param {number} len - Byte length (default 32 bytes for strong entropy)
     * @returns {string} Base58 encoded token
     */
    static issueToken(len = 32) {
        return generator.generateId(len);
    }

    /**
     * Issue a stable device identifier (returned to client for device management).
     * Not a secret — used as the Redis Hash field key and displayed in the admin UI.
     * @param {number} len - Byte length (default 8 bytes, sufficient for uniqueness)
     * @returns {string} Base58 encoded device ID
     */
    static issueDeviceId(len = 8) {
        return generator.generateId(len);
    }

    /**
     * Create a new salt for an anchor entity.
     * @returns {string} 16 bytes hex salt — must never leave the server.
     */
    static createSalt() {
        return generateSalt(16);
    }

    /**
     * Compute a security proof for storage.
     * @param {string} token - The device token
     * @param {string} salt  - The anchor-specific salt (server-side only)
     * @returns {string} sha256 hex string
     */
    static computeProof(token, salt) {
        if (!token || !salt) {
            throw new Error('PASSPORT_MISSING_INPUT');
        }
        return crypto.createHash('sha256')
            .update(token + salt)
            .digest('hex');
    }

    /**
     * Create a proof entry for storage in the Redis Hash whitelist.
     * Call this after OTP verification; store the result under the deviceId field.
     *
     * @param {string} token - The newly issued device token
     * @param {string} salt  - The anchor-specific salt
     * @returns {{ proof: string, issuedAt: number }}
     *
     * @example
     *   const entry = Passport.createProofEntry(deviceToken, salt);
     *   await redis.hSet(`PASSPORT:PROOFS:${anchor}`, deviceId, JSON.stringify(entry));
     */
    static createProofEntry(token, salt) {
        return {
            proof: this.computeProof(token, salt),
            issuedAt: Date.now(),
        };
    }

    /**
     * Verify a request token against a stored proof entry.
     *
     * @param {string} token      - The device token from X-Solo-Device-Token header
     * @param {string} salt       - The anchor-specific salt (fetched server-side)
     * @param {object} proofEntry - The stored entry: { proof, issuedAt }
     * @param {number} [tokenTtl] - Max token age in ms (default 90 days, 0 = no expiry)
     * @returns {{ ok: boolean, reason?: string }}
     *   ok:     true if authenticated
     *   reason: 'TOKEN_EXPIRED' | 'INVALID_TOKEN' on failure
     *
     * @example
     *   const raw = await redis.hGet(`PASSPORT:PROOFS:${anchor}`, deviceId);
     *   if (!raw) return unauthorized();
     *   const result = Passport.verify(deviceToken, salt, JSON.parse(raw));
     *   if (!result.ok) return res.status(401).json({ error: result.reason });
     */
    static verify(token, salt, proofEntry, tokenTtl = DEFAULT_TOKEN_TTL) {
        if (!token || !salt || !proofEntry || typeof proofEntry !== 'object') {
            return { ok: false, reason: 'INVALID_TOKEN' };
        }

        const { proof: storedProof, issuedAt } = proofEntry;

        if (!storedProof || typeof issuedAt !== 'number') {
            return { ok: false, reason: 'INVALID_TOKEN' };
        }

        // Check expiration before the hash computation to fail fast
        if (tokenTtl > 0 && Date.now() - issuedAt > tokenTtl) {
            return { ok: false, reason: 'TOKEN_EXPIRED' };
        }

        const currentProof = this.computeProof(token, salt);
        if (currentProof !== storedProof) {
            return { ok: false, reason: 'INVALID_TOKEN' };
        }

        return { ok: true };
    }
}

module.exports = Passport;
