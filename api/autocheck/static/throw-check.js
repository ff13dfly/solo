/**
 * 模块: 裸 throw 规范检查
 * 检测目标：logic 层必须使用标准 jsonrpc 错误，禁止裸 throw new Error()
 *
 * 问题：裸 throw new Error('...') 没有 code 字段，到 index.js 的 catch 块会走
 *       jsonrpc.INTERNAL_ERROR(-32603)，客户端拿不到语义化错误码，且日志也更难定位。
 *
 * 正确做法（library/jsonrpc 提供的标准错误）：
 *   throw jsonrpc.MISSING_PARAM('fieldName')
 *   throw jsonrpc.NOT_FOUND('entity')
 *   throw jsonrpc.INVALID_PARAM('reason')
 *   throw jsonrpc.FORBIDDEN()
 *   throw jsonrpc.INTERNAL_ERROR('reason')
 *
 * 豁免（允许的裸 throw）：
 *   - catch 块中的 re-throw: throw err / throw e / throw error
 *   - 带有 .code 属性的自定义错误: throw Object.assign(new Error(), { code: ... })
 *   - handlers/ 目录（协议层可以 throw new Error 做 failfast）
 *   - tests/ 目录
 */

const fs = require('fs');
const path = require('path');

// 匹配裸 throw new Error(...)，排除 re-throw 和变量 throw
const BARE_THROW_PATTERN = /\bthrow\s+new\s+Error\s*\(/g;
// 豁免：上一行或同行有 Object.assign、.code =、catch 块标志
const RETHROW_PATTERN = /\bthrow\s+(err|error|e)\b/;

function check(servicePath, results) {
    const logicDir = path.join(servicePath, 'logic');

    if (!fs.existsSync(logicDir)) return;

    const files = fs.readdirSync(logicDir).filter(f => f.endsWith('.js'));
    let totalBare = 0;

    for (const file of files) {
        const fullPath = path.join(logicDir, file);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');

        let match;
        BARE_THROW_PATTERN.lastIndex = 0;
        while ((match = BARE_THROW_PATTERN.exec(content)) !== null) {
            const lineIdx = content.slice(0, match.index).split('\n').length - 1;
            const lineText = lines[lineIdx] || '';

            // 豁免：同行有 Object.assign 或 .code（说明是有意构造带 code 的错误）
            if (lineText.includes('Object.assign') || lineText.includes('.code')) continue;

            // 豁免：注释行
            if (lineText.trimStart().startsWith('//') || lineText.trimStart().startsWith('*')) continue;

            totalBare++;
            results.warnings.push(
                `⚠️ [Throw] logic/${file}:${lineIdx + 1}: 裸 throw new Error() 缺少 code 字段，` +
                `建议改为 throw jsonrpc.MISSING_PARAM() / NOT_FOUND() / INVALID_PARAM() 等标准错误`
            );
        }
    }

    if (totalBare === 0 && files.length > 0) {
        results.passed.push(`✅ [Throw] logic 层未发现裸 throw new Error()，均使用标准 jsonrpc 错误`);
    }
}

module.exports = { check };
