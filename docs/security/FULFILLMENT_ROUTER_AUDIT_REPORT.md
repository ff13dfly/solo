# Fulfillment 与 Router 专项安全审计与修复报告 (Security Audit & Remediation Report)

**审计日期**: 2026-10-19  
**审计范围**: `api/apps/fulfillment`、`api/router` 及直接关联的 `api/library` 公共模块  
**触发背景**: 提交 `f7881817a05f8de9fccfbcb437aa266f0d0e1d70`（*fix(fulfillment,router): 补齐外部哨兵自愈环路四处缺口（expectedTransitionId乐观锁、list过滤、resume事件与RBAC自省）*）后，针对履约状态机生命周期、乐观并发控制、Profile 治理流、网关自省发现与 `_tasks` 异步权能传播开展的 6 阶段源码与沙箱复现审计。  
**完整审计归档产物**:
- 仓库内正式报告：`docs/security/FULFILLMENT_ROUTER_AUDIT_REPORT.md`（本文档）
- 6 阶段结构化审计归档（含覆盖率账本 `coverage-ledger.json`、复现证据 `agents/*/artifacts/*.txt`、机器可读 `findings.json`）：`/Users/fuu/security-audit-skill/solo/run-1/`

---

## 一、 执行摘要 (Executive Summary)

本次专项审计共确认 **8 项安全漏洞（Confirmed Findings）**（4 项 High、4 项 Medium），并已在 `api/apps/fulfillment`（第 1 部分）与 `api/router`（第 2 部分）中完成闭环修复与回归单测覆盖：

| 编号 | 严重度 | 所属模块 | 漏洞指纹 / 标题 | 修复状态 |
| :--- | :--- | :--- | :--- | :--- |
| **#1** | **High** | `api/apps/fulfillment` | `fulfillment/instance/resume:unrestricted-prevstate-rollback` — `instance.resume` 未校验挂起态与 `expectedTransitionId`，可回滚终态实例并双向震荡重放事件 | ✅ 已修复 |
| **#2** | **High** | `api/apps/fulfillment` | `fulfillment/instance/advance:non-atomic-expected-transition-id-toctou` — `advance`/`resume`/`update` 的乐观锁检查与 Redis 写入非原子，存在并发 TOCTOU 覆盖竞态 | ✅ 已修复 |
| **#3** | **High** | `api/router` | `api/router/index.js:rpcHandler.METHODS:unauthenticated-discovery-and-internal-method-bypass` — Router Phase 2 本地 `METHODS` 绕过 Phase 3 `checkAccess` 生产发现门禁 | ✅ 已修复 |
| **#4** | **High** | `api/router` | `api/router/handlers/tasks.js:processTasks:missing-constraints-propagation` — `_tasks` 异步分发签名令牌丢弃调用方 `constraints`（如 `$owner` 行级隔离作用域） | ✅ 已修复 |
| **#5** | **Medium** | `api/apps/fulfillment` | `fulfillment.profile:governance-lane-and-sod-bypass` — Profile 直接 CRUD 缺少管理员门禁，且多次编辑会覆盖 `submittedBy` 绕过职责分离（SoD） | ✅ 已修复 |
| **#6** | **Medium** | `api/apps/fulfillment` | `fulfillment/instance/loadProfile:soft-deleted-profile-bypass` — `loadProfile` 直接读取 Redis 未校验 `status === 'DELETED'`，软删除 Profile 仍可驱动实例 | ✅ 已修复 |
| **#7** | **Medium** | `api/apps/fulfillment` | `fulfillment.profile.generate:unbounded-max-repairs-llm-loop` — `maxRepairs` 参数无上限，单次请求可驱动无限次共享 Bot 凭据 `agent.chat` 调用 | ✅ 已修复 |
| **#8** | **Medium** | `api/router` | `api/router/handlers/service.js:capabilities:wildcard-permit-and-ai-discovery-overexposure` — `system.capability.list` 对通配符权限（`*`）及未带 `all: true` 的请求过度暴露 `ai: false` 管理方法 | ✅ 已修复 |

---

## 二、 详细发现与修复方案 (Detailed Findings & Remediations)

### 第 1 部分：`api/apps/fulfillment` 状态机与 Profile 治理修复

#### 1. [High] `fulfillment.instance.resume` 任意状态回滚与事件风暴 (`fulfillment/instance/resume:unrestricted-prevstate-rollback`)
- **问题根因**:
  `advance()` 在每次状态流转时均会将 `instance.prevState` 设为上一状态（`api/apps/fulfillment/logic/instance.js`）。而 `resume()` 仅检查 `if (!instance.prevState)`，未验证当前实例是否确实通过 `hold_requested` 进入挂起态，也未支持 `expectedTransitionId`。持有 `fulfillment.instance.resume` 权限的哨兵可将已处于 `COMPLETED` 或 `CANCELLED` 终态的实例回滚至前序状态并无限往返触发 `EVENT:FULFILLMENT:TRANSITIONED`。
