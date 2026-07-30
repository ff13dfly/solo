/**
 * Channel probes — "are the credentials wired?" without sending anything (gateway-gaps G12).
 *
 * Before this, the only probe was gateway.smtp.test (per stored account); the env-level
 * email api channel and both SMS providers could only be verified by actually sending a
 * message (SMS costs money per attempt). Each probe hits a READ-ONLY provider endpoint:
 *
 *   email/smtp   → nodemailer transporter.verify() (EHLO+auth, no mail)
 *   email/api    → resend: GET {origin}/domains       (auth check, no send)
 *   sms/aliyun   → signed QuerySmsSignList page 1     (validates the ACS3 signature+creds)
 *   sms/twilio   → GET /Accounts/{sid}.json           (basic-auth check)
 *   mock (both)  → ok:true + a note that NOTHING will actually be sent
 *
 * Contract: connectivity/credential failures return { ok:false, error } — a probe reports,
 * it never throws. Only an invalid `channel` param throws (-32602). Providers with no
 * read-only endpoint honestly return supported:false rather than a fake success.
 */
const clock = require('../../../library/clock');
const jsonrpc = require('../../../library/jsonrpc');
const emailProvider = require('./email');
const smsProvider = require('./sms');
const { signRequest } = require('./providers/aliyun-sign');

const ok = (channel, resolved, extra = {}) => ({ channel, resolved, supported: true, ok: true, ...extra });
const fail = (channel, resolved, error, extra = {}) => ({
    channel, resolved, supported: true, ok: false, error: String(error).slice(0, 300), ...extra,
});

async function probeEmail(emailCfg) {
    const resolved = emailProvider.resolveChannel(emailCfg);

    if (resolved === 'mock') {
        return ok('email', 'mock', { note: 'mock channel — nothing will actually be sent (no credentials configured)' });
    }
    if (resolved === 'smtp') {
        try {
            await emailProvider.getSmtpTransporter(emailCfg);   // verify() inside
            return ok('email', 'smtp');
        } catch (e) { return fail('email', 'smtp', e.message); }
    }
    // api channel — probe endpoint is provider-specific.
    const providerName = emailCfg.api.provider || 'resend';
    if (providerName !== 'resend') {
        return { channel: 'email', resolved: 'api', supported: false, ok: false, error: `no read-only probe for api provider '${providerName}'` };
    }
    try {
        const origin = new URL(emailCfg.api.url).origin;
        const res = await fetch(`${origin}/domains`, {
            headers: { Authorization: `Bearer ${emailCfg.api.key}` },
        });
        if (!res.ok) return fail('email', 'api', `HTTP ${res.status} from ${origin}/domains (bad key?)`);
        return ok('email', 'api');
    } catch (e) { return fail('email', 'api', e.message); }
}

async function probeSms(smsCfg) {
    const resolved = smsProvider.resolveChannel(smsCfg);

    if (resolved === 'mock') {
        return ok('sms', 'mock', { note: 'mock channel — nothing will actually be sent (no credentials configured)' });
    }
    if (resolved === 'aliyun') {
        const a = smsCfg.aliyun || {};
        try {
            const endpoint = a.endpoint || 'https://dysmsapi.aliyuncs.com';
            const host = new URL(endpoint).host;
            const { headers, query } = signRequest({
                accessKeyId: a.accessKeyId,
                accessKeySecret: a.accessKeySecret,
                host,
                action: 'QuerySmsSignList',
                version: '2017-05-25',
                query: { PageIndex: '1', PageSize: '1' },
                body: '',
                method: 'GET',
                date: clock.now(),
            });
            const res = await fetch(`${endpoint.replace(/\/$/, '')}/?${query}`, { method: 'GET', headers: { ...headers, Accept: 'application/json' } });
            const text = await res.text();
            if (!res.ok) return fail('sms', 'aliyun', `HTTP ${res.status}: ${text.slice(0, 200)}`);
            let data = {};
            try { data = JSON.parse(text); } catch (_) { /* fall through */ }
            if (data.Code && data.Code !== 'OK') return fail('sms', 'aliyun', `${data.Code} ${data.Message || ''}`);
            return ok('sms', 'aliyun');
        } catch (e) { return fail('sms', 'aliyun', e.message); }
    }
    // twilio
    const t = smsCfg.twilio || {};
    try {
        const auth = Buffer.from(`${t.accountSid}:${t.authToken}`).toString('base64');
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}.json`, {
            headers: { Authorization: `Basic ${auth}` },
        });
        if (!res.ok) return fail('sms', 'twilio', `HTTP ${res.status} (bad sid/token?)`);
        return ok('sms', 'twilio');
    } catch (e) { return fail('sms', 'twilio', e.message); }
}

async function testChannel({ channel } = {}, { emailCfg, smsCfg }) {
    if (channel === 'email') return probeEmail(emailCfg);
    if (channel === 'sms') return probeSms(smsCfg);
    throw jsonrpc.INVALID_PARAMS(`channel must be 'email' or 'sms', got '${channel}'`);
}

module.exports = { testChannel };
