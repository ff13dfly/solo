# Nexus (Agent 资产与管控中枢)

> 外部 AI 接入 / 受控执行的总体设计见 [`docs/planning/VERSION.md`](../../../docs/planning/VERSION.md)（v1.1 = 受信外部 agent 投稿档）。

## 1. 核心定位

Nexus 是 Solo 多智能体生态的 **全局 Agent 运行时路由中枢**。

任何微服务需要调用 AI 能力时，都通过 Nexus 解析"谁处理这个事件、如何触达"，而不是在代码里硬编码 Agent 身份。这是热拔插的前提：管理员在 Nexus 里 disable 旧 Agent、注册新 Agent，所有调用方下次查询自动路由到新 Agent，无需改代码重新部署。

Bot 账号管理统一放在 `user` 服务（`user.bot.*`），不新建独立的 authority 服务（见 ADR 1.4.1 / `docs/protocol/zh/security.md §7`）。

### 与其它 Core 服务的分工

| 服务 | 职责 |
|------|------|
| `nexus` | Agent 注册、生命周期、**运行时路由决策**（"谁处理、怎么触达"） |
| `user` | Bot 账号与 Token 签发（`user.bot.*`），permit 权限管理 |
| `orchestrator` | 执行 workflow，完成时发布领域事件；需要 AI 介入时查询 nexus 解析路由 |
| `notification` | 物理投递（Inbox / Webhook / SSE），重试与死信（"怎么发"） |

Nexus 是路由的**决策层**：知道哪个 Agent 订阅了什么事件、当前如何触达。Notification 是**执行层**：只管把消息投递出去，不关心业务语义。

### 统一路由模型（两个轨道共用）

```
微服务需要 AI 能力
  ↓
nexus.sentinel.resolve({ event: 'EVENT:WORKFLOW:STATUS:PENDING_REVIEW' })
  ↓ 返回 { agentId, reachability, endpoint }
  ↓
按 reachability 分发：

  built-in  → 进程内直接调用（Agent 作为库内嵌在调用方服务中）
  rpc       → callRpc(endpoint, payload)（Agent 作为独立微服务）
  webhook   → 委托 notification.send → Webhook 投递到外部进程
  sse       → 委托 notification.send → SSE 推送到在线 Adapter
```

两个轨道的区别只在最后一跳的传输方式，路由决策本身统一走 nexus。轨道一（内部 AI）和轨道二（外部 AI）都能热拔插，无需改代码。

---

## 2. 系统职责边界

### A. 资产注册与热拔插

- **注册**：管理员通过 `nexus.sentinel.create` 创建 Agent 档案。Agent 的 bot 账号身份（如需）由管理员在 portal/system Bot Accounts 页单独创建，Nexus 档案通过 `authorityRole` 字段记录关联的角色标识。
- **热拔插**：管理员"禁用" Agent 时，nexus 将档案状态置为 `DISABLED`，后续事件路由跳过该 Agent。
- **台账**：提供管理员全局视图——系统中活跃的 Agent 数量、轨道（内部/外部）、状态。

### B. 触达状态维护

- 跟踪 MCP Adapter 上报的心跳在线状态（通过 TTL key，见 §5）
- 刷新 Agent 最后活跃时间

### C. 事件路由

微服务发布领域事件时，只需关心"发什么事件"，不关心谁在监听。Nexus 维护一张订阅路由表（存于 Redis），事件到来时查表定位目标 Agent，再按其 `reachability` 委托 notification 执行投递或直接 RPC 调用。

### D. 微服务接入规范

**微服务需要 AI 介入时，调用 `nexus.sentinel.resolve` 而非硬编码 Agent 身份。**

```js
// ❌ 错误：硬编码，无法热拔插
await callRpc('security_auditor.analyze', payload);

// ✅ 正确：运行时解析，nexus 决定路由
const { agentId, reachability, endpoint } = await callRpc('nexus.sentinel.resolve', {
  event: 'EVENT:WORKFLOW:STATUS:PENDING_REVIEW',
});
// 再按 reachability 分发
```

**微服务发布领域事件时，通过 Redis Streams XADD，让 Nexus stream consumer 驱动路由。**

```js
// orchestrator workflow 完成时
await redis.xadd('EVENT:WORKFLOW:STATUS', '*',
  'workflow_id', id,
  'status', 'PENDING_REVIEW',
  'message_id', uuid(),
);
// nexus 消费后自动路由到订阅了这个 stream key 的 Agent
```

两种接入方式可以组合使用：同步 AI 调用用 `resolve`，异步事件通知用 XADD。

---

## 3. 显式耦合点

