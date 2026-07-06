#!/usr/bin/env node
/**
 * deploy/local-oss.js — dev launcher for the storage service's single-file
 * local OSS server (api/apps/storage/oss/local-oss-server.js).
 *
 * @why The storage service migrated to a driver-based OSS provider. In dev/test
 *      it talks to this local server, which mirrors Aliyun OSS so the same code
 *      path runs everywhere. Started by deploy/dev.sh; NOT a Solo microservice
 *      (no services.json entry) and NOT used in production (use STORAGE_PROVIDER=
 *      aliyun there). Serves bytes the storage service no longer serves itself.
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
