/**
 * 模块 18: 静态语法检查
 * 检测目标：使用 node -c 验证所有 .js 文件的语法正确性，防止因 AI 幻觉导致的 Unexpected token 等错误。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const filesToExclude = ['node_modules', 'tests', 'test', 'autocheck'];
    
    function walk(dir) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            
            if (stat.isDirectory()) {
                if (!filesToExclude.includes(file)) {
                    walk(fullPath);
                }
            } else if (file.endsWith('.js')) {
                try {
                    // 使用 node -c 执行静态检查 (不运行代码)
                    execSync(`node -c "${fullPath}"`, { stdio: 'ignore' });
                    results.passed.push(`✅ [语法] ${path.relative(servicePath, fullPath)} 检查通过`);
                } catch (e) {
                    results.errors.push(`❌ [语法] ${path.relative(servicePath, fullPath)} 存在语法错误`);
                }
            }
        }
    }

    try {
        walk(servicePath);
    } catch (e) {
        results.errors.push(`❌ [语法] 扫描文件失败: ${e.message}`);
    }
}

module.exports = { check };
