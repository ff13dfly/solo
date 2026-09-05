/**
 * 模块: 环境变量整数取值检查 (Env Int Default Check)
 *
 * 检测目标：`parseInt(process.env.X) || DEFAULT` 这个形状。
 *
 * @why 它有一个**静默且危险**的坑：`parseInt('0')` 得 `0`，而 `0` 在 `||` 里是假值，
 *      ⇒ **显式把一个开关设成 0，反而落回默认值**。于是"把它关掉"这个最自然的动作
 *      做不到，而且没有任何提示——配置写了、进程重启了、行为一点没变。
 *      负数同理（`-1` 是真值所以侥幸没事，但 `NaN` 也会静默落回）。
 *
 *      实测代价（docs/feedback/done/event-triggered-workflow-lifecycle-drops-events.md §三）：
 *      `APPROVAL_COOLING_MS_HIGH=0` 关不掉 workflow 的 24 小时冷却期，下游只能改写成 `1`
 *      才生效；`SIGN_RATE_LIMIT=0`（本意"一律拒签"）静默变成 10。
 *
 *      注意这**不是**风格问题：`parseInt(process.env.X || '600', 10)` 是安全写法
 *      （`||` 作用在字符串上，不吃掉 0），本规则不碰它。坏的只有"先 parseInt 再 ||"。
 *
 * 改法：`const { intFromEnv } = require('<depth>/library/env')` → `intFromEnv('X', DEFAULT)`
 * ——0 与负数照常生效，写错的值被拒绝并 warn 一句，而不是悄悄换成默认值。
 *
 * 级别：ERROR。全队实扫零命中（8 个下游项目 0 处），升级不会让任何现有服务变红。
 * 确有理由保留裸写法就在该行标 `// SAFE:`。
 */

const fs = require('fs');
const path = require('path');

// 只匹配"先 parseInt(process.env.X) 收尾、再 ||"这一种形状。
const BAD = /parseInt\(\s*process\.env\.[A-Za-z_0-9]+\s*(?:,\s*\d+\s*)?\)\s*\|\|/;

function walk(dir, out = []) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function check(servicePath, results) {
    if (!fs.existsSync(servicePath)) return;

    const offenders = [];
    for (const file of walk(servicePath)) {
        const rel = path.relative(servicePath, file);
        fs.readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
            const t = line.trimStart();
            if (t.startsWith('//') || t.startsWith('*')) return;   // 注释里举反例不算
            if (!BAD.test(line)) return;
            if (line.includes('// SAFE:')) return;
            offenders.push({ file: rel, line: i + 1, text: line.trim() });
        });
    }

    if (offenders.length === 0) {
        results.passed.push('✅ [env-int] 环境变量整数取值未使用 `parseInt(...) || D`（显式 0 不会被吃掉）');
        return;
    }

    offenders.forEach(({ file, line, text }) => {
        results.errors.push(
            `❌ [env-int] ${file}:${line}: \`${text}\`\n` +
            `       \`parseInt('0')\` 得 0，而 0 在 \`||\` 里是假值 ⇒ **显式设成 0 反而落回默认值**，\n` +
            `       且没有任何提示（配置写了、重启了、行为没变）。\n` +
            `       改成: const { intFromEnv } = require('<depth>/library/env');  intFromEnv('X', DEFAULT)\n` +
            `       （\`parseInt(process.env.X || '600', 10)\` 是安全写法，本规则不管它；确要保留标 // SAFE:）`
        );
    });
}

module.exports = { check };
