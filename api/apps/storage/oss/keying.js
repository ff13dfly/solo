/**
 * apps/storage/oss/keying.js — CAS object-key derivation for the storage providers.
 *
 * @why  The storage providers are dumb key→bytes stores; SHA-256 content
 *       addressing + dedup stay in apps/storage (Redis index). This module is
 *       the ONE place that turns a content hash into an object key, and it
 *       mirrors library/filestore.js's 2/2/2 partition EXACTLY so existing
 *       on-disk assets (uploads/assets) map 1:1 onto object keys — a zero-copy
 *       cutover from the local-disk backend to any OSS provider.
 *
 *       filestore.save(content, root, {extension}) writes to
 *         <sha[0:2]>/<sha[2:4]>/<sha[4:6]>/<sha[6:]><ext>
 *       keyFor(sha, ext) returns that same relative path as a forward-slash
 *       object key. Object keys are ALWAYS '/'-separated (never path.sep) —
 *       that is what S3/OSS expect and what the local-oss-server stores under.
 */

/**
 * Object key for a content hash.
 * @param {string} sha256    full hex content hash (>= 6 chars)
 * @param {string} [extension='']  file extension incl. dot, e.g. '.png'
 * @returns {string} forward-slash object key, e.g. 'aa/bb/cc/<rest>.png'
 */
function keyFor(sha256, extension = '') {
    if (!sha256 || sha256.length < 6) {
        throw new Error('[storage:keying] sha256 must be at least 6 chars');
    }
    const ext = extension || '';
    return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256.slice(4, 6)}/${sha256.slice(6)}${ext}`;
}

/**
 * Object key for a derived thumbnail (used only in 'pregenerate' thumbnail mode).
 * Matches the legacy filestore.resolve(sha, dir, `_${label}.jpg`) layout.
 * @param {string} sha256
 * @param {string} label  size preset label, e.g. 'sm' | 'md' | 'lg'
 * @returns {string} e.g. 'aa/bb/cc/<rest>_md.jpg'
 */
function thumbKeyFor(sha256, label) {
    if (!label) throw new Error('[storage:keying] thumbnail label is required');
    return keyFor(sha256, `_${label}.jpg`);
}

/**
 * Map a thumbnail size preset to a vendor-neutral image-process spec. The
 * provider prefixes 'image/' and emits ?x-oss-process=image/resize,w_<px>
 * (Aliyun native; the local-oss-server emulates it with sharp).
 * @param {string} label             e.g. 'sm'
 * @param {object} [sizes={}]        { sm: 90, md: 320, lg: 800 }
 * @returns {string|null} e.g. 'resize,w_320', or null when the label is unknown
 */
function processSpecFor(label, sizes = {}) {
    const px = sizes[label];
    if (!px) return null;
    return `resize,w_${px}`;
}

module.exports = { keyFor, thumbKeyFor, processSpecFor };
