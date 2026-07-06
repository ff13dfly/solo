/**
 * 模块 3: RPC 方法命名检查
 * 检测目标：验证 RPC 方法是否遵循 service.entity.action 格式（sample/README.md §324）
 * 合规示例：user.login.request, authority.dept.create
 * 违规示例：user.loginRequest（camelCase）, system.add_service（snake_case）
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const introspectionPath = path.join(servicePath, 'handlers/introspection.js');
    if (!fs.existsSync(introspectionPath)) {
        results.warnings.push(`⚠️ [RPC] 跳过检查 - handlers/introspection.js 不存在`);
        return;
    }

    // 直接 require 模块获取方法列表
    let methods;
    try {
        // 清除缓存以确保获取最新内容
        delete require.cache[require.resolve(introspectionPath)];
        methods = require(introspectionPath);

        // 处理可能的导出格式
        if (methods.default) methods = methods.default;
        if (!Array.isArray(methods)) {
            results.warnings.push(`⚠️ [RPC] introspection.js 导出格式不是数组`);
            return;
        }
    } catch (e) {
        results.errors.push(`❌ [RPC] 无法解析 introspection.js: ${e.message}`);
        return;
    }

    const systemMethods = ['ping', 'methods', 'entities'];

    for (const methodDef of methods) {
        const methodName = methodDef.name;
        if (!methodName) continue;

        // 跳过系统方法的格式检查
        if (systemMethods.includes(methodName)) {
            continue;
        }

        // 禁止带前缀的系统方法 (如 sample.ping)
        for (const sysMethod of systemMethods) {
            if (methodName.endsWith('.' + sysMethod)) {
                results.errors.push(`❌ [RPC] 禁止带前缀的系统方法: "${methodName}" (必须使用不带前缀的顶级名称)`);
                continue;
            }
        }

        const parts = methodName.split('.');

        // 检查点号分隔数量 (允许 2-4 段: service.action 到 service.entity.sub.action)
        if (parts.length < 2 || parts.length > 4) {
            results.errors.push(`❌ [RPC] 方法格式错误: "${methodName}" (应为 service.entity.action 或更深层级)`);
            continue;
        }

        // 检查是否包含 camelCase 或 snake_case
        let hasError = false;
        for (const part of parts) {
            if (/[A-Z]/.test(part)) {
                results.errors.push(`❌ [RPC] 禁止 camelCase: "${methodName}" (发现大写字母)`);
                hasError = true;
                break;
            }
            if (part.includes('_')) {
                results.errors.push(`❌ [RPC] 禁止 snake_case: "${methodName}" (发现下划线)`);
                hasError = true;
                break;
            }
        }

        if (!hasError) {
            results.passed.push(`✅ [RPC] 方法命名正确: ${methodName}`);
        }
    }

    // 检查系统必需方法是否存在于 index.js
    const indexPath = path.join(servicePath, 'index.js');
    if (fs.existsSync(indexPath)) {
        const indexContent = fs.readFileSync(indexPath, 'utf-8');
        for (const method of systemMethods) {
            if (indexContent.includes(`'${method}'`) || indexContent.includes(`"${method}"`)) {
                results.passed.push(`✅ [RPC] 系统方法存在: ${method}`);
            } else {
                results.errors.push(`❌ [RPC] 缺少系统方法: ${method}`);
            }
        }
    }
}

module.exports = { check };
