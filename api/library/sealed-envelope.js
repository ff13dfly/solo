/**
 * api/library/sealed-envelope.js — Zero-Plaintext Credential Envelope (`solo.sealed/v1`)
 *
 * Implements end-to-end hybrid encryption for sensitive credentials (tax passwords,
 * ERP/store cookies, session tokens) transported across SOLO stacks and stored in Redis:
 *   - Execution nodes (Steward plugin / desktop Hand) generate an asymmetric RSA-OAEP keypair
 *     and register ONLY the SPKI public key + SHA-256 fingerprint on the server.
 *   - Upstream callers (`Finance`, `Catalog`, operator portal) seal plaintext JSON/bytes locally
 *     using a fresh 256-bit AES-GCM DEK and wrap the DEK with the target node's RSA-OAEP-256 public key.
 *   - SOLO servers / Redis / fulfillment meta store ONLY the `solo.sealed/v1` envelope and
 *     NEVER possess the private key.
 *
 * Reference: docs/feedback/done/m2m-principal-scope-and-sealed-envelope.md §1.3
 */

const crypto = require('crypto');

const ENVELOPE_SCHEMA = 'solo.sealed/v1';
const ENVELOPE_ALG    = 'RSA-OAEP-256+A256GCM';

/**
 * Generate a 2048-bit (or custom modulus) RSA-OAEP keypair for a worker/execution node.
 */
function generateEnvelopeKeyPair({ modulusLength = 2048 } = {}) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength,
        publicKeyEncoding:  { type: 'spki',  format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const keyId = computeKeyFingerprint(publicKey);
    return {
        publicKey,
        privateKey,
        publicKeyPem: publicKey,
        privateKeyPem: privateKey,
        keyId,
    };
}

/**
 * Compute a deterministic `kid` (`sha256:<16-hex>`) from an SPKI PEM public key.
 */
function computeKeyFingerprint(publicKeyPem) {
    if (!publicKeyPem || typeof publicKeyPem !== 'string') {
        throw new Error('publicKeyPem must be a non-empty PEM string');
    }
    const pubObj = crypto.createPublicKey(publicKeyPem);
    const der = pubObj.export({ type: 'spki', format: 'der' });
    const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 24);
    return `sha256:${hex}`;
}

function serializeAad(aad) {
    if (aad === undefined || aad === null || aad === '') return '';
    if (typeof aad === 'object') {
        const sortedKeys = Object.keys(aad).sort();
        const canonical = {};
        for (const k of sortedKeys) canonical[k] = aad[k];
        return JSON.stringify(canonical);
    }
    return String(aad);
}

/**
 * Seal a JSON-serializable payload (or string/Buffer) into a `solo.sealed/v1` envelope.
 *
 * @param {any} payload - Plaintext object/string to seal
 * @param {string} publicKeyPem - Recipient's RSA SPKI public key PEM
 * @param {object} [options]
 * @param {string|object} [options.aad] - Optional Additional Authenticated Data bound to the GCM tag (e.g. storeId or instanceId)
 * @param {string} [options.keyId] - Optional explicit keyId override
 */
function sealEnvelope(payload, publicKeyPem, { aad = '', keyId = null } = {}) {
    if (payload === undefined) {
        throw new Error('Cannot seal undefined payload');
    }
    const resolvedKeyId = keyId || computeKeyFingerprint(publicKeyPem);
    const dek = crypto.randomBytes(32); // 256-bit AES key
    const iv  = crypto.randomBytes(12); // 96-bit GCM IV

    const plaintextBuf = Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(JSON.stringify(payload), 'utf8');

    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
    const aadStr = serializeAad(aad);
    if (aadStr) {
        cipher.setAAD(Buffer.from(aadStr, 'utf8'));
    }
    const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
    const tag = cipher.getAuthTag();

    const wrappedKey = crypto.publicEncrypt(
        {
            key:      publicKeyPem,
            padding:  crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256',
        },
        dek
    );

    // Zero out the ephemeral DEK buffer after wrapping
    dek.fill(0);

    return {
        $schema:    ENVELOPE_SCHEMA,
        alg:        ENVELOPE_ALG,
        keyId:      resolvedKeyId,
        iv:         iv.toString('base64'),
        wrappedKey: wrappedKey.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag:        tag.toString('base64'),
        ...(aadStr ? { aad: aadStr } : {}),
        sealedAt:   Date.now(),
    };
}

/**
 * Check whether a value is a well-formed `solo.sealed/v1` envelope object.
 */
function isSealedEnvelope(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    return (
        obj.$schema === ENVELOPE_SCHEMA &&
        obj.alg === ENVELOPE_ALG &&
        typeof obj.keyId === 'string' && obj.keyId.length > 0 &&
        typeof obj.iv === 'string' && obj.iv.length > 0 &&
        typeof obj.wrappedKey === 'string' && obj.wrappedKey.length > 0 &&
        typeof obj.ciphertext === 'string' && obj.ciphertext.length > 0 &&
        typeof obj.tag === 'string' && obj.tag.length > 0
    );
}

/**
 * Assert that an envelope is structurally valid (throws on malformed or plaintext leak).
 */
function assertValidEnvelope(obj) {
    if (!isSealedEnvelope(obj)) {
        throw new Error(`Invalid sealed envelope: expected schema "${ENVELOPE_SCHEMA}" with alg "${ENVELOPE_ALG}"`);
    }
    return true;
}

/**
 * Open and authenticate a `solo.sealed/v1` envelope using the recipient's RSA private key.
 *
 * @param {object} envelope - The `solo.sealed/v1` envelope
 * @param {string} privateKeyPem - Recipient's PKCS#8 PEM private key
 * @param {object} [options]
 * @param {string} [options.expectedAad] - If provided, enforces that envelope.aad matches expectedAad
 * @param {boolean} [options.rawBuffer=false] - Return raw Buffer instead of JSON.parse
 */
function openEnvelope(envelope, privateKeyPem, { expectedAad = undefined, rawBuffer = false } = {}) {
    assertValidEnvelope(envelope);
    if (!privateKeyPem || typeof privateKeyPem !== 'string') {
        throw new Error('privateKeyPem must be a non-empty PEM string');
    }
    const expectedAadStr = expectedAad !== undefined ? serializeAad(expectedAad) : undefined;
    if (expectedAadStr !== undefined && String(envelope.aad || '') !== expectedAadStr) {
        throw new Error(`Envelope AAD mismatch: expected "${expectedAadStr}", got "${envelope.aad || ''}"`);
    }

    const dek = crypto.privateDecrypt(
        {
            key:      privateKeyPem,
            padding:  crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256',
        },
        Buffer.from(envelope.wrappedKey, 'base64')
    );

    try {
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            dek,
            Buffer.from(envelope.iv, 'base64')
        );
        if (envelope.aad) {
            decipher.setAAD(Buffer.from(String(envelope.aad), 'utf8'));
        }
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const plainBuf = Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
            decipher.final(),
        ]);
        return rawBuffer ? plainBuf : JSON.parse(plainBuf.toString('utf8'));
    } finally {
        dek.fill(0);
    }
}

module.exports = {
    ENVELOPE_SCHEMA,
    ENVELOPE_ALG,
    generateEnvelopeKeyPair,
    computeKeyFingerprint,
    sealEnvelope,
    openEnvelope,
    isSealedEnvelope,
    assertValidEnvelope,
};
