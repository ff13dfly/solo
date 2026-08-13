/**
 * 模块: 基建参数命名约定检查 (toFix §6.x — fulfillment expiresAt 类型漂移的教训)
 *
 * 检测目标：
 *   introspection 声明里的"全队基建参数"(token/expiresAt/sub/id/uid/page/pageSize/
 *   limit/offset…) 必须与全队约定的类型一致。这些参数名跨服务复用(token.set、
 *   实体 CRUD、分页),一个服务声明漂移(如 expiresAt: string)不会立刻坏——直到
 *   参数校验上线/调用方按约定传值那天才炸(fulfillment 在 e2e 96 里正是这样被
 *   发现的:harness 按全队约定传 number,被离群的 string 声明拒掉,relay token
 *   播不进去,事件链腰斩)。
 *
 *   约定即代码:本表就是权威。要为某个参数名引入第二种类型,先改这里(并说明为何)。
 */
const fs = require('fs');
const path = require('path');

// 全队基建参数 → 唯一合法类型。只收"跨服务复用的基础设施参数",
// 业务参数(amount/state/…)各服务自治,不在此列。
//
// 分页方言(2026-08-13 定): **标准是 limit / offset / cursor**,新方法一律用这三个。
// page / pageSize 是早期服务的历史方言,仍在表里是因为存量方法(ingress / notification /
// nexus / storage / market / collection)继续接受它、调用方(portal / e2e)还在传——它们的
// logic 经 library/pagination.js 把两套折叠成一套,所以两边都合法、类型都要卡住。
// 但**别再给新方法声明 page/pageSize**:底层 library/entity.js 的 list() 只认 limit/offset/
// cursor,多一套方言就多一层各服务手抄的换算(那三行曾在五个服务里各抄一份)。
// cursor 是 string:游标模式的首页用 cursor:null 请求,Router 的 validator 对 null 跳过
// 类型校验(handlers/validator.js),所以声明成 string 不会拒掉合法的首页请求。
const FLEET_PARAM_TYPES = {
    token:     'string',
    expiresAt: 'number',
    sub:       'string',
    id:        'string',
    uid:       'string',
    limit:     'number',   // ← 标准
    offset:    'number',   // ← 标准
    cursor:    'string',   // ← 标准(有界游标分页;首页传 null)
    page:      'number',   // 历史方言,存量方法专用
    pageSize:  'number',   // 历史方言,存量方法专用
    keyword:   'string',
};

function check(servicePath, results) {
    const introspectionPath = path.join(servicePath, 'handlers/introspection.js');
    if (!fs.existsSync(introspectionPath)) return;   // structure check 已报缺失

    let methods;
    try {
        methods = require(introspectionPath);
    } catch (e) {
        results.errors.push(`❌ [param-conventions] introspection.js require 失败: ${e.message}`);
        return;
    }
    if (!Array.isArray(methods)) return;   // introspection check 已报结构问题

    const violations = [];
    for (const m of methods) {
        for (const p of (m && Array.isArray(m.params) ? m.params : [])) {
            if (!p || typeof p.name !== 'string') continue;
            const expected = FLEET_PARAM_TYPES[p.name];
            if (expected && p.type && p.type !== expected) {
                violations.push(`${m.name} → '${p.name}' 声明为 ${p.type}(全队约定 ${expected})`);
            }
        }
    }

    if (violations.length > 0) {
        results.errors.push(
            `❌ [param-conventions] ${violations.length} 处基建参数类型偏离全队约定: ${violations.join('; ')} ` +
            `— 调用方按约定传值会被参数校验拒掉(参考 fulfillment expiresAt 事故)`
        );
    } else {
        results.passed.push(`✅ [param-conventions] 基建参数类型与全队约定一致`);
    }
}

module.exports = { check, FLEET_PARAM_TYPES };
