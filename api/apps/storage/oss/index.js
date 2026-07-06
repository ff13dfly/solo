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
 * @param {object} [storageConfig.local]    { endpoint, bucket, secret, publicBase }
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
        driver = createLocalDriver({
            endpoint: local.endpoint || 'http://localhost:8755',
            bucket: local.bucket || 'solo',
            secret: local.secret,
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
    driver.access = storageConfig.access || 'private';

    /**
     * The URL seam apps/storage uses for resolve()/list()/multi(). Returns a
     * signed, expiring URL by default (closes the unauthenticated-read hole);
     * returns a stable public CDN URL when access==='public' and the driver
     * can build one.
     */
    driver.resolveUrl = (key, opts = {}) => {
        if (driver.access === 'public' && driver.capabilities().publicUrl) {
            return driver.publicUrl(key, opts);
        }
        return driver.presignGet(key, opts);
    };

    return driver;
}

module.exports = {
    createStorageProvider,
    createLocalOssServer: require('./local-oss-server').createLocalOssServer,
    keying,
};
