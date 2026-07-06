# Agent 上下文组装协议 (Agent Context Assembly Protocol)

> [!NOTE]
> **实现状态:v1 已落地(2026-06-05)。** 核心三件套已在 `api/core/nexus/` 实现并通过 e2e:
> `context.guard`(JsonLogic 触发判断)+ `context.data_fetchers`(DAG 声明式拉只读数据)+
> `context.system_prompt_template`(`{{event.*}}/{{fetch.*}}/{{agent.*}}` 插值渲染)。
> 事件到达 → nexus 在投递前装配 → 产出 Context Payload 进 Agent inbox。
> **`context.autorun=true` 时再闭合一步**:nexus 把渲染好的 prompt 直接交给 `agent` 服务的 LLM
> (`agent.chat`)、产出回填 `context.output`,实现 event→装配→**LLM**→产出 全链路(§11)。
> 判断引擎复用 `api/library/jsonlogic.js`(与 fulfillment 共享)。
>
> **本版与原草案的两点接地修正**(原草案早于 ADR 1.4.1 写就):
> 1. **授权不再依赖 `authority.role.get`**(authority 服务不存在)。改为:配置时**只读后缀**静态闸 +
>    运行时经 **nexus 服务账号**(`library/relay.js`)发起、Router `checkAccess` 用其 permit 动态兜底。见 §5.1。
> 2. **投递:inbox 轮询(模式 C)+ autorun 内建闭环已通**;webhook/sse 这两种**外部** Agent runtime 出口尚未就绪(`gateway.webhook.send` 缺失,见 README / toFix)。
>
> 示例中的 `crm` 等业务服务**不存在**(SOLO 是纯框架,见 `CLAUDE.md` §2),仅作声明式配置形态的示意。
> **未尽事项**(按 Agent 各自 bot token 执行 fetch、webhook/sse 投递、`agent.update` 改 context)见 §11.2。

---

> **协议版本**: 1.2.0
> **状态**: v1 已实现(guard / data_fetchers / system_prompt_template);人机协同(§10)仍为草案
> **作者**: Fuu
> **许可证**: Apache 2.0

---

## 摘要

本协议扩展了 Nexus 的 Role Schema，定义 AI Agent 在被事件触发时如何**声明式地**从 Solo 微服务生态中获取数据、渲染系统提示词，并以结构化 Context Payload 的形式交付给 Agent。

上下文组装由 Nexus 在事件到达后、调用 Agent 前完成。Agent 无需自行发起数据拉取，收到的 Payload 即为完整工作上下文。

本协议还定义了**人机协同**机制：人类员工可加入 Agent 会话，将自身在 Solo 系统中的权限注入协同会话 Token，扩展 Agent 在该会话内可调用的方法范围，实现人机联合排查与决策。

---

## 1. 简介

### 1.1 问题背景

Nexus Role Schema（见 `api/core/nexus/README.md` §4）定义了 Agent 的身份、权限引用和事件订阅，但没有定义 Agent 被唤醒时应携带哪些业务数据。

没有上下文组装规范时，每个 Agent 需要在收到事件后自行拉取业务数据，导致：

- 数据获取逻辑分散在各 Agent 实现中，无法统一管控
- Agent 代码耦合具体 RPC 方法，Solo 接口变更时需各 Agent 同步修改
- 权限边界模糊，Agent 可能拉取超出其职责范围的数据

### 1.2 设计目标

| 目标 | 说明 |
|------|------|
| **可组合** | 复用 Solo 已有的 RPC 方法，无需专属数据通道 |
| **声明式** | 由 `role_schema.context` 配置驱动，不写代码 |
| **权限内** | 所有 fetcher 方法必须在 Agent 的 `authority_role` 授权范围内，创建时静态校验 |
| **只读约束** | 组装过程只调用读操作，不产生副作用 |
| **透明可审计** | 组装步骤记录在 Nexus 事件日志中 |

### 1.3 与相关协议的关系

```
事件到达
    ↓
Nexus 路由（api/core/nexus/README.md）
    ↓
上下文组装（本协议）← 调用 Solo RPC 方法
    ↓
notification 投递（notification 协议）
    ↓
Agent 收到 Context Payload，开始工作
```

---

## 2. Role Schema 扩展

