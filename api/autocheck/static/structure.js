/**
 * 模块 1: 目录结构检查
 * 检测目标：验证微服务是否遵循标准目录结构（principles.md §2）
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    if (!fs.existsSync(path.join(servicePath, 'index.js')) && !fs.existsSync(path.join(servicePath, 'config.js'))) {
        results.warnings.push(`⚠️ [结构] 这是一个纯文档/设计阶段的服务，已跳过后续代码审查`);
        return false;
    }

    const requiredDirs = ['logic', 'handlers'];
    const requiredFiles = ['config.js', 'index.js', 'package.json'];
    const recommendedFiles = ['README.md', 'handlers/introspection.js', 'handlers/entities.js'];
    
    // 检查必需目录
    for (const dir of requiredDirs) {
        if (!fs.existsSync(path.join(servicePath, dir))) {
            results.errors.push(`❌ [结构] 缺少必需目录: ${dir}/`);
        } else {
            results.passed.push(`✅ [结构] 目录存在: ${dir}/`);
        }
    }
    
    // 检查必需文件
    for (const file of requiredFiles) {
        if (!fs.existsSync(path.join(servicePath, file))) {
            results.errors.push(`❌ [结构] 缺少必需文件: ${file}`);
        } else {
            results.passed.push(`✅ [结构] 文件存在: ${file}`);
        }
    }
    
    // 检查推荐文件
    for (const file of recommendedFiles) {
        if (!fs.existsSync(path.join(servicePath, file))) {
            results.warnings.push(`⚠️ [结构] 缺少推荐文件: ${file}`);
        }
    }
    
    return true;
}

module.exports = { check };
