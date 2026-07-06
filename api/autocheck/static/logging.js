/**
 * 模块 6: 日志规范检查
 * 检测目标：验证是否使用标准 Logger 工具（principles.md §4）
 * 推荐：使用 library/logger 实现结构化日志存储
 * 警告：直接使用 console.log 不利于日志追溯和审计
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const dirsToCheck = ['.', 'logic', 'handlers'];
    let hasConsoleLog = false;

    dirsToCheck.forEach(dir => {
        const fullPath = path.join(servicePath, dir);
        if (!fs.existsSync(fullPath)) return;

        const files = fs.readdirSync(fullPath).filter(f => f.endsWith('.js'));
        
        files.forEach(file => {
            const filePath = path.join(fullPath, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            
            // 忽略 autocheck 自身文件
            if (filePath.includes('autocheck')) return;

            if (content.match(/console\.(log|error|info|warn)/)) {
                // 允许注释中的 console
                const lines = content.split('\n');
                lines.forEach((line, index) => {
                    if (line.match(/console\.(log|error|info|warn)/) && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
                         results.warnings.push(`⚠️ [日志] 文件 ${path.join(dir, file)}:${index + 1} 使用了 console.* (建议使用 library/logger)`);
                         hasConsoleLog = true;
                    }
                });
            }
        });
    });

    const indexPath = path.join(servicePath, 'index.js');
    if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath, 'utf-8');
        // 检查是否使用系统 Logger
        if (content.includes("require('../../library/logger')") ||
            content.includes("require('../library/logger')") ||
            content.includes("require('../../../library/logger')")) {
            results.passed.push(`✅ [日志] index.js 引用了标准 Logger 工具`);
        }
    }
    
    if (!hasConsoleLog) {
        results.passed.push(`✅ [日志] 未检测到明显的 console.* 使用`);
    }
}

module.exports = { check };
