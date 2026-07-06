# 履约生命周期协议 (Fulfillment Lifecycle Protocol)

> [!WARNING]
> **实现状态：核心已实现，但有已知不一致。** 声明式状态机/Profile/JsonLogic 条件/`_tasks` 发射均可用。注意：(1) 转移方法参数实际为 `event`，而 `handlers/introspection.js` 误声明为 `toState`；(2) 状态转移的 `history` 记录暂未写 `reason` 字段。示例中的 erp/sale/commodity 等为业务举例，SOLO 本身不含这些服务。

---

> **协议版本**: 1.5.0
> **状态**: 草案 (Draft)
> **作者**: Antigravity & Fuu & Claude

---

## 1. 简介

### 1.1 设计目标
本协议定义了 SOLO·AI 系统中通用的"生命周期引擎"规范。它将具体的业务流程从硬编码中解耦，通过声明式的状态机和逻辑规则（JsonLogic）驱动业务流转。

| 目标 | 说明 |
|------|------|
| **领域无关** | 兼容贸易订单、售后服务、任务管理等任何具备状态的实体 |
| **逻辑驱动** | 使用 JsonLogic 定义状态切换条件和参数映射 |
| **异步任务集成** | 通过 `_tasks` 或 `orchestrator` 触发跨服务协同 |
| **长周期协同** | 跨天/跨周的等待由状态机持久化承担，编排器只处理状态切换瞬间的短促执行 |
| **审计追溯** | 强制记录完整的状态变更历史（History） |

---

## 2. 核心数据结构

### 2.1 履约实例 (Fulfillment Instance)
存储在微服务中的状态快照。

```json
{
  "id": "FL-20260311-001",
  "sourceId": "ORD-123",
  "profileId": "standard_trade",
  "state": "DEPOSIT_PENDING",
  "prevState": "DRAFT",
  "stateChangedAt": 1741660462000,
  "meta": {
    "payment_status": "PENDING"
  },
  "pending_callbacks": [
    {
      "executionId": "exec-abc123",
      "workflowId": "erp-sync-on-deposit",
      "on_complete": {
        "event": "erp_synced",
        "meta_patch": { "erpOrderId": "ERP-789" }
      },
      "retry_count": 0,
      "last_error": null
    }
  ],
  "history": [
    {
      "state": "DRAFT",
      "event": "order_submitted",
      "reason": "MANUAL",
      "user": "uid-admin",
      "stamp": 1741660412000
    }
  ]
}
```

**pending_callbacks 字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `executionId` | string | 编排器执行实例 ID，用于幂等锁 |
| `workflowId` | string | 对应的 workflow ID |
| `on_complete.event` | string | 处理成功后触发的事件名 |
| `on_complete.meta_patch` | object | 合并写入 `instance.meta` 的字段 |
| `retry_count` | number | 处理失败的重试次数 |
| `last_error` | string\|null | 最近一次失败的错误信息 |

**history 字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `state` | string | 进入该记录时的状态 |
| `event` | string | 触发本次状态变更的事件名 |
| `reason` | string | 结构化原因码（见附录 C） |
| `user` | string | 操作者 uid |
| `stamp` | number | Unix 时间戳（毫秒） |

> ⚠️ 实现现状：仅初始创建记录含 `reason`，状态转移记录暂未写 `reason`（待补）。

### 2.2 履约配置模板 (Fulfillment Profile)
定义合法的状态切换、触发事件和关联动作。Profile 是声明式配置，不含任何业务逻辑代码。