系统里有两处跨服务的初始化操作，设计为**显式管理员动作**而非隐藏的自动副作用。这样做的原因：隐式自动写入会在代码里埋下跨服务契约，六个月后维护者看不出为什么一个服务要偷偷写另一个服务的配置。显式操作让契约可见、可重试、可审计。

### 耦合点 A：Bot Accounts → 服务（INJECT）

Bot 账号创建后，token 必须显式部署到目标服务，该服务才能以 bot 身份发出 RPC 调用。

```
portal/system Bot Accounts → CREATE → INJECT
                                         ↓
                              {service}.token.set（经 Router）
                              服务 relay 拿到 token，可以对外调用
```

操作文档：`docs/runbook/bot-bootstrap.md`

### 耦合点 B：Nexus Agent → notification（BROADCAST）

SSE / Webhook reachability 的 Agent 创建后，必须显式广播投递配置到 notification，消息才会实际投递出去（而不是只写 inbox）。

```
portal/system Nexus Sentinels → CREATE → BROADCAST
                                          ↓
                               notification.config.set（经 Router，system.nexus token）
                               notification worker 拿到规则，可以按 channel 投递
```

操作文档：`docs/runbook/nexus-agent-bootstrap.md`

### 两处耦合点对比

| | INJECT | BROADCAST |
|---|---|---|
| 触发时机 | Bot 账号创建后 | Nexus Agent 创建后（sse/webhook） |
| 写入目标 | 目标服务的 relay token slot | notification 的投递配置 |
| 不操作的后果 | 服务无法发出跨服务 RPC 调用 | 消息只进 inbox，不实际投递 |
| 可重试 | 是，重新点 INJECT | 是，重新点 BROADCAST |

---

## 4. Agent 接入流程

### 内部 Bot（轨道一）

管理员操作顺序：

1. 在 portal/system **Bot Accounts** 页创建 bot 账号（`user.bot.create`），uid 取 `system.nexus.sentinel.<标识>`，配置最小 permit（枚举该 Sentinel 要读的 `service.method`）
2. `user.bot.issue.token` 签发该 bot 的 token
3. 在 portal/system **Nexus Sentinels** 页注册 Agent 档案（`nexus.sentinel.create`），`authorityRole` 填上一步那个 `system.*` uid，连同事件订阅、触达方式
4. **（§1.2 per-Sentinel 身份）** 把第 2 步的 token 通过 `nexus.sentinel.token.set({ authorityRole, token, expiresAt })` 注入 Nexus —— 此后该 Sentinel 的 `data_fetchers` 经 `relay.callAs` 以**它自己的 bot 身份**发起，Router 按这个 bot 的窄 permit 兜底，审计也归属到它。注入后 Nexus 会按需自动续签（`user.token.refresh`）
5. 若 reachability 为 sse 或 webhook，点 **BROADCAST** 推送投递配置到 notification

> `authorityRole` 不是 `system.*`（或第 4 步未注入 token）时，该 Sentinel 退回共享 `system.nexus` 身份发 fetch（legacy，非破坏）。手动发证：bot/token 由管理员维护，Nexus 只持有并续签。

两步解耦：bot 账号管理和 nexus 档案管理独立操作，不互相阻塞。

**禁用与吊销**：`nexus.sentinel.disable` 停投递并**丢弃** Nexus 持有的该 Sentinel token（软退役）；真正吊销活动 session 需管理员（portal admin）另调 `user.token.revoke({ uid: authorityRole })`（admin-gated，Nexus bot 无此权限）。

### 外部 App（轨道二）

员工个人授权的 AI（如 Claude Desktop），Token 由员工自己管理，Nexus 只做档案注册和事件路由，不介入 Token 签发。创建 Agent 后若需要 webhook/sse 投递，同样需要点 BROADCAST。

---

## 5. Agent 档案结构

```json
{
  "id": "abc123def456",
  "name": "工作流安全审核 AI",
  "description": "审核外部 AI 提交的 PENDING_REVIEW workflow",
  "authorityRole": "system.nexus.sentinel.workflow_auditor",
  "track": "internal",
  "eventSubscriptions": [
    "EVENT:WORKFLOW:STATUS:PENDING_REVIEW"
  ],
  "reachability": "webhook",
  "status": "ACTIVE",
  "online": false,
  "lastSeenAt": null,
  "createdAt": 1747000000000
}
```

`authorityRole` 记录该 Sentinel 的身份 bot。取 `system.*`（Bot Accounts 里的账号）并经 `nexus.sentinel.token.set` 注入 token 后，它就是**承载身份的字段**：该 Sentinel 的 `data_fetchers` 在它自己的最小 permit 下运行（§1.2）。取非 `system.*` 时仅为描述性，fetch 退回共享 `system.nexus` 身份。Nexus 持有并自动续签注入的 token，但不创建/吊销 bot 账号（手动发证，由管理员维护）。

