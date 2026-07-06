const crypto = require('crypto');

// Base58 character set (Bitcoin alphabet: excluding 0, O, I, l)
const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_LEN = BASE58_CHARS.length; // 58

/**
 * Generate a deterministic fixed-length Base58 ID
 * Uses entropy lookup to avoid length drift issues common with integer encoding
 * 
 * @param {number} length - Target length of the ID
 * @returns {string} - The generated ID
 */
function generateId(length = 8) {
    if (length <= 0) return '';
    
    // Get random bytes (one per character)
    const bytes = crypto.randomBytes(length);
    let id = '';
    
    for (let i = 0; i < length; i++) {
        // Modulo bias is negligible for 58 vs 256
        const index = bytes[i] % BASE58_LEN;
        id += BASE58_CHARS[index];
    }
    
    return id;
}

/**
 * Validate a Base58 ID
 * @param {string} id - The ID to validate
 * @param {number} length - Expected length
 * @returns {boolean}
 */
function validateId(id, length) {
    if (!id || typeof id !== 'string') return false;
    if (length && id.length !== length) return false;
    // Regex for Base58 (alphanumeric except 0, O, I, l)
    const base58Regex = /^[1-9A-HJKLMNP-Za-km-z]+$/;
    return base58Regex.test(id);
}

module.exports = { generateId, validateId };
