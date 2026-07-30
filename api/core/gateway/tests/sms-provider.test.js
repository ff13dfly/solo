/**
 * sms-provider.test.js — the two real SMS providers' WIRE SHAPE (gateway-gaps G1/G2).
 *
 * Why this suite exists: both provider paths were previously untested (the contract suite
 * only exercises the mock channel), and the aliyun path was signed with a scheme Aliyun has
 * never accepted. These tests assert the request Aliyun/Twilio actually receive — signature
 * assembly, business-code classification, positional ContentVariables.
 *
 * Hermetic: `fetch` is stubbed; no network, no credentials, no Redis. The clock is frozen so
 * the signature is deterministic.
 */
process.env.CLOCK_TEST_MODE = 'true';

const crypto = require('crypto');
const clock = require('../../../library/clock');
const sms = require('../logic/sms');
const { signRequest, percentEncode, canonicalQueryString, sha256Hex } = require('../logic/providers/aliyun-sign');

const FROZEN = '2026-07-30T08:15:30.123Z';   // ms are stripped by the signer
const KEY_ID = 'LTAI-test-key-id';
const KEY_SECRET = 'test-key-secret';

let calls;
const originalFetch = global.fetch;

function stubFetch(responder) {
    global.fetch = jest.fn(async (url, init) => {
        calls.push({ url: String(url), init });
        return responder(String(url), init);
    });
}

const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
});

beforeEach(() => {
    calls = [];
    clock.freeze(FROZEN);
});

afterEach(() => {
    clock.reset();
    global.fetch = originalFetch;
});

// ─── aliyun-sign: the algorithm itself ────────────────────────────────────────

describe('aliyun-sign (ACS3-HMAC-SHA256)', () => {
    const base = {
        accessKeyId: KEY_ID,
        accessKeySecret: KEY_SECRET,
        host: 'dysmsapi.aliyuncs.com',
        action: 'SendSms',
        version: '2017-05-25',
        query: { PhoneNumbers: '+8613800138000', SignName: 'Solo', TemplateCode: 'SMS_1', TemplateParam: '{"code":"123456"}' },
        body: '',
        date: FROZEN,
        nonce: 'fixed-nonce-0123456789',
    };

    test('percent-encoding follows RFC 3986 (the five encodeURIComponent leaves alone)', () => {
        expect(percentEncode("a!b'c(d)e*f")).toBe('a%21b%27c%28d%29e%2Af');
        expect(percentEncode('a b+c/d=e&f')).toBe('a%20b%2Bc%2Fd%3De%26f');
        expect(percentEncode('~-_.')).toBe('~-_.');       // unreserved, must NOT be escaped
        expect(percentEncode('中文')).toBe('%E4%B8%AD%E6%96%87');
    });

    test('canonical query string is key-sorted and encoded', () => {
        expect(canonicalQueryString({ b: '2', a: '1', c: undefined })).toBe('a=1&b=2');
        expect(canonicalQueryString({ TemplateParam: '{"code":"1"}' }))
            .toBe('TemplateParam=%7B%22code%22%3A%221%22%7D');
    });

    test('canonical request has the documented 6 lines, sorted signed headers, empty-body hash', () => {
        const r = signRequest(base);
        const lines = r.canonicalRequest.split('\n');

        // METHOD, URI, QS, then 6 header lines (canonicalHeaders ends with \n → blank line), SignedHeaders, payload hash
        expect(lines[0]).toBe('POST');
        expect(lines[1]).toBe('/');
        expect(lines[2]).toBe('PhoneNumbers=%2B8613800138000&SignName=Solo&TemplateCode=SMS_1&TemplateParam=%7B%22code%22%3A%22123456%22%7D');

        const headerLines = lines.slice(3, 9);
        expect(headerLines).toEqual([
            'host:dysmsapi.aliyuncs.com',
            'x-acs-action:SendSms',
            `x-acs-content-sha256:${sha256Hex('')}`,
            'x-acs-date:2026-07-30T08:15:30Z',            // ms stripped, second precision
            'x-acs-signature-nonce:fixed-nonce-0123456789',
            'x-acs-version:2017-05-25',
        ]);
        expect(lines[9]).toBe('');                         // trailing \n of canonicalHeaders
        expect(lines[10]).toBe('host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version');
        expect(lines[11]).toBe(sha256Hex(''));             // e3b0c442… for the empty body
    });

    test('signature = HMAC-SHA256(secret, "ALG\\n" + sha256(canonicalRequest)) — recomputed independently', () => {
        const r = signRequest(base);
        expect(r.stringToSign).toBe(`ACS3-HMAC-SHA256\n${sha256Hex(r.canonicalRequest)}`);

        const expected = crypto.createHmac('sha256', KEY_SECRET).update(r.stringToSign).digest('hex');
        expect(r.signature).toBe(expected);
        expect(r.headers.Authorization).toBe(
            `ACS3-HMAC-SHA256 Credential=${KEY_ID},` +
            `SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,` +
            `Signature=${expected}`
        );
    });

    test('signature is stable for identical input and changes with any input change', () => {
        const a = signRequest(base).signature;
        expect(signRequest(base).signature).toBe(a);                                    // deterministic
        expect(signRequest({ ...base, nonce: 'other-nonce' }).signature).not.toBe(a);   // nonce is signed
        expect(signRequest({ ...base, date: '2026-07-30T08:15:31Z' }).signature).not.toBe(a);
        expect(signRequest({ ...base, query: { ...base.query, PhoneNumbers: '+8613800138001' } }).signature).not.toBe(a);
        expect(signRequest({ ...base, accessKeySecret: 'other' }).signature).not.toBe(a);
    });

    test('a non-empty body is hashed into the request (JSON-body APIs)', () => {
        const r = signRequest({ ...base, body: '{"x":1}' });
        expect(r.headers['x-acs-content-sha256']).toBe(sha256Hex('{"x":1}'));
        expect(r.canonicalRequest.endsWith(sha256Hex('{"x":1}'))).toBe(true);
    });

    test('missing credentials fail fast (never sign with an empty secret)', () => {
        expect(() => signRequest({ ...base, accessKeyId: '' })).toThrow(/accessKeyId and accessKeySecret/);
        expect(() => signRequest({ ...base, accessKeySecret: '' })).toThrow(/accessKeyId and accessKeySecret/);
    });
});