---

## 6. 高可用约束（工程要点）

### 事件总线：Redis Streams（非 pub/sub）

orchestrator 发布事件使用 Redis Streams，而非 `PUBLISH/SUBSCRIBE`：

```
# 发布（orchestrator 侧）
XADD EVENT:WORKFLOW:STATUS * workflow_id xxx status PENDING_REVIEW

# 消费（nexus 侧，consumer group 保证至少投递一次）
XREADGROUP GROUP nexus consumer1 BLOCK 5000 STREAMS EVENT:WORKFLOW:STATUS >
```

pub/sub 是 fire-and-forget，Nexus 进程重启期间发布的事件会永久丢失。Streams 有持久化和 consumer group ACK 机制，Nexus 重启后从断点续消费，不丢事件。

### SSE 在线状态：心跳 TTL key（非进程内存）

```
# MCP Adapter 每 30 秒写入（连接存活时）
SET NEXUS:SENTINEL:ONLINE:{agent_id} 1 EX 60

# Nexus 判断在线状态
EXISTS NEXUS:SENTINEL:ONLINE:{agent_id}  → 1 = ONLINE，0 = OFFLINE
```

Adapter 进程挂掉后，60 秒内 key 自然过期，状态自动变 OFFLINE。

### 重试与死信委托给 notification

Nexus 不处理网络 I/O，所有 Webhook 重试、指数退避、死信入队均由 notification 负责。

### 事件幂等

每个 Event Payload 携带全局唯一 `message_id`，要求接收端实现幂等去重，防止 Streams consumer 重试导致重复触发。

---

## 7. 状态性说明

| 组件 | 有状态类型 | 进程重启后 |
|------|-----------|-----------|
| Nexus Stream consumer | Redis Streams（持久） | 从断点续消费，不丢事件 |
| Notification worker | Redis 队列（持久） | 重新 BLPOP，队列中任务不丢 |
| SSE 在线状态 | TTL heartbeat key（持久） | 60 秒后自动 OFFLINE |

---

## 8. 当前实现状态

| 功能 | 状态 |
|------|------|
| `nexus.sentinel.create / list / get / disable` | ✅ 已实现 |
| `nexus.sentinel.heartbeat` | ✅ 已实现 |
| `nexus.sentinel.resolve`（运行时路由解析） | ✅ 已实现 |
| `nexus.sentinel.broadcast`（显式推送投递配置） | ✅ 已实现 |
| `nexus.schedule.create / get / list / update / delete`（定时任务 CRUD，admin） | ✅ 已实现 |
| Stream consumer（读取 + reachability 路由 + ACK）| ✅ 已实现 |
| 时间驱动调度器（`logic/scheduler.js`：进程内 setInterval，从 `NEXUS:SCHEDULE` zset 弹出到期项，触发 `emit_event` / `run_command`，event.md §6.2）| ✅ 已实现 |
| `notification.send` → Agent inbox 写入 | ✅ 已实现 |
| Nexus relay token（`system.nexus` bootstrap）| ✅ 已实现（见 `docs/runbook/bot-bootstrap.md`） |
| §1.2 per-Sentinel 身份（`authorityRole`=`system.*` → `data_fetchers` 经 `relay.callAs` 走该 Sentinel 自己的 bot permit + 审计归属；配置时预审；`disable` 软吊销）| ✅ 已实现（手动发证：`nexus.sentinel.token.set` 注入；硬吊销由 admin `user.token.revoke`） |
| 上游事件发布（orchestrator XADD `EVENT:WORKFLOW:STATUS/RESULT` + Router `event.emit`）| ✅ 已实现（orchestrator runner.js + router `event.emit`/`_event`，event.md §4） |
| Agent 下游消费（SSE / polling / webhook）| ❌ 未实现，pipeline 出口断开 |
| Webhook 投递模式（notification 侧）| ❌ 未实现 |

路由管道的中间段（stream consumer → notification inbox）结构已通，上游入口也已接通：orchestrator 在 workflow 完成/失败后 XADD `EVENT:WORKFLOW:RESULT/STATUS`，Router 提供 `event.emit` / `_event` 主动发布通道（供 nexus 调度器、orchestrator worker 等后台循环使用，event.md §4）。下游消费（Agent 侧 SSE / polling / webhook）尚未实现，pipeline 出口仍断开。

下一步优先级：补齐 Agent 下游消费端，使路由管道端到端可测。
