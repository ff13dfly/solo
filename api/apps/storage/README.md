# Storage Service

Content-Addressable Storage (CAS) over a **driver-based OSS provider**. The service
holds metadata + the dedup index in Redis and delegates all bytes to an object
store — it no longer serves files from its own disk/port.

## Provider selection (`STORAGE_PROVIDER`)

| value | backend | use |
|-------|---------|-----|
| `local` (default) | the single-file local OSS server (`oss/local-oss-server.js`) | dev / test / CI |
| `aliyun` | Aliyun OSS via `ali-oss` | production |

Pick the backend in config; the asset logic is vendor-neutral (it branches on
`store.capabilities()`, never on a vendor name). Adding S3/MinIO later is a new
driver under `oss/` implementing the same interface — no change to `logic/asset.js`.

```
logic/asset.js ──uses──> oss/index.js (createStorageProvider)
                              ├── oss/driver-aliyun.js  → ali-oss (prod)
                              └── oss/driver-local.js   → HTTP → oss/local-oss-server.js (dev/test)
oss/keying.js   — sha256 → 2/2/2 object key (byte-identical to the legacy on-disk layout: zero-copy migration)
oss/presign.js  — shared HMAC for the local driver/server presigned URLs
```

## How files are served

The storage service **does not serve bytes**. `resolve` / `list` / `multi` return
**absolute object-store URLs**:

- `access=public` (default) → stable public/CDN URL (`OSS_CDN_BASE/<key>`, or the
  local server's `http://host:8755/solo/<key>`).
- `access=private` → time-bounded signed URL (closes the old unauthenticated
  `/assets` IDOR hole, B3 / SOLO-SEC-004).

`GET /file/:id?s=sm|md|lg` is kept only as a **back-compat 302 redirect** to the
provider URL (it no longer reads disk). The Router's `/assets` static serving is
disabled by default (`ENABLE_STATIC_ASSETS` opt-in).

## Thumbnails (`STORAGE_THUMBNAIL_MODE`)

- `pregenerate` (default) — on upload, `sharp` produces sm/md/lg JPEGs and uploads
  them as separate objects (`<key>_<label>.jpg`). `resolve`/`list` responses include
  a `thumbnails` map of direct URLs. `storage.thumbnail.rebuild` regenerates them
  from the stored original.
- `off` — originals only (used by unit tests / simulation).

## Config / env

| env | default | meaning |
|-----|---------|---------|
| `STORAGE_PROVIDER` | `local` | `local` \| `aliyun` |
| `STORAGE_ACCESS` | `public` | `public` (CDN) \| `private` (signed) |
| `STORAGE_THUMBNAIL_MODE` | `pregenerate` | `pregenerate` \| `off` |
| `STORAGE_SIGNED_URL_TTL` | `1800` | signed URL TTL (s), `private` mode |
| `LOCAL_OSS_ENDPOINT` | `http://localhost:8755` | local server origin |
| `LOCAL_OSS_SECRET` | `solo-local-oss-dev-secret` | shared HMAC/Bearer secret (server + driver must match) |
| `OSS_REGION` / `OSS_BUCKET` | `oss-cn-hangzhou` / — | Aliyun bucket |
| `OSS_KEY_ID` / `OSS_KEY_SECRET` | — | Aliyun RAM AccessKey (PutObject/GetObject/DeleteObject/ListObjects) |
| `OSS_CDN_BASE` | — | public CDN base (no trailing slash) |

`ali-oss` is an optional dependency (declared at the workspace root
`api/package.json`); with `provider=local` it isn't required.

## Local OSS server

`deploy/dev.sh` starts it on **:8755** (root = `uploads/assets`, so existing files
serve unchanged). It is NOT a Solo microservice (no `services.json` entry). Run
standalone: `node deploy/local-oss.js`.

## Architecture notes

1. **Dedup**: SHA-256 content-addressing + a Redis `STORAGE:SHA256:<sha>` index. The
   provider is a dumb key→bytes store; it never hashes.
2. **Hashing** is offloaded to a Worker pool (`logic/worker.js`) with per-task id
   correlation (prevents cross-user sha256 drift; see issue_20260425).
3. **CAS delete** removes the object (and thumbnails) only when no other asset
   record references the same sha256.

## Tests

- `tests/oss-keying.test.js`, `tests/oss-provider.test.js` — hermetic; boot the
  local OSS server in-process, mock `ali-oss` (in the CI allow-list).
- `tests/scripts/unit.test.js` (`npm test`) and the autocheck simulation boot an
  in-process local OSS server too. Run autocheck: `node api/autocheck/checker.js api/apps/storage`.
