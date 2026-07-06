/**
 * gateway.webhook.send — outbound signed POST (the channel that closes toFix 一.3).
 *
 * Hermetic: spins a real local http.Server as the "external endpoint" (loopback
 * allowed via WEBHOOK_ALLOW_LOOPBACK — the same escape hatch e2e uses; the
 * default-deny itself is asserted in its own test via a fresh module registry).
 */
process.env.WEBHOOK_ALLOW_LOOPBACK = '1';

const http = require('http');
const crypto = require('crypto');
const webhook = require('../logic/webhook');

let server;
let port;
let captured;

beforeAll((done) => {
    server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            captured = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), url: req.url };
            if (req.url === '/fail500') { res.statusCode = 500; return res.end('boom'); }
            if (req.url === '/fail404') { res.statusCode = 404; return res.end('nope'); }
            if (req.url === '/slow') { return; /* never respond → timeout path */ }
            res.statusCode = 200;
            res.end('{"ok":true}');
        });
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
});

afterAll((done) => { server.close(done); });

describe('gateway.webhook.send', () => {
    test('POSTs the JSON envelope and signs it with HMAC-SHA256 when secret given', async () => {
        const res = await webhook.send({
            url: `http://127.0.0.1:${port}/cb`,
            type: 'alert', targetId: 'sentinel-1',
            payload: { decision: 'approve', amount: 42 },
            secret: 'wh-secret',
        });
        expect(res.success).toBe(true);
        expect(res.status).toBe(200);
        expect(res.provider).toBe('webhook');

        const body = JSON.parse(captured.body);
        expect(body.type).toBe('alert');
        expect(body.targetId).toBe('sentinel-1');
        expect(body.payload).toEqual({ decision: 'approve', amount: 42 });
        expect(typeof body.sent_at).toBe('number');

        // Receiver-side verification: recompute the HMAC over the raw body.
        const expected = 'sha256=' + crypto.createHmac('sha256', 'wh-secret').update(captured.body).digest('hex');
        expect(captured.headers['x-solo-signature']).toBe(expected);
        expect(captured.headers['x-solo-timestamp']).toBe(String(body.sent_at));
        expect(captured.headers['content-type']).toBe('application/json');
    });

    test('no secret → no signature header, still delivers', async () => {
        const res = await webhook.send({ url: `http://127.0.0.1:${port}/cb`, payload: { a: 1 } });
        expect(res.success).toBe(true);
        expect(captured.headers['x-solo-signature']).toBeUndefined();
    });

    test('non-2xx target response rejects with httpStatus attached', async () => {
        await expect(webhook.send({ url: `http://127.0.0.1:${port}/fail500`, payload: {} }))
            .rejects.toMatchObject({ httpStatus: 500 });
        await expect(webhook.send({ url: `http://127.0.0.1:${port}/fail404`, payload: {} }))
            .rejects.toMatchObject({ httpStatus: 404 });
    });

    test('never-responding target times out (bounded wait)', async () => {
        await expect(webhook.send({ url: `http://127.0.0.1:${port}/slow`, payload: {}, timeoutMs: 300 }))
            .rejects.toThrow(/timed out/);
    });

    test('invalid url / unsupported protocol are rejected up front', async () => {
        await expect(webhook.send({ url: 'not a url', payload: {} })).rejects.toThrow(/invalid url/);
        await expect(webhook.send({ url: 'ftp://x.example/p', payload: {} })).rejects.toThrow(/unsupported protocol/);
    });

    test('loopback targets are refused by default (SSRF guardrail)', async () => {
        // Fresh module registry without the escape hatch → default-deny path.
        await jest.isolateModulesAsync(async () => {
            const prev = process.env.WEBHOOK_ALLOW_LOOPBACK;
            delete process.env.WEBHOOK_ALLOW_LOOPBACK;
            try {
                const strictWebhook = require('../logic/webhook');
                await expect(strictWebhook.send({ url: `http://127.0.0.1:${port}/cb`, payload: {} }))
                    .rejects.toThrow(/loopback/);
            } finally {
                process.env.WEBHOOK_ALLOW_LOOPBACK = prev;
            }
        });
    });
});
