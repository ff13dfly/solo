/**
 * relay-features.test.js — what the system.gateway relay bot unlocks
 * (gateway-gaps G13 attachments + G12 channel probes).
 *
 * Hermetic: fake relay + a real loopback http.Server as the "storage byte endpoint";
 * probes run against a stubbed fetch. Nothing leaves the process.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-gateway-relayfeat-${process.pid}`);
process.env.GATEWAY_SECRET_KEY = process.env.GATEWAY_SECRET_KEY || 'test-gateway-secret';
process.env.CLOCK_TEST_MODE = 'true';

const http = require('http');
const clock = require('../../../library/clock');
const createLogic = require('../logic');
const baseConfig = require('../config');
const { fetchAttachments } = require('../logic/attachments');
const { testChannel } = require('../logic/probe');
const emailProvider = require('../logic/email');
const { makeFakeRedis, silentLogger } = require('./helpers/fake-redis');

const config = {
    ...baseConfig,
    email: { ...baseConfig.email, channel: 'mock' },
    sms: { ...baseConfig.sms, channel: 'mock' },
};

// ─── byte server: serves deterministic payloads for attachment downloads ──────

let server;
let baseUrl;
const PAYLOADS = {
    '/bytes/small': Buffer.from('hello attachment'),
    '/bytes/big': Buffer.alloc(2048, 7),
};

beforeAll((done) => {
    server = http.createServer((req, res) => {
        const body = PAYLOADS[req.url];
        if (!body) { res.statusCode = 404; return res.end('nope'); }
        if (req.url === '/bytes/big' && req.headers['x-no-length'] !== '1') {
            res.setHeader('Content-Length', body.length);
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(body);
    });
    server.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

// Fake relay backed by the byte server: asset-1 → small payload, asset-big → big payload.
const makeRelay = () => ({
    calls: [],
    call(method, params) {
        this.calls.push({ method, params });
        if (method === 'storage.asset.get') {
            return Promise.resolve({ id: params.id, filename: `${params.id}.bin`, mimeType: 'application/x-test' });
        }
        if (method === 'storage.asset.resolve') {
            const route = params.id === 'asset-big' ? '/bytes/big' : '/bytes/small';
            return Promise.resolve({ url: `${baseUrl}${route}` });
        }
        return Promise.reject(new Error(`unexpected relay call ${method}`));
    },
});

// ─── G13: attachments ─────────────────────────────────────────────────────────

describe('fetchAttachments', () => {
    test('resolves storage references into named Buffers (metadata drives filename/type)', async () => {
        const relay = makeRelay();
        const out = await fetchAttachments(relay, [{ assetId: 'asset-1' }], {});
        expect(out).toHaveLength(1);
        expect(out[0].filename).toBe('asset-1.bin');
        expect(out[0].contentType).toBe('application/x-test');
        expect(out[0].content.equals(PAYLOADS['/bytes/small'])).toBe(true);
        // Caller-supplied filename wins over storage metadata.
        const named = await fetchAttachments(relay, [{ assetId: 'asset-1', filename: 'invoice.pdf' }], {});
        expect(named[0].filename).toBe('invoice.pdf');
    });

    test('size budget is enforced across ALL attachments, not per item', async () => {
        const relay = makeRelay();
        // big=2048 bytes; a 2100-byte budget fits one but not two.
        await expect(fetchAttachments(relay, [{ assetId: 'asset-big' }, { assetId: 'asset-big' }], { maxBytes: 2100 }))
            .rejects.toThrow(/size budget/);
        // Streaming cap catches it even when the server omits Content-Length.
        await expect(fetchAttachments(relay, [{ assetId: 'asset-big' }], { maxBytes: 100 }))
            .rejects.toThrow(/size budget/);
    });

    test('count cap and malformed items fail fast', async () => {
        const relay = makeRelay();
        await expect(fetchAttachments(relay, [{ assetId: 'a' }, { assetId: 'b' }], { maxCount: 1 }))
            .rejects.toThrow(/too many attachments/);
        await expect(fetchAttachments(relay, [{ filename: 'no-asset.txt' }], {}))
            .rejects.toThrow(/assetId/);
    });

    test('email.send wires attachments through to the provider layer', async () => {
        const relay = makeRelay();
        const sent = [];
        const spy = jest.spyOn(emailProvider, 'send').mockImplementation(async (_cfg, p) => {
            sent.push(p);
            return { success: true, messageId: 'm1', provider: 'mock' };
        });
        try {
            const M = createLogic(makeFakeRedis(), { serviceName: 'gateway', config, logger: silentLogger, relay });
            await M.email.send({
                to: 'a@example.com', subject: 'S', content: 'c',
                attachments: [{ assetId: 'asset-1', filename: 'report.bin' }],
            });
        } finally {
            spy.mockRestore();
        }
        expect(sent[0].attachments).toHaveLength(1);
        expect(sent[0].attachments[0].filename).toBe('report.bin');
        expect(Buffer.isBuffer(sent[0].attachments[0].content)).toBe(true);
    });

    test('without a relay, attachments are refused with an actionable -32602 (no retry storm)', async () => {
        const M = createLogic(makeFakeRedis(), { serviceName: 'gateway', config, logger: silentLogger });
        await expect(M.email.send({
            to: 'a@example.com', subject: 'S', content: 'c',
            attachments: [{ assetId: 'asset-1' }],
        })).rejects.toMatchObject({ code: -32602, message: /system\.gateway|RELAY:TOKEN:gateway/ });
    });

    test('the resend API adapter carries attachments as base64', () => {
        const body = JSON.parse(emailProvider.API_PROVIDERS.resend.body(
            { from: 'x@example.com', api: { key: 'k' } },
            {
                to: 'a@example.com', subject: 'S', content: 'c',
                attachments: [{ filename: 'f.bin', content: Buffer.from('bytes!') }],
            }
        ));
        expect(body.attachments).toEqual([{ filename: 'f.bin', content: Buffer.from('bytes!').toString('base64') }]);
    });
});

// ─── G12: channel probes ──────────────────────────────────────────────────────

describe('gateway.channel.test', () => {
    const FROZEN = '2026-07-30T10:00:00Z';
    let fetchCalls;
    const originalFetch = global.fetch;

    beforeEach(() => {
        clock.freeze(FROZEN);
        fetchCalls = [];
    });
    afterEach(() => {
        clock.reset();
        global.fetch = originalFetch;
    });

    const stubFetch = (responder) => {
        global.fetch = jest.fn(async (url, init) => { fetchCalls.push({ url: String(url), init }); return responder(String(url), init); });
    };
    const okJson = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });

    test('mock channels report ok:true with an honest "nothing will be sent" note', async () => {
        const email = await testChannel({ channel: 'email' }, { emailCfg: { channel: 'mock', api: {} }, smsCfg: {} });
        expect(email).toMatchObject({ channel: 'email', resolved: 'mock', supported: true, ok: true });
        expect(email.note).toMatch(/nothing will actually be sent/i);

        const sms = await testChannel({ channel: 'sms' }, { emailCfg: {}, smsCfg: { channel: 'mock' } });
        expect(sms).toMatchObject({ channel: 'sms', resolved: 'mock', ok: true });
    });

    test('resend probe hits GET {origin}/domains with the bearer key — never the send endpoint', async () => {
        stubFetch(() => okJson({ data: [] }));
        const res = await testChannel({ channel: 'email' }, {
            emailCfg: { channel: 'api', api: { key: 're_test', url: 'https://api.resend.com/emails', provider: 'resend' } },
            smsCfg: {},
        });
        expect(res).toMatchObject({ resolved: 'api', ok: true });
        expect(fetchCalls[0].url).toBe('https://api.resend.com/domains');
        expect(fetchCalls[0].init.headers.Authorization).toBe('Bearer re_test');
    });

    test('aliyun probe sends a SIGNED read-only QuerySmsSignList — HTTP 200 + business code still checked', async () => {
        stubFetch(() => okJson({ Code: 'OK' }));
        const cfg = { channel: 'aliyun', aliyun: { accessKeyId: 'LTAI-x', accessKeySecret: 's', endpoint: 'https://dysmsapi.aliyuncs.com' } };
        const res = await testChannel({ channel: 'sms' }, { emailCfg: {}, smsCfg: cfg });
        expect(res).toMatchObject({ resolved: 'aliyun', ok: true });
        expect(fetchCalls[0].url).toContain('https://dysmsapi.aliyuncs.com/?PageIndex=1&PageSize=1');
        expect(fetchCalls[0].init.method).toBe('GET');
        expect(fetchCalls[0].init.headers.Authorization).toMatch(/^ACS3-HMAC-SHA256 /);
        expect(fetchCalls[0].init.headers['x-acs-action']).toBe('QuerySmsSignList');

        stubFetch(() => okJson({ Code: 'InvalidAccessKeyId.NotFound', Message: 'bad key' }));
        const bad = await testChannel({ channel: 'sms' }, { emailCfg: {}, smsCfg: cfg });
        expect(bad.ok).toBe(false);
        expect(bad.error).toMatch(/InvalidAccessKeyId/);
    });

    test('twilio probe reads the account resource with basic auth', async () => {
        stubFetch(() => okJson({ sid: 'AC1' }));
        const res = await testChannel({ channel: 'sms' }, {
            emailCfg: {}, smsCfg: { channel: 'twilio', twilio: { accountSid: 'AC1', authToken: 't' } },
        });
        expect(res).toMatchObject({ resolved: 'twilio', ok: true });
        expect(fetchCalls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1.json');
        expect(fetchCalls[0].init.headers.Authorization).toBe(`Basic ${Buffer.from('AC1:t').toString('base64')}`);
    });

    test('connectivity failures REPORT (ok:false), they never throw; unknown channel throws -32602', async () => {
        stubFetch(() => { throw new Error('getaddrinfo ENOTFOUND'); });
        const res = await testChannel({ channel: 'sms' }, {
            emailCfg: {}, smsCfg: { channel: 'twilio', twilio: { accountSid: 'AC1', authToken: 't' } },
        });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/ENOTFOUND/);

        await expect(testChannel({ channel: 'push' }, { emailCfg: {}, smsCfg: {} }))
            .rejects.toMatchObject({ code: -32602 });
    });

    test('an api provider without a read-only probe is honestly unsupported (no fake success)', async () => {
        const res = await testChannel({ channel: 'email' }, {
            emailCfg: { channel: 'api', api: { key: 'k', url: 'https://mail.example.com/send', provider: 'sendgrid' } },
            smsCfg: {},
        });
        expect(res.supported).toBe(false);
        expect(res.ok).toBe(false);
    });
});
