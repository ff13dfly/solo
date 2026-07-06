/**
 * apps/storage/oss/presign.js — shared presigned-URL signing for the LOCAL
 * storage provider (driver-local mints URLs, local-oss-server validates them).
 *
 * @why  Kept in ONE module so the canonical string can never drift between the
 *       signer (driver-local) and the verifier (local-oss-server). This is a
 *       DEV/TEST emulation of Aliyun OSS signatureUrl — NOT the real OSS V1/V4
 *       signature. The aliyun driver delegates signing to ali-oss itself; this
 *       helper is only used by the local provider pair.
 *
 *       Canonical string (newline-joined, order is load-bearing):
 *         METHOD \n /<bucket>/<key> \n <expires> \n <contentType> \n <process>
 *       HMAC-SHA256(secret, canonical) → lowercase hex, compared constant-time.
 *
 *       `expires` is unix EPOCH SECONDS (not ms) to match ali-oss's Expires
 *       query param. `contentType` binds PUT uploads to a single content type
 *       (prevents upload-type spoofing); it is '' for GET. `process` carries
 *       the x-oss-process value (e.g. 'image/resize,w_320') so a thumbnail URL
 *       cannot be re-pointed at a different transform.
 */

const crypto = require('crypto');

/**
 * @param {object} parts
 * @param {string} parts.method        HTTP method (case-insensitive)
 * @param {string} parts.bucket        bucket name
 * @param {string} parts.key           object key
 * @param {number|string} parts.expires  unix epoch seconds
 * @param {string} [parts.contentType='']
 * @param {string} [parts.process='']
 * @returns {string}
 */
function canonical({ method, bucket, key, expires, contentType = '', process = '' }) {
    return [
        String(method).toUpperCase(),
        `/${bucket}/${key}`,
        String(expires),
        contentType || '',
        process || '',
    ].join('\n');
}

/**
 * @returns {string} lowercase hex HMAC-SHA256 signature
 */
function sign(secret, parts) {
    if (!secret) throw new Error('[storage:presign] secret is required to sign');
    return crypto.createHmac('sha256', secret).update(canonical(parts)).digest('hex');
}

/**
 * Constant-time signature comparison. Returns false (never throws) on any
 * length mismatch or missing input.
 * @returns {boolean}
 */
function verify(secret, parts, signature) {
    if (!secret || !signature) return false;
    let expected;
    try {
        expected = sign(secret, parts);
    } catch (_) {
        return false;
    }
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signature), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

module.exports = { canonical, sign, verify };
