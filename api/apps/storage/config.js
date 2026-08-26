require('dotenv').config();
const pkg = require('./package.json');
const path = require('path');
const { portFor, bindAddr } = require('../../library/ports');

// --- local OSS backend: resolved BEFORE module.exports so the endpoint can be
// derived from this service's own port. @why The default provider is `local`,
// which serves bytes from api/apps/storage/oss/local-oss-server.js. That server
// used to require a SEPARATE process on a fixed :8755 that only deploy/dev.sh
// ever started — so every stack launched by deploy/run.sh (i.e. every production
// deployment) had a 100%-broken upload path that only failed on first use, with
// a bare ECONNREFUSED. See docs/feedback/done/storage-local-oss-server-never-started.md.
// It is now mounted IN-PROCESS on this service's own port (index.js), so the
// default config is self-consistent and there is no shared 8755 for two stacks
// on one machine to collide on.
const STORAGE_PORT = portFor('storage', 8750);
const DEV_OSS_SECRET = 'solo-local-oss-dev-secret';
const LOCAL_OSS_MOUNT = process.env.LOCAL_OSS_MOUNT_PATH || '/_oss';
const STORAGE_ACCESS = process.env.STORAGE_ACCESS || 'public';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../../uploads/assets');
const LOCAL_OSS_SECRET = process.env.LOCAL_OSS_SECRET || DEV_OSS_SECRET;
// The driver talks to the mount over loopback. A wildcard bind (or none) means
// "reach me on 127.0.0.1"; an explicit per-service bind address is honoured.
const _bind = bindAddr('storage');
const OSS_HOST = (!_bind || _bind === '0.0.0.0' || _bind === '::') ? '127.0.0.1' : _bind;

