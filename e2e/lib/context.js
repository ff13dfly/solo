/**
 * Run context bridge — globalSetup writes it, suites read it.
 *
 * globalSetup (plain require) and test files (jest sandboxed require) are
 * different module instances, so we go through a file on disk, not a shared
 * module variable. Holds: redisUrl / routerUrl / logDir / adminToken / profile / services.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONTEXT_FILE = path.join(os.tmpdir(), 'solo-e2e-context.json');

let _cache = null;

function write(ctx) {
    // 0600：内容含 redisUrl（带 REDIS_PASSWORD）与 adminToken。os.tmpdir() 在 Linux 上是
    // 全机共享的 /tmp，默认 0644 = 同机任何账号都读得到。mode 只在新建时生效，已存在的
    // 旧文件（此前以 0644 建的）靠 chmod 收回。
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2), { mode: 0o600 });
    fs.chmodSync(CONTEXT_FILE, 0o600);
    _cache = ctx;
}

function read() {
    if (_cache) return _cache;
    try { _cache = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')); }
    catch { _cache = {}; }
    return _cache;
}

module.exports = { CONTEXT_FILE, write, read };
