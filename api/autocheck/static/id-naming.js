/**
 * 模块 2: ID 命名规范检查
 * 检测目标：验证外键字段是否遵循 {Entity}Id 格式（microservice-guide.md §45）
 * 合规示例：deptId, roleId, warehouseId
 * 违规示例：DEPTID（全大写）, dept_id（下划线）, uId（单字母前缀）
 * 特例豁免：uid 被允许作为 User ID 的全局缩写
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const entitiesPath = path.join(servicePath, 'handlers/entities.js');
    if (!fs.existsSync(entitiesPath)) {
        results.warnings.push(`⚠️ [ID] 跳过检查 - handlers/entities.js 不存在`);
        return;
    }
    
    const content = fs.readFileSync(entitiesPath, 'utf-8');
    
    // 正则匹配所有字段名
    const fieldMatches = content.matchAll(/"(\w+)":\s*\{[^}]*type:/g);
    
    for (const match of fieldMatches) {
        const fieldName = match[1];
        const lowerName = fieldName.toLowerCase();
        
        // 检查以 'id' 结尾但不符合规范的字段
        if (lowerName.endsWith('id') && fieldName !== 'id') {
            // 特例: uid 是允许的
            if (lowerName === 'uid') {
                results.passed.push(`✅ [ID] 全局特例字段: ${fieldName}`);
                continue;
            }
            
            // 检查是否为 {Entity}Id 格式 (camelCase)
            const prefix = fieldName.slice(0, -2);
            if (prefix.length < 2) {
                results.errors.push(`❌ [ID] 非法外键命名: "${fieldName}" (前缀过短，应为 {Entity}Id)`);
            } else if (!/^[a-z][a-zA-Z]*$/.test(prefix)) {
                results.warnings.push(`⚠️ [ID] 可疑外键命名: "${fieldName}" (建议使用 camelCase)`);
            } else {
                results.passed.push(`✅ [ID] 符合规范: ${fieldName}`);
            }
        }
    }
}

module.exports = { check };
