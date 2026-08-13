/**
 * 模块 33: 内存击穿预警 (Pagination Safety Check)
 * 检测目标：检查 logic 目录中是否存在滥用 sMembers / hGetAll / zRange(0,-1) / KEYS
 *          获取全量集合的反模式。
 *
 * @why `redis.keys()` 是后加的（此前正则只认 sMembers|hGetAll|zRange 0 -1）：消费项目
 *      在 list 方法里写 `redis.keys('PREFIX:*')` 时门禁一声不吭放行，而它比前三者更糟——
 *      前三者只是把一个索引拉进 V8（内存问题），KEYS 是让 Redis 的**单线程**遍历整个
 *      keyspace（全栈停顿，所有服务一起卡），而且 key 数远大于单个索引的成员数。
 *      合法用法只有一种：boot 期一次性重建索引（见 core/orchestrator/logic/run.js
 *      的 rebuildIndex），那种场景加 `// SAFE:` 并写明理由。
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    // 优先扫 <servicePath>/logic/*.js（服务标准布局）；没有 logic/ 子目录时退化为
    // 直接扫 servicePath 自身（api/library 这种扁平库目录）——entity.js 的全量拉取
    // 反模式曾在 api/library 潜伏一整个版本没被这条规则抓到，根因就是这里此前只认
    // logic/ 子目录，checker.js 也从没被指向过 api/library。
    const logicPath = path.join(servicePath, 'logic');
    const scanDir = fs.existsSync(logicPath) ? logicPath : servicePath;
    if (!fs.existsSync(scanDir)) return;

    const files = fs.readdirSync(scanDir).filter(f => f.endsWith('.js'));
    const PATTERN = /redis\.(sMembers|hGetAll|keys)\s*\(|redis\.zRange\s*\([^,]+,\s*0\s*,\s*-1/g;
    const relPrefix = scanDir === logicPath ? 'logic/' : '';

    // KEYS 的危害与另外三个不同（阻塞 Redis 单线程遍历全 keyspace，不只是撑爆 V8），
    // 建议也不同（要的是索引，不是"改成 SCAN 分页"——SCAN 同样要遍历全 keyspace）。
    const adviceFor = (method) => method === 'keys'
        ? '`KEYS` 会让 Redis 单线程遍历整个 keyspace，期间所有服务的请求一起排队——'
          + '数据少时看不出来，上线几个月后突然拖垮全栈。改成维护一个 SET/ZSET 索引'
          + '（`library/entity.js` 的 Entity Factory 已经替你维护好了，直接用它的 `list({limit, cursor})`）。'
          + '只在 boot 期一次性重建索引时可用——那种场景在此行加 `// SAFE: boot-only，非热路径` 并写明理由。'
        : `如果数据量过大可能会撑爆 V8 内存，建议改用 \`Scan\` 分页拉取，或在此行添加 \`// SAFE: small\` 豁免。`;

    files.forEach(file => {
        const filePath = path.join(scanDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        lines.forEach((line, i) => {
            if (line.includes('// SAFE:')) return; // 豁免注释
            if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;

            let m;
            PATTERN.lastIndex = 0;
            while ((m = PATTERN.exec(line)) !== null) {
                const method = m[0].split('.')[1].split('(')[0].trim();
                results.warnings.push(
                    `⚠️ [内存-安全] ${relPrefix}${file}:${i + 1}: 发现全量拉取方法 \`${method}\`。${adviceFor(method)}`
                );
            }
        });
    });
}

module.exports = { check };
