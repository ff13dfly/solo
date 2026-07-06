/**
 * 模块 20: Category 分类规范检查
 * 检测目标：验证微服务是否符合联邦分类协议 (docs/protocol/category.md)
 * 
 * 注意：Category 是可选功能，微服务可以不实现分类功能
 * 
 * 检查项：
 *   1. [可选] logic/category.js 存在且委托给共享库
 *   2. [如果存在] config.js 中 seeds.categories 结构正确
 *   3. [如果存在] bootstrap.js 使用正确的 Redis Key 格式 (SERVICE:CONFIG:CATEGORY:KEY)
 *   4. [如果存在] Key 转换为大写 (toUpperCase)
 */

const fs = require('fs');
const path = require('path');

// Redis Key 格式规范
const REDIS_KEY_PATTERN = /CONFIG:CATEGORY:/;
const UPPERCASE_PATTERN = /\.toUpperCase\(\)/;

function check(servicePath, results) {
    const categoryPath = path.join(servicePath, 'logic/category.js');
    const configPath = path.join(servicePath, 'config.js');
    const bootstrapPath = path.join(servicePath, 'handlers/bootstrap.js');
    
    // 检查是否实现了分类功能
    const hasCategory = fs.existsSync(categoryPath);
    
    if (!hasCategory) {
        // 分类功能是可选的
        results.passed.push(`✅ [Category] 未实现分类功能 (可选模块，已跳过)`);
        return;
    }
    
    results.passed.push(`✅ [Category] logic/category.js 存在`);
    
    const categoryContent = fs.readFileSync(categoryPath, 'utf-8');
    
    // 检查 1: 是否委托给共享库
    if (/require\(['"]\.\.\/\.\.\/library\/category['"]\)/.test(categoryContent) ||
        /require\(['"]@solo\/library\/category['"]\)/.test(categoryContent)) {
        results.passed.push(`✅ [Category] 委托给共享库 (library/category)`);
    } else if (/module\.exports\s*=\s*require/.test(categoryContent)) {
        results.passed.push(`✅ [Category] 使用模块委托模式`);
    } else {
        // 检查是否自行实现了正确的模式
        if (REDIS_KEY_PATTERN.test(categoryContent)) {
            results.passed.push(`✅ [Category] 使用正确的 Redis Key 格式`);
        } else {
            results.warnings.push(`⚠️ [Category] logic/category.js 未使用标准 Redis Key 格式 (SERVICE:CONFIG:CATEGORY:KEY)`);
        }
    }
    
    // 检查 2: config.js 中的 seeds.categories 结构
    if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        
        if (/seeds\s*:\s*\{/.test(configContent)) {
            if (/categories\s*:\s*\[/.test(configContent)) {
                results.passed.push(`✅ [Category] config.js 包含 seeds.categories 结构`);
                
                // 检查 category 结构注释或示例
                if (/key\s*:/.test(configContent) && /type\s*:/.test(configContent)) {
                    results.passed.push(`✅ [Category] seeds.categories 包含正确的字段 (key, type)`);
                }
            } else {
                results.passed.push(`✅ [Category] config.js 有 seeds 结构 (categories 为空或未定义)`);
            }
        }
    }
    
    // 检查 3: bootstrap.js 中的分类初始化
    if (fs.existsSync(bootstrapPath)) {
        const bootstrapContent = fs.readFileSync(bootstrapPath, 'utf-8');
        
        if (/seeds\.categories/.test(bootstrapContent) || /seeds\?\s*\.categories/.test(bootstrapContent)) {
            results.passed.push(`✅ [Category] bootstrap.js 处理 seeds.categories`);
            
            // 检查 Redis Key 格式
            if (/CONFIG:CATEGORY:/.test(bootstrapContent)) {
                results.passed.push(`✅ [Category] bootstrap.js 使用正确的 Redis Key 格式`);
            } else {
                results.warnings.push(`⚠️ [Category] bootstrap.js 未使用标准 Redis Key 格式`);
            }
            
            // 检查大写转换
            if (/toUpperCase\(\)/.test(bootstrapContent)) {
                results.passed.push(`✅ [Category] Key 转换为大写 (符合协议)`);
            } else {
                results.warnings.push(`⚠️ [Category] 未检测到 Key 大写转换 (协议要求 Key 统一大写)`);
            }
            
            // 检查幂等初始化 (仅在 Key 不存在时创建)
            if (/exists/.test(bootstrapContent) || /!existing/.test(bootstrapContent)) {
                results.passed.push(`✅ [Category] 幂等初始化 (检查 Key 是否存在)`);
            }
        }
    }
    
    // 检查 4: 禁止在握手时携带 categories (协议 2.1)
    const indexPath = path.join(servicePath, 'index.js');
    if (fs.existsSync(indexPath)) {
        const indexContent = fs.readFileSync(indexPath, 'utf-8');
        
        // 检查是否在注册时携带 categories（这是不符合协议的）
        if (/system\.register.*categories/.test(indexContent)) {
            results.errors.push(`❌ [Category] 握手时携带 categories 字段 (违反协议 §2.1)`);
        }
    }
}

module.exports = { check };
