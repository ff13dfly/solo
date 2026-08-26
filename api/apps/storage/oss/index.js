/**
 * apps/storage/oss/index.js — driver-based object-storage provider for the
 * storage service. Select the backend in config; the storage logic stays
 * vendor-neutral and never branches on a vendor name (it branches on
 * capabilities()).
 *
 * @why  The user-facing knob: STORAGE_PROVIDER=local|aliyun. 'local' targets
 *       the single-file local-oss-server (dev/test); 'aliyun' wraps ali-oss.
 *       An 's3'/'minio' driver can be added later behind the same interface —
 *       apps/storage will not change because it consumes the interface +
 *       capabilities() seam, not the SDK.
 *
 * @interface  every driver implements:
 *   async put(key, body, {contentType,cacheControl,meta}) -> {key,etag,size}
 *   async get(key, {process}) -> {content:Buffer, contentType}
 *   async getStream(key, {process}) -> {stream, contentType}
 *   async exists(key) -> boolean
 *   async head(key) -> {size,contentType,lastModified} | null
 *   async delete(key) -> void
 *   async deleteMany(keys) -> {deleted:string[]}     (keys: string[] | {name}[])
 *   async list({prefix,max,cursor}) -> {objects:[{key,size,lastModified}], cursor}
 *   presignGet(key, {expires,process}) -> string            (SYNC)
 *   async presignGetAsync(key, {expires,process}) -> string
 *   presignPut(key, {expires,contentType}) -> {uploadUrl,key,contentType}
 *   publicUrl(key, {process}) -> string
 *   capabilities() -> {presign,imageProcessUrl,publicUrl,list}
 */

const { createLocalDriver } = require('./driver-local');
const { createAliyunDriver } = require('./driver-aliyun');
const keying = require('./keying');

/**
 * @param {object} storageConfig   the apps/storage config.storage block
 * @param {string} storageConfig.provider   'local' | 'aliyun'
 * @param {string} [storageConfig.access='private']  'private' (signed urls) | 'public' (cdn urls)
 * @param {number} [storageConfig.signedUrlTtl=1800]
 * @param {object} [storageConfig.local]    { endpoint, bucket, secret, outwardOrigin, publicBase }
 * @param {object} [storageConfig.oss]      { region, bucket, accessKeyId, accessKeySecret, secure, cdnBase, endpoint }
 * @param {object} [deps]   { now } injectable time source
 * @returns {object} the selected driver, augmented with { provider, access, resolveUrl }
 */
