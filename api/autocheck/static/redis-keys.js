/**
 * 模块 9: Redis Key 规范检查
 * 检测目标：验证是否使用 SERVICE:ENTITY:ID 格式
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const logicDir = path.join(servicePath, 'logic');
    if (!fs.existsSync(logicDir)) return;
    
    const logicFiles = fs.readdirSync(logicDir).filter(f => f.endsWith('.js'));
    
    for (const file of logicFiles) {
        const filePath = path.join(logicDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        
        // 检查是否有硬编码的 Redis key
        const hardcodedKeys = content.matchAll(/redis\.(?:get|set|del|hGet|hSet)\s*\(\s*['"`]([^'"`\$]+)['"`]/g);
        for (const match of hardcodedKeys) {
            const key = match[1];
            // 检查是否符合 SERVICE:ENTITY:ID 格式
            if (!key.includes(':')) {
                results.warnings.push(`⚠️ [Redis] ${file}: 可疑硬编码 Key "${key}" (建议使用 SERVICE:ENTITY:ID 格式)`);
            }
        }
        
        // 检查是否使用 Entity Factory
        if (content.includes("require('../../library/entity')") ||
            content.includes("require('../../../library/entity')")) {
            results.passed.push(`✅ [Redis] ${file}: 使用 Entity Factory (自动规范化 Key)`);
        }
    }
}

module.exports = { check };
