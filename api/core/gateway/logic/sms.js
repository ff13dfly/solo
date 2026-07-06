const crypto = require('crypto');

function resolveChannel(cfg) {
    if (cfg.channel && cfg.channel !== 'auto') return cfg.channel;
    if (cfg.aliyun && cfg.aliyun.accessKeyId) return 'aliyun';
    if (cfg.twilio && cfg.twilio.accountSid) return 'twilio';
    return 'mock';
}

async function sendAliyun(cfg, { phone, templateCode, variables }) {
    // Aliyun SMS — requires official SDK or signed REST call in production
    const res = await fetch(cfg.aliyun.endpoint || 'https://dysmsapi.aliyuncs.com', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `AccessKeyId ${cfg.aliyun.accessKeyId}`
        },
        body: JSON.stringify({
            PhoneNumbers: phone,
            SignName: cfg.aliyun.signName,
            TemplateCode: templateCode,
            TemplateParam: JSON.stringify(variables || {})
        })
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Aliyun SMS error ${res.status}: ${err}`);
    }

    const data = await res.json().catch(() => ({}));
    return { success: true, messageId: data.RequestId || crypto.randomUUID(), provider: 'aliyun' };
}

async function sendTwilio(cfg, { phone, templateCode, variables }) {
    const sid = cfg.twilio.accountSid;
    const auth = Buffer.from(`${sid}:${cfg.twilio.authToken}`).toString('base64');

    const body = new URLSearchParams({
        To: phone,
        From: cfg.twilio.from,
        ContentSid: templateCode,
        ContentVariables: JSON.stringify(variables || {})
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
        throw new Error(`Twilio SMS error ${res.status}: ${err}`);
    }

    const data = await res.json().catch(() => ({}));
    return { success: true, messageId: data.sid || crypto.randomUUID(), provider: 'twilio' };
}

async function send(cfg, { phone, templateCode, variables }) {
    if (!phone || !templateCode) throw new Error('Missing required fields: phone, templateCode');

    const channel = resolveChannel(cfg);
    if (channel === 'aliyun') return sendAliyun(cfg, { phone, templateCode, variables });
    if (channel === 'twilio') return sendTwilio(cfg, { phone, templateCode, variables });

    return { success: true, messageId: crypto.randomUUID(), provider: 'mock' };
}

module.exports = { send, resolveChannel };
