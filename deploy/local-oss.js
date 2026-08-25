#!/usr/bin/env node
/**
 * deploy/local-oss.js — standalone launcher for the storage service's single-file
 * local OSS server (api/apps/storage/oss/local-oss-server.js).
 *
 * @why The storage service migrated to a driver-based OSS provider, which mirrors
 *      Aliyun OSS so the same code path runs everywhere. NOT a Solo microservice
 *      (no services.json entry).
 *
 *      You usually do NOT need this: the storage service mounts the same server
 *      IN-PROCESS on its own port when provider=local (api/apps/storage/index.js),
 *      which is the default. Run this standalone only to put the object store in
 *      its own process / on its own host — then point the service at it with
 *      LOCAL_OSS_ENDPOINT, which also stops it from booting a second one.
 *      (Pre-v1.2.3 this was the ONLY way to serve bytes, and no production launcher
 *      started it: docs/feedback/done/storage-local-oss-server-never-started.md.)
 */
const fs = require('fs');
const path = require('path');
const { createLocalOssServer } = require('../api/apps/storage/oss/local-oss-server');

const root = process.env.LOCAL_OSS_ROOT || process.env.UPLOAD_DIR || path.join(__dirname, '../uploads/assets');
const secret = process.env.LOCAL_OSS_SECRET || 'solo-local-oss-dev-secret';
const bucket = process.env.LOCAL_OSS_BUCKET || 'solo';
const port = Number(process.env.LOCAL_OSS_PORT) || 8755;
const publicRead = process.env.LOCAL_OSS_PUBLIC_READ !== 'false';

if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

const server = createLocalOssServer({
    root,
    secret,
    bucket,
    publicRead,
    logger: { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) },
});

server.listen(port)
    .then((p) => console.log(`[local-oss] ready on :${p} (bucket=${bucket}, root=${root}, publicRead=${publicRead})`))
    .catch((e) => { console.error(`[local-oss] failed to start: ${e.message}`); process.exit(1); });
