/**
 * 模块 12: Introspection 与路由一致性检查
 * 检测目标：验证 introspection.js 中声明的方法是否在 index.js 的路由中实现
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const introspectionPath = path.join(servicePath, 'handlers/introspection.js');
    const indexPath = path.join(servicePath, 'index.js');
    
    if (!fs.existsSync(introspectionPath) || !fs.existsSync(indexPath)) {
        results.warnings.push(`⚠️ [路由] 跳过检查 - 缺少 introspection.js 或 index.js`);
        return;
    }
    
    // 获取 introspection 中声明的方法
    let declaredMethods;
    try {
        delete require.cache[require.resolve(introspectionPath)];
        const methods = require(introspectionPath);
        declaredMethods = (Array.isArray(methods) ? methods : [])
            .map(m => m.name)
            .filter(Boolean);
    } catch (e) {
        results.errors.push(`❌ [路由] 无法解析 introspection.js: ${e.message}`);
        return;
    }
    
    // 读取 index.js 内容
    const indexContent = fs.readFileSync(indexPath, 'utf-8');
    
    // 检查每个声明的方法是否在 index.js 中被路由
    const systemMethods = ['ping', 'methods', 'entities'];
    const missingRoutes = [];
    
    for (const method of declaredMethods) {
        // 跳过系统方法
        if (systemMethods.includes(method)) continue;
        
        // 检查方法是否出现在 index.js 中
        if (indexContent.includes(`'${method}'`) || indexContent.includes(`"${method}"`)) {
            results.passed.push(`✅ [路由] 方法已路由: ${method}`);
        } else {
            missingRoutes.push(method);
        }
    }
    
    // 报告未路由的方法
    for (const method of missingRoutes) {
        results.errors.push(`❌ [路由] introspection 声明但未路由: ${method}`);
    }
    
    if (missingRoutes.length === 0 && declaredMethods.length > 0) {
        results.passed.push(`✅ [路由] 所有 ${declaredMethods.length} 个方法均已正确路由`);
    }

    // 反向检查：index.js 中注册的业务方法是否都在 introspection 中声明
    // 提取形如 'service.entity.action': 的字符串（业务方法特征：含两个以上 . 分隔的片段）
    const routedMethodPattern = /['"]([a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*){2,})['"]\s*:/g;
    const routedMethods = new Set();
    let match;
    while ((match = routedMethodPattern.exec(indexContent)) !== null) {
        routedMethods.add(match[1]);
    }

    const declaredSet = new Set(declaredMethods);
    const missingFromIntrospection = [];
    for (const method of routedMethods) {
        if (!declaredSet.has(method) && !systemMethods.includes(method)) {
            missingFromIntrospection.push(method);
        }
    }

    for (const method of missingFromIntrospection) {
        results.errors.push(`❌ [路由] index.js 已路由但 introspection 未声明: ${method} (Portal 无法发现此方法)`);
    }

    if (missingFromIntrospection.length === 0 && routedMethods.size > 0) {
        results.passed.push(`✅ [路由] 所有已路由方法均已在 introspection 中声明`);
    }
}

module.exports = { check };
