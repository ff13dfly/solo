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

async function getTransporter(config, cacheKey) {
    if (cacheKey && _transporters.has(cacheKey)) return _transporters.get(cacheKey);
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.pass }
    });
    await transporter.verify();
    if (cacheKey) _transporters.set(cacheKey, transporter);
    return transporter;
}

module.exports = { createSmtpEntity, getTransporter };
