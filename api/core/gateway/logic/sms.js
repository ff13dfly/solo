/**
 * SMS channels — Aliyun · Twilio · mock.
 *
 * Template-only by design: carriers reject free text, so `templateCode` must be a
 * provider-side PRE-APPROVED template id (Aliyun TemplateCode / Twilio Content SID).
 *
 * @attention Error classification matters here. A 4xx (or a permanent business code)
 *   gets `httpStatus` attached so the notification worker dead-letters it instead of
 *   retrying 5× against a template the carrier will never accept; throttling codes are
 *   deliberately left un-classified (= temporary) so the retry/backoff path handles them.
 */
const crypto = require('crypto');
const clock = require('../../../library/clock');
const { signRequest } = require('./providers/aliyun-sign');

const ALIYUN_API_VERSION = '2017-05-25';   // Dysmsapi
const ALIYUN_DEFAULT_HOST = 'dysmsapi.aliyuncs.com';

// Aliyun answers HTTP 200 with a business Code. These mean "try again later" — everything
// else non-OK is a configuration/content problem that retries cannot fix.
const ALIYUN_RETRYABLE_CODES = new Set([
    'isv.BUSINESS_LIMIT_CONTROL',        // per-recipient flow control
    'isv.SMS_TEMPLATE_ILLEGAL_QUEUE',    // template still under review
    'SystemError',
    'ServiceUnavailable',
    'Throttling',
    'Throttling.User',
    'Throttling.Api',
]);

function resolveChannel(cfg) {
    if (cfg.channel && cfg.channel !== 'auto') return cfg.channel;
    if (cfg.aliyun && cfg.aliyun.accessKeyId) return 'aliyun';
    if (cfg.twilio && cfg.twilio.accountSid) return 'twilio';
    return 'mock';
}

/**
 * Map named variables onto the positional keys Twilio's Content API expects:
 * ContentVariables is `{"1":"…","2":"…"}`, NOT `{"code":"…"}` — the template entity
 * declares the order via `variableOrder`.
 */
function toPositionalVariables(variables = {}, variableOrder) {
    if (!Array.isArray(variableOrder) || variableOrder.length === 0) return variables;
    const out = {};
    variableOrder.forEach((name, i) => {
        const v = variables[name];
        if (v !== undefined && v !== null) out[String(i + 1)] = String(v);
    });
    return out;
}

async function sendAliyun(cfg, { phone, templateCode, variables }) {
    const a = cfg.aliyun || {};
    const endpoint = a.endpoint || `https://${ALIYUN_DEFAULT_HOST}`;
    const host = new URL(endpoint).host;

    // RPC-style call: parameters ride in the query string, body is empty.
    const query = {
        PhoneNumbers: phone,
        SignName: a.signName,
        TemplateCode: templateCode,
        TemplateParam: JSON.stringify(variables || {}),
    };

    const { headers, query: qs } = signRequest({
        accessKeyId: a.accessKeyId,
        accessKeySecret: a.accessKeySecret,
        host,
        action: 'SendSms',
        version: ALIYUN_API_VERSION,
        query,
        body: '',
        method: 'POST',
        date: clock.now(),
    });

    const res = await fetch(`${endpoint.replace(/\/$/, '')}/?${qs}`, {
        method: 'POST',
        headers: { ...headers, Accept: 'application/json' },
    });

    const text = await res.text();
    if (!res.ok) {
        const err = new Error(`Aliyun SMS error ${res.status}: ${text}`);
        err.httpStatus = res.status;
        throw err;
    }

    // HTTP 200 does NOT mean sent — Aliyun reports business failures in `Code`.
    let data = {};
    try { data = JSON.parse(text); } catch (_) { /* keep {} → treated as non-OK below */ }

    if (data.Code !== 'OK') {
        const err = new Error(`Aliyun SMS rejected: ${data.Code || 'unparseable response'} ${data.Message || text.slice(0, 200)}`);
        err.providerCode = data.Code;
        if (!ALIYUN_RETRYABLE_CODES.has(data.Code)) err.httpStatus = 400;   // permanent → DLQ, no retry storm
        throw err;
    }

    return { success: true, messageId: data.BizId || data.RequestId || crypto.randomUUID(), provider: 'aliyun' };
}

async function sendTwilio(cfg, { phone, templateCode, variables, variableOrder }) {
    const sid = cfg.twilio.accountSid;
    const auth = Buffer.from(`${sid}:${cfg.twilio.authToken}`).toString('base64');

    const body = new URLSearchParams({
        To: phone,
        From: cfg.twilio.from,
        ContentSid: templateCode,
        ContentVariables: JSON.stringify(toPositionalVariables(variables, variableOrder)),
    });

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${auth}`
        },
        body: body.toString()
    });

    if (!res.ok) {
        const err = await res.text();
        const e = new Error(`Twilio SMS error ${res.status}: ${err}`);
        e.httpStatus = res.status;
        throw e;
    }

    const data = await res.json().catch(() => ({}));
    return { success: true, messageId: data.sid || crypto.randomUUID(), provider: 'twilio' };
}

async function send(cfg, { phone, templateCode, variables, variableOrder }) {
    if (!phone || !templateCode) throw new Error('Missing required fields: phone, templateCode');

    const channel = resolveChannel(cfg);
    if (channel === 'aliyun') return sendAliyun(cfg, { phone, templateCode, variables });
    if (channel === 'twilio') return sendTwilio(cfg, { phone, templateCode, variables, variableOrder });

    // mock — NOTHING left the system. Callers must check provider !== 'mock'.
    return { success: true, messageId: crypto.randomUUID(), provider: 'mock' };
}

module.exports = { send, resolveChannel, toPositionalVariables, ALIYUN_RETRYABLE_CODES };
