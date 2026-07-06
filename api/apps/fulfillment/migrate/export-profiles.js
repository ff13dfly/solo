/**
 * export-profiles.js — 导出本地 Redis 中的 Fulfillment Profile 配置
 *
 * 导出范围：
 *   FULFILLMENT:PROFILE:INDEX   Profile ID 索引（Set）
 *   FULFILLMENT:PROFILE:*       Profile 记录（string，含软删除条目）
 *
 * 不导出：
 *   FULFILLMENT:INSTANCE:*      履约实例为运行时数据，不随配置迁移
 *
 * 用法：
 *   node export-profiles.js [--out <path>] [--redis <url>]
 *
 * 默认输出：./fulfillment-profiles-export.json
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
const OUT       = getArg('--out', path.join(__dirname, 'fulfillment-profiles-export.json'));
const REDIS_URL = getArg('--redis', process.env.REDIS_URL || 'redis://localhost:6379');

const PREFIXES = [
    'FULFILLMENT:PROFILE:',
];

(async () => {
    console.log(`🔗 Redis  : ${REDIS_URL}`);
    console.log(`📄 Output : ${OUT}`);

    const client = Redis.createClient({ url: REDIS_URL });
    client.on('error', e => console.error('Redis error:', e));
    await client.connect();

    const exported = { meta: { exportedAt: new Date().toISOString(), source: REDIS_URL }, keys: [] };

    try {
        for (const prefix of PREFIXES) {
            console.log(`\n🔍 Scanning ${prefix}* ...`);
            let cursor = '0';
            let count  = 0;

            do {
                const reply = await client.sendCommand(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '200']);
                cursor = reply[0];
                const keys = reply[1];

                for (const key of keys) {
                    const type = await client.type(key);

                    if (type === 'string') {
                        const value = await client.get(key);
                        exported.keys.push({ key, type: 'string', value });
                        count++;
                    } else if (type === 'set') {
                        const members = await client.sMembers(key);
                        exported.keys.push({ key, type: 'set', value: members });
                        count++;
                    }
                }
            } while (cursor !== '0');

            console.log(`   ✅ ${count} keys`);
        }

        fs.writeFileSync(OUT, JSON.stringify(exported, null, 2), 'utf8');
        const size  = fs.statSync(OUT).size;
        const total = exported.keys.length;
        console.log(`\n✅ Done — ${total} keys → ${OUT} (${(size / 1024).toFixed(1)} KB)`);

        // Summary
        const index    = exported.keys.find(k => k.key === 'FULFILLMENT:PROFILE:INDEX');
        const profiles = exported.keys.filter(k => k.key.startsWith('FULFILLMENT:PROFILE:') && k.type === 'string');
        console.log(`   Index entries : ${index ? index.value.length : 0}`);
        console.log(`   Profile keys  : ${profiles.length}`);
        profiles.forEach(p => {
            try {
                const obj = JSON.parse(p.value);
                console.log(`   → [${obj.status || '?'}] ${p.key}  name=${obj.name || '?'}`);
            } catch (_) {}
        });

    } finally {
        await client.quit();
    }
})();