```json
{
  "id": "standard_trade",
  "name": "标准业务履约",
  "version": "1.0.0",
  "states": ["DRAFT", "DEPOSIT_PENDING", "DEPOSIT_CONFIRMED", "SOURCING",
             "PACKING", "READY_TO_SHIP", "DISPATCHED", "DELIVERED",
             "SETTLED", "CLOSED", "ON_HOLD", "CANCELLED", "DISPUTE"],
  "transitions": [
    {
      "event": "payment_received",
      "from": "DEPOSIT_PENDING",
      "to": "DEPOSIT_CONFIRMED",
      "condition": {
        "and": [
          { "==": [{ "var": "instance.meta.payment_status" }, "SUCCESS"] },
          { ">=": [{ "var": "instance.meta.amount_received" }, { "var": "instance.meta.deposit_required" }] }
        ]
      },
      "actions": [
        {
          "type": "workflow",
          "workflowId": "erp-sync-on-deposit",
          "input": {
            "instanceId": { "var": "instance.id" },
            "sourceId": { "var": "instance.sourceId" }
          },
          "on_complete": {
            "event": "erp_synced",
            "meta_patch": {
              "erpOrderId": "$step.sync.result.id"
            }
          }
        }
      ]
    }
  ],
  "ai_hooks": [
    {
      "trigger": {
        "event": "payment_received",
        "condition": { ">": [{ "var": "instance.meta.amount_received" }, 50000] }
      },
      "invoke": "risk.creditAssessment",
      "input": ["instance", "user"],
      "disposition": "human_confirm",
      "confidence_threshold": 0.85,
      "outcome_map": {
        "approve": { "event": "credit_approved" },
        "hold":    { "event": "hold_requested",   "reason": "AI_RECOMMENDED" },
        "reject":  { "event": "cancel_requested", "reason": "AI_RECOMMENDED" }
      }
    }
  ]
}
```

**transition 字段说明：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `event` | 是 | 触发本次切换的事件名，同一 `(from, to)` 可有多个 event |
| `from` | 是 | 来源状态 |
| `to` | 是 | 目标状态 |
| `condition` | 否 | JsonLogic 条件，缺省则无条件允许 |
| `actions` | 否 | 切换成功后发射的动作列表（见下方 Action 类型） |

**Action 类型说明：**

| `type` | 说明 | 适用场景 |
|--------|------|----------|
| `task`（默认） | 通过 `_tasks` fire-and-forget 执行单个 RPC | 通知、日志、非关键副作用 |
| `workflow` | 调用编排器执行多步 workflow，支持 `on_complete` 回调 | 需要步骤编排、有结果回流的业务操作 |

**`type: "workflow"` 专属字段：**

| 字段 | 说明 |
|------|------|
| `workflowId` | 编排器中已定义的 workflow ID |
| `input` | 传入 workflow 的初始参数，支持 JsonLogic 变量注入 |
| `on_complete.event` | workflow 完成后回调给 fulfillment 的事件名 |
| `on_complete.meta_patch` | 用 workflow 执行结果更新 `instance.meta` 的字段映射（`$step.` 路径引用编排器的步骤结果） |

**`type: "task"` 专属字段：**

| 字段 | 说明 |
|------|------|
| `service` | 目标服务名 |
| `method` | RPC 方法名 |
| `params` | 调用参数，支持 JsonLogic 变量注入 |

### 2.3 Profile 存储规范
Profile 是运行时热加载的核心数据，存储在 Redis 中：

```
KEY:   FULFILLMENT:PROFILE:{profileId}
TYPE:  String (JSON)
TTL:   无（持久化）

示例:
  FULFILLMENT:PROFILE:standard_trade  → { ...Profile JSON... }
```

**版本管理：**
- Profile 变更时，旧版本归档至 `FULFILLMENT:PROFILE:{profileId}:v{version}`
- 已存在的履约实例继续使用创建时的 Profile 版本
- 新实例使用最新版本

---

## 3. 运行机制

### 3.1 状态切换逻辑 (Transition)
当调用 `fulfillment.transition` 方法时，引擎按以下步骤操作：

> ⚠️ 已知不一致：`handlers/introspection.js` 当前把参数误声明为 `toState`，实现实际读 `event`；以 `event` 为准（待修）。

