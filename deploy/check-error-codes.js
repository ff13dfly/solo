#!/usr/bin/env node
/**
 * check-error-codes.js — error-code coverage + collision guard (CI).
 *
 * The shared error catalog (api/library/jsonrpc.js) owns a CODES registry: the single
 * source of truth for every JSON-RPC error code in the system. Each service's
 * handlers/jsonrpc.js may re-export the catalog AND append service-specific named errors
 * (the documented pattern). This guard asserts those additions stay disciplined:
 *
 *   1. COVERAGE  — every code a named helper uses must be registered in CODES.
 *   2. NO STEALTH COLLISION — a helper name on a code must be the registered canonical
 *      name OR a registered alias of that code. An unregistered name on an existing code
 *      is exactly how the old -32099 triple-collision (UPSTREAM_ERROR / SERVICE_NOT_READY
 *      / RETRY_LATER) crept in — this turns that into a red CI line.
 *
 * Scope: the named-helper catalog (library/jsonrpc.js + every service handlers/jsonrpc.js).
 * Router inline codes (category/system handlers) are documented in CODES for traceability
 * but are not named helpers, so they are not enforced here.
 *
 * Exit 0 = clean, exit 1 = drift.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API = path.join(__dirname, '..', 'api');
const { CODES } = require(path.join(API, 'library', 'jsonrpc.js'));

// Find the catalog + every service shim.
const shims = execSync(
    `find "${API}/library/jsonrpc.js" "${API}/core" "${API}/apps" "${API}/router" "${API}/sample" -name jsonrpc.js -not -path '*/node_modules/*'`,
    { encoding: 'utf8' }
).trim().split('\n').filter(Boolean);

// NAME: (args) => ({ code: -32NNN, ...
const HELPER = /([A-Z_]{3,}):\s*\([^)]*\)\s*=>\s*\(\{\s*code:\s*(-32\d{3})/g;

const problems = [];
let helperCount = 0;

for (const file of shims) {
    const rel = path.relative(path.join(__dirname, '..'), file);
    const txt = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = HELPER.exec(txt)) !== null) {
        helperCount++;
        const name = m[1];
        const code = m[2];
        const entry = CODES[code];
        if (!entry) {
            problems.push(`UNREGISTERED CODE ${code} used by ${name} (${rel}) — add it to CODES in library/jsonrpc.js`);
            continue;
        }
        if (name !== entry.canonical && !entry.aliases.includes(name)) {
            problems.push(`UNREGISTERED ALIAS ${name} on ${code} (${rel}) — canonical is ${entry.canonical}; add ${name} to its aliases (or pick a free code) in library/jsonrpc.js`);
        }
    }
}

// Sanity: the registry itself must not map two codes to the same canonical name.
const seenCanonical = {};
for (const [code, e] of Object.entries(CODES)) {
    if (seenCanonical[e.canonical]) problems.push(`DUP CANONICAL ${e.canonical} on ${code} and ${seenCanonical[e.canonical]}`);
    else seenCanonical[e.canonical] = code;
}

if (problems.length) {
    console.error('❌ 错误码漂移检查未通过：\n  - ' + problems.join('\n  - '));
    process.exit(1);
}
console.log(`✅ 错误码检查通过：${helperCount} 个命名错误助手、${Object.keys(CODES).length} 个登记码，覆盖完整、无未登记撞码（CODES = library/jsonrpc.js 唯一真源）。`);