- **修复措施**:
  - 在 `api/apps/fulfillment/logic/instance.js` 的 `resume()` 中校验最新历史记录必须为 `lastEntry.event === 'hold_requested'` 且 `instance.prevState` 非空；恢复后追加 `event: 'resume'` 历史项，天然阻止连续二次 `resume` 震荡。
  - 为 `resume()` 增加可选参数 `expectedTransitionId` 并在 `api/apps/fulfillment/handlers/introspection.js` 中同步声明。

#### 2. [High] `expectedTransitionId` 乐观锁非原子读写 TOCTOU 竞态 (`fulfillment/instance/advance:non-atomic-expected-transition-id-toctou`)
- **问题根因**:
  `advance()`、`resume()` 和 `update()` 先执行 `await getInstance(id)` 检查 `expectedTransitionId`，随后 `await loadProfile(...)`，最后 `await redis.set(...)`。当外部超时哨兵与业务回调携带相同的 `expectedTransitionId` 并发到达时，双方在任一方写入前均通过校验，后写入者静默覆盖先写入者的状态与历史。此外 `advance()` 未对非对象类型的 `metaUpdate`（如数组）做归一化保护。
- **修复措施**:
  - 在 `api/apps/fulfillment/logic/instance.js` 中引入进程内按实例 Key 串行化的 `withInstanceLock(key, fn)` 队列，并结合 `api/library/optimistic.js` 的 `optimisticUpdate(redis, key, mutateFn)`（Redis `WATCH/MULTI/EXEC` CAS 事务）执行状态校验、条件求值与写入。
  - 对 `advance()` 中的 `metaUpdate` 增加纯对象归一化校验。

#### 3. [Medium] Profile 治理通道与职责分离（SoD）绕过 (`fulfillment.profile:governance-lane-and-sod-bypass`)
- **问题根因**:
  - `api/apps/fulfillment/index.js` 中直接 CRUD 方法（`fulfillment.profile.{create,update,delete,restore,destroy}`）未校验 `isAdmin`，非管理员若被授予方法权限可绕过 `submit -> approve` 审核流。
  - `api/apps/fulfillment/logic/profile.js` 的 `update()` 在修改审核流 Profile 的可执行字段时，以当前编辑者覆盖 `submittedBy`，导致原始提交者 `author-1` 可在 `editor-2` 编辑后审批自己参与编写的 Profile；且当 `req.user` 缺失时不会保留既有 `submittedBy`。
- **修复措施**:
  - 在 `api/apps/fulfillment/index.js` RPC 入口层对 `fulfillment.profile.{create,update,delete,restore,destroy}` 强制要求 `isAdmin`。
  - 在 `api/apps/fulfillment/logic/profile.js` 的 `GOVERNANCE_FIELDS` 中加入 `'contributors'`，在 `submit` 与 `update` 中累积记录所有参与编写的用户列表 `contributors`（并在 `req.user` 为空时保留原 `submittedBy`），在 `approve()` 中禁止 `submittedBy` 或 `contributors` 中的任何贡献者自审通过。

#### 4. [Medium] `loadProfile` 绕过软删除状态校验 (`fulfillment/instance/loadProfile:soft-deleted-profile-bypass`)
- **问题根因**:
  `fulfillment.profile.delete` 通过 Entity Factory 将 Profile 标记为 `status: 'DELETED'`，但 `api/apps/fulfillment/logic/instance.js` 的 `loadProfile(profileId)` 直接调用 `redis.get` 解析 JSON，未检查 `profile.status === 'DELETED'`，导致已软删除的 Profile 仍可创建和流转实例。
- **修复措施**:
  - 在 `loadProfile(profileId)` 中增加 `if (profile && profile.status === 'DELETED') throw jsonrpc.NOT_FOUND(\`Profile ${profileId}\`);`，恢复后（`status: 'ACTIVE'`）方可继续使用。

#### 5. [Medium] `fulfillment.profile.generate` 的 `maxRepairs` 循环无上限 (`fulfillment.profile.generate:unbounded-max-repairs-llm-loop`)
- **问题根因**:
  `generateProfile` 直接信任调用方传入的整数 `maxRepairs`，当 LLM 返回無法通过 lint 的候选 JSON 时，单次 RPC 请求可触发 `1 + maxRepairs` 次 `relay.call('agent.chat')` 调用。
