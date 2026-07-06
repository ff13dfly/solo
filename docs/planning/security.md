# 安全待办

记录已知但尚未修复的安全问题。按优先级排序，修复后移入下方"已修复"记录。

> 校对：2026-06-04，逐条对代码核实。SOLO 是纯框架，举例中的业务方法名（如 `commodity.*`）在代码中**不存在**，对应的具体攻击面在当前代码不成立。

---

## 待修复

### 🟡 中优先级

**API 枚举探测无自动封锁**
- 位置：`api/router/index.js`（permit 检查后）
- 现状：已有手动 `SYSTEM:CONFIG:PERMIT_BLACKLIST`（`setting.blacklist.*`）+ 统一 IP 限流（500/分）提供基础节流；`logInteraction` 已记录 404/403
- 仍缺：基于错误率的**自动**封锁——同一 token/IP 60 秒内超过 N 次 404/403 自动写入临时黑名单（数据源已具备，只差"检测 + 写入"这一步）

**~~resolver 写保护用黑名单（设计加固）~~ → 已按设计移除（2026-06 核实，非缺陷）**
- 现状：resolver **已不用任何关键词黑名单**——`api/core/orchestrator/logic/workflow.js:204-205` / `:391` 明确注释「no method-name blacklist here，C1 审批闸 + H6 footprint 预审才是真安全边界」。关键词正则只给「虚假安全感」（改个命名即绕过），故删。
- 结论：写保护现由 **C1 审批（create 默认 `PENDING_REVIEW`，须他人审批）+ H6 footprint 预审（执行前校验触发方 permit 覆盖整条 footprint）** 承担，强于黑名单。原「改白名单」诉求被这套取代，**本条关闭**。
- 注：勿与上一条 router 的 `PERMIT_BLACKLIST`（枚举探测节流）混淆——那是另一回事，仍在。

---

### 🟢 设计决策（已确认，非缺陷——勿当待修 bug）

**workflow 步骤执行凭证 = 透传触发方 token（2026-06 决定保持不变）**
- 行为：`runner.js` 的 `makeRpcCall` 透传调用方 `Authorization`（约 L405），步骤用**触发方的 token** 执行——sync 触发 = 调用方，event/cron 触发 = orchestrator bot。这是有意设计
- 治理：**H6 footprint 预审**（执行前校验触发方 permit 覆盖整条 footprint）+ **`run.grant`**（缺方法时人在环一次性补授，run 暂停为 `PAUSED_AWAITING_HUMAN`，e2e suite 50 验证），防止绕审执行高权方法
- 决定：**保持透传，不改为 orchestrator 服务凭证**。"透传 + 预审 + 补授"已自洽；明确记录于此，以免后人再当作待修漏洞处理

---

## 已修复

| 问题 | 修复 | 位置 |
|------|------|------|
| `system.report` public 端点不经统一限流（本地分发表绕过限流闸） | 2026-06（本地分发前补限流闸 + config 收紧 30/分 by IP；`router/tests/ratelimit.test.js` 守护） | `router/index.js` / `router/config.js` |
| 外部 token 无主动吊销（泄露后只能等 TTL） | 2026-06（方案 b：`USER:SESSIONS:{uid}` 反向索引 + `user.token.revoke`(admin) 按 uid 吊销其全部 live session；`core/user/tests/bot-revoke.test.js` 守护） | `core/user/logic/bot.js` |
| `workflow.create` 直接建 ACTIVE 绕过审核 | 2026-06（C1：create 默认 PENDING_REVIEW；`workflow.approve` 落地，e2e suite 52 验证） | `core/orchestrator/logic/workflow.js:206` |
| `workflow.restore` 直接恢复 ACTIVE 绕过审核 | 2026-06（C5：restore 只回到 PENDING_REVIEW，不再直达 ACTIVE） | `core/orchestrator/logic/workflow.js:383` |
| `condition` 字段 `new Function` 代码注入 | 2026-04-27 | `core/orchestrator/logic/runner.js` |
| `$env` 环境变量通过 `$env.X` 泄露 | 2026-04-27 | `core/orchestrator/logic/runner.js` |
| ACTIVE workflow 可修改 steps/resolvers 绕过审核 | 2026-04-27 | `core/orchestrator/logic/workflow.js` |
| `METHOD_NOT_FOUND` 未写入 logInteraction | 2026-04-27 | `router/index.js` |
