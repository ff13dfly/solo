/**
 * MockRouter — a throwaway local HTTP server that stands in for the real Router.
 *
 * The orchestrator's ONLY outbound dependency is an HTTP POST to its
 * `routerUrl` (see logic/runner.js `makeRpcCall`). Point `routerUrl` at this
 * mock and you can drive any workflow without booting a single downstream
 * service: stub each method's response, then assert on what the orchestrator
 * actually sent.
 *
 *   const mock = new MockRouter();
 *   mock.on('user.profile.get', ({ uid }) => ({ uid, name: 'Alice' }));  // canned result
 *   mock.on('svc.fail', () => { throw new Error('boom'); });             // simulate failure (code -32603)
 *   // A thrown error with `.rpcCode` set simulates a BUSINESS rejection the real
 *   // Router would forward verbatim (e.g. USER_NOT_FOUND) instead of a transient fault:
 *   mock.on('user.permit.get', () => { const e = new Error('not found'); e.rpcCode = -32001; throw e; });
 *   const routerUrl = await mock.start();
 *   ...
 *   mock.calls('user.profile.get')   // -> [ { uid: 'c-1' }, ... ] params seen, in order
 *   mock.count()                     // -> total downstream calls
 *   await mock.stop();               // ALWAYS stop, or jest will hang on the open socket
 *
 * A handler returns the inner `result` value — i.e. what the workflow sees as
 * `$step.<id>.result`. Throwing from a handler makes that step fail.
 */
const http = require('http');

class MockRouter {
    constructor() {
        this.server = null;
        this.port = null;
        this._handlers = new Map();   // method -> (params) => result
        this._default = null;          // (method, params) => result
        this._calls = [];              // ordered [{ method, params }]
    }

    on(method, fn) { this._handlers.set(method, fn); return this; }
    onAny(fn) { this._default = fn; return this; }

    calls(method) { return this._calls.filter(c => c.method === method).map(c => c.params); }
    lastParams(method) { const c = this.calls(method); return c[c.length - 1]; }
    allCalls() { return this._calls.slice(); }
    count(method) { return method ? this.calls(method).length : this._calls.length; }

    _resolve(method, params) {
        if (this._handlers.has(method)) return this._handlers.get(method)(params);
        if (this._default) return this._default(method, params);
        return {}; // unstubbed methods return an empty result (still recorded)
    }

    start() {
        return new Promise((resolve) => {
            this.server = http.createServer((req, res) => {
                let body = '';
                req.on('data', c => body += c);
                req.on('end', async () => {
                    let id = 1;
                    try {
                        const parsed = JSON.parse(body);
                        id = parsed.id;
                        this._calls.push({ method: parsed.method, params: parsed.params });
                        const result = await this._resolve(parsed.method, parsed.params);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ jsonrpc: '2.0', result, id }));
                    } catch (e) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: e.rpcCode || -32603, message: e.message }, id }));
                    }
                });
            });
            this.server.listen(0, '127.0.0.1', () => {
                this.port = this.server.address().port;
                resolve(`http://127.0.0.1:${this.port}`);
            });
        });
    }

    stop() {
        return new Promise(resolve => (this.server ? this.server.close(resolve) : resolve()));
    }
}

module.exports = { MockRouter };