1. **加载 Profile**：从 Redis 读取 `instance.profileId` 对应的 Profile。
2. **匹配规则**：在 `transitions` 中寻找 `event` 和 `from`（= 实例当前状态）均匹配的候选定义；目标状态不由调用方传入，而是从命中的 transition 的 `to` 字段派生。
3. **条件校验**：将上下文注入变量作用域，运行 JsonLogic（见 3.2）。
4. **状态持久化**：更新 `state`、`prevState`、`stateChangedAt`，向 `history` 追加记录。
5. **动作发射 (Action Emission)**：按 Action 类型分别处理：
   - `type: "task"` → 解析 `params`，放入响应的 `_tasks` 字段，由 Router fire-and-forget 执行。
   - `type: "workflow"` → 解析 `input`，调用编排器 `orchestrator.workflow.run`，注册 `on_complete` 回调（见 3.3）。
6. **AI 钩子触发**：检查 `ai_hooks`，满足触发条件的钩子按 `disposition` 处理（见 6.2）。

### 3.2 变量解析作用域
在 `condition`、`actions.params`、`ai_hooks.trigger.condition` 中，JsonLogic 的数据上下文为：

```json
{
  "instance": { },
  "user": "uid-xxx",
  "permit": "admin",
  "constraints": { }
}
```

引用方式均使用 JsonLogic 标准 `{ "var": "path.to.field" }` 语法：

```json
{ "var": "instance.meta.payment_status" }
{ "var": "permit" }
{ "var": "constraints.maxAmount" }
```

> **注意**：文档中描述变量路径时使用点路径表示法（如 `instance.meta.payment_status`），不加任何前缀符号。

### 3.3 长周期协同模型

**核心原则：等待发生在状态节点上，不发生在 Workflow 内部。**

Workflow 天然不适合挂起等待数天——它运行在单次 HTTP 请求内，必须在秒级完成。跨天/跨周的业务等待由履约实例持久化在 Redis 承担，外部事件到达后再触发下一次切换。

```
时间轴示例（业务履约）

Day 0   ── payment_received 事件
            → transition: DEPOSIT_PENDING → DEPOSIT_CONFIRMED
            → 触发 workflow "erp-sync-on-deposit"（秒级完成）
            → on_complete 回调：meta_patch { erpOrderId } + 触发 erp_synced 事件
            → transition: DEPOSIT_CONFIRMED → SOURCING

            履约实例持久化停在 SOURCING
            （等待供应商/工厂确认，可能 3～7 天）

Day 4   ── supplier_confirmed 事件（外部系统或人工触发）
            → transition: SOURCING → PACKING
            → 触发 workflow "warehouse-packing-init"（秒级完成）
            → on_complete 回调：meta_patch { packingOrderId }

            履约实例持久化停在 PACKING
            （等待包装完成确认）

Day 5   ── packing_completed 事件
            → transition: PACKING → READY_TO_SHIP
            ...
```

**等待期间系统的状态：**
- 履约实例保持在当前状态，随时可查询
- 没有任何进程挂起或占用资源
- 超时检测由独立的定时任务扫描 Redis 中的实例完成（不在此协议范围内）

**`on_complete` 回调机制：懒求值（Lazy Evaluation）策略**

`on_complete` 采用**懒求值**而非主动 Push：Workflow 完成时，编排器将结果写入 `instance.pending_callbacks`，不立即触发事件。处理时机由 `fulfillment.instance.get`（view）在每次被调用时触发：

```
用户/系统 view instance
    → 检查 instance.pending_callbacks 是否非空
    → 遍历处理：meta_patch 合并 + 触发 on_complete.event
    → 清除已处理的 callback 条目
    → 返回最新 instance
```

**选择懒求值的理由：**
- 业务履约以天为单位推进，无需毫秒级响应
- 人在回路：人查看订单的时机即为最自然的处理时机
- 不需要激活 `engine.tick()` 或额外的消息队列基础设施

**关键实现要点：**

1. **并发幂等**：多个并发 view 同时检测到 pending callback 时，使用 Redis `SET NX` 对 `executionId` 加锁，防止重复处理。

2. **失败容错**：callback 处理失败时不向调用方抛出错误，保留该条目在 `pending_callbacks` 中，更新 `retry_count` 和 `last_error`，下次 view 时重试。

3. **全局 Review（懒触发，非阻塞）**：不依赖定时任务，改用**全局水位线（Watermark）**机制。任意 view 操作时，检查水位线是否落后于当前日期，若落后则 fire-and-forget 推送一个全局扫描任务。

