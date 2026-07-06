/**
 * import-profiles.js — 将导出的 Fulfillment Profile 配置导入 Redis
 *
 * 策略：
 *   - string 类型：SET key value（覆盖写，幂等）
 *   - set 类型：SADD key members（不清空，只追加缺失成员）
 *
 * 用法：
 *   node import-profiles.js [--in <path>] [--redis <url>] [--dry-run]
 *
 * 默认输入：./fulfillment-profiles-export.json
 * --dry-run：只打印不写入
 */

'use strict';

const fs   = require('fs');
const path = require('path');

function requireRedis() {
    const candidates = [
        path.join(__dirname, '../../../node_modules/redis'),
        path.join(__dirname, '../../../../node_modules/redis'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return require(p);
    }
    throw new Error('Cannot find redis module. Run npm install in api/ first.');
}
const Redis = requireRedis();

const args      = process.argv.slice(2);
const getArg    = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };
const IN        = getArg('--in', path.join(__dirname, 'fulfillment-profiles-export.json'));
const REDIS_URL = getArg('--redis', process.env.REDIS_URL || 'redis://localhost:6379');
const DRY_RUN   = args.includes('--dry-run');

(async () => {
    if (!fs.existsSync(IN)) {
        console.error(`❌ Input file not found: ${IN}`);
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(IN, 'utf8'));
    console.log(`📄 Input  : ${IN}`);
    console.log(`🔗 Redis  : ${REDIS_URL}`);
    console.log(`📦 Keys   : ${data.keys.length}`);
    console.log(`📅 Exported at: ${data.meta?.exportedAt || 'unknown'}`);
    if (DRY_RUN) console.log(`🔍 DRY RUN — no writes`);
    console.log('');

    const client = Redis.createClient({ url: REDIS_URL });
    client.on('error', e => console.error('Redis error:', e));
    if (!DRY_RUN) await client.connect();

    let written = 0;
    let skipped = 0;

    try {
        for (const entry of data.keys) {
            const { key, type, value } = entry;

            if (type === 'string') {
                console.log(`  SET  ${key}`);
                if (!DRY_RUN) await client.set(key, value);
                written++;
            } else if (type === 'set') {
                const members = Array.isArray(value) ? value : [];
                if (members.length === 0) { skipped++; continue; }
                console.log(`  SADD ${key}  (${members.length} members)`);
                if (!DRY_RUN) await client.sAdd(key, members);
                written++;
            } else {
                console.log(`  SKIP ${key}  (unsupported type: ${type})`);
                skipped++;
            }
        }

        console.log('');
        if (DRY_RUN) {
            console.log(`✅ Dry run complete — would write ${written} keys, skip ${skipped}`);
        } else {
            console.log(`✅ Done — wrote ${written} keys, skipped ${skipped}`);
        }
    } finally {
        if (!DRY_RUN) await client.quit();
    }
})();
