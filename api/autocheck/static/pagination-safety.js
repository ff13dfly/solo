/**
 * 模块 33: 内存击穿预警 (Pagination Safety Check)
 * 检测目标：检查 logic 目录中是否存在滥用 sMembers 或 zRange 获取全量集合的反模式。
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
    const PATTERN = /redis\.(sMembers|hGetAll)\s*\(|redis\.zRange\s*\([^,]+,\s*0\s*,\s*-1/g;
    const relPrefix = scanDir === logicPath ? 'logic/' : '';

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
                    `⚠️ [内存-安全] ${relPrefix}${file}:${i + 1}: 发现全量拉取方法 \`${method}\`。如果数据量过大可能会撑爆 V8 内存，建议改用 \`Scan\` 分页拉取，或在此行添加 \`// SAFE: small\` 豁免。`
                );
            }
        });
    });
}

module.exports = { check };