**编排器所需的最小改动：**
在现有 `runner.js` 的 `run()` 方法末尾，将执行结果写入 `instance.pending_callbacks`（约 20 行），无需改动编排器的核心结构。

---

### 3.4 全局 Review 触发机制（Watermark）

**设计目标**：让 AI 具备主动感知全局状态的能力，同时不引入定时任务（容易挂起、难以追踪）。

**核心模式：全局水位线 + view 懒触发**

Redis 中维护一个全局水位线：

```
KEY: FULFILLMENT:GLOBAL:LAST_REVIEW_DATE
VAL: "2026-03-11"
```

在每次 `fulfillment.instance.get`（view）时，附加以下非阻塞逻辑：

```
view instance
  → 处理 pending_callbacks（见 3.3）
  → 读取 LAST_REVIEW_DATE，对比今日日期
  → 若落后：Redis SET NX 抢占更新（确保同一天只触发一次）
      → 抢到：_tasks fire-and-forget 推送 fulfillment.internal.globalReview
      → 未抢到：跳过（已有其他请求触发）
  → 返回 instance（不等待 globalReview 完成）
```

**`globalReview` 任务做什么：**
- 扫描所有未终态实例，检查各状态停留时长是否超过 Profile 定义的 `max_stay_duration`
- 对超时实例写入 `pending_callbacks`（触发 ai_hook 类型：`stale_check`）
- 更新水位线（由任务本身写入，确保时序正确）

**为什么这个设计可靠：**

| 特性 | 说明 |
|------|------|
| 零 cron | 触发源是真实用户访问，无人使用时不做无效扫描 |
| 天然幂等 | `SET NX` 确保同一水位线周期内只触发一次 |
| 不阻塞 | `_tasks` fire-and-forget，view 响应延迟不变 |
| 自愈 | 若某天无访问，次日第一个 view 自动补扫 |

**水位线粒度可配置：**

| 水位线键 | 触发频率 | 适用场景 |
|----------|----------|----------|
| `LAST_REVIEW_DATE` | 每天最多一次 | stale 检测、日度风险汇总 |
| `LAST_REVIEW_HOUR` | 每小时最多一次 | 时效性更高的异常预警 |
| `LAST_REVIEW_COUNT:{N}` | 每 N 次 view 一次 | 流量驱动，适合高频访问场景 |

默认使用 `LAST_REVIEW_DATE`，Phase 1/2 足够。

---

## 4. 安全与约束

### 4.1 权限过滤
- 只有拥有关联业务实体访问权的用户，才能查询或操作其履约实例。
- 敏感状态切换（如 `FINANCE_CLOSED`）应通过 `action` 触发专门的 `approval` 服务流程。

### 4.2 软删除一致性
当 `sourceId` 对应的实体被删除时，履约引擎应根据 Profile 配置自动将实例状态置为 `CANCELLED`，并在 history 中记录 `reason: SOURCE_DELETED`。

---

## 5. 错误处理

| 错误场景 | 错误码 | 说明 |
|----------|--------|------|
| 条件校验不满足 | `TRANSITION_DENIED` (-32010) | 业务规则拒绝，非参数错误 |
| 未找到匹配的 transition | `TRANSITION_NOT_FOUND` (-32011) | 当前状态不支持该事件 |
| Profile 不存在 | `PROFILE_NOT_FOUND` (-32012) | Redis 中无对应 Profile |
| Action 失败 | 仅记录，不报错 | 进入 `ERROR:QUEUE`，不回滚实例状态 |

> Action 属于异步任务，失败不应导致履约实例状态回滚。Router 会将失败任务记录在 `ERROR:QUEUE` 中供运维处理。

---

## 6. AI 治理与安全边界 (AI Governance & Safety)

### 6.1 决策与执行分层
在 SOLO·AI 架构中，采用"双 Agent"协同模式，与长周期协同模型（见 3.3）对齐：

