const crypto = require('crypto');

/**
 * Global Crypto Utilities
 * @why Standardizes high-security operations (PBKDF2, AES-GCM) across microservices.
 */

// Recommended iteration count for PBKDF2
const DEFAULT_ITERATIONS = 200000;
const KEY_LEN = 32; // 256 bits
const IV_LEN = 12;  // 96 bits for GCM
const AUTH_TAG_LEN = 16;

/**
 * Derive a secure encryption key from a password and salt.
 */
function deriveKey(password, salt, iterations = DEFAULT_ITERATIONS) {
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, salt, iterations, KEY_LEN, 'sha256', (err, key) => {
            if (err) reject(err);
            else resolve(key);
        });
    });
}

/**
 * Encrypt data using AES-256-GCM.
 * @returns {string} Combined hex string: [iv:32][authTag:32][ciphertext:...]
 */
function encrypt(plaintext, key) {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return iv.toString('hex') + authTag.toString('hex') + ciphertext;
}

/**
 * Decrypt data using AES-256-GCM.
 * @param {string} encrypted - Combined hex string.
 */
function decrypt(encrypted, key) {
    const iv = Buffer.from(encrypted.slice(0, 24), 'hex');
    const authTag = Buffer.from(encrypted.slice(24, 56), 'hex');
    const ciphertext = encrypted.slice(56);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let plaintext = decipher.update(ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');

    return plaintext;
}

/**
 * Generate a random secure salt.
 */
function generateSalt(len = 16) {
    return crypto.randomBytes(len).toString('hex');
}

module.exports = {
    deriveKey,
    encrypt,
    decrypt,
    generateSalt,
    DEFAULT_ITERATIONS
};
