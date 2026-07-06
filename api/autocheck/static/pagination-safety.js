/**
 * 模块 33: 内存击穿预警 (Pagination Safety Check)
 * 检测目标：检查 logic 目录中是否存在滥用 sMembers 或 zRange 获取全量集合的反模式。
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const logicPath = path.join(servicePath, 'logic');
    if (!fs.existsSync(logicPath)) return;

    const files = fs.readdirSync(logicPath).filter(f => f.endsWith('.js'));
    const PATTERN = /redis\.(sMembers|hGetAll)\s*\(|redis\.zRange\s*\([^,]+,\s*0\s*,\s*-1/g;

    files.forEach(file => {
        const filePath = path.join(logicPath, file);
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
                    `⚠️ [内存-安全] logic/${file}:${i + 1}: 发现全量拉取方法 \`${method}\`。如果数据量过大可能会撑爆 V8 内存，建议改用 \`Scan\` 分页拉取，或在此行添加 \`// SAFE: small\` 豁免。`
                );
            }
        });
    });
}

module.exports = { check };
