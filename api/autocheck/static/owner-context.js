/**
 * 模块: 行隔离上下文注入检查 (Owner Context Check)
 *
 * 检测目标：服务的 `walContext.run(...)` 是否用 `requestContext(req)` 构造 store，
 *          而不是手写 `{ uid: …, trace: …, depth: … }` 字面量。
 *
 * @why passport 外部会话的行隔离声明（constraints.$owner）由 Router 下发，Entity Factory
 *      自 v1.1.16 起在数据层自动执行（create 盖章 / get·update·delete 校验 / list 过滤）——
 *      但前提是它能从 walContext store 里读到 owner 字段。手写的 store 字面量不带这个
 *      字段，于是隔离静默失效：外部主体能读到全表，且没有任何报错或日志。
 *      这正是 docs/feedback/done/passport-owner-isolation-declared-not-enforced.md 记录的
 *      「强制声明、可选执行」缺口——三道发证关卡都在拦，执行环节却依赖每个服务作者
 *      记得手工实现。requestContext(req)（library/entity 导出）把 uid/trace/depth/owner
 *      一次构造齐，服务侧一行接入，后续 store 再加字段也自动到位。
 *
 * 级别：WARN。存量服务是老写法时功能不损（只是行隔离不生效），设 ERROR 会一次炸一片；
 * autocheck 挂 PostToolUse 钩子，WARN 每次改完都会呈现给作者。
 */

const fs = require('fs');
const path = require('path');

const RUN_INLINE_RE = /walContext\.run\(\s*\{/;

function check(servicePath, results) {
    const indexPath = path.join(servicePath, 'index.js');
    if (!fs.existsSync(indexPath)) return;

    const content = fs.readFileSync(indexPath, 'utf-8');
    // 不用 walContext 的服务（无实体工厂/无审计面）由 wal-context 检查负责，这里不管。
    if (!content.includes('walContext.run(')) return;

    if (content.includes('requestContext(')) {
        results.passed.push('✅ [owner-ctx] walContext.run 经 requestContext(req) 注入 —— $owner 行隔离由 Entity Factory 自动执行');
        return;
    }

    if (RUN_INLINE_RE.test(content)) {
        results.warnings.push(
            `⚠️ [owner-ctx] walContext.run(...) 用的是手写 store 字面量 —— Router 下发的行隔离声明\n` +
            `       (constraints.$owner) 进不了 Entity Factory，passport 外部会话将能读到全表（静默、无告警）。\n` +
            `       改成: const { walContext, requestContext } = require('<depth>/library/entity');\n` +
            `             walContext.run(requestContext(req), async () => { … })\n` +
            `       内部/admin 会话没有 $owner，此改动对它们零行为变化。`
        );
    }
}

module.exports = { check };