function createStorageProvider(storageConfig = {}, deps = {}) {
    const provider = storageConfig.provider || 'local';
    const ttl = storageConfig.signedUrlTtl || 1800;
    let driver;

    if (provider === 'local') {
        const local = storageConfig.local || {};
        if (!local.secret) {
            throw new Error('[storage] provider=local requires storage.local.secret (LOCAL_OSS_SECRET) — signed URLs are forgeable without it');
        }
        // The scaffold's shipped dev secret is a PUBLIC CONSTANT (it is in the
        // open-source repo). It is both the presign HMAC key and the Bearer token,
        // so anyone can forge asset urls and — with the Bearer — list or bulk-delete
        // the whole bucket. Tolerable in dev; never where signed urls are the
        // security promise, hence the hard stop in private mode.
        if (local.isDevSecret) {
            const msg = 'storage.local.secret is still the shipped dev default — set LOCAL_OSS_SECRET to a per-project random value (openssl rand -hex 24)';
            if ((storageConfig.access || 'private') === 'private') {
                throw new Error(`[storage] ${msg}. Refusing to start: STORAGE_ACCESS=private promises unforgeable signed urls, and a public secret makes that promise false.`);
            }
            const warn = (deps.logger && typeof deps.logger.warn === 'function')
                ? deps.logger.warn.bind(deps.logger) : console.warn;
            warn(`[storage] ${msg}. Fine for dev; in a real deployment anyone can mint asset urls and list/delete the bucket.`);
        }
        driver = createLocalDriver({
            // 127.0.0.1, not 'localhost' — a refused dual-stack dial yields an
            // AggregateError with an EMPTY message (see config.js). This fallback
            // is only for direct callers that hand-build a config; the real default
            // comes from apps/storage/config.js and points at the in-process mount.
            endpoint: local.endpoint || 'http://127.0.0.1:8755',
            bucket: local.bucket || 'solo',
            secret: local.secret,
            outwardOrigin: local.outwardOrigin,
            publicBase: local.publicBase,
            signedUrlTtl: ttl,
            now: deps.now,
        });
    } else if (provider === 'aliyun' || provider === 'oss') {
        const oss = storageConfig.oss || {};
        driver = createAliyunDriver({ ...oss, signedUrlTtl: ttl });
    } else {
        throw new Error(`[storage] unknown provider '${provider}' (expected 'local' | 'aliyun')`);
    }

    driver.provider = provider;
    // NOTE: this `|| 'private'` fallback only applies to DIRECT callers that hand-build a
    // config (tests/simulation). The production default comes from apps/storage config.js,
    // which fills access = STORAGE_ACCESS || 'public' — i.e. a real deployment that sets
    // nothing runs in 'public' mode. Do not read this line as "the system defaults private".
    driver.access = storageConfig.access || 'private';

    /**
     * The URL seam apps/storage uses for resolve()/list()/multi(). Branches:
     *   access==='public' + driver has publicUrl  → stable UNSIGNED URL (anyone holding
     *                                               the URL can download the bytes)
     *   otherwise                                 → signed, expiring URL (presignGet)
     *
     * @attention `visibility` on an asset governs the RPC face only (who may OBTAIN a URL
     *   via resolve/get). Byte-level protection is decided HERE by `access`, not by
     *   visibility — an `internal` asset's bytes are anonymously downloadable in public
     *   mode. Capability-URL model (same as S3 presign); the boot warning below makes the
     *   combination explicit. See docs/feedback/done/storage-visibility-semantics.md.
     */
    driver.resolveUrl = (key, opts = {}) => {
        if (driver.access === 'public' && driver.capabilities().publicUrl) {
            return driver.publicUrl(key, opts);
        }
        return driver.presignGet(key, opts);
    };

    // Three individually-reasonable defaults (visibility=internal, STORAGE_ACCESS=public,
    // a permissive byte server) can combine into "everything anonymously downloadable"
    // with no single place saying so — this warning is that place. Fired once at boot,
    // only on the public-mode path (unit tests that build private-mode configs stay quiet).
    // The symmetric trap (docs/feedback/done/local-oss-outward-base-only-covers-public-access.md):
    // LOCAL_OSS_PUBLIC_BASE participates ONLY in the public branch above. An operator who
    // sets it under private access gets loopback signed URLs anyway and reads the dead
    // links as "upload failed" / "the proxy is broken". Fire the correction at boot, where
    // the misconfiguration is, not at resolve time. Quiet unless that exact combination is
    // present, so private-mode unit tests stay silent.
    if (provider === 'local' && driver.access !== 'public'
        && (storageConfig.local || {}).publicBase && !(storageConfig.local || {}).outwardOrigin) {
        const warn = (deps.logger && typeof deps.logger.warn === 'function')
            ? deps.logger.warn.bind(deps.logger) : console.warn;
        warn('[storage] LOCAL_OSS_PUBLIC_BASE is set but STORAGE_ACCESS is private — it only ' +
             'affects public-mode unsigned urls and is ignored on this deployment. Signed urls ' +
             'will point at the local endpoint (unreachable from other machines); to serve them ' +
             'through a public host set LOCAL_OSS_OUTWARD_ORIGIN (scheme+host+mount of the ' +
             'reverse proxy mapping to the endpoint).');
    }
    if (driver.access === 'public') {
        const warn = (deps.logger && typeof deps.logger.warn === 'function')
            ? deps.logger.warn.bind(deps.logger) : console.warn;
        warn('[storage] STORAGE_ACCESS=public — resolve/list return stable UNSIGNED urls: ' +
             'anyone holding a url can download the bytes anonymously, regardless of the asset\'s ' +
             '`visibility` (which gates the RPC face only). For byte-level isolation set ' +
             'STORAGE_ACCESS=private (signed, expiring urls).');
    }

    return driver;
}

module.exports = {
    createStorageProvider,
    createLocalOssServer: require('./local-oss-server').createLocalOssServer,
    keying,
};
