/**
 * 模块: 参数 Schema 强度检查 (Param Schema Strength)
 *
 * 检测目标：handlers/introspection.js 中声明为 string 的参数是否带了长度上限 (maxLength)。
 *   未声明 maxLength 的 string 参数 = 薄声明，异常/超长字符串能穿过 Router 落进 Redis（脏数据）。
 *   Router 的参数校验是声明驱动的：声明里只写 type 而不写约束，等于不挡。
 *
 * 级别：WARNING（不阻断构建门禁，checker.js 仅 errors 才 exit 1）。
 *   这是"参数加强"逐服务推广的待办清单 —— 某服务全部补齐后即在该服务转绿。
 *
 * 豁免：二进制/大字段 (image/audio/file/data/base64) 走 Router 的 binary size 通道，不强制 maxLength。
 *
 * 配套：library/validate.js（实现） + router/handlers/validator.js（执行，认 pattern/maxLength/minLength）。
 * 金标准参考：api/sample/handlers/introspection.js（每个 string 参数都已加厚）。
 */
const fs = require('fs');
const path = require('path');

// 二进制/大 payload 字段：由 Router 的 binary size 上限保护，不要求 maxLength。
const BINARY_EXEMPT = new Set(['image', 'audio', 'file', 'data', 'base64']);
// Router 发现机制依赖的系统方法，无需参数加强。
const SYSTEM_METHODS = new Set(['ping', 'methods', 'entities']);

function check(servicePath, results) {
    const introspectionPath = path.join(servicePath, 'handlers/introspection.js');
    if (!fs.existsSync(introspectionPath)) {
        results.warnings.push(`⚠️ [ParamSchema] 跳过检查 - handlers/introspection.js 不存在`);
        return;
    }

    let methods;
    try {
        delete require.cache[require.resolve(introspectionPath)];
        methods = require(introspectionPath);
        if (methods && methods.default) methods = methods.default;
        if (!Array.isArray(methods)) {
            results.warnings.push(`⚠️ [ParamSchema] introspection.js 导出格式不是数组`);
            return;
        }
    } catch (e) {
        results.errors.push(`❌ [ParamSchema] 无法解析 introspection.js: ${e.message}`);
        return;
    }

    let stringParams = 0;
    let weak = 0;

    for (const m of methods) {
        if (!m || !m.name || SYSTEM_METHODS.has(m.name)) continue;
        if (!Array.isArray(m.params)) continue;
        for (const p of m.params) {
            if (!p || p.type !== 'string') continue;       // 只检 string 参数
            if (BINARY_EXEMPT.has(p.name)) continue;        // 二进制字段豁免
            stringParams++;
            if (typeof p.maxLength !== 'number') {
                weak++;
                results.warnings.push(
                    `⚠️ [ParamSchema] ${m.name} 的参数 '${p.name}' 未声明 maxLength（薄声明，超长/异常字符串易落库）`
                );
            }
        }
    }

    if (stringParams === 0) {
        results.passed.push(`✅ [ParamSchema] 无 string 参数需要加强`);
    } else if (weak === 0) {
        results.passed.push(`✅ [ParamSchema] 全部 ${stringParams} 个 string 参数均已声明 maxLength`);
    }
}

module.exports = { check };
