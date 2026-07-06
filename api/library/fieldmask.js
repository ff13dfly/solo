/**
 * Field Mask Utilities
 *
 * @why 字段拦截工具，用于在服务 logic 层根据角色或用户配置过滤响应字段。
 *      支持黑名单（hide）和白名单（show）两种模式。
 *
 * @design
 *   - 配置来源：Role.constraints（通过权限同步管道写入 user.permit.constraints）
 *   - 实现位置：core/lib（共享），各微服务 logic 层按需引入，渐进式落地
 *   - 调用位置：logic 层（紧靠数据），而非 handler 层或 Router 层
 *   - Router 不感知：Router 只透传 constraints，不解析内容
 *
 * @flow
 *   authority role.constraints 配置（含 hide/show 规则）
 *     → employee.bind() → _tasks: user.permit.update
 *     → user.permit.constraints
 *     → Router x-router-token 透传
 *     → req.user.constraints（微服务可用）
 *     → fieldmask.apply(data, method, constraints)
 *
 * @modes
 *   show（白名单）：只返回列出的字段，新字段默认隐藏，优先级高于 hide
 *   hide（黑名单）：移除列出的字段，新字段默认透传，维护成本低
 *
 * @rule 合并优先级（method 规则 + * 全局规则）
 *   - show：method 级 show 存在时忽略 *，否则回退到 * 的 show
 *   - hide：method 级与 * 取并集（均生效）
 *
 * @see docs/zh/protocol/security.md § 3.6
 */

/**
 * 递归剥离指定字段（黑名单，处理嵌套对象和数组）
 *
 * @param {*} data
 * @param {string[]|Set<string>} fields - 要移除的字段名
 * @returns {*}
 *
 * @example
 * strip({ id: 1, cost: 99, name: 'A' }, ['cost'])
 * // → { id: 1, name: 'A' }
 */
function strip(data, fields) {
    const fieldSet = fields instanceof Set ? fields : new Set(fields);
    if (!fieldSet.size) return data;

    if (Array.isArray(data)) {
        return data.map(item => strip(item, fieldSet));
    }
    if (data !== null && typeof data === 'object') {
        return Object.fromEntries(
            Object.entries(data)
                .filter(([k]) => !fieldSet.has(k))
                .map(([k, v]) => [k, strip(v, fieldSet)])
        );
    }
    return data;
}

/**
 * 递归保留指定字段（白名单，处理嵌套对象和数组）
 * 注意：白名单只作用于顶层字段，嵌套对象内部不递归过滤
 *
 * @param {*} data
 * @param {string[]|Set<string>} fields - 要保留的字段名
 * @returns {*}
 *
 * @example
 * pick({ id: 1, cost: 99, name: 'A' }, ['id', 'name'])
 * // → { id: 1, name: 'A' }
 */
function pick(data, fields) {
    const fieldSet = fields instanceof Set ? fields : new Set(fields);
    if (!fieldSet.size) return data;

    if (Array.isArray(data)) {
        return data.map(item => pick(item, fieldSet));
    }
    if (data !== null && typeof data === 'object') {
        return Object.fromEntries(
            Object.entries(data).filter(([k]) => fieldSet.has(k))
        );
    }
    return data;
}

/**
 * 基于 constraints 动态过滤（配置驱动）
 *
 * 规则解析顺序：
 *   1. method 级 show → 白名单，直接返回，忽略其余规则
 *   2. * 级 show      → 白名单回退（无 method 级 show 时生效）
 *   3. method 级 hide ∪ * 级 hide → 黑名单，取并集
 *
 * @param {*} data - 原始数据
 * @param {string} method - 当前 RPC 方法名，如 'sale.order.list'
 * @param {object|undefined} constraints - req.user.constraints
 * @returns {*} 过滤后的数据
 *
 * @example
 * return fieldmask.apply(orders, 'sale.order.list', req.user.constraints);
 */
function apply(data, method, constraints) {
    if (!constraints) return data;

    const methodRule = constraints[method] || {};
    const globalRule = constraints['*']    || {};

    // 白名单优先（method 级 > * 级）
    const showFields = methodRule.show || globalRule.show;
    if (showFields?.length) return pick(data, showFields);

    // 黑名单（method 级 ∪ * 级）
    const hideFields = [...(methodRule.hide || []), ...(globalRule.hide || [])];
    if (hideFields.length) return strip(data, hideFields);

    return data;
}

/**
 * 工厂方法：为服务模块定义静态黑名单角色规则（代码级配置）
 * 适合字段限制是固定业务规则、不需要动态配置的场景
 *
 * @param {{ [role: string]: string[] }} roleRules
 *   key 为角色名（'admin' | 'operator' | 'user'），value 为要隐藏的字段列表
 *   未匹配的角色回退到 'user' 规则
 * @returns {{ forUser(data: *, permit: object): * }}
 *
 * @example
 * const mask = fieldmask.define({
 *     admin:    [],
 *     operator: ['cost_price'],
 *     user:     ['cost_price', 'margin', 'supplier_id']
 * });
 *
 * return mask.forUser(orders, req.user.permit);
 */
function define(roleRules) {
    return {
        forUser(data, permit) {
            // permit 可以是字符串 'admin'|'user'（来自 req.permit）
            // 也可以是对象 { allow_all, role }（旧版或直接传 permit 对象时）
            const role = (permit === 'admin' || permit?.allow_all) ? 'admin' : (permit?.role || 'user');
            const fields = roleRules[role] ?? roleRules['user'] ?? [];
            return fields.length ? strip(data, fields) : data;
        }
    };
}

module.exports = { strip, pick, apply, define };
