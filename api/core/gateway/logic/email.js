/**
 * Email channels — SMTP (nodemailer) · HTTP API · mock.
 *
 * @attention The HTTP API path speaks ONE body shape: **Resend-compatible**
 *   `{from, to, cc, bcc, reply_to, subject, text, html}` (config default URL
 *   https://api.resend.com/emails). SendGrid (`personalizations`) and SES (its own
 *   Action + SigV4) do NOT accept this shape — pointing EMAIL_API_URL at them yields
 *   a 4xx. Adding one means adding an adapter to `API_PROVIDERS` below, not just a URL.
 */
const crypto = require('crypto');

// Lazy-initialized SMTP transporter
let _smtpTransporter = null;

function resolveChannel(cfg) {
    if (cfg.channel && cfg.channel !== 'auto') return cfg.channel;
    if (cfg.api && cfg.api.key) return 'api';
    if (cfg.smtp && cfg.smtp.host) return 'smtp';
    return 'mock';
}

async function getSmtpTransporter(cfg) {
    if (_smtpTransporter) return _smtpTransporter;
    const nodemailer = require('nodemailer');
    _smtpTransporter = nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.secure,
        auth: { user: cfg.smtp.user, pass: cfg.smtp.pass }
    });
    await _smtpTransporter.verify();
    return _smtpTransporter;
}

async function sendSmtp(cfg, { to, cc, bcc, replyTo, subject, content, html }) {
    const transporter = await getSmtpTransporter(cfg);
    const info = await transporter.sendMail({
        from: cfg.from,
        to,
        ...(cc ? { cc } : {}),
        ...(bcc ? { bcc } : {}),
        ...(replyTo ? { replyTo } : {}),
        subject,
        text: content,
        html: html || content
    });
    return { success: true, messageId: info.messageId, provider: 'smtp' };
}

// --- HTTP API providers (body-shape adapters) ---------------------------------
// One entry per provider wire format. `resend` is the only shipped adapter; the map
// exists so adding SendGrid/SES is a local change with a real name, instead of the
// silent "any URL will do" the previous single-shape code implied.
const asList = (v) => (v === undefined || v === null ? undefined : (Array.isArray(v) ? v : [v]));

const API_PROVIDERS = {
    resend: {
        // https://resend.com/docs/api-reference/emails/send-email
        body: (cfg, { to, cc, bcc, replyTo, subject, content, html }) => JSON.stringify({
            from: cfg.from,
            to: asList(to),
            ...(cc ? { cc: asList(cc) } : {}),
            ...(bcc ? { bcc: asList(bcc) } : {}),
            ...(replyTo ? { reply_to: asList(replyTo) } : {}),
            subject,
            text: content,
            html: html || content
        }),
        headers: (cfg) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api.key}` }),
        messageId: (data) => data.id,
    },
};

async function sendApi(cfg, params) {
    const name = cfg.api.provider || 'resend';
    const provider = API_PROVIDERS[name];
    if (!provider) {
        throw new Error(
            `Email API provider '${name}' has no adapter (shipped: ${Object.keys(API_PROVIDERS).join(', ')}). ` +
            `Add one to logic/email.js API_PROVIDERS — changing EMAIL_API_URL alone is not enough.`
        );
    }

    const res = await fetch(cfg.api.url, {
        method: 'POST',
        headers: provider.headers(cfg),
        body: provider.body(cfg, params)
    });

    if (!res.ok) {
        const err = await res.text();
        const e = new Error(`Email API error ${res.status}: ${err}`);
        e.httpStatus = res.status;   // 4xx → notification treats it as permanent (no retry storm)
        throw e;
    }

    const data = await res.json().catch(() => ({}));
    return { success: true, messageId: provider.messageId(data) || crypto.randomUUID(), provider: 'api' };
}

async function send(cfg, params) {
    const { to, subject, content } = params;
    if (!to || !subject || !content) {
        throw new Error('Missing required fields: to, subject, content');
    }

    const channel = resolveChannel(cfg);

    if (channel === 'smtp') return sendSmtp(cfg, params);
    if (channel === 'api') return sendApi(cfg, params);

    // mock — NOTHING left the system. Callers must check provider !== 'mock'.
    const messageId = crypto.randomUUID();
    return { success: true, messageId, provider: 'mock' };
}

module.exports = { send, resolveChannel, API_PROVIDERS };
