/**
 * 模块 20: 内联错误对象检测
 * 检测目标：logic 层和 index.js 中直接 throw { code: -32xxx } 或
 *           throw Object.assign(new Error(), { code }) 的情况。
 * 规范：所有错误必须通过各服务的 handlers/jsonrpc.js 模块抛出，
 *       不允许直接硬编码错误码对象。
 */

const fs = require('fs');
const path = require('path');

// 检测模式
const INLINE_PATTERNS = [
    {
        pat: /\bthrow\s*\{[^}]*code\s*:\s*-3\d{4}/,
        label: 'throw { code: -32xxx } 内联错误对象',
    },
    {
        pat: /\bthrow\s+Object\.assign\s*\(\s*new\s+Error/,
        label: 'throw Object.assign(new Error(), { code }) 模式',
    },
];

function check(servicePath, results) {
    const targets = [];

    // 扫描 logic/ 目录下所有 .js 文件
    const logicPath = path.join(servicePath, 'logic');
    if (fs.existsSync(logicPath)) {
        fs.readdirSync(logicPath)
            .filter(f => f.endsWith('.js'))
            .forEach(f => targets.push(path.join(logicPath, f)));
    }

    // 扫描 index.js
    const indexPath = path.join(servicePath, 'index.js');
    if (fs.existsSync(indexPath)) targets.push(indexPath);

    let found = 0;

    for (const file of targets) {
        const content = fs.readFileSync(file, 'utf-8');
        const relPath = path.relative(servicePath, file);
        const lines = content.split('\n');

        lines.forEach((line, i) => {
            const trimmed = line.trimStart();
            // 跳过注释行
            if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

            for (const { pat, label } of INLINE_PATTERNS) {
                if (pat.test(line)) {
                    results.errors.push(
                        `❌ [内联错误] ${relPath}:${i + 1}: ${label} — 请改用 handlers/jsonrpc.js 模块`
                    );
                    found++;
                }
            }
        });
    }

    if (found === 0) {
        results.passed.push(`✅ [内联错误] 所有错误均通过 jsonrpc 模块抛出`);
    }
}

module.exports = { check };
