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
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2));
    _cache = ctx;
}

function read() {
    if (_cache) return _cache;
    try { _cache = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')); }
    catch { _cache = {}; }
    return _cache;
}

module.exports = { CONTEXT_FILE, write, read };