在 Nexus Role Schema 基础上新增可选字段 `context`：

```json
{
  "role_id": "bot:workflow_auditor",
  "name": "工作流安全审核 AI",
  "description": "审核 PENDING_REVIEW 工作流，结构校验 + 风险分级",
  "authority_role": "bot:workflow_auditor",
  "event_subscriptions": ["EVENT:WORKFLOW:STATUS:PENDING_REVIEW"],
  "reachability": {
    "mode": "webhook",
    "url": "http://internal-auditor/webhook",
    "secret": "..."
  },

  "context": {
    "system_prompt_template": "你是工作流安全审核员，专责审核 PENDING_REVIEW 状态的工作流。\n\n待审工作流：\n{{fetch.workflow}}\n\n提交人：{{fetch.submitter.name}}（{{fetch.submitter.email}}）",

    "data_fetchers": [
      {
        "key": "workflow",
        "method": "orchestrator.workflow.get",
        "params": { "id": "{{event.workflow_id}}" },
        "result_path": "data"
      },
      {
        "key": "submitter",
        "method": "authority.user.get",
        "params": { "userId": "{{fetch.workflow.created_by}}" },
        "result_path": "data",
        "depends_on": ["workflow"],
        "on_error": "fallback",
        "fallback": { "name": "未知用户" }
      }
    ]
  }
}
```

`context` 字段为可选项。不声明时，Agent 收到的 Payload 仅包含原始事件数据。

### 2.1 触发判断 `guard`（JsonLogic）

