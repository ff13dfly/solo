/**
 * 模块 13: Mock 数据合规检查
 * 检测目标：验证测试/种子数据的 Redis Key、ID 格式、数据关联是否合规
 * 
 * 检查范围：
 * - tests/utils/*.js 中的种子脚本
 * - 任何包含 mock/seed/fixture 的文件
 */

const fs = require('fs');
const path = require('path');

// Base58 字符集 (排除 0, O, I, l)
const BASE58_REGEX = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

function check(servicePath, results) {
    // 查找测试/种子文件
    const testDirs = [
        path.join(servicePath, 'tests'),
        path.join(servicePath, 'tests/utils'),
        path.join(servicePath, 'test'),
        path.join(servicePath, 'fixtures'),
        path.join(servicePath, 'seeds')
    ];
    
    const mockFiles = [];
    for (const dir of testDirs) {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
            files.forEach(f => mockFiles.push(path.join(dir, f)));
        }
    }
    
    if (mockFiles.length === 0) {
        results.warnings.push(`⚠️ [Mock] 未找到测试/种子文件`);
        return;
    }
    
    results.passed.push(`✅ [Mock] 找到 ${mockFiles.length} 个测试文件`);
    
    for (const filePath of mockFiles) {
        const fileName = path.basename(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        
        // 1. 检查 Redis Key 格式
        checkRedisKeys(content, fileName, results);
        
        // 2. 检查 ID 格式 (Base58)
        checkIdFormat(content, fileName, results);
        
        // 3. 检查数据关联一致性
        checkDataRelations(content, fileName, results);
    }
}

/**
 * 检查 Redis Key 是否符合 SERVICE:ENTITY:ID 格式
 */
function checkRedisKeys(content, fileName, results) {
    // 匹配 redis.set/get/json.set 中的 key
    const keyPatterns = [
        /redis\.set\s*\(\s*['"`]([^'"`$]+)['"`]/g,
        /redis\.get\s*\(\s*['"`]([^'"`$]+)['"`]/g,
        /redis\.json\.set\s*\(\s*['"`]([^'"`$]+)['"`]/g,
        /client\.set\s*\(\s*['"`]([^'"`$]+)['"`]/g,
        /client\.json\.set\s*\(\s*['"`]([^'"`$]+)['"`]/g
    ];
    
    const foundKeys = new Set();
    for (const pattern of keyPatterns) {
        const matches = content.matchAll(pattern);
        for (const match of matches) {
            foundKeys.add(match[1]);
        }
    }
    
    for (const key of foundKeys) {
        const parts = key.split(':');
        if (parts.length < 2) {
            results.errors.push(`❌ [Mock] ${fileName}: 非法 Key 格式 "${key}" (应为 SERVICE:ENTITY:ID)`);
        } else if (parts.length >= 2) {
            // 检查是否全大写 (规范)
            const prefix = parts.slice(0, -1).join(':');
            if (prefix !== prefix.toUpperCase()) {
                results.warnings.push(`⚠️ [Mock] ${fileName}: Key 前缀建议大写 "${key}"`);
            } else {
                results.passed.push(`✅ [Mock] ${fileName}: Key 格式正确 "${key}"`);
            }
        }
    }
}

/**
 * 检查 ID 是否符合 Base58 格式
 */
function checkIdFormat(content, fileName, results) {
    // 匹配 id: "xxx" 或 id: 'xxx' 模式
    const idMatches = content.matchAll(/['"]?id['"]?\s*:\s*['"]([^'"]+)['"]/g);
    
    for (const match of idMatches) {
        const id = match[1];
        
        // 跳过明显的占位符、动态引用和业务单号（含连字符的 display ID）
        if (id.includes('$') || id.includes('{') || id.length < 4 || id.includes('-')) continue;
        
        // 检查 Base58 合规性
        if (!BASE58_REGEX.test(id)) {
            // 检查是否包含非法字符
            const illegalChars = id.match(/[0OIl]/g);
            if (illegalChars) {
                results.errors.push(`❌ [Mock] ${fileName}: ID "${id}" 包含 Base58 非法字符: ${illegalChars.join(', ')}`);
            }
        }
    }
}

/**
 * 检查数据关联一致性
 */
function checkDataRelations(content, fileName, results) {
    // 提取所有定义的 ID
    const definedIds = new Set();
    const idDefMatches = content.matchAll(/['"]?id['"]?\s*:\s*['"]([^'"]+)['"]/g);
    for (const match of idDefMatches) {
        definedIds.add(match[1]);
    }
    
    // 提取所有引用的外键
    const referencedIds = new Map(); // { refId: fieldName }
    const refPatterns = [
        /['"]?(\w+Id)['"]?\s*:\s*['"]([^'"]+)['"]/g,  // xxxId: "value"
        /['"]?(uid)['"]?\s*:\s*['"]([^'"]+)['"]/g     // uid: "value"
    ];
    
    for (const pattern of refPatterns) {
        const matches = content.matchAll(pattern);
        for (const match of matches) {
            const fieldName = match[1];
            const refId = match[2];
            if (!refId.includes('$') && !refId.includes('{')) {
                referencedIds.set(refId, fieldName);
            }
        }
    }
    
    // 检查引用的 ID 是否在同文件中定义
    // 注意：跨文件引用无法检测，这里只做同文件内的一致性检查
    let orphanCount = 0;
    for (const [refId, fieldName] of referencedIds) {
        if (!definedIds.has(refId)) {
            orphanCount++;
            // 只在数量较少时报告，避免过多噪音
            if (orphanCount <= 3) {
                results.warnings.push(`⚠️ [Mock] ${fileName}: ${fieldName}="${refId}" 引用了未在同文件定义的 ID`);
            }
        }
    }
    
    if (orphanCount > 3) {
        results.warnings.push(`⚠️ [Mock] ${fileName}: 还有 ${orphanCount - 3} 个外键引用了外部 ID (可能是正常的跨实体关联)`);
    }
    
    if (orphanCount === 0 && referencedIds.size > 0) {
        results.passed.push(`✅ [Mock] ${fileName}: ${referencedIds.size} 个外键关联检查通过`);
    }
}

module.exports = { check };
