/**
 * 模块: EventEmitter listener 累积检测
 *
 * 检测目标：在函数体（请求路径、逻辑函数）内部调用 .on() / .addListener()
 *           而没有对应的 removeListener / off / once，每次调用都会新增监听器。
 *
 * 背景：Node.js 默认每个 emitter 超过 10 个同名监听器时打印 MaxListenersExceededWarning，
 *       但不会自动清理。在高频调用路径（如 JSON-RPC handler、循环）里累积
 *       会导致内存泄漏和"幽灵"事件重复触发。
 *
 * 规则：
 *   ❌ 错误：redis.on('error', handler)  在函数体内，没有对应的 removeListener
 *   ✅ 正确：redis.once('error', handler) — once 自动移除
 *   ✅ 正确：模块顶层注册（仅执行一次）
 *   ✅ 豁免：行内含 // SAFE: 注释
 *
 * 局限：静态分析无法确定函数被调用频率，只标记高风险模式（报 warning）。
 */

const fs = require('fs');
const path = require('path');

// 已知安全的 emitter 对象（只初始化一次，不在热路径里）
const SAFE_EMITTERS = ['app', 'server', 'process', 'worker'];

function check(servicePath, results) {
    const logicPath = path.join(servicePath, 'logic');
    if (!fs.existsSync(logicPath)) return;

    const files = fs.readdirSync(logicPath).filter(f => f.endsWith('.js'));

    files.forEach(file => {
        const content = fs.readFileSync(path.join(logicPath, file), 'utf-8');
        const lines = content.split('\n');

        // 追踪函数嵌套深度（简单括号计数）
        let braceDepth = 0;
        let inFunction = false;

        lines.forEach((line, i) => {
            if (line.includes('// SAFE:')) return;
            if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;

            // 更新括号深度
            const opens  = (line.match(/\{/g) || []).length;
            const closes = (line.match(/\}/g) || []).length;
            const prevDepth = braceDepth;
            braceDepth += opens - closes;
            if (braceDepth > 0) inFunction = true;
            if (braceDepth <= 0) { inFunction = false; braceDepth = 0; }

            // 只检查函数体内（depth > 0）
            if (prevDepth === 0) return;

            // 匹配 .on( 但不是 .once(
            const m = /(\w+)\s*\.\s*on\s*\(\s*['"](\w+)['"]/g;
            let match;
            while ((match = m.exec(line)) !== null) {
                const emitter = match[1].toLowerCase();
                const event = match[2];

                // 豁免安全 emitter
                if (SAFE_EMITTERS.some(e => emitter.includes(e))) continue;

                // 如果同文件有对应的 removeListener/off，放行
                const removePattern = new RegExp(
                    `${match[1]}\\s*\\.\\s*(removeListener|off)\\s*\\(\\s*['"]${event}['"]`
                );
                if (removePattern.test(content)) continue;

                results.warnings.push(
                    `⚠️ [EventLeak] logic/${file}:${i + 1}: ` +
                    `\`${match[1]}.on('${event}', ...)\` 在函数体内注册，` +
                    `未找到对应 removeListener/off。每次调用都会新增监听器，可能导致内存泄漏。` +
                    `如只需触发一次请改用 .once()；如确认安全请加 \`// SAFE:\` 注释。`
                );
            }
        });
    });
}

module.exports = { check };
