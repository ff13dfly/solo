require('dotenv').config();
const pkg = require('./package.json');
const path = require('path');
const { portFor } = require('../../library/ports');

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
    assetIdSortedSet: 'STORAGE:ASSETS:SORTED'  // Sorted Set ordered by createdAt score
  },

  // Filesystem
  uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, '../../../uploads/assets'),

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
    access: process.env.STORAGE_ACCESS || 'public',               // 'public' (CDN) | 'private' (signed)
    signedUrlTtl: Number(process.env.STORAGE_SIGNED_URL_TTL) || 1800,
    // toFix §6.4 — per-asset authorization defaults.
    // defaultVisibility: applied when upload omits `visibility` ('public'|'internal'|'private').
    // routeSecret: HMAC secret gating the back-compat /file/:id route for non-public assets.
    defaultVisibility: process.env.STORAGE_DEFAULT_VISIBILITY || 'internal',
    routeSecret: process.env.STORAGE_ROUTE_SECRET || process.env.LOCAL_OSS_SECRET || 'solo-local-oss-dev-secret',
    thumbnails: {
      mode: process.env.STORAGE_THUMBNAIL_MODE || 'pregenerate'   // 'pregenerate' | 'off'
    },
    local: {
      endpoint: process.env.LOCAL_OSS_ENDPOINT || 'http://localhost:8755',
      bucket: process.env.LOCAL_OSS_BUCKET || 'solo',
      secret: process.env.LOCAL_OSS_SECRET || 'solo-local-oss-dev-secret',
      publicBase: process.env.LOCAL_OSS_PUBLIC_BASE || undefined
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