- **Fulfillment Agent（战略层）**：感知履约实例的全局状态，判断当前阶段是否需要推进、选择哪条路径、触发哪个 workflow。它不执行具体操作，只做决策。

- **Task / Workflow Agent（执行层）**：在编排器内完成具体的短促任务序列（秒级），不感知履约全局状态，只负责把当前被分配的工作做好，通过 `on_complete` 将结果回流给 Fulfillment 层。

```
Fulfillment Agent（战略层）
    │  感知：instance.state / instance.meta / history
    │  决策：选择 workflow，或触发 ai_hook
    ↓
编排器 workflow（执行层，秒级）
    │  执行：多步 RPC 调用
    │  结果：通过 on_complete 回调回流
    ↓
fulfillment.callback
    │  更新：instance.meta
    │  触发：下一个 event（可选）
    ↓
Fulfillment Agent 重新感知，进入下一轮决策
```

**关键约束**：执行层（Task / Workflow Agent）不应直接调用 `fulfillment.transition`，状态推进只能由 Fulfillment Agent 或明确授权的人工操作发起，确保决策链路可审计。

### 6.2 AI 介入合约 (AI Hook Contract)
`ai_hooks` 定义了 AI 介入的触发时机、调用方式和结果处置方式。

**触发（trigger）：**
- `event`：在哪个事件发生后触发
- `condition`：JsonLogic 条件，满足时才调用 AI

**调用（invoke）：**
- 指向具体的 AI 能力方法（如 `risk.creditAssessment`）

**输入（input）：**
- 声明传入 AI 的上下文字段列表，限制数据暴露范围

**输出 schema：**
AI 必须按以下结构返回：

```json
{
  "recommendation": "approve | hold | reject",
  "confidence": 0.85,
  "reasons": ["客户首单", "金额超过阈值"]
}
```

**`outcome_map`（建议 → 执行的桥接）：**

`recommendation` 是语义字符串，`outcome_map` 将其映射为具体的状态机事件，由引擎负责转换。AI 不需要知道事件名，事件名不写进模型。

```json
"outcome_map": {
  "approve": { "event": "credit_approved" },
  "hold":    { "event": "hold_requested",   "reason": "AI_RECOMMENDED" },
  "reject":  { "event": "cancel_requested", "reason": "AI_RECOMMENDED" }
}
```

**处置（disposition）：**

| 值 | 说明 |
|----|------|
| `human_confirm` | 生成待确认记录推送责任人，人工采纳后引擎执行 `outcome_map` 对应事件 |
| `auto_execute` | 置信度 >= `confidence_threshold` 时直接执行，否则降级为 `human_confirm` |
| `log_only` | 仅记录 AI 判断，不干预流程 |

**`human_confirm` 待确认记录结构：**

```json
{
  "type": "ai_suggestion",
  "instanceId": "FL-20260311-001",
  "resolved_event": "hold_requested",
  "resolved_reason": "AI_RECOMMENDED",
  "ai_output": { "recommendation": "hold", "confidence": 0.91, "reasons": ["首单大额", "汇率波动"] },
  "disposition": "human_confirm",
  "expires_at": 1741746862000,
  "status": "pending"
}
```

责任人确认时，系统直接执行 `fulfillment.transition(event: resolved_event)`，无需人工判断对应哪个操作。

**完整执行链：**

```
ai_hook 触发
  → AI 返回 { recommendation, confidence, reasons }
  → 引擎查 outcome_map[recommendation] → { event, reason }

  auto_execute（confidence >= threshold）
    → 直接 fulfillment.transition(event)
    → 记录 adopted: true

  human_confirm
    → 生成待确认记录（携带 resolved_event）→ 推送责任人
    → 人工确认 → fulfillment.transition(event) → 记录 adopted: true
    → 人工拒绝 → 记录 adopted: false，不触发任何 transition

  log_only
    → 仅写入观察记录，adopted: null
```

**AI 观察记录：**
无论 disposition 为何，每次 AI 介入都应记录：

