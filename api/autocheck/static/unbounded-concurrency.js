/**
 * 模块: 无限制并发 Promise.all 检测
 *
 * 检测目标：logic 层对大数组直接 Promise.all(array.map(...)) 而不做并发限制，
 *           在数组规模不可控时可能打爆 Redis 连接、CPU 或下游服务。
 *
 * 规则：
 *   ❌ 警告：Promise.all(someArray.map(  ← 数组来自外部参数或 Redis 查询结果
 *   ✅ 豁免：Promise.all([a, b, c])      ← 字面量数组，数量已知且有限
 *   ✅ 豁免：行内有 // SAFE: 注释
 *   ✅ 豁免：数组名包含明确有限集合词（workers, pool, chunks, batch）
 *
 * 建议修复：使用 pLimit 或手动分批（chunk + sequential Promise.all）
 */

const fs = require('fs');
const path = require('path');

// 有限集合词豁免（这些变量名通常是已知规模的数组）
const BOUNDED_NAMES = ['workers', 'pool', 'chunks', 'batch', 'pages', 'shards', 'parts'];

function check(servicePath, results) {
    const logicPath = path.join(servicePath, 'logic');
    if (!fs.existsSync(logicPath)) return;

    const files = fs.readdirSync(logicPath).filter(f => f.endsWith('.js'));

    files.forEach(file => {
        const content = fs.readFileSync(path.join(logicPath, file), 'utf-8');
        const lines = content.split('\n');

        lines.forEach((line, i) => {
            if (line.includes('// SAFE:')) return;
            if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;

            // 匹配 Promise.all(xxx.map( 模式
            const m = /Promise\.all\s*\(\s*(\w+)\s*\.\s*map\s*\(/.exec(line);
            if (!m) return;

            const arrayName = m[1].toLowerCase();

            // 豁免字面量数组 [...]
            if (/Promise\.all\s*\(\s*\[/.test(line)) return;

            // 豁免有限集合命名
            if (BOUNDED_NAMES.some(n => arrayName.includes(n))) return;

            results.warnings.push(
                `⚠️ [UnboundedConcurrency] logic/${file}:${i + 1}: ` +
                `Promise.all(${m[1]}.map(...)) 无并发限制。` +
                `若 ${m[1]} 来自 Redis 查询结果或用户输入，规模不可控时可能打爆连接或 CPU。` +
                `建议分批执行或使用 pLimit。如数量确定有限请加 \`// SAFE:\` 注释。`
            );
        });
    });
}

module.exports = { check };
