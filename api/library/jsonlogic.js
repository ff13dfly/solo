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
 *   - evaluateCondition(rule, data)  空规则（null/undefined）视为 true 的守卫语义
 *   - resolveParams(template, data)  对象模板里逐字段求 JsonLogic（var/$op 才求值，否则原样/递归）
 */
const jsonLogic = require('json-logic-js');

function apply(rule, data) {
    return jsonLogic.apply(rule, data);
}

/**
 * 守卫语义：没有规则 = 放行。用于"没声明 guard 就默认通过"。
 */
function evaluateCondition(rule, data) {
    if (rule === undefined || rule === null) return true;
    return jsonLogic.apply(rule, data);
}

/**
 * 对参数模板逐字段求值。值若是 JsonLogic 对象（含 `var` 或 `$`-前缀算子）则求值，
 * 普通对象递归，标量原样保留。
 */
function resolveParams(template, data) {
    if (!template || typeof template !== 'object') return template;

    const resolved = {};
    for (const [key, value] of Object.entries(template)) {
        if (value && typeof value === 'object' && (value.var || Object.keys(value).some(k => k.startsWith('$')))) {
            resolved[key] = jsonLogic.apply(value, data);
        } else if (value && typeof value === 'object') {
            resolved[key] = resolveParams(value, data);
        } else {
            resolved[key] = value;
        }
    }
    return resolved;
}

module.exports = { apply, evaluateCondition, resolveParams };
