const EntityFactory = require('../../../library/entity');
const { deriveKey, encrypt, decrypt } = require('../../../library/crypto');

const SALT = 'solo-gateway-smtp-v1';
let _encKey = null;

async function getEncKey() {
    if (_encKey) return _encKey;
    const secret = process.env.GATEWAY_SECRET_KEY;
    if (!secret) throw new Error('GATEWAY_SECRET_KEY is not set');
    _encKey = await deriveKey(secret, SALT);
    return _encKey;
}

// Per-account transporter cache
const _transporters = new Map();

function createSmtpEntity(redis) {
    const entity = EntityFactory(redis, {
        serviceName: 'gateway',
        entityName: 'smtp',
        sensitiveFields: ['pass']
    });

    async function encryptPass(params) {
        if (!params.pass) return params;
        const key = await getEncKey();
        return { ...params, pass: encrypt(params.pass, key) };
    }

    async function decryptItem(item) {
        if (!item || !item.pass) return item;
        const key = await getEncKey();
        return { ...item, pass: decrypt(item.pass, key) };
    }

    function stripPass(item) {
        if (!item) return item;
        const { pass, ...rest } = item;
        return rest;
    }

    return {
        async create(params) {
            const data = await encryptPass(params);
            return stripPass(await entity.create(data));
        },
        async get({ id }) {
            const item = await entity.get({ id });
            return stripPass(item);
        },
        async list(params) {
            const result = await entity.list(params);
            result.items = result.items.map(stripPass);
            return result;
        },
        async update({ id, ...updates }) {
            _transporters.delete(id); // Invalidate cached transporter
            const data = await encryptPass(updates);
            return stripPass(await entity.update({ id, ...data }));
        },
        async delete({ id }) {
            _transporters.delete(id);
            return entity.delete({ id });
        },
        // Internal: returns full config with decrypted pass for building transporter
        async getDecrypted(id) {
            const item = await entity.get({ id });
            return decryptItem(item);
        }
    };
}

/**
 * 把一份 SMTP 配置（`gateway.smtp` 实体记录，或 `config.email.smtp`）翻成 nodemailer
 * 的 transport options。两条建 transporter 的路径（本文件的实体路、logic/email.js 的
 * env 路）共用这一个函数，免得合并规则各写一遍、日后只改到一边。
 *
 * 合并规则：**`options` 先铺底，显式字段后盖** —— 所以 options 里即便写了 host/port/auth
 * 也劫持不了连接目标与凭据。它能提供的是 nodemailer 的其余开关，典型如：
 *   - `requireTLS: true`      —— 强制 587 必须升 STARTTLS，不允许明文回落
 *   - `tls: { rejectUnauthorized, servername, ciphers }` —— 自签/老 cipher 的服务器
 *   - `pool`, `maxConnections`, `rateDelta`, `rateLimit` —— 各家限速不同
 *   - `name`                  —— EHLO 用的主机名，少数服务器会校验
 *   - `connectionTimeout`, `greetingTimeout`, `socketTimeout`
 *
 * ⚠️ 为什么是"透传"而不是"每家邮箱一个 adapter"（与本文件同层的 logic/email.js
 *    `API_PROVIDERS` 刻意相反）：**SMTP 是 RFC 5321 标准协议**，Gmail / 163 / QQ /
 *    Outlook / SES-SMTP 说的是同一套话，换一家只是换 host/port/secure，属于**配置**、
 *    不该落进代码；而 HTTP API 那边每家 body 形状根本不兼容（Resend 的 `{to,subject}`
 *    vs SendGrid 的 `personalizations` vs SES 的 SigV4），那才非分 adapter 不可。
 *    厂商之间真正过不去的只有**认证方式**：Gmail 要应用专用密码、163/QQ 要授权码——
 *    这两种仍只是往 `pass` 里填不同来源的字符串，配置能解决；只有 Outlook/M365 的
 *    OAuth2 需要换掉 `auth` 的形状，那是单独一档，不在本函数职责内。
 */
function buildTransportOptions(cfg) {
    const extra = (cfg.options && typeof cfg.options === 'object' && !Array.isArray(cfg.options))
        ? cfg.options
        : {};
    return {
        ...extra,
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { user: cfg.user, pass: cfg.pass }
    };
}

async function getTransporter(config, cacheKey) {
    if (cacheKey && _transporters.has(cacheKey)) return _transporters.get(cacheKey);
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport(buildTransportOptions(config));
    await transporter.verify();
    if (cacheKey) _transporters.set(cacheKey, transporter);
    return transporter;
}

module.exports = { createSmtpEntity, getTransporter, buildTransportOptions };
