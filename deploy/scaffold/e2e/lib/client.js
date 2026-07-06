/**
 * JSON-RPC client over the Router.
 *
 * Router RPC endpoint is POST `/` (NOT `/jsonrpc`). Auth via `Authorization: Bearer <token>`.
 * Returns { status, result, error, body } — never throws on RPC-level errors
 * (only on transport failure), so suites can assert on `error.code`.
 */
const http = require('http');
const { read } = require('./context');

let _id = 0;

function rpc(method, params = {}, token = null, opts = {}) {
    const url = opts.routerUrl || read().routerUrl || 'http://localhost:8600/';
    const raw = JSON.stringify({ jsonrpc: '2.0', id: ++_id, method, params: params || {} });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) };
    // opts.authHeader:发送原始 Authorization 值(如 ingress 的 'ApiKey <key>');否则用 Bearer token.
    if (opts.authHeader) headers['Authorization'] = opts.authHeader;
    else if (token) headers['Authorization'] = `Bearer ${token}`;

    return new Promise((resolve, reject) => {
        const req = http.request(url, { method: 'POST', headers }, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
                let body;
                try { body = JSON.parse(d); } catch { body = { _raw: d }; }
                resolve({ status: res.statusCode, result: body?.result, error: body?.error, body });
            });
        });
        req.on('error', reject);
        req.setTimeout(opts.timeout || 15_000, () => { req.destroy(); reject(new Error(`rpc timeout: ${method}`)); });
        req.write(raw);
        req.end();
    });
}

module.exports = { rpc };
