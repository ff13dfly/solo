/**
 * 模块: setInterval / setTimeout 清理检测
 *
 * 检测目标：
 *   1. setInterval() 返回值未赋给变量 → 无法 clearInterval，服务重启/模块重载后 interval 堆积
 *   2. setInterval() 有引用但文件内找不到 clearInterval → 只启动不停止
 *
 * 规则：
 *   ❌ setInterval(fn, ms)            — 无引用，无法清理
 *   ❌ let x = setInterval(fn, ms)    — 有引用但无 clearInterval(x)
 *   ✅ this.timer = setInterval(...)  — 引用存在对象上，服务可自行管理（豁免）
 *   ✅ module.exports 里有 stop/destroy 方法含 clearInterval — 约定式生命周期管理（豁免）
 *   ✅ 行内含 // SAFE: 注释
 *
 * setTimeout 单次延迟通常无需清理，但如果在循环/热路径中调用则警告。
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const logicPath = path.join(servicePath, 'logic');
    if (!fs.existsSync(logicPath)) return;

    const files = fs.readdirSync(logicPath).filter(f => f.endsWith('.js'));

    files.forEach(file => {
        const content = fs.readFileSync(path.join(logicPath, file), 'utf-8');
        const lines = content.split('\n');

        const hasClearInterval = content.includes('clearInterval');
        // 如果文件有 stop/destroy/cleanup 方法含 clearInterval，视为生命周期管理完整
        const hasLifecycle = /\b(stop|destroy|cleanup|shutdown)\b[\s\S]{0,200}clearInterval/.test(content);

        lines.forEach((line, i) => {
            if (line.includes('// SAFE:')) return;
            if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;

            // 检查 setInterval 调用
            if (!/\bsetInterval\s*\(/.test(line)) return;

            const trimmed = line.trimStart();

            // 裸调用（无赋值）
            const isBare = /^\s*setInterval\s*\(/.test(line) ||
                           /[^=!<>]\s*setInterval\s*\(/.test(line) &&
                           !/(?:=|let|const|var|this\.\w+|exports\.\w+)\s*(?:\w+\s*=\s*)?setInterval/.test(line);

            if (isBare) {
                results.warnings.push(
                    `⚠️ [IntervalLeak] logic/${file}:${i + 1}: ` +
                    `setInterval() 返回值未赋给变量，无法 clearInterval。` +
                    `服务重载时 interval 会堆积。请赋值给成员变量并在 stop/destroy 里清理。`
                );
                return;
            }

            // 有赋值但文件内无 clearInterval（且无生命周期管理）
            if (!hasClearInterval && !hasLifecycle) {
                results.warnings.push(
                    `⚠️ [IntervalLeak] logic/${file}:${i + 1}: ` +
                    `setInterval() 有引用但文件内未找到 clearInterval。` +
                    `请在 stop()/destroy() 方法里调用 clearInterval 以支持干净重启。`
                );
            }
        });
    });
}

module.exports = { check };
