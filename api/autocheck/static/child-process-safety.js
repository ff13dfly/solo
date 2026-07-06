/**
 * 模块: child_process 安全检测
 *
 * 检测目标：logic/ 里使用 child_process 时的常见风险模式。
 * 当前 Solo apps/ 服务均未使用 child_process，本检查作为预防性门控。
 *
 * 规则：
 *   ❌ error:   exec(变量/拼接字符串)       — 命令注入风险，改用 execFile
 *   ❌ error:   spawn(..., { shell: true })  — 开启 shell 解析，注入风险
 *   ⚠️ warning: exec() 无 timeout 选项       — 子进程可能挂死阻塞服务
 *   ⚠️ warning: child 无 .on('error') 处理   — 静默失败
 *
 * 豁免：文件名含 test / deploy / migrate / script（非业务逻辑文件）
 */

const fs = require('fs');
const path = require('path');

const EXEMPT_NAMES = ['test', 'deploy', 'migrate', 'script', 'seed', 'fixture'];

function check(servicePath, results) {
    const logicPath = path.join(servicePath, 'logic');
    if (!fs.existsSync(logicPath)) return;

    const files = fs.readdirSync(logicPath).filter(f => f.endsWith('.js'));

    files.forEach(file => {
        const baseName = path.basename(file, '.js').toLowerCase();
        if (EXEMPT_NAMES.some(n => baseName.includes(n))) return;

        const content = fs.readFileSync(path.join(logicPath, file), 'utf-8');

        // 跳过不使用 child_process 的文件
        if (!content.includes('child_process')) return;

        const lines = content.split('\n');

        lines.forEach((line, i) => {
            if (line.includes('// SAFE:')) return;
            if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;

            // ❌ exec() 参数是变量或字符串拼接（非纯字面量）→ 注入风险
            if (/\bexec\s*\(/.test(line)) {
                // 纯字符串字面量调用豁免: exec('fixed-cmd')
                const isLiteralOnly = /\bexec\s*\(\s*['"`][^'"`+${}]+['"`]/.test(line);
                if (!isLiteralOnly) {
                    results.errors.push(
                        `❌ [ChildProcess] logic/${file}:${i + 1}: ` +
                        `exec() 参数包含变量或拼接，存在命令注入风险。` +
                        `请改用 execFile(file, args[]) 将命令与参数分离。`
                    );
                }

                // ⚠️ exec() 无 timeout 选项
                if (!/timeout\s*:/.test(line) && !content.slice(0, content.indexOf(line)).match(/timeout\s*:/)) {
                    // 简单检查同行或紧邻行有无 timeout
                    const nearby = lines.slice(Math.max(0, i - 1), i + 3).join(' ');
                    if (!/timeout\s*:/.test(nearby)) {
                        results.warnings.push(
                            `⚠️ [ChildProcess] logic/${file}:${i + 1}: ` +
                            `exec() 未设置 timeout 选项，子进程挂死时会阻塞服务。` +
                            `建议加 { timeout: 30000 }。`
                        );
                    }
                }
            }

            // ❌ spawn 开启 shell: true → 注入风险
            if (/\bspawn\s*\(/.test(line) || content.includes('shell: true')) {
                const nearby = lines.slice(Math.max(0, i - 1), i + 4).join(' ');
                if (/shell\s*:\s*true/.test(nearby)) {
                    results.errors.push(
                        `❌ [ChildProcess] logic/${file}:${i + 1}: ` +
                        `spawn() 使用了 { shell: true }，启用 shell 解析会引入命令注入风险。` +
                        `去掉 shell: true 并直接传参数数组。`
                    );
                }
            }
        });

        // ⚠️ 使用了 child_process 但无 .on('error') 处理
        if (!/.on\s*\(\s*['"]error['"]/.test(content)) {
            results.warnings.push(
                `⚠️ [ChildProcess] logic/${file}: ` +
                `使用了 child_process 但未找到 .on('error') 处理，子进程错误会被静默丢弃。`
            );
        }
    });
}

module.exports = { check };
