# approval 服务任务配方

> 由 fleet-standard `guide` 方法下发（经 Router：`system.guide { service: "approval" }`）。
> 与服务代码同目录、同 commit 更新。方法签名与参数约束以 `methods` 自省为准，
> 本文只讲自省说不出的**任务流程与语义**。

## 这是什么

Solo 审批协议（SAP）：把任意 `service:entity:id` 的**变更意图**纳入受控、可审计的审批，
服务本身内容中立、不需被审服务改造。两条**互相独立**的审批线：

- **record**：顺序三段签 SAP（request → verify → confirm），带 append-only 证据链。
- **gate**：并行 m-of-n 多签门（open → sign×m → APPROVED），orchestrator 高风险通道用。

## 配方一：发起一次变更审批（record 三段链）

1. `approval.record.request { target, payload }` → 生成 `INIT` 记录，返回 `id`。
   - `target` 是 `service:entity:id` 表达式；`payload` 是非空 `Operation[]`，
     每个 op 的 `op ∈ UPDATE|DELETE|ADD` 且 `field` 必填。
2. 另一个人 `approval.record.verify { id }` → `INIT → DISPATCHED`（核准内容）。
3. 再一个人 `approval.record.confirm { id }` → `DISPATCHED → DONE`，盖 `confirmedAt`。
4. 任意时刻可 `approval.record.reject { id, reason? }` → `INIT|DISPATCHED → REJECTED`。

**独立审批人是硬约束**：verify 者不能是申请人，confirm 者必须区别于**前面所有**签署人——
走完 request→verify→confirm 至少要三个不同身份（collection 退款门即靠此要求 3 个独立审批人）。

**幂等 / 防重放**：record 段无独立幂等键，重复 `request` 会新建记录；但状态机天然防重放——
对已 `DISPATCHED` 的记录再 `verify` 直接 `FORBIDDEN`（非法迁移一律拒绝）。

## 配方二：高风险多签门（gate，m-of-n）

1. `approval.gate.open { subject, digest, requiredSigners, expiresInSec? }` → `OPEN`，返回 `id`。
   - `digest` 是被批对象定义的 hex 串（16–128 位）；`requiredSigners` 即阈值 m（默认 1）；
     `expiresInSec` 不传默认 72h。
2. 每个审批人先用 `user.key.sign` 对 **gate 的 `digest`** 签名，再
   `approval.gate.sign { id, approverUid, signature }`。
3. 累计到 m 个**不同** approver 的有效签名 → 自动翻 `APPROVED`。
   - `sign` 返回**进度对象** `{ id, state, signed, required }`（不是完整实体）——
     要判断是否通过，读 `state === 'APPROVED'` 或 `signed >= required`。
   - 提交人（`submitterUid`）不能签自己的门；同一 `approverUid` 只计一次。
4. 人工否决 `approval.gate.reject { id, reason? }` → `REJECTED`。

**过期 fail-closed**：`OPEN` 门过了 `expiresAt`，下一次读/签会惰性翻成 `EXPIRED`，无法再签。

## 坑与约定

- **state ≠ status**：`state` 是 SAP 状态机（record: `INIT|DISPATCHED|DONE|REJECTED`；
  gate: `OPEN|APPROVED|REJECTED|EXPIRED`）；`status` 是实体软删生命周期 `ACTIVE|DELETED`。
  判断审批进度看 `state`，别看 `status`。
- **时间戳是 epoch 毫秒数字**（`Date.now()`），不是 ISO 字符串——
  `createdAt/updatedAt/confirmedAt/expiresAt/approvedAt` 皆然。
- **身份不靠参数传**：申请人/签署人取自 Router 验证过的会话（`ctx.actor`），你只提交内容，
  系统记录"谁在何时对哪个 payloadHash 操作"。自审/独立审批人比较是 uid 字符串比较。
- **签名可选但两条线签的东西不同**：编码都是 bs58 Ed25519、验签走 `user.key.public`
  （含已退休历史公钥）。record 段签的是 `stageDigest = sha256("{target}\n{stage}\n{payloadHash}")`；
  gate 段直接签 `open` 传入的 `digest`——**别混用**。record 段不传 `signature` 即
  server-attested（仅记录事实）；`gate.sign` 的 `signature` 必填。
- **可见面收窄**：面向外部 AI 的只有 `record.request/get/list`；`verify/confirm/reject`
  与整条 gate 线是 verifier / 人工 / orchestrator 内部通道（方法级权限由 Router `checkAccess` 把关）。
- 本服务满足不了你的任务时，把缺口提到 `system.report`（用法见 Router guide §6），
  不要静默放弃或绕野路子。
