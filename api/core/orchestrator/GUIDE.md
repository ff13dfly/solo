# orchestrator 服务任务配方

> 由 fleet-standard `guide` 方法下发（经 Router：`system.guide { service: "orchestrator" }`）。
> 与服务代码同目录、同 commit 更新。方法签名与参数约束以 `methods` 自省为准，
> 本文只讲自省说不出的**任务流程与语义**。

## 这是什么

工作流模板的 CRUD + 执行引擎。一个 workflow 是一串 `steps`，每步调另一个服务的方法；
新建的模板必须**经他人审核**才能执行。ACTIVE 的 workflow 会被 mcp 适配器映射成 MCP tool。
`steps[]` 的每项形如 `{ id, service, method, params, compensate? }`，`params` 里可注入
`$input.* / $config.* / $step.<id>.* / $context.*`（见 config 描述）；`compensate` 指向**另一个** step 的
id，作为该步的 Saga 回滚（不允许补偿链，补偿步自身不能再带 compensate）。

## 配方一：建模板 → 提审 → ACTIVE → 执行（完整生命周期）

1. `orchestrator.workflow.create { category, name, desc, steps, ... }`
   —— 落库即 `PENDING_REVIEW`，**不能自己执行**。`category` 是对象（旧库可能是字符串）。
2. **换一个人**调 `orchestrator.workflow.approve { id }`。**自审禁止**：approver ≠ submitter，同一 uid 只算一票。
   - 低风险（LOW）：单签（C1 快车道）直接 → `ACTIVE`。
   - 高风险（HIGH，足迹里含敏感/写方法）：走多签。第一次不带 `signature` 调用，拿回
     `{ status:'NEEDS_SIGNATURE', digest, gateId }`；用 `user.key.sign` 签 `digest`，再带 `signature` 重调；
     每个审批人重复，达阈值才 `ACTIVE`。激活后可能有**冷静期** `effective_at`（默认 24h），到点前不能跑。
3. 激活后调 `orchestrator.workflow.build` 刷新 AI 能力快照（供 agent 识别 / MCP 映射），否则新模板对 AI 不可见。
4. 执行见配方二。

## 配方二：执行一个 ACTIVE workflow（同步 vs 异步）

- **同步**：`orchestrator.workflow.run`（或短别名 `orchestrator.run`）`{ workflowId, input }`——
  行内执行、立即返回 `{ status:'completed'|'failed', trace, ... }`，**不产生 run 实体**。适合要拿结果的调用。
- **异步**（管理员）：`orchestrator.run.enqueue`——入队后台 worker 执行，产生 **run 实体**（`orchestrator.run.list/get` 可查）。
  状态机：`RUNNING → DONE / FAILED / STALLED / PAUSED_AWAITING_HUMAN / DEADLETTER`。

**幂等与重跑**（异步路径）：at-least-once。worker 死在半路会把 run 标 `STALLED`；用 `orchestrator.run.retry`
从头重驱——**原 triggerId 保留**，已提交的 step 靠幂等键在下游去重，**前提是下游是幂等感知的**。
瞬时错误自动退避重试（上限 5 次）后进死信队列（DEADLETTER）。

**权限缺口暂停**：bot permit 不够覆盖某 step，run 转 `PAUSED_AWAITING_HUMAN` 并给 ops 发告警；
管理员用 `orchestrator.run.grant { id, methods }` 一次性放行并重入队，或 `orchestrator.run.abort` 放弃。

## 配方三：下线 / 改版一个 workflow

- `orchestrator.workflow.deprecate`：**只对 ACTIVE**，ACTIVE → `DEPRECATED`（"退役一个上线模板"，与丢弃草稿的 delete 分开审计）。
- `orchestrator.workflow.delete`：软删（标 `DELETED`，不真删，保留执行历史），任意状态可用，是钝器/应急路径。
- `orchestrator.workflow.restore`：把 DELETED/REJECTED/DEPRECATED 拉回 **`PENDING_REVIEW`**——
  **永远回到重审**，绝不直接复活成 ACTIVE（旧签名一律作废）。
- 改内容用 `orchestrator.workflow.update`：ACTIVE 模板的 `steps`/`resolvers`/`require_actor_permit` 被**冻结**
  （改不动，防绕过审批）；改 PENDING 模板的这些字段会**作废在途的审批签名**（digest 变了）。

## 坑与约定

- **自审禁止**：approve / restore 换人做；submitter 不能给自己的模板投票。
- **时间戳是毫秒数字**（`createdAt/updatedAt/...` 均 `Date.now()`），**不是 ISO 字符串**——别当字符串解析。
- **软删语义**：delete 不物理删；判"存活"看 `status`（DELETED/REJECTED/DEPRECATED 都不是可执行态），别只看存在与否。
- **外键命名** `{targetService}Id`：跑的时候用 `workflowId`，不是 `id`。
- **提报限流**（非管理员建模板）：每人默认 10 次/小时 + 全局 PENDING 积压上限 100，超了 `FORBIDDEN`。
- `run.enqueue / list / get / grant / abort / retry / trace` 及 `token.* / control.*` 都是**管理员**方法。
- 本服务满足不了你的任务时，把缺口提到 `system.report`（用法见 Router guide §6），不要绕野路子。
