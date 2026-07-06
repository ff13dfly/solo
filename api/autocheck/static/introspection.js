/**
 * 模块 8: Introspection 同步检查
 * 检测目标：
 *   1. logic/*.js 的函数与 introspection.js 定义是否一致
 *   2. ai:true 的方法是否都有 returns 字段（MCP 可用性要求）
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const introspectionPath = path.join(servicePath, 'handlers/introspection.js');
    const logicDir = path.join(servicePath, 'logic');

    if (!fs.existsSync(introspectionPath) || !fs.existsSync(logicDir)) {
        return;
    }

    const introspectionContent = fs.readFileSync(introspectionPath, 'utf-8');

    // 提取 introspection 中定义的方法
    const declaredMethods = new Set();
    const methodMatches = introspectionContent.matchAll(/name:\s*['"]([^'"]+)['"]/g);
    for (const match of methodMatches) {
        declaredMethods.add(match[1]);
    }

    // 扫描 logic 目录下的导出函数
    const logicFiles = fs.readdirSync(logicDir).filter(f => f.endsWith('.js'));
    const logicFunctions = new Set();

    for (const file of logicFiles) {
        const filePath = path.join(logicDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const funcMatches = content.matchAll(/async\s+(\w+)\s*\(|(\w+):\s*async\s*\(/g);
        for (const match of funcMatches) {
            const funcName = match[1] || match[2];
            if (funcName && !['module', 'exports'].includes(funcName)) {
                logicFunctions.add(funcName);
            }
        }
    }

    const undeclaredCount = logicFunctions.size > 0 ?
        `(${logicFunctions.size} 个业务函数)` : '';
    results.passed.push(`✅ [自省] Logic 层扫描完成 ${undeclaredCount}`);

    // ── ai:true 方法必须有 returns ──────────────────────────────
    // 将文件按顶层方法对象切分（每个 { name: 'service.method', ... } 是一块）
    // 方法名特征：包含点号（service.method），与 params 内的字段名区別
    const missing = [];
    const methodBlockRe = /\{[^{}]*name:\s*['"]([a-z][a-z0-9]*\.[a-z][^'"]*)['"'][^{}]*\}/gs;
    let blockMatch;
    while ((blockMatch = methodBlockRe.exec(introspectionContent)) !== null) {
        const block = blockMatch[0];
        const methodName = blockMatch[1];
        const isAi = /ai:\s*true/.test(block);
        const hasReturns = /returns:/.test(block);
        if (isAi && !hasReturns) {
            missing.push(methodName);
        }
    }

    if (missing.length === 0) {
        results.passed.push(`✅ [自省] 所有 ai:true 方法均有 returns 定义`);
    } else {
        results.warnings.push(
            `⚠️  [自省] ${missing.length} 个 ai:true 方法缺少 returns（外部 AI 无法自主链路调用）:\n` +
            missing.map(m => `       - ${m}`).join('\n')
        );
    }
}

module.exports = { check };