module.exports = {
  serviceName: process.env.SERVICE_NAME || 'storage',
  category: 'business',
  version: pkg.version || '0.1.0',
  port: portFor('storage', 8750),
  pageSize: 20,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',

  // AI Semantic Descriptions (for Intent Detection)
  description: {
    en: {
      main: [
        "handles binary asset storage and retrieval",
        "provides content-addressable storage (CAS) for files",
        "resolves asset IDs to public URLs"
      ],
      methods: {
        "storage.asset.upload": ["upload a new binary asset and get an ID"],
        "storage.asset.get": ["fetch asset metadata by ID"],
        "storage.asset.resolve": ["resolve asset IDs to accessible URLs"],
        "storage.asset.delete": ["soft delete an asset by ID"],
        "storage.asset.list": ["list all stored assets with pagination"],
        "storage.asset.multi": ["batch fetch multiple assets by ID array"],
        "storage.thumbnail.rebuild": ["rebuild thumbnails for all image assets"]
      }
    },
    zh: {
      main: [
        "处理二进制资产的存储和检索",
        "提供文件的内容寻址存储 (CAS)",
        "将资产 ID 解析为公开 URL"
      ],
      methods: {
        "storage.asset.upload": ["上传新的二进制资产并获取 ID"],
        "storage.asset.get": ["根据 ID 获取资产元数据"],
        "storage.asset.resolve": ["将资产 ID 解析为可访问的 URL"],
        "storage.asset.delete": ["软删除指定 ID 的资产"],
        "storage.asset.list": ["分页列出所有已存储资产"],
        "storage.asset.multi": ["批量根据 ID 数组获取多个资产"],
        "storage.thumbnail.rebuild": ["重建所有图片资产的缩略图"]
      }
    }
  },

  // Security
  routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',

  // Redis Keys
  redis: {
    assetPrefix: 'STORAGE:ASSET:',         // Metadata hash
    sha256Prefix: 'STORAGE:SHA256:',       // Content-addressable dedup index
    assetIdSet: 'STORAGE:ASSETS',          // Legacy Set (kept for reference, no longer written)
    assetIdSortedSet: 'STORAGE:ASSETS:SORTED',  // Sorted Set ordered by createdAt score

    // Visibility-scoped indexes — let list() answer "what can THIS caller see" with a
    // bounded ZUNIONSTORE instead of scanning every asset in the store. Legacy assets
    // (uploaded before these existed) aren't in them until deploy/migrate-storage-index.js
    // runs once; list() falls back to the pre-existing full-scan behavior until then
    // (see assetVisibilityIndexReadyKey) — never wrong, just not fast yet.
    assetByOwnerPrefix: 'STORAGE:ASSETS:BY_OWNER:', // {prefix}{owner} -> ZSET, all of that owner's assets
    assetPublicSortedSet: 'STORAGE:ASSETS:PUBLIC',   // ZSET, visibility === 'public'
    assetInternalSortedSet: 'STORAGE:ASSETS:INTERNAL', // ZSET, visibility === 'internal'
    assetVisibilityIndexReadyKey: 'STORAGE:ASSETS:VISIBILITY_INDEX_READY', // set only by the migration script

    // Content-hash reference count — lets delete() decide "can I purge the underlying
    // bytes" in O(1) instead of scanning every asset for a matching sha256. Same
    // fallback story: absent for a given hash (pre-fix content) -> delete() falls back
    // to the old full scan for that one hash, never wrongly deletes shared bytes.
    sha256RefcountPrefix: 'STORAGE:SHA256:REFCOUNT:'
  },

  // Filesystem
  uploadDir: UPLOAD_DIR,

  // Debug
  debug: process.env.DEBUG !== 'false',
  bodyLimit: process.env.BODY_LIMIT || '50mb',

  // ID Lengths
  idLengths: {
    asset: process.env.ASSET_ID_LENGTH || 8
  },

  // Cache Settings
  maxCacheSize: Number(process.env.MAX_CACHE_SIZE) || 1000,

  // Asset Serving
  assetsPublicPath: process.env.ASSETS_PUBLIC_PATH || '/assets',

  // Thumbnail Generation (Sharp)
  thumbnails: {
    enabled: process.env.THUMBNAILS_ENABLED !== 'false',  // master switch: rebuild allowed
    auto: process.env.THUMBNAILS_AUTO !== 'false',        // auto-generate on upload
    sizes: {
      sm: 90,
      md: 320,
      lg: 800
    },
    quality: 82,
    format: 'jpeg'
  },

  // OSS storage provider (driver-based). STORAGE_PROVIDER selects the backend:
  // 'local' targets the single-file local-oss-server (dev/test), 'aliyun' wraps
  // ali-oss. Bytes never touch this service's disk — the provider serves them.
  storage: {
    provider: process.env.STORAGE_PROVIDER || 'local',            // 'local' | 'aliyun'
    access: STORAGE_ACCESS,                                       // 'public' (CDN) | 'private' (signed)
    signedUrlTtl: Number(process.env.STORAGE_SIGNED_URL_TTL) || 1800,
    // toFix §6.4 — per-asset authorization defaults.
    // defaultVisibility: applied when upload omits `visibility` ('public'|'internal'|'private').
    // routeSecret: HMAC secret gating the back-compat /file/:id route for non-public assets.
    defaultVisibility: process.env.STORAGE_DEFAULT_VISIBILITY || 'internal',
    routeSecret: process.env.STORAGE_ROUTE_SECRET || LOCAL_OSS_SECRET,
    thumbnails: {
      mode: process.env.STORAGE_THUMBNAIL_MODE || 'pregenerate'   // 'pregenerate' | 'off'
    },
    local: {
      // 127.0.0.1, never 'localhost': on a dual-stack host Node's happy-eyeballs
      // dials ::1 AND 127.0.0.1 and, when both are refused, throws an
      // AggregateError whose `message` is the EMPTY STRING — the caller sees
      // {code:'ECONNREFUSED', message:''} with the host:port nowhere in sight.
      // A literal IP keeps the real 'connect ECONNREFUSED 127.0.0.1:<port>'.
      endpoint: process.env.LOCAL_OSS_ENDPOINT || `http://${OSS_HOST}:${STORAGE_PORT}${LOCAL_OSS_MOUNT}`,
      bucket: process.env.LOCAL_OSS_BUCKET || 'solo',
      secret: LOCAL_OSS_SECRET,
      publicBase: process.env.LOCAL_OSS_PUBLIC_BASE || undefined,
      // Outward origin (scheme+host+mount of the reverse proxy in front of the store).
      // Unlike LOCAL_OSS_ENDPOINT this does NOT change how storage reaches its own
      // store and does NOT flip inProcess below — it only changes the host baked into
      // URLs handed out (signed URLs in private mode, publicBase default in public
      // mode). URLs are never persisted (resolve-time concatenation), so changing
      // this re-points every asset, past and future, with zero migration.
      outwardOrigin: process.env.LOCAL_OSS_OUTWARD_ORIGIN || undefined,
      // --- in-process mount (index.js) ---
      // On by default; an explicit LOCAL_OSS_ENDPOINT means "someone else runs
      // the object store" (a standalone deploy/local-oss.js, a shared box), so
      // we don't also boot one. LOCAL_OSS_IN_PROCESS forces either way.
      inProcess: process.env.LOCAL_OSS_IN_PROCESS
        ? !['false', '0', 'no'].includes(String(process.env.LOCAL_OSS_IN_PROCESS).toLowerCase())
        : !process.env.LOCAL_OSS_ENDPOINT,
      mountPath: LOCAL_OSS_MOUNT,
      root: process.env.LOCAL_OSS_ROOT || UPLOAD_DIR,
      // Unsigned GET must be allowed exactly when this service hands out
      // unsigned urls (access=public), or every public asset url 403s.
      publicRead: process.env.LOCAL_OSS_PUBLIC_READ
        ? process.env.LOCAL_OSS_PUBLIC_READ !== 'false'
        : STORAGE_ACCESS === 'public',
      isDevSecret: LOCAL_OSS_SECRET === DEV_OSS_SECRET
    },
    oss: {
      region: process.env.OSS_REGION || 'oss-cn-hangzhou',
      bucket: process.env.OSS_BUCKET || '',
      accessKeyId: process.env.OSS_KEY_ID || '',
      accessKeySecret: process.env.OSS_KEY_SECRET || '',
      secure: process.env.OSS_SECURE !== 'false',
      cdnBase: process.env.OSS_CDN_BASE || '',
      endpoint: process.env.OSS_ENDPOINT || undefined
    }
  }
};