```json
{
  "instanceId": "FL-20260311-001",
  "event": "payment_received",
  "invoke": "risk.creditAssessment",
  "output": { "recommendation": "hold", "confidence": 0.91, "reasons": [...] },
  "resolved_event": "hold_requested",
  "disposition": "human_confirm",
  "adopted": true,
  "stamp": 1741660462000
}
```

`adopted` 从此有完整意义：不只是事后记录，而是执行链的最后一步。积累的 `adopted` 数据是模型持续改进的基础。

**ai_hook 字段说明：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `trigger.event` | 是 | 在哪个事件发生后触发 |
| `trigger.condition` | 否 | JsonLogic 条件，满足时才调用 AI |
| `invoke` | 是 | AI 能力方法名 |
| `input` | 否 | 传入 AI 的上下文字段列表，限制数据暴露范围 |
| `disposition` | 是 | `human_confirm` / `auto_execute` / `log_only` |
| `confidence_threshold` | 否 | `auto_execute` 时的置信度阈值，默认 0.8 |
| `outcome_map` | 否 | `recommendation` → `{ event, reason }` 的映射，`log_only` 时可省略 |

### 6.3 三层安全防线
即使 AI 具备探索工作流的自主性，系统通过以下机制确保安全：
1. **协议层（Profile）**：只有明确定义在 `actions` 中的 Service/Method 才能被触发。
2. **路由层（Router Whitelist）**：`_tasks` 机制强制校验调用源与目标服务的白名单关系。
3. **方法层（RPC Permit）**：最终执行方法的服务会验证 `context: task` 的权限令牌，确保 AI 无法执行越权操作。

### 6.4 任务发现机制
AI 可以通过调用 `orchestrator.methods()` 探索可用的工作流，但其在 `fulfillment` 实例中注册的 `action` 必须符合业务配置的 Schema 约束。

---

## 7. Profile 授权与生成契约（NL → Profile）

Profile（§2.2）既可人工编写，也可由 AI 从自然语言生成。为让「**AI 投稿 → 人审 → 框架执行 → 可退回人工**」成为可信闭环，本节把 Profile 的 **schema 当版本化契约**、定义 **校验契约**（机器能检测什么、不能检测什么），以及 **生成 / 投稿生命周期**。schema 本身见 §2.2；存储/版本化见 §2.3。

### 7.1 校验契约（lint contract）

权威实现 = `apps/fulfillment/logic/lint.js`：**纯函数**，对照跨服务 introspection 索引**静态**校验一个 Profile（不跑、不连服务）。它把"会在运行时静默走错分支/失败"的结构错变成激活前的明确报错。

**机器保证（命中 = error = 拒绝激活）：**
1. **source 方法存在**：`meta_fields[].source` 的 `{service}.{method}` 是已注册 API 方法。
2. **pick 路径真实**：`source.pick` 是该方法 `returns_schema` 声明的返回键（方法无返回契约时降级为 warning）。
3. **条件键耦合**：`transition.condition` 里每个 `instance.meta.<X>` 都有同名 `meta_field` 背书（否则 JsonLogic 静默读 `undefined`、不报错地走错分支）。
4. **action 方法存在**：每个 `task` action 的 `method` 是已注册方法（幻觉/改名方法会在运行时被 Router 拒）。
5. **状态图良构**：实例创建即处于初始态 `DRAFT`，故必须有转移**离开 DRAFT**；从「DRAFT 不可达态」出发的转移是**死分支**（warning）。
6. **动作策略（可选，`options.allowedActions`）**：给定允许集时，每个 `task` action ∈ 允许集——镜像 workflow 的 **H6 footprint 预审**，让投稿面在激活前拒掉越权 Profile。

**机器不保证（必须人审 / 真 LLM eval）：**
- **业务意图**：lint 证明"接线对、图能通"，**不证明"这条流程符合需求"**。阈值写反（`≤` 写成 `≥`）、状态语义错配、把"放行"接到"冻结"——lint 一律看不出来。
- **运行时副作用边界**：action 方法存在 ≠ 该 Profile 有权调它。运行时仍由 **§6.3 三层防线**（Profile actions 白名单 → Router `_tasks` 白名单 → RPC permit）兜底；`allowedActions` 只是激活前的镜像预审，**不替代**运行时校验。
- 结论：**人审是本协议的一部分，不是可选项**——lint 把"机器能判的"判到位，"机器判不了的意图"留给人签名背书。