// ─── aliyun channel: request + response classification ────────────────────────

describe('sms.send → aliyun channel', () => {
    const cfg = {
        channel: 'aliyun',
        aliyun: { accessKeyId: KEY_ID, accessKeySecret: KEY_SECRET, signName: 'Solo', endpoint: 'https://dysmsapi.aliyuncs.com' },
    };
    const params = { phone: '13800138000', templateCode: 'SMS_123', variables: { code: '654321' } };

    test('signs the request: ACS3 Authorization + x-acs-* headers + params in the query string', async () => {
        stubFetch(() => jsonResponse(200, { Code: 'OK', Message: 'OK', BizId: 'biz-1', RequestId: 'req-1' }));

        const res = await sms.send(cfg, params);
        expect(res).toEqual({ success: true, messageId: 'biz-1', provider: 'aliyun' });

        expect(calls).toHaveLength(1);
        const { url, init } = calls[0];
        expect(url).toContain('https://dysmsapi.aliyuncs.com/?');
        expect(url).toContain('PhoneNumbers=13800138000');
        expect(url).toContain('TemplateCode=SMS_123');
        expect(url).toContain('TemplateParam=%7B%22code%22%3A%22654321%22%7D');
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toMatch(/^ACS3-HMAC-SHA256 Credential=LTAI-test-key-id,SignedHeaders=host;/);
        expect(init.headers['x-acs-action']).toBe('SendSms');
        expect(init.headers['x-acs-version']).toBe('2017-05-25');
        expect(init.headers['x-acs-date']).toBe('2026-07-30T08:15:30Z');
        expect(init.headers['x-acs-content-sha256']).toBe(sha256Hex(''));
        // The dead scheme must be gone.
        expect(init.headers.Authorization).not.toContain('AccessKeyId ');
    });

    test('HTTP 200 with a business Code ≠ OK is a FAILURE (was silently reported as sent)', async () => {
        stubFetch(() => jsonResponse(200, { Code: 'isv.SMS_SIGNATURE_ILLEGAL', Message: '签名不合法', RequestId: 'r' }));

        await expect(sms.send(cfg, params)).rejects.toMatchObject({
            providerCode: 'isv.SMS_SIGNATURE_ILLEGAL',
            httpStatus: 400,          // permanent → notification dead-letters instead of retrying
        });
    });

    test('throttling codes stay RETRYABLE (no httpStatus → temporary)', async () => {
        stubFetch(() => jsonResponse(200, { Code: 'isv.BUSINESS_LIMIT_CONTROL', Message: 'flow control', RequestId: 'r' }));

        const err = await sms.send(cfg, params).catch((e) => e);
        expect(err.providerCode).toBe('isv.BUSINESS_LIMIT_CONTROL');
        expect(err.httpStatus).toBeUndefined();
    });

    test('transport-level 4xx carries httpStatus through', async () => {
        stubFetch(() => ({ ok: false, status: 403, text: async () => 'Forbidden', json: async () => ({}) }));
        await expect(sms.send(cfg, params)).rejects.toMatchObject({ httpStatus: 403 });
    });

    test('unparseable 200 body is a failure, not a success', async () => {
        stubFetch(() => ({ ok: true, status: 200, text: async () => 'not json', json: async () => ({}) }));
        await expect(sms.send(cfg, params)).rejects.toThrow(/unparseable response/);
    });
});