- **修复措施**:
  - 在 `api/apps/fulfillment/logic/generate.js` 中定义硬上限 `MAX_REPAIRS_CAP = 5`，将 `maxRepairs` 钳制在 `[0, 5]` 区间内，并在 `api/apps/fulfillment/handlers/introspection.js` 中同步更新参数说明。

---

### 第 2 部分：`api/router` 网关发现、鉴权与异步任务传播修复

#### 6. [High] Router Phase 2 本地 `METHODS` 绕过生产发现与鉴权门禁 (`api/router/index.js:rpcHandler.METHODS:unauthenticated-discovery-and-internal-method-bypass`)
- **问题根因**:
  `api/router/index.js` 在 Phase 2 分发本地 `METHODS`（位于 Phase 3 `handlers.access.checkAccess` 之前）。`system.service.list`、`system.service.status`、`system.capability.list`、`system.category.locate`、`system.category.list`、`system.workflow.list` 在生产模式（`!config.debug`）下未拦截匿名 `guest` 请求，且 `system.category.list` 允许非管理员传入 `includeDeleted: true` 枚举已删除分类。
- **修复措施**:
  - 在 `api/router/index.js` 中对 `system.service.status`、`system.service.list` 及未认证的 `system.capability.list` 调用 `handlers.access.checkAccess(sessionUser, 'router', method)` 执行生产环境发现门禁。
  - 对 `system.category.locate`、`system.category.list` 和 `system.workflow.list` 在 `!config.debug` 下要求已认证会话或显式方法授权。
  - 在 `api/router/handlers/category.js` 的 `list()` 中仅允许管理员（`includeDeleted && isAdmin`）查看已软删除的分类记录。

#### 7. [High] `_tasks` 异步分发丢失调用方 `constraints` (`api/router/handlers/tasks.js:processTasks:missing-constraints-propagation`)
- **问题根因**:
  同步转发 `forwardRequest` 会将 `sessionUser.permit.constraints`（例如外部设备 Passport 的 `$owner: { field, value }` 行级隔离约束）签入 `X-Router-Token`；但 `processTasks`（`api/router/handlers/tasks.js`）构造异步任务签名令牌时未传入 `constraints`，导致状态机或业务方法派生的后台 `_tasks` 在下游微服务执行时脱离了调用方的行级隔离约束。
- **修复措施**:
  - 在 `api/router/index.js` 调用 `handlers.tasks.processTasks` 时传入 `sessionUser.permit?.constraints || null`。
  - 在 `api/router/handlers/tasks.js` 的 `processTasks` 中接收 `constraints` 参数，并在非空时将其签入 `authPayload.constraints`。

#### 8. [Medium] `system.capability.list` 通配符权限与非 `all: true` 过度暴露 (`api/router/handlers/service.js:capabilities:wildcard-permit-and-ai-discovery-overexposure`)
- **问题根因**:
  `api/router/handlers/service.js` 的 `capabilities()` 在过滤非公开、`ai: false` 方法时调用了 `authHandlers.checkPermission(permit, val.service, key)`。由于 `checkPermission` 对 `permit.allow_all === true` 和服务级通配符 `permit.services[svc] = ['*']` 均返回 `true`，导致：(1) 管理员未传 `params.all = true` 时第 306 行的过滤开关失效；(2) 持有服务级 `['*']` 的非管理员（如普通操作员或业务 Bot）在自省列表中看到仅限管理员调用的 `ai: false` 方法（如 `fulfillment.instance.override`、`fulfillment.profile.approve`、`fulfillment.token.*`）。
- **修复措施**:
  - 在 `api/router/handlers/service.js` 的 `capabilities()` 过滤循环中，仅当方法为 `val.ai === true`、`val.public === true` 或调用方在 `permit.services[val.service]` 中**显式列名授权**（`Array.isArray(allowedMethods) && allowedMethods.includes(key)`）时才向非 `all: true` 响应暴露，彻底消除通配符越权暴露并恢复管理员 `params.all === true` 的语义。

---

## 三、 验证与门禁结果 (Verification & Gate Results)

1. **单元测试与回归测试**:
   - `api/apps/fulfillment/tests/{logic.test.js,returns-contract.test.js,generate.test.js,profile-lanes.test.js,lint.test.js}` 全部通过。
   - `api/router/tests/{service.test.js,tasks.test.js,auth.test.js,category_protocol.test.js,capability.test.js,security/access.test.js}` 全部通过。
2. **SOLO Autocheck 静态与一致性门禁**:
   - `node api/autocheck/checker.js api/apps/fulfillment --static` → `Failed: 0`
   - `bash deploy/precheck.sh` → 全部微服务 `Failed: 0`
