/**
 * 模块: _tasks 结构规范检查
 * 检测目标：确保 logic 层返回的 _tasks 包含必需的 method 字段
 *
 * 规则：
 * 1. _tasks.push({ ... }) 中必须包含 method 字段
 * 2. _tasks 数组元素中不能缺少 method（Router 依赖此字段路由任务，缺失时静默丢弃）
 *
 * 允许的格式：
 *   _tasks.push({ method: 'user.permit.update', params: { ... } })
 *   _tasks.push({ service: 'user', method: 'permit.update', params: { ... } })
 *
 * 不允许的格式：
 *   _tasks.push({ service: 'user', params: { ... } })   // 缺少 method
 *   _tasks.push({ type: 'workflow', workflowId: '...' }) // 旧 workflow 格式
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const logicDir = path.join(servicePath, 'logic');
    const indexPath = path.join(servicePath, 'index.js');

    const filesToCheck = [];

    if (fs.existsSync(logicDir)) {
        fs.readdirSync(logicDir)
            .filter(f => f.endsWith('.js'))
            .forEach(f => filesToCheck.push({ file: `logic/${f}`, fullPath: path.join(logicDir, f) }));
    }
    if (fs.existsSync(indexPath)) {
        filesToCheck.push({ file: 'index.js', fullPath: indexPath });
    }

    let foundTasksUsage = false;

    for (const { file, fullPath } of filesToCheck) {
        const content = fs.readFileSync(fullPath, 'utf-8');

        // 只处理用了 _tasks 的文件
        if (!content.includes('_tasks')) continue;
        foundTasksUsage = true;

        // 查找所有 _tasks.push({ ... }) 块（单行或简单多行）
        // 策略：找到每个 _tasks.push( 的位置，提取括号内的内容（最多向后扫 300 字符）
        const pushPattern = /_tasks\.push\s*\(/g;
        let match;

        while ((match = pushPattern.exec(content)) !== null) {
            const start = match.index + match[0].length;
            // 向后最多扫 400 字符，找到对应的闭合括号
            const snippet = content.slice(start, start + 400);

            // 检查 snippet 是否包含 method 字段
            const hasMethod = /\bmethod\s*:/.test(snippet);

            // 检查是否是旧 workflow 格式（有 workflowId 但没有 method）
            const hasWorkflowId = /\bworkflowId\s*:/.test(snippet);

            // 提取行号
            const lineNum = content.slice(0, match.index).split('\n').length;

            if (!hasMethod) {
                if (hasWorkflowId) {
                    results.errors.push(
                        `❌ [Tasks] ${file}:${lineNum}: _tasks.push() 使用了旧 workflowId 格式，Router 无法识别，必须改为 { method: '...', params: {} }`
                    );
                } else {
                    results.errors.push(
                        `❌ [Tasks] ${file}:${lineNum}: _tasks.push() 缺少 method 字段，Router 将静默丢弃该任务`
                    );
                }
            }
        }

        // 检查 _tasks 数组字面量定义（如 const _tasks = [{ ... }]）
        const arrayLiteralPattern = /const\s+_tasks\s*=\s*\[([^\]]{0,800})\]/gs;
        let arrMatch;
        while ((arrMatch = arrayLiteralPattern.exec(content)) !== null) {
            const inner = arrMatch[1];
            if (inner.trim() === '') continue; // 空数组

            // 每个 { ... } 对象
            const objPattern = /\{([^{}]{0,300})\}/gs;
            let objMatch;
            while ((objMatch = objPattern.exec(inner)) !== null) {
                const obj = objMatch[1];
                if (!/\bmethod\s*:/.test(obj)) {
                    const lineNum = content.slice(0, arrMatch.index).split('\n').length;
                    results.errors.push(
                        `❌ [Tasks] ${file}:${lineNum}: _tasks 数组元素缺少 method 字段`
                    );
                }
            }
        }
    }

    if (foundTasksUsage) {
        // 如果运行到这里没有错误被加入，说明全部合规
        const hasTaskErrors = results.errors.some(e => e.includes('[Tasks]'));
        if (!hasTaskErrors) {
            results.passed.push(`✅ [Tasks] 所有 _tasks.push() 均包含 method 字段`);
        }
    }
}

module.exports = { check };
