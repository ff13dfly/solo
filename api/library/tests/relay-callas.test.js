/**
 * relay.callAs — §1.2 explicit-token transport (hermetic: a local echo HTTP server
 * stands in for the Router; no Redis, no mesh).
 *
 * callAs lets a caller act AS a different principal by presenting an explicit token,
 * bypassing the relay's own service-bot token lifecycle + SUB guard. This is what
 * nexus uses to issue a Sentinel's data-fetch under that Sentinel's own bot token.
 */
const http = require('http');
const { createRelay } = require('../relay');

describe('relay.callAs', () => {
    let server, url, seen;

    beforeAll((done) => {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                seen = { auth: req.headers['authorization'], body: JSON.parse(body) };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: seen.body.id, result: { ok: true, echoedMethod: seen.body.method } }));
            });
        });
        server.listen(0, () => { url = `http://127.0.0.1:${server.address().port}/jsonrpc`; done(); });
    });

    afterAll(() => new Promise((resolve) => {
        server.closeAllConnections?.();   // drop lingering keep-alive sockets so close() completes
        server.close(() => resolve());    // swallow the no-op-close error arg
    }));

    test('presents the explicit token (not a stored service token) and needs no provisioning', async () => {
        // redis:{} is never touched by callAs (no token lifecycle) — proves it bypasses the store.
        const relay = createRelay({ redis: {}, serviceName: 'nexus', routerUrl: url });
        const r = await relay.callAs('SENTINEL_TOKEN_XYZ', 'collection.payment.get', { id: 'p1' });
        expect(r).toEqual({ ok: true, echoedMethod: 'collection.payment.get' });
        expect(seen.auth).toBe('Bearer SENTINEL_TOKEN_XYZ');   // the SUPPLIED token, not system.nexus
        expect(seen.body.method).toBe('collection.payment.get');
        expect(seen.body.params).toEqual({ id: 'p1' });
    });

    test('rejects a missing / non-string token before any network call', async () => {
        const relay = createRelay({ redis: {}, serviceName: 'nexus', routerUrl: url });
        await expect(relay.callAs('', 'x.y.get', {})).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
        await expect(relay.callAs(null, 'x.y.get', {})).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    });
});

// A stalled upstream must not wedge the caller forever (toFix §一.1).
describe('relay request timeout', () => {
    let server, url;

    beforeAll((done) => {
        // Accept the connection but NEVER respond — the wedge scenario.
        server = http.createServer(() => { /* intentionally no res.end() */ });
        server.listen(0, () => { url = `http://127.0.0.1:${server.address().port}/jsonrpc`; done(); });
    });

    afterAll(() => new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
    }));

    test('call rejects with RPC_TIMEOUT when the Router never responds', async () => {
        const relay = createRelay({ redis: {}, serviceName: 'nexus', routerUrl: url, requestTimeoutMs: 150 });
        await expect(relay.callAs('TKN', 'x.y.get', {})).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
    }, 5000);
});