### 7.2 生成路径（NL → 候选）

`fulfillment.profile.generate({ requirement, profileId?, maxRepairs? })`：
1. 服务经 relay 调 `agent.chat`，以「能力上下文（可用方法及其返回字段）+ schema + 需求」为提示词，产出候选 JSON（提示词受 `agent.chat` 4000 字上限约束，目录过大时按预算截断 + 标注省略）。
2. 立即跑 §7.1 lint；有 error 就把 error 回喂 LLM 做**有界修复**（默认 ≤2 轮）。
3. 返回 `{ profile, lintReport:{errors,warnings}, attempts, ok }`，**`ok` = 0 errors = 可激活**。
4. **永不自动创建**——返回候选，由人审后另行 `fulfillment.profile.create`。

operator 门户「✨ 描述生成」即此路径的人审 UI：展示判定 + 错误/警告 + 候选，**「创建」按 lint 干净与否门控**。

### 7.3 投稿生命周期（外部 AI → ACTIVE）

受信外部 agent（B 档，见 [VERSION.md §3.4](../../planning/VERSION.md) / [governance.md](./governance.md)）以**窄 permit bot** 投稿 Profile，流程对齐 workflow 的 C1 审批：
1. 外部 AI 产出 Profile JSON（或经 §7.2 generate）→ 提交。
2. 服务跑 §7.1 lint（带 `allowedActions` = 投稿身份的允许方法集）→ 任一 error 即拒。
3. 通过则落 `PENDING_REVIEW`，进入审批队列（配额 / 快照同 workflow 投稿面）。
4. 人工经**签名审批**（governance.md §3.2）激活为 `ACTIVE`；执行发生在审批背书后的身份下，**投稿身份永不执行**；失败随时退回人工。

> ⚠️ **实现状态**：§7.1（lint 六规则）+ §7.2（generate）+ §7.3 投稿面**核心已落地**（`logic/{lint,generate,profile,instance}.js`）：
> - `profile.submit`（lint 把关 → `PENDING_REVIEW`，broken 直接拒、不入队）/ `profile.approve`（管理员，**审批人 ≠ 投稿人**）/ `profile.reject`；
> - `reviewState` 审批轴（独立于 Factory 的 `status`）+ **激活闸**：`instance.create` **与** `instance.transition`(advance) 都对非 `APPROVED` 的 profile 拒 `FORBIDDEN`（新建 + in-flight 实例都拦）；直建 profile 无 `reviewState` → 仍即用，向后兼容；
> - **激活后完整性闸**：`profile.update` 改可执行字段（`transitions`/`meta_fields`）→ **重新 lint + 回落 `PENDING_REVIEW` + 清审批**（其 in-flight 实例随之冻结，待重审）；元数据改（name/desc）不触发。`approve` 落 **`approvedDigest`**（可执行定义的 sha256 规范化摘要，绑定「批了哪一版」，改一字即变、可验不可抵赖）；
> - hermetic + e2e `102`/`103`/`104` 验证（104 十用例覆盖：lint 闸、不可用、职责分离、审批后可用、驳回、自审禁止、**改可执行字段回审 + 冻结 + 重审恢复 + lint-on-edit + 摘要绑定**）。
>
> **剩（深档，镜像 workflow 投稿面）**：per-identity 投稿配额、高风险 **Ed25519 签名多签审批**（经 approval 服务，governance.md §3.2）、给外部投稿身份（OpenClaw 等）正式授 `profile.submit` 的窄 bot、以及（可选）完整版本归档 + 实例 pin 已批 digest（让 in-flight 跑"批过的那版"而非冻结）。见 BACKLOG。

---

## 附录 A. 状态命名约定

Protocol 不强制规定状态枚举，各 Profile 自定义完整状态集。命名遵循以下约定：

