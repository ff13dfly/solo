/**
 * 模块: JsonLogic 求值来源检查 (JsonLogic Source Check)
 *
 * 检测目标：服务代码是否绕过 `api/library/jsonlogic.js` 直接 `require('json-logic-js')`。
 *
 * @why 裸 json-logic-js 对**缺失操作数的数值比较是 fail-OPEN**：取不到的 `var` 得 null，
 *      而 JS 在 `< <= > >=` 里把 null 转成 0。于是
 *        { ">=": [{var:'input.score'}, {var:'input.threshold'}] }
 *      在阈值没喂进来时变成 `x >= 0` —— 一个「够格才放行」的闸门，**恰好在阈值缺失那一刻
 *      变成无条件放行**。而闸门缺数据时的安全默认必须是拦住。
 *
 *      这不是假想：2026-08-11 colony 报过一次（交易闸门「带宽 ≥ 门槛才开仓」变成无条件开仓，
 *      docs/feedback/fulfillment-condition-fail-open.md），当时的修法是给 `library/jsonlogic.js`
 *      加 `failClosedOnMissing`。**但 orchestrator 的 runner.js 直接 require 了裸库**，
 *      于是同一个 bug 在 workflow 的 step condition 里又活了三周 —— 而 workflow 是**审批过的**，
 *      带着"这条链路有人签过字"的信任跑在关键路径上。
 *
 *      为什么测试没拦住：**两边都有测试，而且都是绿的**。`library/tests/jsonlogic.test.js`
 *      有一整段 fail-closed 断言；`orchestrator/tests/condition.test.js` 有十条 condition 用例
 *      ——但没有一条喂缺失操作数。两份测试各自描述各自的实现，谁也不知道对方存在。
 *      ⇒ **这类分叉靠加测试防不住，只能靠"只有一个求值器"**。这条规则就是那个约束。
 *
 * 级别：ERROR。全队实扫零命中（6 个下游项目里的 json-logic-js 引用**全部**是 bundle 自带的
 * `api/library/jsonlogic.js` 本身，不在 per-service 扫描面内），所以升级不会让任何现有服务变红。
 * 真有非闸门用途（纯数据变换等），在该行标 `// SAFE:` 豁免。
 */

const fs = require('fs');
const path = require('path');

const RAW_REQUIRE = /require\(\s*['"`]json-logic-js['"`]\s*\)/;

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
        const lines = fs.readFileSync(file, 'utf-8').split('\n');
        lines.forEach((line, i) => {
            const t = line.trimStart();
            if (t.startsWith('//') || t.startsWith('*')) return;   // 注释里提到不算
            if (!RAW_REQUIRE.test(line)) return;
            if (line.includes('// SAFE:')) return;
            offenders.push({ file: rel, line: i + 1, text: line.trim() });
        });
    }

    if (offenders.length === 0) {
        results.passed.push('✅ [jsonlogic] 规则求值统一走 library/jsonlogic.js（数值比较缺操作数 fail-closed）');
        return;
    }

    offenders.forEach(({ file, line, text }) => {
        results.errors.push(
            `❌ [jsonlogic] ${file}:${line}: \`${text}\` —— 绕过了 api/library/jsonlogic.js。\n` +
            `       裸 json-logic-js 对缺失操作数的 \`< <= > >=\` 是 **fail-open**：取不到的 var 得 null，\n` +
            `       JS 再把 null 转成 0，于是「够格才放行」的闸门在数据没喂进来时无条件放行。\n` +
            `       改成: const { evaluateCondition } = require('<depth>/library/jsonlogic');\n` +
            `       （守卫用 evaluateCondition，参数模板用 resolveParams；确需裸语义就在该行标 // SAFE:）`
        );
    });
}

module.exports = { check };
