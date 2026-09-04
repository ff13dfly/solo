/**
 * library/jsonlogic.js — 共享的声明式判断 / 参数求值原语（JsonLogic）
 *
 * @why JsonLogic（"规则即数据"的布尔判断 + 模板求值）原本只埋在
 *      apps/fulfillment/logic/rules.js 里。但同一套原语在多处都需要：
 *        - fulfillment 状态机：transition 守卫 + _task 参数求值
 *        - nexus 上下文装配（context.md）：data_fetcher 的 guard、触发 guard
 *        - orchestrator H6 footprint 预审（后续）
 *      抽到 library 作为单一来源，避免各处 require 跨层、各自实现漂移。
 *
 * 提供三件套：
 *   - apply(rule, data)              裸 JsonLogic.apply
 *   - evaluateCondition(rule, data)  守卫语义：空规则（null/undefined）视为 true；
 *                                    数值比较引用的字段缺失时视为 false（fail-closed，见下）
 *   - resolveParams(template, data)  对象模板里逐字段求 JsonLogic（var/$op 才求值，否则原样/递归）
 */
const jsonLogic = require('json-logic-js');

function apply(rule, data) {
    return jsonLogic.apply(rule, data);
}

// 比较类算子：json-logic-js 把它们落到 JS 松散比较，null 会被转成 0。
const COMPARE_OPS = new Set(['<', '<=', '>', '>=']);

/**
 * 收集一棵规则子树里「不带缺省值」的 var 路径。
 * `{var: 'a.b'}` / `{var: ['a.b']}` 计入；`{var: ['a.b', 0]}` 是调用方显式给的缺省，不计入；
 * `{var: ''}`（整个 data）与数字下标不计入。
 */
function varPathsWithoutDefault(node, out) {
    if (Array.isArray(node)) { for (const n of node) varPathsWithoutDefault(n, out); return out; }
    if (!node || typeof node !== 'object') return out;
    for (const [op, val] of Object.entries(node)) {
        if (op === 'var') {
            const p = Array.isArray(val) ? (val.length === 1 ? val[0] : null) : val;
            if (typeof p === 'string' && p !== '') out.push(p);
        } else {
            varPathsWithoutDefault(val, out);
        }
    }
    return out;
}

/**
 * 把规则树里每个比较类算子包成「引用字段任一缺失 → false，否则原样比较」。
 * 纯函数、不动传入对象；标量与空对象原样返回，保住 evaluateCondition 既有的透传行为。
 */
function failClosedOnMissing(rule) {
    if (Array.isArray(rule)) return rule.map(failClosedOnMissing);
    if (!rule || typeof rule !== 'object') return rule;
    const keys = Object.keys(rule);
    const out = {};
    for (const op of keys) out[op] = failClosedOnMissing(rule[op]);
    if (keys.length === 1 && COMPARE_OPS.has(keys[0])) {
        const paths = varPathsWithoutDefault(rule[keys[0]], []);
        if (paths.length) return { if: [{ missing: paths }, false, out] };
    }
    return out;
}

/**
 * 守卫语义：没有规则 = 放行。用于"没声明 guard 就默认通过"。
 *
 * 🔴 数值比较对缺失字段 fail-closed（2026-09-04，docs/feedback/fulfillment-condition-fail-open.md）。
 *   `{var:'meta.x'}` 取不到时得 null，而 `null >= null` 在 JS 里是 **true**（两边都转成 0）。
 *   于是「余额 ≥ 阈值才放行」这类闸门在数据没喂进来时会**无条件放行**——闸门缺数据时的
 *   安全默认必须是拦住。实测：colony 派生项目的交易闸门「带宽 ≥ 门槛才开仓」变成了无条件开仓。
 *   做法：求值前改写规则树，`<` `<=` `>` `>=` 子树里引用的 `{var: path}` 任一缺失
 *   （json-logic `missing` 语义：undefined / null / 空串）→ 该比较为 false。
 *   - 值为 0 / false **不算缺失**（`missing` 只判 null 与空串）。
 *   - `{var: [path, default]}` 是显式缺省，照旧取缺省值，不触发。
 *   - `==` `!=` `!` 等**不改**：`{'!': {var:'meta.cancelled'}}`「没设过就当 false」是合法惯用法。
 *   - `apply()` 是裸原语，不做改写；只有守卫（本函数）带这层语义。
 */
function evaluateCondition(rule, data) {
    if (rule === undefined || rule === null) return true;
    return jsonLogic.apply(failClosedOnMissing(rule), data);
}

/**
 * 对参数模板逐字段求值。值若是 JsonLogic 对象（含 `var` 或 `$`-前缀算子）则求值，
 * 普通对象递归，数组保持数组身份逐元素递归，标量原样保留。
 *
 * @attention 只有「顶层带 `var` 键 / `$` 前缀键的对象」会被求值——**字符串不做任何
 *      插值**（`"{{a.b}}"` 这类模板语法不存在，会原样透传给下游），其余 JsonLogic
 *      算子（如 `cat`）也不会被识别。要引用上下文只能整字段写 `{ "var": "path" }`。
 *      详见 docs/feedback/runbook-browser-extension-ai-extraction-not-runnable.md。
 */
function resolveParams(template, data) {
    if (!template || typeof template !== 'object') return template;

    // 数组必须保持数组身份：此前走 Object.entries 会塌成 {"0":...,"1":...}，
    // 任何带数组参数的 action（如 agent.chat 的 messages）都传不进去。
    if (Array.isArray(template)) return template.map((value) => resolveValue(value, data));

    const resolved = {};
    for (const [key, value] of Object.entries(template)) {
        resolved[key] = resolveValue(value, data);
    }
    return resolved;
}

function resolveValue(value, data) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && (value.var || Object.keys(value).some(k => k.startsWith('$')))) {
        return jsonLogic.apply(value, data);
    }
    return resolveParams(value, data); // 对象/数组递归；标量由顶部守卫原样返回
}

module.exports = { apply, evaluateCondition, resolveParams };
