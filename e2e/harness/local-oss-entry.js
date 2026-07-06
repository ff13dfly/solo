/**
 * e2e/harness/local-oss-entry.js — standalone launcher for the storage byte backend.
 *
 * @why storage's default provider=local does NOT persist to its own disk — it PUTs the
 *      bytes to the local-oss-server (HTTP, :8755), exactly as driver-aliyun talks to real
 *      OSS. The full-profile mesh therefore needs this backend up, or every
 *      storage.asset.upload connects to :8755 → ECONNREFUSED (an empty-message socket
 *      error that storage passes straight through). createLocalOssServer has no CLI entry,
 *      so this thin wrapper boots it as a child process the harness can track + kill.
 *
 * Env: PORT (8755), LOCAL_OSS_SECRET (must match the storage service's), LOCAL_OSS_ROOT
 *      (disk dir backing the bucket), LOCAL_OSS_BUCKET (default 'solo').
 */
const path = require('path');
const os = require('os');
const { createLocalOssServer } = require(path.resolve(__dirname, '../../api/apps/storage/oss/local-oss-server.js'));

const srv = createLocalOssServer({
    root: process.env.LOCAL_OSS_ROOT || path.join(os.tmpdir(), 'solo-e2e-oss'),
    secret: process.env.LOCAL_OSS_SECRET || 'solo-local-oss-dev-secret',
    bucket: process.env.LOCAL_OSS_BUCKET || 'solo',
    publicRead: true, // e2e: allow unsigned GET so asset URLs resolve without a presign step
    logger: { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) },
});

srv.listen(Number(process.env.PORT) || 8755)
    .then((p) => console.log(`[local-oss] e2e byte backend listening on ${p}`))
    .catch((e) => { console.error(`[local-oss] failed to start: ${e.message}`); process.exit(1); });
