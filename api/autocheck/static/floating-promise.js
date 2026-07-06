/**
 * 模块 35: 悬浮异步操作检测 (Floating Promise Check)
 * 检测目标：检查 logic 目录中调用 redis 的写操作前是否漏写了 await 或 return。
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const logicPath = path.join(servicePath, 'logic');
    if (!fs.existsSync(logicPath)) return;

    const files = fs.readdirSync(logicPath).filter(f => f.endsWith('.js'));
    // 匹配以 redis. 开始，不带 await/return/赋值的行
    const PATTERN = /^\s*(?:redis|client|multi)\.(set|hSet|zAdd|sAdd|del|hDel|zRem|sRem|lPush|rPush|expire)\s*\(/;

    files.forEach(file => {
        const filePath = path.join(logicPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        lines.forEach((line, i) => {
            if (line.includes('// SAFE:')) return;
            if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;

            // 过滤带有 await, return, 或者多方法链式 (如 Promise.all(redis.set))
            if (line.includes('await ') || line.includes('return ') || line.includes('=>') || line.includes('Promise.all')) return;

            const m = PATTERN.exec(line);
            if (m) {
                // 如果是在 multi 链条里 (如 multi.set) 其实也不需要 await，但在 Solo 里 multi 也是异步的(如果是 pipeline)
                if (m[0].includes('multi.')) return; // 豁免 multi
                
                results.warnings.push(
                    `⚠️ [悬浮-Promise] logic/${file}:${i + 1}: 发现孤立的 Redis 写操作 \`${line.trim()}\`。请确认是否漏写了 \`await\`，否则会导致竞态条件。如果是刻意的后台触发，请添加 \`// SAFE:\` 注释。`
                );
            }
        });
    });
}

module.exports = { check };
