#!/usr/bin/env node
/**
 * deploy/mock/bootstrap.js
 *
 * Auto-registers the "mock-listener" ingress source in Redis on first run
 * (or recreates it if the API key is missing from keys.env). Saves the
 * one-time API key to deploy/mock/keys.env (gitignored).
 *
 * Safe to run on every dev.sh startup — idempotent when source + key both exist.
 */
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { createClient } = require('../../api/node_modules/redis');

const REDIS_URL   = process.env.REDIS_URL   || 'redis://127.0.0.1:6699';
const SOURCE_NAME  = process.env.SOURCE_NAME  || 'mock-listener';
const HEALTH_URL   = process.env.HEALTH_URL   || `http://localhost:${process.env.MOCK_PORT || 8091}/health`;
// MOCK_KEYS_FILE:e2e harness 用独立 Redis 跑时必须给 per-run 路径——否则这里会把
// dev 栈正在用的 deploy/mock/keys.env 顶掉(key 注册在别的 Redis 里,dev 下次起就废了)。
const KEYS_FILE   = process.env.MOCK_KEYS_FILE || path.join(__dirname, 'keys.env');

// Mirrors api/library/generator.js
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function genBase58(len) {
    const bytes = crypto.randomBytes(len);
    let id = '';
    for (let i = 0; i < len; i++) id += BASE58[bytes[i] % 58];
    return id;
}
function genApiKey()    { return 'ingk_' + crypto.randomBytes(24).toString('hex'); }
function hashApiKey(k)  { return crypto.createHash('sha256').update(k).digest('hex'); }

function readStoredKey() {
    if (!fs.existsSync(KEYS_FILE)) return null;
    for (const line of fs.readFileSync(KEYS_FILE, 'utf8').split('\n')) {
        if (line.startsWith(`SRC_${SOURCE_NAME}=`)) {
            return line.slice(`SRC_${SOURCE_NAME}=`.length).trim() || null;
        }
    }
    return null;
}

function saveKey(apiKey) {
    let content = fs.existsSync(KEYS_FILE) ? fs.readFileSync(KEYS_FILE, 'utf8') : '';
    // Remove any existing line for this source
    content = content.split('\n').filter(l => !l.startsWith(`SRC_${SOURCE_NAME}=`)).join('\n');
    if (content.length > 0 && !content.endsWith('\n')) content += '\n';
    content += `SRC_${SOURCE_NAME}=${apiKey}\n`;
    fs.writeFileSync(KEYS_FILE, content);
}

async function main() {
    const redis = createClient({ url: REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();

    const NAME_KEY = `INGRESS:NAME:${SOURCE_NAME}`;
    const existingId  = await redis.get(NAME_KEY);
    const existingKey = readStoredKey();

    if (existingId && existingKey) {
        console.log(`  [bootstrap] mock-listener already registered (id: ${existingId})`);
        await redis.disconnect();
        return;
    }

    // Clean up stale state if source exists but key is gone
    if (existingId) {
        console.log(`  [bootstrap] source exists but API key missing — recreating`);
        const raw = await redis.get(`INGRESS:SOURCE:${existingId}`);
        if (raw) {
            try {
                const entity = JSON.parse(raw);
                if (entity.keyHash) await redis.del(`INGRESS:KEYHASH:${entity.keyHash}`);
            } catch (_) {}
        }
        await redis.del(`INGRESS:SOURCE:${existingId}`);
        await redis.sRem('INGRESS:SOURCE:INDEX', existingId);
        await redis.del(NAME_KEY);
    }

    // Create fresh source entity directly in Redis (mirrors ingress/logic/source.js create)
    const id     = genBase58(8);
    const apiKey = genApiKey();
    const kh     = hashApiKey(apiKey);
    const now    = Date.now();

    const entity = {
        status:      'ACTIVE',
        name:        SOURCE_NAME,
        keyHash:     kh,
        enabled:     true,
        dedupTtlSec: 86400,
        hitCount:    0,
        dupCount:    0,
        lastFiredAt: null,
        healthUrl:   HEALTH_URL,
        id,
        createdAt:   now,
        updatedAt:   now,
    };

    const multi = redis.multi();
    multi.set(`INGRESS:SOURCE:${id}`, JSON.stringify(entity));
    multi.sAdd('INGRESS:SOURCE:INDEX', id);
    multi.set(NAME_KEY, id);
    multi.set(`INGRESS:KEYHASH:${kh}`, id);
    await multi.exec();

    saveKey(apiKey);

    console.log(`  [bootstrap] created source "${SOURCE_NAME}" (id: ${id})`);
    console.log(`  [bootstrap] API key saved to deploy/mock/keys.env`);

    await redis.disconnect();
}

main().catch(e => {
    console.error('[bootstrap] fatal:', e.message);
    process.exit(1);
});