- 全部大写，单词间用下划线连接：`DEPOSIT_CONFIRMED`
- 终态建议以 `CLOSED` 或 `CANCELLED` 结尾
- 旁路态建议用 `ON_HOLD`、`DISPUTE` 等语义明确的名称

**贸易履约参考状态集（standard_trade）：**

| 状态 | 说明 | 类型 |
|------|------|------|
| `DRAFT` | 草稿，可自由编辑 | 常规 |
| `DEPOSIT_PENDING` | 待付订金 | 常规 |
| `DEPOSIT_CONFIRMED` | 订金已确认 | 常规 |
| `SOURCING` | 备货/排产中 | 常规 |
| `PACKING` | 包装处理中 | 常规 |
| `BALANCE_PENDING` | 待付尾款（可选） | 常规 |
| `READY_TO_SHIP` | 待发货 | 常规 |
| `DISPATCHED` | 已发货/运输中 | 常规 |
| `DELIVERED` | 已收货 | 常规 |
| `SETTLED` | 已结算 | 常规 |
| `CLOSED` | 已关闭 | 终态 |
| `ON_HOLD` | 暂停 | 旁路 |
| `DISPUTE` | 争议处理中 | 旁路 |
| `CANCELLED` | 已取消 | 终态 |

---

## 附录 B. 标准事件目录 (Event Catalog)

transition 中的 `event` 字段使用以下标准事件名。事件分三类：

**业务触发（H — 人工或系统操作）**

| 事件名 | 触发时机 | 典型来源 |
|--------|----------|----------|
| `order_submitted` | 订单提交确认 | 销售人工 |
| `payment_received` | 收款到账 | 财务确认 / 支付回调 |
| `credit_approved` | 信用额度审批通过 | 财务审批 |
| `sourcing_started` | 内勤接收备货任务 | 内勤人工 |
| `goods_arrived` | 货品到仓确认 | 仓管确认 |
| `packing_completed` | 包装处理完成 | 仓管确认 |
| `balance_received` | 尾款到账 / 账期豁免 | 财务确认 |
| `dispatched` | 货物离仓，物流单号已录 | 仓管操作 |
| `delivery_confirmed` | 客户签收确认 | 客户 / 物流回调 |
| `dispute_raised` | 客户发起争议 | 客户 / 售后 |
| `dispute_resolved` | 争议协商解决 | 售后人工 |
| `dispute_failed` | 争议协商破裂 | 售后人工 |
| `finance_closed` | 财务核销完成 | 财务人工 |
| `hold_requested` | 请求暂停履约 | 任意角色 |
| `hold_released` | 解除暂停 | 任意角色 |
| `cancel_requested` | 请求取消订单 | 任意角色（需审批） |

**系统回调（Workflow `on_complete` 触发）**

| 事件名 | 触发时机 |
|--------|----------|
| `erp_synced` | ERP 单据同步 workflow 完成 |
| `warehouse_notified` | 仓库通知 workflow 完成 |
| `no_dispute_timeout` | 无争议期满（定时任务触发） |

**命名约定：**
- 全小写，单词间用下划线连接：`payment_received`
- 过去式动词短语，表示"某件事已发生"
- 系统回调事件建议以 `_synced`、`_confirmed`、`_timeout` 结尾，便于区分来源

---

## 附录 C. 标准原因码 (Reason Codes)

history 记录中的 `reason` 字段使用以下标准码：

| 原因码 | 说明 |
|--------|------|
| `MANUAL` | 人工手动操作 |
| `PAYMENT_RECEIVED` | 收款到账触发 |
| `CREDIT_APPROVED` | 信用额度审批通过 |
| `SUPPLIER_CONFIRMED` | 供应商产能确认 |
| `GOODS_ARRIVED` | 货品到仓确认 |
| `DELIVERY_CONFIRMED` | 客户签收确认 |
| `DISPUTE_RESOLVED` | 争议协商解决 |
| `TIMEOUT` | 超时自动触发 |
| `AI_RECOMMENDED` | AI 建议被采纳后触发 |
| `SOURCE_DELETED` | 关联业务实体被删除 |
| `SYSTEM` | 系统自动处理 |
