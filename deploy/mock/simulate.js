#!/usr/bin/env node
//
// simulate.js — fire sample external payloads at the ingress chain (DEV ONLY).
//
// Two modes:
//   default        send the sample to a RUNNING mock listener (realistic:
//                  external → listener → normalize + raw-archive → Router → ingress)
//   --direct       send straight to the Router's ingress.ingest with the source's
//                  API key (fast multi-source; skips the listener layer)
//
// Usage:
//   node deploy/mock/simulate.js <source> [options]
//   <source>            sample name in deploy/mock/samples/<source>.json
//
// Options:
//   --direct            send to Router ingress.ingest instead of a listener
//   --id <REQUEST_ID>   fixed request_id (reuse to test dedup)
//   -n <COUNT>          send COUNT times (default 1; with fixed --id → dedup)
//   --url <URL>         (listener mode) hook url   (default http://localhost:8091/hook)
//   --router <URL>      (direct mode)  router base (default https://127.0.0.1:8800)
//   --key <APIKEY>      (direct mode)  override key (else env INGRESS_API_KEY / keys.env SRC_<source>)
//
// Examples:
//   node deploy/mock/simulate.js github                       # through listener
//   node deploy/mock/simulate.js stripe --direct              # direct, key from keys.env SRC_stripe
//   node deploy/mock/simulate.js github --id fixed-1 -n 3     # 1 accepted + 2 duplicates
//
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { direct: false, n: 1 };
let source = null;
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--direct') opts.direct = true;
    else if (a === '--id') opts.id = argv[++i];
    else if (a === '-n') opts.n = parseInt(argv[++i], 10) || 1;
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '--router') opts.router = argv[++i];
    else if (a === '--key') opts.key = argv[++i];
    else if (!a.startsWith('-')) source = a;
}

const SAMPLES_DIR = path.join(__dirname, 'samples');
if (!source) {
    const list = fs.existsSync(SAMPLES_DIR) ? fs.readdirSync(SAMPLES_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)) : [];
    console.error('✗ usage: node deploy/mock/simulate.js <source> [--direct] [--id X] [-n N]');
    console.error(`  available samples: ${list.join(', ') || '(none — add deploy/mock/samples/<source>.json)'}`);
    process.exit(1);
}

const samplePath = path.join(SAMPLES_DIR, `${source}.json`);
if (!fs.existsSync(samplePath)) {
    console.error(`✗ sample not found: ${samplePath}`);
    process.exit(1);
}
const data = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

// ── keys.env (for --direct) ──────────────────────────────────────────────────
function loadKeysEnv() {
    const p = path.join(__dirname, 'keys.env');
    const map = {};
    if (!fs.existsSync(p)) return map;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq > 0) map[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return map;
}

// ── transport ────────────────────────────────────────────────────────────────
function post(urlStr, body, headers) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const isTls = u.protocol === 'https:';
        const client = isTls ? https : http;
        const payload = JSON.stringify(body);
        const r = client.request({
            hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
            ...(isTls ? { rejectUnauthorized: false } : {}),   // dev self-signed proxy
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
        }, (resp) => {
            let buf = '';
            resp.on('data', c => { buf += c; });
            resp.on('end', () => resolve({ status: resp.statusCode, body: buf }));
        });
        r.on('error', reject);
        r.write(payload);
        r.end();
    });
}

function newRequestId() {
    return opts.id || `${source}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

// ── send one ─────────────────────────────────────────────────────────────────
async function sendDirect(requestId) {
    const router = (opts.router || process.env.ROUTER_URL || 'https://127.0.0.1:8800').replace(/\/$/, '');
    const key = opts.key || process.env.INGRESS_API_KEY || loadKeysEnv()[`SRC_${source}`];
    if (!key) {
        console.error(`✗ --direct needs an API key for "${source}". Set --key, INGRESS_API_KEY, or keys.env SRC_${source}.`);
        process.exit(1);
    }
    return post(`${router}/jsonrpc`,
        { jsonrpc: '2.0', id: requestId, method: 'ingress.ingest', params: { request_id: requestId, data } },
        { authorization: `ApiKey ${key}` });
}

// Resolve the listener hook url: explicit --url / env, else the port that
// start.sh assigned this source (deploy/mock/.ports), else the default 8091.
function listenerUrl() {
    if (opts.url) return opts.url;
    if (process.env.LISTENER_URL) return process.env.LISTENER_URL;
    const portsFile = path.join(__dirname, '.ports');
    if (fs.existsSync(portsFile)) {
        for (const line of fs.readFileSync(portsFile, 'utf8').split('\n')) {
            const eq = line.indexOf('=');
            if (eq > 0 && line.slice(0, eq).trim() === source) {
                return `http://localhost:${line.slice(eq + 1).trim()}/hook`;
            }
        }
    }
    return 'http://localhost:8091/hook';
}

async function sendViaListener(requestId) {
    return post(listenerUrl(), data, { 'x-request-id': requestId });
}

(async () => {
    const mode = opts.direct ? 'direct→Router' : 'via listener';
    console.log(`simulate "${source}" (${mode}) × ${opts.n}${opts.id ? `  request_id=${opts.id}` : ''}`);
    for (let i = 0; i < opts.n; i++) {
        const rid = newRequestId();
        try {
            const res = opts.direct ? await sendDirect(rid) : await sendViaListener(rid);
            console.log(`  [${i + 1}/${opts.n}] ${rid} → ${res.status}: ${res.body.slice(0, 160)}`);
        } catch (e) {
            console.error(`  [${i + 1}/${opts.n}] ${rid} ✗ ${e.message}`);
        }
    }
})();
