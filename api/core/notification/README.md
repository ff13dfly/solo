# Notification（统一消息存储与触达引擎）

## 1. 核心定位

**Notification 是 Solo 系统事件通知的唯一可信源。**

这里"系统通知"有明确范围——**不是所有经过 gateway 的消息**，而是特指由系统事件驱动、需要持久化存档的异步通知。

### 两类消息，不同路径

| 类型 | 特征 | 路径 |
|------|------|------|
| **系统通知**（async） | 系统事件触发（workflow 完成、告警、AI Agent 唤醒），需存档，可延迟 | 必须经 notification → gateway |
| **事务性消息**（sync） | 用户行为触发（OTP、验证码、支付确认），必须实时，无需持久化 | 业务服务直接经 Router → gateway |

**事务性消息不应走 notification**：验证码加入异步队列反而增加失败点，语义上也不对——OTP 没有"存档"的意义。auth / user 等服务按需配置 permit，直接调用 `gateway.sms.send`，这不破坏架构，Router 仍是唯一入口。

**系统通知必须走 notification**：触发方是系统事件而非用户操作，接收方需要能随时查历史（Inbox），且通知的可靠投递由 notification 统一保证。

```
系统事件（orchestrator / nexus / 任意服务）
        ↓ notification.send（经 Router）
notification（落库 + 写 Inbox + 写投递队列）
        ↓ worker 消费队列（异步，按 delivery config）
Router（notification service account token）
        ↓
gateway（email / SMS / webhook 实际投递）

目标（人类 / AI Agent）
        ↓ notification.inbox.list（主动 poll）
notification（返回未读消息）

─────────────────────────────────────────────

用户动作（login / 支付等）
        ↓ 业务服务直接调用（经 Router）
gateway（OTP SMS 实时发送）
```

---

## 2. 方法清单

> **方法清单与参数以 introspection 为准** —— 调 `system.introspect` 或读本服务 `handlers/introspection.js`（声明↔注册由 `deploy/check-doc-drift.js` CI 守护）。

方法围绕三组能力组织：消息收发（`notification.send` / `notification.inbox.list` / `notification.inbox.ack`）、投递配置（`notification.config.set/get`，规则结构见 §5）、以及管理面（死信队列 `notification.deadletter.list/requeue` 与 relay token 生命周期 `notification.token.set/status/clear`）。`send` 落库后的投递由后台 worker 异步处理，不通过 `_tasks` 链返回（见 §5）。

---

## 3. 消息类型（type 字段）

| type | 含义 | 主要接收方 |
|------|------|-----------|
| `workflow.approved` | workflow 审核通过 | AI Agent |
| `workflow.rejected` | workflow 审核拒绝 | AI Agent |
| `workflow.completed` | workflow 执行完成 | AI Agent / 员工 |
| `workflow.failed` | workflow 执行失败 | AI Agent / 员工 |
| `system.alert` | 系统告警 | 管理员 |
| `custom` | 自定义，payload 自描述 | 任意 |

---

## 4. Redis 数据结构

```
NOTIFICATION:MSG:{id}
  → JSON string，完整消息体（id / targetId / type / payload / status / createdAt / readAt）

NOTIFICATION:INBOX:{targetId}
  → Sorted Set，score = createdAt timestamp，value = message id
  → 查未读：取出 id 后批量 GET MSG，过滤 status != 'read'

NOTIFICATION:CONFIG:{targetId}
  → JSON string，delivery rules 数组

NOTIFICATION:INDEX
  → Sorted Set（全局），score = createdAt，value = message id（管理员查全量用）
```

---

## 5. 投递机制：Redis 队列 + 后台 Worker

`notification.send` 落库后，若 delivery config 有匹配规则，将投递任务写入 Redis 队列：

```
NOTIFICATION:QUEUE:PENDING  →  List，RPUSH 入队，worker BLPOP 消费
```

Worker 从队列取任务后，以 **notification service account token** 向 Router 发起 JSON-RPC 调用，Router 转发到 gateway 执行实际投递。

**不使用 `_tasks` 链**：`_tasks` 是 fire-and-forget，若 notification 本身是被 `_tasks` 触发的，其返回的 `_tasks` 会被 Router 丢弃。队列 + worker 是自包含的，不依赖调用链深度。

**重复拉起是安全的**：
- notification 是投递的唯一发起方，其他身份的 gateway 投递调用被 Router permit 拦截
- 队列任务携带 `message_id`，gateway 侧可做幂等去重
- Worker 重启后从队列头继续消费，不丢任务

### Service Account Permit 约束

notification service account 的 permit 开通 gateway 投递方法：

```js
{
  services: {
    'gateway': {
      allow: ['gateway.email.send', 'gateway.sms.send', 'gateway.webhook.send']
    }
  }
}
```

其他服务（如 auth 发 OTP）也可以在自己的 permit 里开通 `gateway.sms.send`，这是合理的——permit 控制的是"谁能调"，业务上的约定是"系统通知必须走 notification，事务性消息可以直接走 gateway"。两者不冲突。

---

## 6. 三种触达模式对应关系

| 模式 | 描述 | 实现方式 |
|------|------|---------|
| A：Webhook 主动回调 | AI Agent 注册了 Webhook URL | delivery config `channel: 'webhook'` → worker → `gateway.webhook.send`（**未实现**：配得上但投不出，会进死信） |
| B：SSE 长连推送 | MCP Adapter 保持长连 | delivery config `channel: 'sse'`（待 MCP Adapter 实现后支持） |
| C：Inbox 轮询兜底 | 无状态脚本 AI，主动 poll | `notification.inbox.list`，无需 delivery config |

模式 C 是最简单的，也是最先落地的、当前**唯一端到端可用**的模式。模式 A 依赖 `gateway.webhook.send`（**未建**——worker 会调一个不存在的方法 → 重试 → 死信），模式 B 依赖 MCP Adapter。

---

## 7. 与 gateway 的边界

| 服务 | 职责 |
|------|------|
| notification | 消息存储、Inbox 管理、delivery 路由决策 |
| gateway | 实际 I/O 执行：email / SMS / webhook HTTP 请求 |

gateway 已有 `gateway.email.send` 和 `gateway.sms.send`，notification 直接复用，不重复实现。webhook 投递也走 gateway（需补充 `gateway.webhook.send` 方法）。

---

## 8. 当前状态

**MVP 已实现**（由 e2e suite 50 验证）：
1. `notification.send` + Inbox 存储（模式 C 可用）
2. `notification.inbox.list` + `notification.inbox.ack`
3. `notification.config.set/get`（投递配置可写）；worker 调 `gateway.{channel}.send` 投递
4. 后台 Worker：退避重试 + 死信队列（`notification.deadletter.list / requeue`，见 §5）

未实现：
- **Webhook 投递（模式 A）**：`gateway.webhook.send` 不存在 → webhook 规则配得上但投不出（会进死信，toFix §一.3）
- SSE 主动推送（模式 B，等 MCP Adapter 就绪）