`context` 可携带一个可选的 `guard` —— 一段 [JsonLogic](https://jsonlogic.com/) 表达式，在装配**最前面**对事件做布尔判断：**为真才唤醒该 Agent 并继续装配，为假则整条跳过（不拉数据、不投递）**。这把"事件订阅"从"流级粗筛"细化到"载荷级精筛"，无需为每种条件单开一个事件流。

```json
{
  "context": {
    "guard": { "and": [
      { "==": [ { "var": "event.status" }, "PENDING_REVIEW" ] },
      { ">":  [ { "var": "event.amount" }, 1000 ] }
    ] },
    "data_fetchers": [ ... ]
  }
}
```

判断引擎是共享原语 `api/library/jsonlogic.js`（同一套被 fulfillment 状态机的 transition 守卫复用）。`guard` 的变量命名空间此刻只有 `{{event.*}}`（数据尚未拉取）。

每个 `data_fetcher` 也可带 `guard`（见 §4.1）——满足才拉该项，不满足则该 key 置 `null`；此时可引用 `{{event.*}}` 和**已完成的** `{{fetch.*}}`。

---

## 3. 变量命名空间

上下文组装使用 `{{namespace.path}}` 语法进行变量插值，支持点号路径访问嵌套字段。

| 命名空间 | 来源 | 示例 |
|---------|------|------|
| `event` | 触发此次组装的事件 Payload | `{{event.workflow_id}}` |
| `fetch` | 已完成的 data_fetcher 结果 | `{{fetch.workflow.name}}` |
| `agent` | 本 Agent 的档案字段 | `{{agent.name}}`, `{{agent.role_id}}` |

### 3.1 路径语法

| 语法 | 说明 | 示例 |
|------|------|------|
| `{{ns.field}}` | 顶层字段 | `{{event.workflow_id}}` |
| `{{ns.a.b.c}}` | 嵌套路径 | `{{fetch.workflow.steps.0.id}}` |
| `{{fetch.key}}` | 整个 fetcher 结果（JSON 序列化后插入模板） | `{{fetch.workflow}}` |

路径某层为 `null` / `undefined` 时，按该 fetcher 的 `on_error` 规则处理（见 §6）。

---

## 4. data_fetchers 规范

### 4.1 字段定义

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | string | ✅ | 唯一标识，供后续 fetcher 和模板通过 `{{fetch.key}}` 引用 |
| `method` | string | ✅ | Solo RPC 方法名（`{service}.{entity}.{action}` 格式） |
| `params` | object | ✅ | 调用参数，值支持 `{{...}}` 插值 |
| `result_path` | string | ❌ | 从 RPC 响应 `result` 字段中提取数据的点号路径（默认取完整 `result`） |
| `depends_on` | string[] | ❌ | 前置 fetcher key 列表，声明后方可引用其结果；同层无依赖的 fetcher 并行执行 |
| `on_error` | string | ❌ | 失败策略：`abort`（默认）\| `skip` \| `fallback` |
| `fallback` | any | ❌ | `on_error: fallback` 时的替代值，插入 `{{fetch.key}}` 命名空间 |
| `guard` | object | ❌ | JsonLogic 判断：为真才执行本 fetcher，为假则该 key 置 `null`（不发 RPC）。可引用 `{{event.*}}` 与已完成的 `{{fetch.*}}`（见 §2.1） |

### 4.2 result_path

Solo RPC 响应体为 JSON-RPC 标准的 `result` 字段，内部结构因方法而异（常见 `result.data`、`result.items`）。`result_path` 用点号路径从 `result` 中提取目标数据：

```
result_path: "data"        → result.data
result_path: "items.0"     → result.items[0]
result_path:（省略）        → result（完整 result 字段）
```

### 4.3 执行顺序（DAG）

Nexus 根据 `depends_on` 构建有向无环图（DAG），同层无依赖的 fetcher **并行**执行：

```
示例 data_fetchers 执行计划：

[workflow]                ← 无依赖，立即执行
       ↓
[submitter, risk_config]  ← 均依赖 workflow，并行执行
       ↓
[risk_score]              ← 依赖 risk_config
```

循环依赖在 `nexus.agent.create` 校验阶段检测并拒绝。

---

## 5. 执行流程

```
事件到达 Nexus Stream Consumer
        ↓
查路由表 → 找到目标 Agent 档案，读取 role_schema.context
        ↓（context 不存在则跳至最后一步）
① 解析事件 Payload → 建立 {{event.*}} 命名空间
        ↓
② 按 DAG 顺序执行 data_fetchers
   · Nexus 系统账号经 Router 调用各 RPC 方法
   · 同层 fetcher 并行，层间串行
   · 将 result_path 提取的结果挂载到 {{fetch.<key>}} 命名空间
        ↓
③ 渲染 system_prompt_template（变量插值）
        ↓
④ 组装 Context Payload（见 §6）
        ↓
委托 notification 投递（Webhook / SSE）
```

### 5.1 执行权限（已接地：双层授权）

> **接地修正**：原草案靠 `authority.role.get(authority_role)` 取 `allow_methods` 做配置时子集校验。但 **authority 服务不存在**（ADR 1.4.1：bot 账号统一走 `user.bot.*`）。v1 改为下面的**双层**模型——配置时纯静态闸 + 运行时 Router 动态兜底，不依赖任何不存在的服务。

**① 配置时（`nexus.agent.create`，纯函数静态校验，`api/core/nexus/logic/context.js#validateContext`）**

```
nexus.agent.create 的 context 校验：
1. 每个 data_fetcher.method 的动作段（最后一个 . 后）必须是只读后缀：
   get / list / query / search / count / resolve / info       —— 否则拒绝（挡住写方法当 fetcher）
2. fetcher key 唯一
3. depends_on 引用的 key 必须存在
4. depends_on 构成的图无环（DFS 三色法）
5. guard / system_prompt_template / on_error 类型合法
全部通过才建档。
```

**② 运行时（事件到达，装配阶段）**

data_fetchers 的 RPC 调用由 **Nexus 服务账号**（`library/relay.js` 的 `system.nexus` token）经 Router 发起。Router 的 `checkAccess` 用该 bot 的 permit **动态兜底**：fetcher 方法若超出 nexus 服务账号的 permit，直接 `FORBIDDEN`。即"配置时挡只读越界，运行时挡权限越界"。

> **未尽（§11.2）**：理想是按 **Agent 各自的 bot token** 执行 fetch（每-Agent 最小权限 + 数据级 `constraints` 随之生效）。v1 统一走 nexus 服务账号；要做到每-Agent 身份，需 nexus 侧持有/解析各 Agent 的 bot token（后续硬化）。

校验失败则拒绝创建，返回具体原因：

| 错误码 | 原因 |
|--------|------|
| `-32602` | fetcher method 含写操作后缀（非只读） |
| `-32602` | depends_on 存在循环依赖 |
| `-32602` | depends_on 引用了不存在的 key |
| `-32602` | fetcher key 重复 / guard / template / on_error 类型非法 |
| `FORBIDDEN`（运行时） | fetcher method 超出 nexus 服务账号 permit |

---

## 6. Context Payload（发给 Agent 的结构）

组装完成后，Nexus 向 Agent 发送标准化 Context Payload：

```json
{
  "message_id": "msg_abc123",

  "event": {
    "type": "EVENT:WORKFLOW:STATUS:PENDING_REVIEW",
    "payload": {
      "workflow_id": "wf_xyz",
      "status": "PENDING_REVIEW",
      "timestamp": 1746000000
    }
  },

  "context": {
    "system_prompt": "你是工作流安全审核员，专责审核 PENDING_REVIEW 状态的工作流。\n\n待审工作流：\n{\"id\":\"wf_xyz\",...}\n\n提交人：张三（zhang@example.com）",
    "data": {
      "workflow": { "id": "wf_xyz", "steps": [...], "created_by": "u_001" },
      "submitter": { "id": "u_001", "name": "张三", "email": "zhang@example.com" }
    },
    "agent": {
      "id": "agent_auditor_01",
      "name": "工作流安全审核 AI",
      "role_id": "bot:workflow_auditor"
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `message_id` | 全局唯一，接收端用于幂等去重（与 Nexus §5 保持一致） |
| `event.type` | 触发事件的 Stream key |
| `event.payload` | 事件原始数据 |
| `context.system_prompt` | 渲染后的系统提示词（`context` 未声明时为空字符串） |
| `context.data` | 所有 fetcher 结果，按 key 索引（`context` 未声明时为 `{}`） |
| `context.agent` | 本 Agent 的身份信息 |

`context.data` 由 Nexus 预取完毕，Agent 直接使用，无需再次调用 RPC。

---

## 7. 错误处理

### 7.1 fetcher 级错误

| `on_error` 值 | RPC 调用失败 / 业务错误 | 路径取值为 null |
|---------------|------------------------|----------------|
| `abort`（默认）| 中止组装，整个事件进死信队列 | 同左 |
| `skip` | 跳过，`{{fetch.key}}` 为 `null`，模板中该插值渲染为空字符串 | 同左 |
| `fallback` | 使用 `fallback` 值填充 `{{fetch.key}}` | 同左 |

### 7.2 系统级错误

| 场景 | 处理 |
|------|------|
| 模板渲染失败（变量路径不存在且无 fallback） | 组装失败，事件进死信队列 |
| DAG 执行超时（单个 fetcher 超过 5 秒） | 视为 RPC 调用失败，按 `on_error` 处理 |
| Nexus 系统账号 Token 失效 | 组装失败，告警，事件进死信队列 |

### 7.3 投递可靠性：成功才 ack + 退避重试 + 死信（✅ 已实现）

> 实现要点：**不再静默丢**。Redis Stream 消费组本身就是持久、可重投的队列（PEL），无需另起 worker。

- **成功才 ack**：一条事件投递到它所有订阅者**全部成功**才 `xAck`（移出 PEL）；任一失败 → **不 ack**，留在 PEL。
- **退避重试**：每条 pending 用 `NEXUS:RETRY:{stream}:{id}` 记尝试次数，指数退避（`retryBaseMs · 2^(n-1)`，封顶 `retryMaxMs`）。消费循环每轮在读新消息（`'>'`）后，再读本消费者的 pending（`'0'`）按退避重试 —— **崩溃留在 PEL 的条目也由此恢复**。
- **死信**：超过 `maxDeliveries` 次仍失败 → 写入 **`NEXUS:DLQ`** Stream（字段：`sourceStream / sourceId / event(原始扁平字段 JSON) / attempts / failedAt`）并 ack（停止重试）。管理员经 **`nexus.dlq.list`** 查看、**`nexus.dlq.retry`** 把原始事件重投回源流并删除该 DLQ 条目。
- **幂等**：投递携带 `ref =` 源流条目 id；`notification.send` 按 `(targetId, ref)` 去重（`NOTIFICATION:DEDUP:{targetId}:{ref}`，SET NX），故重试/重投**绝不重复落 inbox**。

> 实现说明：DLQ 是**单条全局 `NEXUS:DLQ` 流**（非草案设的 per-agent `NEXUS:DLQ:{agent_id}`），条目里带 `sourceStream/sourceId` 足以定位与重投。代码 `nexus/logic/stream.js`（settle/recoverPending/moveToDLQ）+ `nexus/logic/dlq.js`；e2e `67-nexus-dlq`。

---

## 8. 安全考虑

| 风险 | 缓解措施 |
|------|----------|
| fetcher 越权读取 | 创建时静态校验 method ∈ authority_role.allow_methods |
| fetcher 触发写操作 | 创建时检查方法动作后缀；Nexus 账号的 permit 也仅授读方法 |
| Prompt Injection | `system_prompt_template` 由管理员在 `nexus.agent.create` 时写入，不接受用户输入 |
| fetch 结果注入模板 | `{{fetch.key}}` 整体插值时对 `}}` 转义，防止注入闭合插值语法 |
| 横向数据获取 | fetcher params 只可引用 `{{event.*}}`、`{{fetch.*}}`、`{{agent.*}}`，不能硬编码其他 Agent 的 ID |
| Payload 传输安全 | Webhook 投递附带 HMAC-SHA256 签名（Nexus `reachability.secret`）；SSE 通道已有 Bearer 鉴权 |

---

## 9. 完整示例

### 9.1 工作流审核 Agent（多步骤依赖）

```json
{
  "role_id": "bot:workflow_auditor",
  "name": "工作流安全审核 AI",
  "description": "审核 PENDING_REVIEW 工作流，结构校验 + 风险分级",
  "authority_role": "bot:workflow_auditor",
  "event_subscriptions": ["EVENT:WORKFLOW:STATUS:PENDING_REVIEW"],
  "reachability": {
    "mode": "webhook",
    "url": "http://internal-auditor/webhook",
    "secret": "s3cr3t"
  },
  "context": {
    "system_prompt_template": "你是工作流安全审核员。\n\n待审工作流（JSON）：\n{{fetch.workflow}}\n\n提交人：{{fetch.submitter.name}}\n\n请输出 PASS / LOW / MEDIUM / HIGH 并附说明。",
    "data_fetchers": [
      {
        "key": "workflow",
        "method": "orchestrator.workflow.get",
        "params": { "id": "{{event.workflow_id}}" },
        "result_path": "data"
      },
      {
        "key": "submitter",
        "method": "authority.user.get",
        "params": { "userId": "{{fetch.workflow.created_by}}" },
        "result_path": "data",
        "depends_on": ["workflow"],
        "on_error": "fallback",
        "fallback": { "name": "未知用户" }
      }
    ]
  }
}
```

### 9.2 CRM 跟进建议 Agent（并行获取）

```json
{
  "role_id": "bot:crm_advisor",
  "name": "客户跟进建议 AI",
  "authority_role": "bot:crm_advisor",
  "event_subscriptions": ["EVENT:CRM:OPPORTUNITY:STALE"],
  "reachability": { "mode": "sse" },
  "context": {
    "system_prompt_template": "你是销售顾问助手。\n\n商机信息：{{fetch.opportunity}}\n\n客户历史活动（最近 5 条）：{{fetch.activities}}\n\n请给出具体的下一步跟进建议。",
    "data_fetchers": [
      {
        "key": "opportunity",
        "method": "crm.opportunity.get",
        "params": { "id": "{{event.opportunity_id}}" },
        "result_path": "data"
      },
      {
        "key": "activities",
        "method": "crm.activity.list",
        "params": { "opportunityId": "{{event.opportunity_id}}", "limit": 5 },
        "result_path": "items"
      }
    ]
  }
}
```

> `opportunity` 与 `activities` 无依赖关系，Nexus 并行执行，减少等待时间。

### 9.3 无 context 的简单事件 Bot

```json
{
  "role_id": "bot:event_logger",
  "name": "事件记录 Bot",
  "authority_role": "bot:event_logger",
  "event_subscriptions": ["EVENT:SALE:ORDER:CREATED"],
  "reachability": { "mode": "webhook", "url": "http://logger/hook", "secret": "..." }
}
```

此时 Agent 收到的 Payload 中 `context.system_prompt` 为空字符串，`context.data` 为 `{}`。

---

## 10. 人机协同 (Human Collaboration)

> [!WARNING]
> **本节（§10）仍为设计草案，未实现。** v1 只落地了 §1–§9 的自动装配；协同会话 Token、权限叠加、双归因审计尚无代码。

### 10.1 设计动机

Agent 的 `authority_role` 通常被严格限制在最小权限集（只读、单一领域）。当 Agent 遇到需要写操作或跨领域数据的场景——如确认一个高风险工作流、修正一条异常库存记录——Agent 本身无权推进。

人机协同解决这个问题：**人类员工以自身的 Solo 权限"入场"，扩展当前会话的可用方法范围**，Agent 和人共同完成 Agent 单独无法完成的任务。

### 10.2 role_schema 的 collaboration 字段

在 Role Schema `context` 同级新增可选字段 `collaboration`：

```json
{
  "role_id": "bot:workflow_auditor",
  "authority_role": "bot:workflow_auditor",
  "event_subscriptions": ["EVENT:WORKFLOW:STATUS:PENDING_REVIEW"],
  "reachability": { "mode": "webhook", "url": "...", "secret": "..." },
  "context": { "..." },

  "collaboration": {
    "mode": "optional",
    "notify_roles": ["operator:workflow_manager"],
    "prompt_extension": "\n\n当前协同人：{{collab.name}}，其补充指令：{{collab.input}}"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mode` | string | ✅ | `optional`：人可加入但 Agent 不等待；`required`：Nexus 先通知人、等待人加入后再触发 Agent；`on_request`：Agent 主动请求时才发起协同邀请 |
| `notify_roles` | string[] | ❌ | 收到协同邀请通知的 Authority role 列表；省略时仅人主动加入 |
| `prompt_extension` | string | ❌ | 人加入后追加到 `system_prompt` 末尾的模板片段，支持 `{{collab.*}}` 变量 |

### 10.3 协同发起方式

三种路径均可触发协同会话：

```
① 事件触发时自动通知（mode: required / notify_roles 已配）
   Nexus 发布事件 → 组装上下文 → 通知 notify_roles 中的人
                                      ↓（人接受邀请）
                                  协同会话建立 → Agent 触发

② 人主动加入（Portal "加入协同" 按钮）
   人在 Portal 看到进行中的 Agent 任务 → 点击加入
   → nexus.collab.join({ session_id, userId }) → 协同会话建立

③ Agent 请求人介入（mode: on_request）
   Agent 处理过程中遇到决策边界 → 返回信号 { "request_human": true, "reason": "..." }
   → Nexus 发送协同邀请给 notify_roles → 人加入后 Agent 继续
```

### 10.4 协同会话 Token（权限叠加）

人加入时，`authority` 服务签发一个**短生命周期的协同会话 Token**：

```
authority.collab.create({ agent_id, collaborator_id: userId, session_id })
  → 返回 collab_token（TTL 30 分钟，可续期）
```

该 Token 的有效方法集 = **`agent.authority_role.allow_methods ∪ collaborator.permit.services`**：

```
Agent 单独可用：
  orchestrator.workflow.get / list

Agent + 协同人（workflow_manager）可用：
  orchestrator.workflow.get / list       ← 来自 agent role
  orchestrator.workflow.approve          ← 来自 collaborator permit
  orchestrator.workflow.reject           ← 来自 collaborator permit
  authority.user.get                     ← 来自 collaborator permit
```

协同期间所有 RPC 调用（fetcher 或 Agent 发起的工具调用）均使用 `collab_token`。Router 对该 Token 的鉴权逻辑与普通 Token 一致，仅增加 `collab` 类型解析。

**关键约束**：人只能将自身拥有的权限注入协同 Token，不能超出自身 permit 范围。

### 10.5 Context Payload 扩展

人加入后，Nexus 向 Agent 推送更新的 Context Payload，新增 `context.collaborator` 字段：

```json
{
  "message_id": "msg_abc124",
  "event": { "..." },
  "context": {
    "system_prompt": "你是工作流安全审核员。...\n\n当前协同人：李明，其补充指令：这个工作流是紧急上线需求，请重点检查步骤 3。",
    "data": { "workflow": { "..." }, "submitter": { "..." } },
    "agent": { "id": "agent_auditor_01", "name": "工作流安全审核 AI", "role_id": "bot:workflow_auditor" },
    "collaborator": {
      "userId": "u_manager_001",
      "name": "李明",
      "role": "operator:workflow_manager",
      "input": "这个工作流是紧急上线需求，请重点检查步骤 3。",
      "session_id": "collab_sess_xyz",
      "joined_at": 1746001200
    }
  }
}
```

`{{collab.*}}` 变量命名空间（用于 `prompt_extension` 模板）：

| 变量 | 说明 |
|------|------|
| `{{collab.name}}` | 协同人姓名 |
| `{{collab.role}}` | 协同人的 Authority role |
| `{{collab.input}}` | 协同人最新输入的文字指令 |
| `{{collab.session_id}}` | 协同会话 ID，用于续期或主动结束 |

### 10.6 审计双归因

协同会话期间产生的所有 WAL 日志条目同时记录两个主体：

```json
{
  "op": "orchestrator.workflow.approve",
  "agent_id": "agent_auditor_01",
  "collaborator_id": "u_manager_001",
  "session_id": "collab_sess_xyz",
  "stamp": 1746001350
}
```

**人加入即承担责任**：协同 Token 下的操作同时归属于 Agent 和协同人，任何一方事后均不可抵赖。这与 YAP 审批协议的不可抵赖目标一致。

### 10.7 会话结束

| 结束方式 | 触发 |
|---------|------|
| 人主动离开 | `nexus.collab.leave({ session_id })` |
| Token 过期 | 30 分钟 TTL 到期，可在过期前调 `nexus.collab.renew` 续期 |
| Agent 任务完成 | Agent 返回终态信号，Nexus 自动结束协同会话 |
| 人被强制踢出 | 管理员调用 `nexus.collab.revoke` |

会话结束时 `authority` 吊销 `collab_token`，后续调用被 Router 拒绝。

### 10.8 安全约束

| 风险 | 缓解措施 |
|------|----------|
| 人借协同无限扩权 | 协同 Token = agent ∪ collaborator，不超出协同人自身 permit |
| 协同会话被滥用 | `collab_token` 绑定 `session_id`，离开或过期后立即失效 |
| 静默提权（无审计） | 协同会话对管理员全程可见；WAL 双归因；Portal 有活跃协同列表 |
| 伪造协同邀请 | 邀请通过 notification 服务投递，携带 Nexus 系统账号签名 |

---

## 11. 实现映射与未尽事项

### 11.1 已实现（v1，代码映射）

| 协议要素 | 代码位置 |
|----------|----------|
| `validateContext`（配置时只读后缀 + DAG 无环静态闸，§5.1①） | `api/core/nexus/logic/context.js#validateContext` |
| 装配执行器（guard → DAG 拉取 → 渲染 → Context Payload，§5/§6） | `api/core/nexus/logic/context.js#createAssembler` |
| `{{namespace.path}}` 插值（§3） | 同上 `interpolate()` |
| JsonLogic 判断引擎（guard，§2.1） | `api/library/jsonlogic.js`（与 fulfillment `apps/fulfillment/logic/rules.js` 共享同一原语） |
| 事件到达 → 装配 → 投递接入点 | `api/core/nexus/logic/stream.js#deliverEvent`（Agent 有 `context` 则装配，否则透传原始事件） |
| **autorun 闭环（装配 → 调 LLM → 产出回投）** | `stream.js#deliverEvent` 内：`context.autorun=true` 时，nexus 作为 built-in agent runtime，经 Router（system.nexus bot）调 `agent.chat`，把产出挂到 `context.output` 一并投递。LLM 在 `agent` 服务（模型选择见 `agent/logic/model_config.js`）。离线测试用 mock provider：`agent/providers/mock.js`（`AI_PROVIDER=mock`） |
| `context` 字段声明 | `api/core/nexus/handlers/entities.js`、`nexus.agent.create` 的 `context` 参数（含 `autorun`） |
| **投递可靠性（成功才 ack + 退避重试 + DLQ + 幂等，§7.3）** | `nexus/logic/stream.js`（settle / recoverPending / moveToDLQ）+ `nexus/logic/dlq.js`（`nexus.dlq.list/retry`）+ `notification/logic/message.js`（`(targetId, ref)` 去重） |
| 端到端 + 单元测试 | e2e `65-nexus-context`（装配）+ `66-nexus-autorun`（装配→mock LLM→产出）+ `67-nexus-dlq`（重试→死信→重投 + 幂等），full profile；单元 `nexus/tests/context.test.js` + `nexus/tests/dlq.test.js` + `agent/tests/mock-provider.test.js`（hermetic，CI 白名单） |

执行流程与草案 §5 一致：guard 不满足 → 跳过不投递；fetcher 按 `depends_on` 分层、层内并行；`on_error` 支持 `abort`（默认，装配失败不投递半成品）/ `skip` / `fallback`。

**autorun（nexus-hosted built-in agent）**：`context.autorun=true` 时，装配出的 `system_prompt` 由 nexus 直接交给 `agent.chat`，LLM 产出回填到 Context Payload 的 `context.output`（+ `context.model`）。LLM 调用失败不挡装配投递（`output=null` + `autorun_error`）。这是 §11.2"下游消费出口"的**内建路径**；外部/自管 Agent runtime 仍可走 polling/webhook 自行消费 Context Payload 再调模型。

### 11.2 未尽事项（按优先级）

> **完整的 nexus 待办（含本协议外的运维/生命周期/订阅路由等）汇总在 `docs/planning/BACKLOG.md`。** 本表只列上下文装配协议自身的未尽。

| 项 | 说明 | 关联 |
|----|------|------|
| **消费流硬编码（订阅路由）** | 消费者只读固定的 `EVENT:WORKFLOW:STATUS/RESULT`；agent 订阅其它流会静默失效。见 `BACKLOG.md §2.1` | `nexus/config.js` consumer.streams |
| **每-Agent bot token 执行 fetch / autorun** | 运行时现统一走 nexus 服务账号（fetch + agent.chat 都用 system.nexus）；理想按各 Agent 自身 bot 身份发起，使数据级 `constraints` 随之生效 | §5.1② |
| **webhook / sse 投递出口** | autorun 闭环已通（产出回投 inbox）；但 webhook/sse 这两种**外部** Agent runtime 的投递仍断（`gateway.webhook.send` 缺失、SSE 未建） | README / `toFix.md` #2 |
| **autorun 仅 `agent.chat`** | v1 autorun 固定调 `agent.chat(system_prompt)`；多能力（如 `agent.text.parse` 结构化产出）/ 自定义入参映射未做 | §11.1 |
| **`nexus.agent.update` 改 context** | 现 context 只能在 create 时设；改 context 需重建 Agent | — |
| **人机协同（§10）** | 协同会话 Token / 权限叠加 / 双归因审计 | §10 |

---

## 附录 A. 变更日志

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| 1.4.0 | 2026-06-05 | 投递可靠性（§7.3 落地）：消费组成功才 ack + 指数退避重试 + `NEXUS:DLQ` 死信 + `nexus.dlq.list/retry`；`notification.send` 按 `(targetId, ref)` 幂等；e2e `67-nexus-dlq`。消除"失败静默丢" |
| 1.3.0 | 2026-06-05 | autorun 闭环：`context.autorun=true` → 装配后经 nexus 调 `agent.chat`(LLM)、产出回填 `context.output`，端到端 e2e（66）通过；`agent` 服务加离线 mock provider 进 full profile/CI |
| 1.2.0 | 2026-06-05 | v1 落地：`guard`(JsonLogic 触发判断)+ `data_fetchers` + `system_prompt_template` 实现并通过 e2e；授权接地（去 authority.role，改只读静态闸 + 服务账号运行时兜底）；新增 §2.1、§11 |
| 1.1.0 | 2026-05-10 | 新增第 10 节：人机协同机制 |
| 1.0.0 | 2026-05-10 | 初始版本 |

## 附录 B. 相关协议

- [Nexus README](../../../api/core/nexus/README.md) — Role Schema 基础定义与事件路由
- [工作流协议](./workflow) — `_tasks` 分发、变量解析（`$input/$step`）
- [安全协议](./security) — 服务间信任与权限模型
- [配置协议](./config) — system service account 机制（ADR-007 前置条件）
- [审批协议](./approval) — YAP 不可抵赖签名链（与协同双归因互补）
