/**
 * Shared File Storage Utility
 * Implements a hash-based distributed file storage system for assets and large files.
 * 
 * Strategy:
 * 1. Calculate SHA256 hash of the content (for integrity) or key.
 * 2. Use the first 6 characters of the hash for a 3-level directory structure (2/2/2).
 * 3. Save the actual content with the remaining hash as the filename.
 * 4. Supports binary Buffer, strictly atomic writes, and custom extensions.
 * 
 * Pathway consistency with logger.js hashing strategy.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Save a file to the storage system
 * 
 * @param {string|Buffer} content - Data to be saved (Buffer recommended for binary)
 * @param {string} rootFolder - Root directory for storage
 * @param {object} options - Configuration options
 * @param {string} [options.extension=''] - File extension (e.g., '.png')
 * @param {string} [options.key] - Optional custom key instead of content hashing
 * @returns {object} - { id, sha256, path, absolutePath }
 */
function save(content, rootFolder, options = {}) {
    if (!content) throw new Error('File save failed: Missing content');
    if (!rootFolder) throw new Error('File save failed: Missing root folder');

    const { extension = '', key } = options;
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    
    // 1. Calculate SHA256 Hash
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    
    // Use the hash (or key's hash) for directory partitioning
    const partitionHash = key ? crypto.createHash('sha256').update(key).digest('hex') : sha256;

    // 2. Directory Hashing (3 Levels: 2/2/2)
    const dirL1 = partitionHash.substring(0, 2);
    const dirL2 = partitionHash.substring(2, 4);
    const dirL3 = partitionHash.substring(4, 6);
    
    // Construct Path
    const targetDir = path.join(rootFolder, dirL1, dirL2, dirL3);
    const filename = `${partitionHash.substring(6)}${extension}`;
    const relativePath = path.join(dirL1, dirL2, dirL3, filename);
    const absolutePath = path.join(targetDir, filename);

    // 3. Ensure Directory Exists
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    // 4. Atomic Write (Overwrite if exists, no append)
    fs.writeFileSync(absolutePath, buffer);

    return {
        id: partitionHash,
        sha256: sha256,
        path: relativePath,
        absolutePath: absolutePath,
        size: buffer.length
    };
}

/**
 * Resolve a file path by its ID (hash)
 * 
 * @param {string} id - The file ID (hash) 
 * @param {string} rootFolder - Root directory
 * @param {string} [extension=''] - File extension
 * @returns {string} - Absolute path
 */
function resolve(id, rootFolder, extension = '') {
    if (!id || id.length < 6) return null;
    
    const dirL1 = id.substring(0, 2);
    const dirL2 = id.substring(2, 4);
    const dirL3 = id.substring(4, 6);
    const filename = `${id.substring(6)}${extension}`;
    
    return path.join(rootFolder, dirL1, dirL2, dirL3, filename);
}

/**
 * Check if a file exists in the storage system
 * 
 * @param {string} id - The file ID (hash)
 * @param {string} rootFolder - Root directory
 * @param {string} [extension=''] - File extension
 * @returns {boolean} - True if file exists on disk
 */
function exists(id, rootFolder, extension = '') {
    const absolutePath = resolve(id, rootFolder, extension);
    return absolutePath ? fs.existsSync(absolutePath) : false;
}

module.exports = {
    save,
    resolve,
    exists
};
