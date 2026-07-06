const crypto = require('crypto');

// Lazy-initialized SMTP transporter
let _smtpTransporter = null;

function resolveChannel(cfg) {
    if (cfg.channel && cfg.channel !== 'auto') return cfg.channel;
    if (cfg.api.key) return 'api';
    if (cfg.smtp.host) return 'smtp';
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

async function sendSmtp(cfg, { to, subject, content, html }) {
    const transporter = await getSmtpTransporter(cfg);
    const info = await transporter.sendMail({
        from: cfg.from,
        to,
        subject,
        text: content,
        html: html || content
    });
    return { success: true, messageId: info.messageId, provider: 'smtp' };
}

async function sendApi(cfg, { to, subject, content, html }) {
    const body = JSON.stringify({
        from: cfg.from,
        to: Array.isArray(to) ? to : [to],
        subject,
        text: content,
        html: html || content
    });

    const res = await fetch(cfg.api.url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.api.key}`
        },
        body
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Email API error ${res.status}: ${err}`);
    }

    const data = await res.json().catch(() => ({}));
    return { success: true, messageId: data.id || crypto.randomUUID(), provider: 'api' };
}

async function send(cfg, params) {
    const { to, subject, content, html } = params;
    if (!to || !subject || !content) {
        throw new Error('Missing required fields: to, subject, content');
    }

    const channel = resolveChannel(cfg);

    if (channel === 'smtp') return sendSmtp(cfg, params);
    if (channel === 'api') return sendApi(cfg, params);

    // mock
    const messageId = crypto.randomUUID();
    return { success: true, messageId, provider: 'mock' };
}

module.exports = { send, resolveChannel };
