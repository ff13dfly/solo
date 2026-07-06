/**
 * 模块 17: AI 语义描述 (Prompt) 校验
 *
 * 两层描述，目的不同：
 *   introspection.js  description: 'English string'   → AI/Router 方法发现，只需英文 ✅
 *   config.js         description.zh/en.main          → Portal 服务简介，强制双语
 *   config.js         description.zh/en.methods       → Portal 方法标签，缺 zh 只警告
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const configPath = path.join(servicePath, 'config.js');
    const introspectionPath = path.join(servicePath, 'handlers/introspection.js');

    if (!fs.existsSync(configPath) || !fs.existsSync(introspectionPath)) {
        return;
    }

    // 1. 获取配置数据
    let config;
    try {
        delete require.cache[require.resolve(configPath)];
        config = require(configPath);
    } catch (e) {
        results.errors.push(`❌ [语义] 无法解析 config.js: ${e.message}`);
        return;
    }

    const desc = config.description;
    if (!desc) {
        results.errors.push(`❌ [语义] config.js 中缺少 description 字段`);
        return;
    }

    // 2. 语言包完整性检查
    const languages = ['zh', 'en'];
    for (const lang of languages) {
        if (!desc[lang]) {
            results.errors.push(`❌ [语义] 缺少 ${lang.toUpperCase()} 语言包`);
            continue;
        }

        const langDesc = desc[lang];
        
        // 主语描述（Main）检查
        if (!Array.isArray(langDesc.main) || langDesc.main.length < 2) {
            results.warnings.push(`⚠️ [语义] ${lang.toUpperCase()} 主语描述 (main) 过少，建议至少 2 条以增强 AI 理解`);
        } else {
            results.passed.push(`✅ [语义] ${lang.toUpperCase()} 主语描述已配置 (${langDesc.main.length} 条)`);
        }
    }

    if (!desc.zh || !desc.en) return;

    // 3. 方法覆盖率检查
    let methods;
    try {
        delete require.cache[require.resolve(introspectionPath)];
        methods = require(introspectionPath);
    } catch (e) {
        results.errors.push(`❌ [语义] 发现 introspection.js 但无法解析`);
        return;
    }

    // 3. 方法覆盖率检查
    // 规则：introspection.js 每个方法的 description 字段（英文字符串）是 AI 路由的主要信号，
    // 已在 introspection 模块单独校验。
    // config.js 方法级描述（description.zh/en.methods）仅供 Portal 人类展示，
    // 不强制要求——降为 warning，减少无意义的维护成本。
    const systemMethods = ['ping', 'methods', 'entities'];
    const businessMethods = methods
        .map(m => m.name)
        .filter(name => !systemMethods.includes(name));

    let coveredCount = 0;
    for (const methodName of businessMethods) {
        const hasEn = desc.en?.methods?.[methodName]?.[0];
        const hasZh = desc.zh?.methods?.[methodName]?.[0];

        if (hasEn) {
            coveredCount++;
        }
        // zh 方法描述缺失只警告（Portal 展示用，非 AI 必需）
        if (hasEn && !hasZh) {
            results.warnings.push(`⚠️ [语义] ${methodName} 缺少中文描述 (description.zh.methods，Portal 展示用)`);
        }
    }

    if (coveredCount > 0) {
        results.passed.push(`✅ [语义] 方法英文描述已配置: ${coveredCount}/${businessMethods.length} 个`);
    }
}

module.exports = { check };
