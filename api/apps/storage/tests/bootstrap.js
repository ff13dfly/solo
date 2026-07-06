const { createClient } = require('redis');
const fs = require('fs');
const os = require('os');
const path = require('path');
const baseConfig = require('../config');
const { createLocalOssServer } = require('../oss');

/**
 * @why The asset logic now persists bytes through an OSS provider. For unit
 *      tests we boot the single-file local-oss-server in-process (ephemeral
 *      port, temp root, publicRead so public URLs are fetchable) and point the
 *      'local' driver at it — exercising the real upload→OSS path without an
 *      external service. Thumbnails are disabled to keep tests fast/hermetic.
 */
let _server = null;
let _root = null;

async function setup() {
    _root = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-storage-test-'));
    _server = createLocalOssServer({ root: _root, secret: 'storage-test-secret', bucket: 'solo', publicRead: true });
    const port = await _server.listen(0);

    const config = {
        ...baseConfig,
        storage: {
            ...(baseConfig.storage || {}),
            provider: 'local',
            access: 'public',
            thumbnails: { mode: 'off' },
            local: { endpoint: `http://localhost:${port}`, bucket: 'solo', secret: 'storage-test-secret' },
        },
    };

    const redisClient = createClient({ url: config.redisUrl });
    await redisClient.connect();
    return { redisClient, config };
}

async function teardown() {
    if (_server) { await _server.close(); _server = null; }
    if (_root) { fs.rmSync(_root, { recursive: true, force: true }); _root = null; }
}

module.exports = { setup, teardown };
