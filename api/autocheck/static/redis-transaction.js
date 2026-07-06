/**
 * 模块 34: 悬挂事务检测 (Hanging Multi/Exec Check)
 * 检测目标：检查 logic 目录中是否出现了 `.multi()` 却没有对应的 `.exec()` 或 `.discard()`。
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const logicPath = path.join(servicePath, 'logic');
    if (!fs.existsSync(logicPath)) return;

    const files = fs.readdirSync(logicPath).filter(f => f.endsWith('.js'));

    files.forEach(file => {
        const filePath = path.join(logicPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        
        if (content.includes('.multi()') || content.includes('redis.multi()')) {
            if (!content.includes('.exec()') && !content.includes('.discard()')) {
                results.errors.push(`❌ [事务-安全] logic/${file}: 发现了 \`.multi()\` 开启了 Redis 事务，但同一个文件中没有找到 \`.exec()\` 或 \`.discard()\`，这会导致严重的连接池泄漏和悬挂事务！`);
            } else {
                results.passed.push(`✅ [事务-安全] logic/${file}: Redis 事务闭环检测通过`);
            }
        }
    });
}

module.exports = { check };
