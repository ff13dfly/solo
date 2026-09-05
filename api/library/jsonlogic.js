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
 * @attention **字符串本身不做插值**（`"{{a.b}}"` 这类模板语法不存在，会原样透传给下游）。
 *      被求值的只有三种形状：顶层带 `var` 键的对象、带 `$` 前缀键的对象，以及
 *      唯一键落在 `RESOLVE_OPS`（当前只有 `cat`）里的对象。要拼字符串就写
 *      `{ "cat": ["fx-", {"var":"instance.id"}, "-publish"] }`。
 *      详见 docs/feedback/done/runbook-browser-extension-ai-extraction-not-runnable.md
 *      与 docs/feedback/done/fulfillment-actions-have-no-business-egress.md §3.1。
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

/**
 * 除 `var` / `$` 前缀外，额外按算子求值的白名单。
 *
 * @why 只认 `var` 等于把 JsonLogic 砍成「只剩取值」——**拼不出任何字符串**。
 *      现实代价：profile 想给下游派单写一个每实例唯一的幂等键
 *      `"fx-{instance.id}-publish"`，字符串不插值会原样当字面量发出去，于是
 *      **所有实例共用同一个幂等键**——第一张单建成后，后面每一张都命中下游幂等、
 *      返回那张旧单，调用链看起来次次成功，实际一次都没派。
 *      （docs/feedback/done/fulfillment-actions-have-no-business-egress.md §3.1）
 *
 * @attention 刻意只放 `cat` 与 `+`，不放开全部标准算子：放开是**行为变更**——参数模板里
 *      任何恰好以算子命名的字面量字段（`{ if: … }`、`{ map: … }` 这类业务字段名）
 *      会突然被当算子求值。要再放别的算子，往这个集合里加，并同步 CHANGELOG 的
 *      下游 action（消费者的存量 profile 可能正带着同名字面量字段）。
 * @why 这两个算子是「给人写的声明面」的最小可用集：`cat` 让每实例唯一的幂等键拼得出来，
 *      `+` 让**相对**死期写得出来（`{"+": [{"var":"now"}, 7200000]}` = 此刻 +2h）。
 *      少了 `+`，作者只能把死期烤成一个绝对时刻——而状态机/工作流要跑几周，
 *      烤死的值当天就过期了，于是那件事被挪回代码里，"配置即数据"这个前提被悄悄拆掉。
 * @attention 只在该算子是**对象唯一键**时才求值（JsonLogic 自身的表达形状），
 *      `{ cat: [...], note: '…' }` 这种明显是业务对象，照旧递归、不求值。
 */
const RESOLVE_OPS = new Set(['cat', '+']);

function resolveValue(value, data) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && (value.var || Object.keys(value).some(k => k.startsWith('$')))) {
        return jsonLogic.apply(value, data);
    }
    // 加在 var/$ 判定之后：上面那条的行为逐字节不变，这里只多接一种形状。
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length === 1 && RESOLVE_OPS.has(keys[0])) return jsonLogic.apply(value, data);
    }
    return resolveParams(value, data); // 对象/数组递归；标量由顶部守卫原样返回
}

/**
 * 这个值是不是一个「该被求值的 JsonLogic 节点」——`resolveValue` 的判据本身，导出给
 * **另一个声明面**（orchestrator 的 `$` 参数解析）复用。
 *
 * @why Solo 有两个给人写的声明面（fulfillment profile 的 `action.params`、orchestrator
 *      workflow 的 `step.params`），它们语法不同（前者整字段写 JsonLogic，后者 `$input.x`），
 *      但**必须认同一套算子**。此前只有 fulfillment 认 `cat`/`now`，于是作者把在 profile 里
 *      刚学会的写法搬进 workflow step 就**静默失效**——对象原样当字面量发给下游，不报错。
 *      缺口对称时人还能记住"这里不行"，不对称时只能靠踩。导出判据而不是让第二个面自己
 *      抄一份，是为了让"加一个算子"永远只需要改 RESOLVE_OPS 一处。
 */
function isLogicNode(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.var) return true;
    const keys = Object.keys(value);
    if (keys.some(k => k.startsWith('$'))) return true;
    return keys.length === 1 && RESOLVE_OPS.has(keys[0]);
}

module.exports = { apply, evaluateCondition, resolveParams, resolveValue, isLogicNode, RESOLVE_OPS };