// ─── twilio channel: positional content variables ─────────────────────────────

describe('sms.send → twilio channel', () => {
    const cfg = { channel: 'twilio', twilio: { accountSid: 'AC123', authToken: 'tok', from: '+15550000000' } };

    test('variableOrder maps named vars onto Twilio positional keys {"1":…}', async () => {
        stubFetch(() => jsonResponse(201, { sid: 'SM123' }));

        const res = await sms.send(cfg, {
            phone: '+15551234567',
            templateCode: 'HX_content_sid',
            variables: { code: '999111', ttl: 5 },
            variableOrder: ['code', 'ttl'],
        });
        expect(res).toEqual({ success: true, messageId: 'SM123', provider: 'twilio' });

        const body = new URLSearchParams(calls[0].init.body);
        expect(body.get('To')).toBe('+15551234567');
        expect(body.get('From')).toBe('+15550000000');
        expect(body.get('ContentSid')).toBe('HX_content_sid');
        expect(JSON.parse(body.get('ContentVariables'))).toEqual({ '1': '999111', '2': '5' });
        expect(calls[0].init.headers.Authorization).toBe(`Basic ${Buffer.from('AC123:tok').toString('base64')}`);
    });

    test('no variableOrder → named keys pass through unchanged (documented legacy shape)', () => {
        expect(sms.toPositionalVariables({ code: '1' }, undefined)).toEqual({ code: '1' });
        expect(sms.toPositionalVariables({ code: '1' }, [])).toEqual({ code: '1' });
    });

    test('variables absent from the order are dropped, not shifted', () => {
        expect(sms.toPositionalVariables({ a: 'A', c: 'C' }, ['a', 'b', 'c']))
            .toEqual({ '1': 'A', '3': 'C' });
    });

    test('4xx from Twilio carries httpStatus (permanent → DLQ)', async () => {
        stubFetch(() => ({ ok: false, status: 400, text: async () => 'bad template', json: async () => ({}) }));
        await expect(sms.send(cfg, { phone: '+15551234567', templateCode: 'HX', variables: {} }))
            .rejects.toMatchObject({ httpStatus: 400 });
    });
});

// ─── channel resolution ───────────────────────────────────────────────────────

describe('sms.resolveChannel', () => {
    test('explicit channel wins; auto probes credentials; nothing configured → mock', () => {
        expect(sms.resolveChannel({ channel: 'twilio', aliyun: { accessKeyId: 'x' } })).toBe('twilio');
        expect(sms.resolveChannel({ channel: 'auto', aliyun: { accessKeyId: 'x' } })).toBe('aliyun');
        expect(sms.resolveChannel({ channel: 'auto', twilio: { accountSid: 'AC' } })).toBe('twilio');
        expect(sms.resolveChannel({ channel: 'auto' })).toBe('mock');
        expect(sms.resolveChannel({})).toBe('mock');
    });

    test('mock channel never touches the network', async () => {
        global.fetch = jest.fn();
        const res = await sms.send({ channel: 'mock' }, { phone: '13800138000', templateCode: 'SMS_1' });
        expect(res.provider).toBe('mock');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('phone/templateCode are required before any provider work', async () => {
        await expect(sms.send({ channel: 'mock' }, { phone: '', templateCode: 'x' })).rejects.toThrow(/Missing required fields/);
        await expect(sms.send({ channel: 'mock' }, { phone: '138', templateCode: '' })).rejects.toThrow(/Missing required fields/);
    });
});
