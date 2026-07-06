# 事件与触发总线协议 (Event & Trigger Bus Protocol)

> [!NOTE]
> **本文状态（2026-06-02）：核心机制已落地，少数细节与实现存在差异。** 文中每节用状态标注 ✅ 已实现 / ⚠️ 部分实现 / ❌ 设计未实现。
>
> **已实现**：Router `_event` + `event.emit`（§4）、Orchestrator run-queue + worker（§5）、事件匹配器（§6.1）、Nexus 时钟驱动器 + Schedule CRUD（§6.2）、`allowed_triggers` 守门（§7）、人在环状态机（§9）、Portal Event Bus 管理页（§11.2）。
>
> **已修正**：Orchestrator runner 曾直接 `redis.xAdd`（绕过 Router），已改为标准信封路径（2026-06-02）。
>
> **诚实前提**：SOLO 是纯框架，**没有业务层 → 没有真实领域事件**。当前流上只有 orchestrator 自己发的 `EVENT:WORKFLOW:*`。即使本设计全部落地，能闭的环也主要是 orchestrator→事件→orchestrator 的自循环；端到端的真实业务事件要等有业务服务接入后才跑得起来。
>
> **⚠️ 协议与实现差异**：§4.3 信封格式、§6.2 日程 schema 与当前代码存在若干字段差异，已在对应节内注明。以代码为准，协议待对齐。

---

> **协议版本**: 0.5.0
> **状态**: 草案 (Draft) — 设计阶段，未实现
> **作者**: Fuu & Claude

---

## 已定决策（2026-05-31，实现前拍板）

| # | 决策 | 落点 |
|---|------|------|
| D1 | `_event` 走**白名单**（事件注册表，谁能往哪个流发什么 type）；未注册拒绝 | §4.2 / §4.6 |
| D2 | bot 账号**动态独立配置**（`user.bot.create/update` 已支持，permit 强制枚举不许 `allow_all`）；workflow 可加 `run_as` 指定 bot，全局默认 `system.orchestrator` | §8 |
| D3 | 统一到 `_event`，**去除 runner 直写 `xAdd`**；主动发事件经 `event.emit`（见 D4） | §4.5 / §4.7 |
| D4 | 新增 `event.emit`（router 方法）：**后台循环**（worker/调度器）无响应可搭载时，经 relay(bot) 主动发事件，router 同样认证 source + 查白名单 + 盖戳 + 写流。**仅用于无响应的主动发**；step 事件、同步 run 完成事件仍搭响应走 `_event` | §4.7 |
| D5 | 同步 RPC **不挂起**：permit 不足直接 403（调用方在等响应）。人在环挂起只对**异步源**（event/cron）生效 | §6 / §9 |
| D6 | nexus 调度器 = **同进程** `setInterval` tasker，与现有 agent-投递 consumer 并存 | §6.2 |
| D7 | **runner 只信号、worker 才决策**：runner 检测 permit 不足时抛类型化 `NeedsGrantError(missingMethods)`，不自己挂起。同步 handler 接住→403；异步 worker 接住→挂起+发 NEEDS_GRANT。runner 保持纯函数 | §9.3 |
| D8 | run 实体 `ORCHESTRATOR:RUN:{id}` **仅为异步源建**（同步跑完即弃，D5）；存状态机/trigger/actor_bot/grant + trace 指针 | §5.4 |
| D9 | run 留存（建议默认，**待定**）：完成态保留 7 天 TTL，`PAUSED_AWAITING_HUMAN` 态不过期（等人） | §5.4 |
| D10 | 事件流 trim（建议默认，**待定**）：`xAdd` 带 `MAXLEN ~ 10000`（近似裁剪），防 Redis 无限增长 | §4.2 |

> **依赖顺序提醒**：人在环（§9）**建立在 run-queue + worker 之上**，无法独立落地。推进必须按 §13 拓扑链：地基（allowed_triggers + trigger_source 入 context）→ **run-queue + worker** → 人在环 → 事件匹配器 → nexus 调度器 → `_event` 对称化。

---

## 0. 一句话设计

**触发源只有两类，执行只有一条。**

- **被动源**：任何入站请求（外部 webhook、内部业务调用）处理时，在响应里挂 `_event`，由 Router 写入事件流。
- **主动源**：唯一一个持时钟的部件（**nexus**）按节律 tick，主动发起。

两类源最终都收敛到 orchestrator 的**单一执行链**（run-queue → worker → `runner.run`）。

```
被动源：入站请求 ──▶ 服务处理 ──响应挂 _event──▶ Router 写流 ┐
                  (webhook / 业务事件都在这里)              │
                                                          ├─▶ [事件流] ─▶ orchestrator 事件匹配器
主动源：nexus 时钟 tick ──▶ 发起动作 ───────────────────────┘         │
        (cron 唯一住这里)                                            ▼
                                                         [run-queue] ─▶ orchestrator worker ─▶ runner.run
                                                                        (system.orchestrator bot permit
                                                                         + allowed_triggers 守门
                                                                         + H6 footprint 预审)
```

**核心认知**：不要为每种"由头"各建一条执行路径——那是反模式（三套重试、三套权限、三套审计，长期必然漂移）。触发源五花八门，但"执行一个 workflow"永远是同一件事。

---

## 1. 为什么是"两类源"而非"四种触发器"

早期设计（README §8）把触发器列成四行：sync / event / cron / webhook，容易让人以为要建四条并行路径。**收敛后只剩两类**，关键是看清每种"由头"的本质：

| 由头 | 本质 | 归类 |
|------|------|------|
| **webhook** | 外部 POST 打到某服务的一个方法 → 一次**入站请求** | 被动源 |
| **业务事件** | 某服务处理请求时顺带"发生了某事" → 挂在那次**入站请求**的响应上 | 被动源 |
| **同步 RPC** | 调用方直接 `workflow.run`，在等响应 | 被动源（特例：不入队，见 §6） |
| **cron** | 时间到了，**没有任何入站请求**，自己发生 | 主动源 |

**关键推论 —— 这是整套设计唯一不可消除的硬核**：

> `_event` 必须搭在"入站请求的响应"上。cron 的定义就是"没有入站请求"。
> → 没有请求 = 没有响应 = 没有地方挂 `_event`。

所以系统里**必须有一个常驻部件，持有时钟，到点主动发起**——它不可能纯被动等别人调。这个硬核无法被 `_event` 吸收，只能被**收进一个明确的部件**里。本设计把它收进 **nexus**（见 §6.2）。一旦它存在，cron 就被"翻译"成和被动源一样的东西（发 `_event` 或入 run-queue），其余全部统一。

**webhook 不是独立接收器**：它就是"某服务的一个入站方法 + `_event`"。它的鉴权是**那个服务自己的入站鉴权问题**（外部来源走 `passport` 外部身份，或该方法配 HMAC 验签），与事件写入机制无关。

---

## 2. event 与 run-command：两个必须分开的概念

| | **event（事件）** | **run-command（运行指令）** |
|---|---|---|
| 语义 | "发生了某事" `order.paid` | "执行 workflow X" |
| 时态 | 过去式（事实，已发生） | 祈使式（命令，待执行） |
| 形态 | 流 / 发布订阅（pub/sub） | 队列（point-to-point） |
| 消费者 | N 个（谁订阅谁收） | 1 个（被唯一 worker 取走执行） |
| 失败语义 | 漏读一条是观测问题 | 丢一条 = 一次业务执行没发生，必须重试/死信 |

`_event` 解决"怎么把事件干净地发出来"（生产侧，扇出给 N 个订阅者）；run-queue 解决"怎么统一地执行"（point-to-point，唯一 worker）。**两层，别压成一层。**

被动源产出的是 **event**（发到流，可被多方订阅）。nexus 主动源既可以发 **event**（节律广播，供任意订阅者），也可以直接产 **run-command**（"到点跑 workflow X" 这种点对点指令，无需扇出）——见 §6.2。

---

## 3. 现状：已对称化 ✅

| 方向 | 当前做法 | 经 Router？ | 位置 |
|------|---------|------------|------|
| **生产（被动源）** | 服务响应挂 `_event` → Router 提取、认证、盖戳、写流 | ✅ 是 | `router/handlers/events.js` |
| **生产（主动源）** | Nexus scheduler `relay.call('event.emit', ...)` → Router 认证、盖戳、写流 | ✅ 是 | `nexus/logic/scheduler.js` + `router/index.js` |
| **生产（runner 结果）** | runner 完成/失败写标准信封 xAdd | ✅ 是（直写但格式已标准化，2026-06-02 修正） | `orchestrator/logic/runner.js` |
| **消费（Agent 投递）** | nexus `xReadGroup` + consumer group → `relay.call('notification.send')` 经 Router | ✅ 是 | `nexus/logic/stream.js` |
| **消费（Workflow 触发）** | orchestrator 事件匹配器 `xReadGroup` → 翻译 run-command 入队 | ✅ 是 | `orchestrator/logic/matcher.js` |

```
生产: 服务/runner ──标准信封──▶ Redis Stream   ✅ 格式统一
消费: Redis Stream ──xReadGroup──▶ nexus(agent投递) / orchestrator(workflow触发)   ✅ 双消费者隔离
```

> **曾存在的不对称（已修正）**：`orchestrator/logic/runner.js` 原先直接 `redis.xAdd` 写裸字段（无 `type`/`source`/`actor`/`trace_id`/`event_id`），2026-06-02 改为标准信封格式，与 Router `processEvents` 对齐。

---

## 4. 被动源：`_event` 信封（对称化）✅

镜像现有 `_tasks` 机制（`router/handlers/forward.js` 的 `extractTasks` + `router/handlers/tasks.js` 的 `processTasks`），新增 `_event`：服务在 RPC 响应里挂载要发布的事件，**由 Router 提取、认证来源、盖戳、写流**。

### 4.1 信封格式

服务的 RPC 响应：

```jsonc
{
  "jsonrpc": "2.0",
  "id": "...",
  "result": {
    "...": "业务返回",
    "_tasks": [ /* 现有：异步副作用调用 */ ],
    "_event": [
      {
        "stream": "EVENT:ORDER:CREATED",   // 目标流
        "type": "order.paid",               // 事件类型（消费侧过滤用）
        "payload": { "orderId": "ORD-123", "amount": 100 }
      }
    ]
  }
}
```

### 4.2 Router 的处理（与 `_tasks` 同构）

```
Router 收到下游响应
  ├─ extractEvents(response)         // 摘出 _event，从 result 中删除（不回传客户端）
  ├─ 认证来源                         // Router 知道是哪个服务转发的 → source 字段不可伪造
  ├─ 校验事件注册表（D1 白名单）        // 谁能往哪个流发什么 type；未注册拒绝
  ├─ 盖信封戳                         // source / actor / trace_id / emitted_at / event_id
  └─ xAdd(stream, '*', 标准信封, MAXLEN~10000)   // Router 统一写流（D10 近似裁剪）
```

### 4.3 标准事件信封（Router 盖戳后落流）✅

> **⚠️ 实现与原设计的差异**：Redis Stream 要求所有字段值为字符串；`emitted_at` 落库为字符串（`String(Date.now())`），`payload` 落库为 `JSON.stringify` 后的字符串。消费侧（matcher/nexus consumer）读取时对 `{`/`[` 开头的字段自动 JSON.parse 回对象。

```jsonc
// 实际落入 Redis Stream 的字段（全部为字符串）
{
  "type":       "order.paid",
  "source":     "fulfillment",          // Router 认证，不可伪造
  "actor":      "uid-abc123",           // 触发者（见下方 actor 约定）
  "trace_id":   "a3f9c1d2b4e50f61",    // 8字节 hex，贯穿调用链
  "event_id":   "b7e20f11d3c49a82",    // 8字节 hex，消费侧幂等 key
  "emitted_at": "1748823600000",        // String(Date.now())，⚠️ 字符串非数字
  "payload":    "{\"orderId\":\"ORD-1\",\"amount\":100}"  // JSON.stringify 后的字符串
}
```

**三个正交概念，三处归属（理解整套格式的关键）**：

| 想知道 | 归属 | 字段 |
|--------|------|------|
| 发生了什么 | 事件本身 | `type` + `payload`（纯业务数据） |
| 谁/什么导致的（provenance） | 信封 `actor` | 一等字段，**不塞 payload** |
| 以后还跑不跑（重复性） | Schedule 实体 | `recurrence_ms`，**事件层不携带** |

**actor 取值约定**（原设计 `"uid-or-bot-or-cron"` 太模糊，实际规则）：

| actor 值 | 触发来源 | 谁设置 |
|---------|---------|--------|
| `uid-abc123` | 用户同步调用 | runner：`triggerSource==='sync'` → 取 `callerUid` |
| `cron:{schedule_id}` | Nexus Scheduler 定时触发 | scheduler 经 `event.emit` 声明 actor；runner 透传 `triggerSource` |
| `event:{stream}` | 事件链触发的 workflow | runner 透传 `triggerSource` |
| bot 账号名 | bot 主动发且未声明更具体来源 | `event.emit` 兜底为 `source` |
| `system` | 无触发上下文 | runner 兜底 |

> **payload 只装业务数据，不装触发/调度元信息。** `payload` 字段如 `workflow_id` / `status` 是"这件事的数据"；触发来源在 `actor`，重复性在 Schedule。早期实现曾把 `trigger_source`/`trigger_id` 塞进 payload（因 `event.emit` 把 actor 写死为 bot），已于 2026-06-02 修正——`event.emit` 现采信调用方声明的 `actor`（`trustEventActor`），scheduler 直接传 `actor: cron:{id}`，payload 回归纯净。

**重复任务的透明性规则**：单次与循环任务写出的信封**完全相同**，消费者无法仅凭事件区分。
- "是否定时触发" → 看 `actor` 是否以 `cron:` 开头。
- "这个 cron 会不会再跑" → 从 `actor` 取 `schedule_id`，反查 `nexus.schedule.get` 读 `recurrence_ms`。**事件层查不到是设计如此**——事件是过去式事实，没有"未来会不会再发生"的概念。
- 幂等去重 → 信封层 `event_id`（每条唯一）；run-queue 路径另有确定性 `trigger_id`（见 §5.1，run-command 字段，不在事件里）。

> `actor` 字段是"AI 行为可观察"落到信封上的抓手：任何人能在总线上回答"这条事件是哪个 AI / 哪个人 / 哪条 cron 触发的"。`source` 只说"哪个服务发的"，`actor` 才说"哪个主体导致的"。

### 4.4 `_event` 的三个收益

1. **符合 SOLO 铁律**：发事件也经 Router，不再直写 Redis。
2. **防伪造**：来源由 Router 认证并盖戳，杜绝任意服务伪造他人事件。
3. **可观察 + 信封标准化**：统一字段（含 `actor`）、统一审计点。

### 4.5 两种发事件的口子：搭响应（被动）vs `event.emit`（主动）

> **D3/D4** —— 修正早期"进度事件豁免、仍直写"的写法。所有事件最终都经 Router（认证 + 白名单 + 盖戳），**runner 不再直写 `xAdd`**。区别只在"事件搭哪趟车进 Router"：

| 事件来源 | 有无响应可搭载 | 走哪条 | 例子 |
|---------|--------------|--------|------|
| **某服务处理 RPC 时顺带发事件** | 有（它正在回应请求） | 响应挂 `_event`（§4.1） | A.m_02 发"库存已扣"；B.m_23 发"已发货" |
| **同步 run 完成** | 有（`workflow.run` 的响应） | 搭 `workflow.run` 响应的 `_event` | 人点触发，跑完连 trace 一起返回 |
| **异步 worker 的生命周期 / 半路喊人** | **无**（后台循环，不在回应谁） | **`event.emit`（§4.7）** | worker 发进度 / 完成 / `NEEDS_GRANT` |
| **nexus 调度器 cron 触发** | **无**（时钟到了，无入站请求） | **`event.emit`** | "daily-sweep 已触发" |

**关键收窄**：绝大多数事件靠"搭响应"就够（step 事件 + 同步 run 完成），**不需要** `event.emit`。`event.emit` 只服务于一个角落——**后台循环（worker / 调度器）想发事件、手里却没有任何 RPC 响应可搭载**。详见 §4.7。

### 4.6 事件注册表（D1 白名单）

> 安全要求：不是任何服务都能往任何流发任何事件。Router 在写流前查注册表，**未注册的 (source, stream, type) 组合一律拒绝**。这是 `_event` / `event.emit` 共用的同一道关（类比 `_tasks` 白名单 `taskWhitelist`）。

- 存储：Redis（运行时权威）+ config 默认（如 `EVENT:REGISTRY`）。
- 条目语义：`{ source: 'fulfillment', stream: 'EVENT:ORDER:CREATED', types: ['order.paid', ...] }`。
- Router 校验：响应里 `_event` 或 `event.emit` 的 `(经认证的 source, stream, type)` 必须命中注册表，否则丢弃 + 记审计。
- 管理：admin 维护（具体 RPC 待实现时定，参照 `_tasks` 白名单的管理方式）。

### 4.7 `event.emit`（D4 主动发事件通道）

后台循环（orchestrator worker、nexus 调度器）发事件时**没有响应可搭载**（它们不是在回应某个请求）。给它们开一个经 Router 的主动口子：

```
worker / 调度器 要发事件
  → relay.call('event.emit', { stream, type, payload })   // 用 bot token，经 Router
  → Router 收到（像收任何 RPC）
       ├─ 认证 source（来自 bot 的 sub，如 system.orchestrator）
       ├─ 查事件注册表（§4.6 白名单）
       ├─ 盖信封戳（source / actor / trace_id / event_id / emitted_at）
       └─ xAdd(stream, '*', 信封, MAXLEN~10000)
```

- **复用现成机制**：relay（bot token 经 Router）已跑通（nexus 就这么调 `notification.send`），不需要新机制，只需 Router 新增 `event.emit` 方法。
- **与 `_event` 殊途同归**：两条路最终都进 Router 的同一套"认证 + 白名单 + 盖戳 + 写流"。
- **边界**：`event.emit` **仅**用于"无响应可搭载的主动发"。能搭响应的（step 事件、同步 run 完成）**必须**走 `_event`，不得滥用 `event.emit` 绕过。

---

## 5. 统一执行：run-queue + 单 worker（在 orchestrator）✅

这是"orchestrator 能被触发"的核心，也是工作量大头。**执行器不独立成微服务**——workflow 引擎本就在 orchestrator，run-queue 的 worker 长在 orchestrator 里最自然（如 notification 的投递 worker 长在 notification 里）。复用 notification 成熟的队列模式（`QUEUE:PENDING / RETRY / DEADLETTER` + 指数退避 `min(base·2^n, max)` + 死信，见 `core/notification/logic/worker.js`）。

### 5.1 运行指令（run-command）

所有触发源最终产出统一结构：

```jsonc
{
  "workflow_id": "wf_abc",
  "input": { "...": "运行参数" },
  "trigger_source": "event:EVENT:ORDER:CREATED",  // 见 §6 取值
  "trigger_id": "evt_...",                          // 溯源/幂等键
  "enqueued_at": 1234567890
}
```

### 5.2 队列键（镜像 notification）

| 键 | 用途 |
|----|------|
| `ORCHESTRATOR:RUNQ:PENDING` | 待执行运行指令（list，`blPop`） |
| `ORCHESTRATOR:RUNQ:RETRY` | 失败重试（zset，score = 到期时间戳，指数退避） |
| `ORCHESTRATOR:RUNQ:DEADLETTER` | 超过 `maxRetries` 的死信（list，admin 可 list/requeue） |

### 5.3 worker 执行（唯一路径）

```
worker blPop ORCHESTRATOR:RUNQ:PENDING
  → 取 bot token（relay）：workflow.run_as 指定的 bot，默认 system.orchestrator（D2）
  → 建/更新 run 实体 ORCHESTRATOR:RUN:{id}（D8，仅异步源）
  → try runner.run({ workflowId, input }, botHeaders, botUid)
       ├─ C2: status === 'ACTIVE' 校验
       ├─ allowed_triggers 守门（§7）
       ├─ H6: footprint 预审（用 bot 的 permit）
       │    └─ permit 不覆盖某 method → runner 抛 NeedsGrantError(missing)（D7，仅信号，不自己挂起）
       └─ 执行 steps
  → 成功：ack，run 实体 → DONE
  → catch NeedsGrantError：run → PAUSED_AWAITING_HUMAN，event.emit NEEDS_GRANT（§9）
  → catch 其他（下游真实故障）：按退避入 RETRY；超限：入 DEADLETTER
```

> **D7 职责边界**：`runner.run` 是**纯函数**——它只检测并**抛出类型化的 `NeedsGrantError(missingMethods)`**，不决定"该挂起还是该报错"。决策权在调用方：
> - **同步 handler**（`workflow.run`）接住 → 转 403 返回（调用方在等响应，当场报错，D5）。
> - **异步 worker** 接住 → 挂起 + 发 NEEDS_GRANT（§9）。
> 同一个"权限不足"，同步报错、异步挂起，由语境决定。runner 不被异步队列基础设施焊死。

> **关键区分**：RETRY/DEADLETTER 是"机器重试同样的事"（瞬时故障）；`PAUSED_AWAITING_HUMAN` 是"机器做不了、需要人提权"（权限不足）。两者语义不同，**权限不足绝不能进 RETRY**——重试一万次结果一样。详见 §9。

---

## 6. 两类源的具体形态

| 源 | 子形态 | 鉴权 | `trigger_source` | 进 run-queue？ | 状态 |
|----|--------|------|------------------|---------------|------|
| **同步 RPC** | 调用方直接 `workflow.run` | 调用方 token | `sync` | 否（直接执行，保低延迟） | ✅ |
| **被动事件** | webhook / 业务调用 → `_event` → 事件匹配 | bot permit（执行时） | `event:{stream}` | 是 | ✅ |
| **主动节律** | nexus 时钟 tick | bot permit（执行时） | `cron:{schedule_id}` | 是 | ✅ |

> **同步 RPC 为何不走 run-queue？** 调用方在等响应，需要低延迟和直接拿到 trace。它保留现状直接 `runner.run`。其余异步源走 run-queue。即"**一条执行函数（runner.run），两种入口（同步直调 / 异步队列）**"。

### 6.1 事件匹配器（消费侧，给 orchestrator 长出 nexus 那样的消费者）

- orchestrator 启动一个 `xReadGroup` consumer（复用 nexus `stream.js` 的 consumer-group + `xAck` 模式）。
- workflow 声明事件订阅：

  ```jsonc
  "event_subscriptions": [
    { "stream": "EVENT:ORDER:CREATED", "filter": { "type": "order.paid" } }
  ]
  ```
- 事件到达 → 匹配 ACTIVE 且订阅该流的 workflow → 事件 `payload` 作为 `$input` → 翻译成 run-command 入队。
- `trigger_id` 用 stream entry ID（天然幂等键）。
- webhook 走的就是这条：外部 POST → 某服务方法处理 → 响应挂 `_event` → Router 写流 → 此匹配器接住。**没有"webhook 接收器"这个独立部件。**

> **双 consumer 分工（重要，避免实现时困惑）**：同一批 `EVENT:*` 流上会有**两个独立 consumer**，用不同 consumer group 隔离、各干各的：
> - **nexus 现有 consumer**（`stream.js`）：事件 → 查订阅的 **agent** → `relay.call('notification.send')` 投递。这是 agent 协同，**已实现**。
> - **orchestrator 新 consumer**（本节）：事件 → 匹配订阅的 **workflow** → 翻译成 run-command。这是 workflow 触发，**待实现**。
>
> 两者主体不同（agent vs workflow），字段名也近似但分属：nexus agent 有 `eventSubscriptions`（agent 订阅），workflow 新增 `event_subscriptions`（workflow 订阅）——实现时勿混。被动源消费在 orchestrator，主动源（cron）调度在 nexus，两个服务各持一摊。
>
> **这两个 consumer 不只是"实现隔离"，更是两条语义路径**：① workflow 匹配 = 确定性执行（无 AI），② agent 通知 = AI 判断（增强）。完整的引用场景与"为什么必须用流"见 **§6.3**。

### 6.2 时钟驱动器（主动源，落在 nexus，due-zset 模型）✅

**为什么放 nexus**：nexus 已经是"事件路由中枢 + 常驻 `xReadGroup` consumer"，是系统里唯一天然适合再背一个"系统节律"职责的常驻服务。把时钟收进 nexus，意味着"按时间发起"成为一项明确的、可重启恢复的能力，而非散落各处的 `setInterval`（现仓库所有 `setInterval` 都只用于扫过期 session，**无任何业务级调度器**——这个角色当前空缺）。

> **进程形态（D6）**：tasker = nexus **同进程**新加一个 `setInterval` 循环，与现有 agent-投递 `xReadGroup` consumer **并存**（两个独立循环，互不阻塞）。轻量，不新增进程/服务。tick 到点后发事件经 `event.emit`（§4.7，无响应可搭载）。

**核心数据结构 = due-zset（到期有序集），不是内存定时器。** 这与 notification 的 RETRY 队列同构（`zAdd` score=到期时间戳 + `promoteDueRetries` 定时把到期项移回 pending，见 `core/notification/logic/worker.js`），好处是**重启不丢、一次性与循环统一、状态全在 Redis**。

#### 调度循环（nexus tasker）

nexus 起一个定时 tasker，按固定间隔（如每 30s）轮询**自己的日程 zset**——注意：**它轮询的是日程表，不是 `EVENT:*` 事件流**。事件流由 orchestrator 反应式 `xReadGroup` 消费（§6.1），零延迟；让 nexus 去轮询事件流会把推送退化成拉取，是反模式。两者职责不交叉。

```
nexus tasker 循环（每 N 秒）:
  1. 原子捞取到期项                                  // 见下"多实例防重"
       due = ZPOPMIN(NEXUS:SCHEDULE, until=now)      // 取出 score ≤ now 的日程条目
  2. 对每条到期日程 entry:
       a. 按 entry.action 发起触发：
            kind=run_command → 推 run-command 进 ORCHESTRATOR:RUNQ:PENDING（点对点）
            kind=emit_event  → 发 _event 进事件流（广播给多方订阅者）
       b. 续期判定：
            entry.recurrence != null → 算下次 fire_at → ZADD 回 NEXUS:SCHEDULE   ← 循环任务"创建下一个"
            entry.recurrence == null → 不回写，自然消失                          ← 一次性任务
```

> "发现是循环任务就创建下一个继续推队列"，就是 step 2b 的回写。循环与一次性的唯一区别 = `recurrence` 是否为 null；逻辑完全统一。

#### 日程条目 schema（NEXUS:SCHEDULE 的成员）

> **⚠️ 协议与实现差异（字段名 + 类型）**：原设计 `recurrence` 为 cron 表达式字符串（`"0 2 * * *"`），实现改为 `recurrence_ms`（毫秒整数，如 `86400000`）。两者语义不同：cron 表达式可精确到"每天 02:00"，毫秒间隔只能表达固定步长。当前实现更简单但表达能力弱——如需"每天 02:00"精度，需回到 cron 表达式。以下为实际实现字段：

```jsonc
// 实际字段（nexus/logic/schedule.js create()）
{
  "schedule_id":    "daily-balance-sweep",   // 唯一 id（也用于 trigger_source）
  "fire_at":        1735660800000,           // 下次触发的绝对时间戳 ms（= zset score）
  "recurrence_ms":  86400000,               // ⚠️ 毫秒间隔，非 cron 表达式；null = 一次性
  "action": {
    "kind":        "run_command",            // run_command | emit_event
    "workflow_id": "wf_sweep"               // kind=run_command 时必填
    // kind=emit_event 时：stream（必填）+ type（必填）+ payload（可选）
  },
  "enabled":        true,                    // false = 停用但保留定义
  "owner":          "uid-abc123",            // 创建者 UID，可为 null
  "created_at":     1735660000000,
  "last_fired_at":  null                     // 上次实际触发时间，null 表示从未触发
}
```

> zset score = `fire_at`；member = `schedule_id`，详情另存 `NEXUS:SCHEDULE:DEF:{id}`。循环续期：`next_fire_at = fired_at + recurrence_ms`，精度受 tick 间隔限制（默认 30s，即触发精度约 ±30s）。`Date.now()` 禁止散落，应使用 `library/clock.js`（可注入、测试可冻结）。

#### 多实例防重（必须原子）

单实例下"捞取→处理"无冲突；但 nexus 跑多副本时，两个实例可能同时捞到同一条 → 重复触发。捞取动作**必须原子**：

- 首选 `ZPOPMIN`（原子弹出，弹出即归属当前实例）；或
- 每条用 `SET NEXUS:SCHEDULE:LOCK:{schedule_id}:{minute} NX EX` 抢锁，只有抢到的实例发起。

> notification 现在是单 worker 所以没暴露这问题；调度器若要支持多实例就得显式处理。这是落地时的硬约束，不能省。

`trigger_source = cron:{schedule_id}`，`trigger_id = {schedule_id}:{fire_at}`（fire_at 天然是幂等键）。

> 这一节就是 §1 那个"不可消除硬核"的归宿：时钟无法被 `_event` 吸收，于是被收进 nexus 这一个明确部件（一张 due-zset + 一个 tasker），其余触发源全部统一。

### 6.3 引用场景：消费侧的两条路（确定性执行 + AI 判断）

> **本节是设计备忘，不是严格协议。** 记录 event 流"为什么不是队列"的根本理由，避免日后遗忘。讨论于 2026-06-02。

一个 event 落流后，**扇出成两条互不相干的消费路径**，由两个独立 consumer group 各自消费（§6.1 注）：

```
webhook 进来 → 某服务入站方法处理 → 响应挂 _event → Router 写流
                                                  │
                          ┌───────────────────────┴───────────────────────┐
                          ▼                                                 ▼
              ① orchestrator matcher                            ② nexus → agent 通知
                 workflow 的 event_subscriptions                   agent 收到"发生了 X"
                 规则匹配命中 → 直接触发 workflow                    agent 自己判断 → 要不要调 workflow
                 【确定性，无 AI —— 地板】                          【AI 在环 —— 增强】
```

| | 路 ① 确定性匹配 | 路 ② agent 判断 |
|---|---|---|
| 决策者 | 规则（`event_subscriptions` filter） | AI agent 的判断力 |
| 依赖 AI？ | 否 | 是 |
| 落点 | `orchestrator/logic/matcher.js`（§6.1） | `nexus/logic/stream.js` → `notification.send` |
| 角色 | **地板**：保证拔掉 agent 也能跑 | **增强**：有 AI 时更聪明 |

**为什么 event 用流而不是队列**——这是流（pub/sub）相对队列唯一不可替代的能力：

> 同一个事件，要让"确定性执行（①）"和"AI 观测/判断（②）"两个互不相干的消费者**并行各做各的**。若只要路 ①，队列就够、流是多余；正因为要路 ② 也独立订阅同一事件，才必须扇出 → 流。

**设计红线**：绝不能把路 ② 做成**唯一**触发方式（即"事件必须经 agent 判断才能调 workflow"）。那会把 AI 变成硬依赖，拔掉 agent 系统瘫痪，直接违反 §12 "可退化成无 AI 支持"。正确分层：**路 ① 是地板，路 ② 是增强，两条并存**。

> 与 §1 的呼应：§1 讲的是触发源收敛（被动/主动两类）；本节讲的是**消费侧扇出**（确定性/AI 两路）。一进一出，合起来才是 event 总线的完整存在理由。注意 cron→workflow 的最常见路径（`run_command`，§6.2）其实**直接进 run-queue、不经流**——流真正撑着的是这里的"双路独立消费"。

---

## 7. `allowed_triggers` 守门 ✅

approve workflow 时**必须显式声明**允许的触发源；未声明的来源即使有指令也被拒。避免"为同步用途审批，被事件偷偷触发"。

```jsonc
// workflow 字段
"allowed_triggers": ["sync", "event", "cron"]
```

- 守门位置：`runner.run` 入口，在 C2 状态校验之后、H6 预审之前。
- `trigger_source` 的前缀（`sync` / `event:` / `cron:`）不在 `allowed_triggers` 集合内 → `FORBIDDEN`，零副作用。
- create / update 两个入口都要校验该字段格式。

---

## 8. 鉴权模型：用现成的 relay bot，不需要 actor-claim ✅（机制已存在）

> **纠正一个常见误判**：曾认为"无 caller 的事件/cron 触发需要先做 C4（orchestrator 自有 Ed25519 + X-Actor-Claim）"。**这是错的。** SOLO 已有现成的无-caller 权限模型。

`api/library/relay.js`（ADR-007 / `security.md` §7）：每个服务有自己的 bot 账号 `system.<serviceName>`，带独立 permit；`relay.call(method, params)` 用该 bot token **经 Router** 调下游。nexus 的事件消费正是这么做的。

因此 orchestrator 被异步源触发时：

- `callerUid = system.orchestrator` 的 bot uid。
- H6 footprint 预审用 **bot 自己的 permit** 校验 workflow 足迹——若 bot permit 不覆盖某方法，**进入 §9 的人在环提权**（不是失败、不是重试）。
- 调下游用 bot token 经 Router，符合铁律。

**不需要** Ed25519 actor-claim 签名那一套。X-Actor-Claim 是跨信任域 / 强不可抵赖才需要的增强（见 `governance.md` §2 / AUDIT C4），SOLO 单信任域内部环境用 relay bot 即足够。

> 边界提醒：bot permit 应按最小权限配置（只覆盖它要触发的 workflow 足迹），避免 `system.orchestrator` / `system.nexus` 膨胀成 `allow_all`——这正是 governance §2 "信任根/服务凭证单调膨胀"风险的具体落点。webhook 的**外部**来源鉴权是另一回事（见 §1），由接收方法自行用 passport / HMAC 处理。

---

## 9. 人在环：意外时的一次性提权（human-in-the-loop）✅

这是 SOLO 灵魂特性之一落到事件总线上的形态：**正常任务由 bot 自动跑；只有出意外（bot 权限不足以完成某步）时，才需要人登录介入、提权放行。** 提权是**例外路径**，不是常态——常态是 bot 一路跑通，零人工。

### 9.1 触发条件：H6 预审拦截 = 唯一的"需要人"信号

worker 用 `system.orchestrator` bot 的最小 permit 跑 workflow。绝大多数情况 bot permit 足够，直接跑完。**当且仅当** H6 footprint 预审发现 bot permit 不覆盖某个 method（如某条 workflow 意外引用了 `ledger.transfer`，而 bot 没这权限），才进入人在环：

- 这一刻**不是失败**（重试无意义，bot 权限不会自己长出来），也**不是部署期审批**（workflow 早已 ACTIVE）。
- 它是**运行期**的"差一点权限，请人看一眼放不放行"。

### 9.2 路线 A：一次性提权（已定，不污染 bot 常驻权限）

> **决策（2026-05-31）**：提权走**路线 A**——授权的是**这一条挂起的 run，针对缺失的那个 method，仅此一次**。权限随本次执行消亡，**绝不**永久加进 `system.orchestrator` 的 permit。
>
> 这从根上避开 governance §2 / orchestrator README §5.3 警告的"服务凭证单调膨胀"：bot permit 永远停在最小集，每次高敏感调用都留一条"谁在何时为哪条 run 放了哪个 method 的行"。
>
> 对比 README §5.3 的 `method.grant`（把 method **永久**加进服务凭证）：那是独立的**运维决策**通道（"这个 method 以后都该让 orchestrator 常规调用"），走 grant approver，**不是**临场救火。两者不可混用——救火用 A（一次性），常规化用 method.grant（永久）。

### 9.3 run-command 生命周期（新增挂起态）

> **谁决定挂起**（D7，详见 §5.3）：runner 只抛 `NeedsGrantError(missing)`（信号）。**异步 worker** 接住才挂起（下图）；**同步 handler** 接住则直接 403（D5，不进此状态机）。下图仅描述异步源的 run 实体（§5.4）。

```
PENDING ──worker取──▶ RUNNING
   RUNNING ──runner 抛 NeedsGrantError──▶ PAUSED_AWAITING_HUMAN   ← 新增态
   PAUSED  ──人登录+一次性提权──▶ RESUMING ──▶ RUNNING（带本次 grant 重跑该步）
   PAUSED  ──人拒绝/超时──▶ ABORTED（留痕，不执行）
   RUNNING ──全部完成──▶ DONE
   RUNNING ──真实故障──▶ RETRY → （超限）DEADLETTER     ← 与提权正交
```

`PAUSED_AWAITING_HUMAN` 与 RETRY/DEADLETTER **正交**：前者等人，后者等机器重试。一条 run 可能先因权限挂起、提权后继续、再因下游瞬时故障进 RETRY——互不干扰。

### 9.4 事件与通知（可观察 + 唤起人）

worker 挂起时，**发一条事件**（经 §4 的 `_event` 机制，进事件流）：

```jsonc
{
  "type": "workflow.needs_grant",
  "stream": "EVENT:WORKFLOW:NEEDS_GRANT",
  "payload": {
    "run_id": "...",                 // 哪条挂起的 run
    "workflow_id": "wf_abc",
    "missing_methods": ["ledger.transfer"],  // 差哪些权限
    "actor": "system.orchestrator",   // 当前以谁的身份在跑（bot）
    "trigger_source": "cron:daily-sweep",
    "trace_id": "...",
    "paused_at": 1234567890
  }
}
```

这条事件**一举两得**：① 是"AI/bot 行为可观察"的具体载体（人能在总线上看到"某 run 卡在权限墙前"）；② 经既有订阅/通知链（nexus → notification）唤起该提权的人。

### 9.5 提权与恢复（在 nexus 管理区操作）

```
人在 portal/system 的 nexus 管理区看到挂起的 run（NEEDS_GRANT 列表）
  → 登录（人的身份，非 bot）
  → 审视：哪条 run、为什么差、差哪个 method
  → 一次性提权：对 run_id 签发 { run_id, method, granted_by, granted_at, 一次性 }
       存 ORCHESTRATOR:RUN:{run_id}:GRANT（随 run 结束清理，不入 bot permit）
  → 下 resume 指令 → run-command 重回 ORCHESTRATOR:RUNQ:PENDING（带 grant 标记）
  → worker 重跑：本次 H6 校验 = bot permit ∪ 本次一次性 grant → 通过 → 继续执行
```

- **谁能提权**：人的身份须持相应 permit（提权本身是高敏感操作，受 Router checkAccess 约束）。最小形态下，提权人 permit 须覆盖被提的 method（即"你自己能调，才能放行让 bot 替这次调"），与 H6 "以触发者 permit 为准"的精神一致。
- **留痕**：`granted_by` / `run_id` / `method` / 时间，写入该 run 的 trace，双向可溯（谁为哪次执行提了什么权）。
- **粒度**：grant 绑定 `run_id` + `method`，**用完即弃**。同一 workflow 下次执行若再缺权，仍需再次提权——这是特性不是缺陷（每次高敏感放行都过人眼）。

### 9.6 与既有治理的关系

| | 部署期审批（C1，已实现） | 运行期提权（本节，路线 A） | 永久授权（method.grant，README §5.3） |
|---|---|---|---|
| 时机 | workflow 上线前 | workflow 跑到一半、bot 权限不足 | 运维决策"某 method 常规化" |
| 对象 | 整个 workflow（PENDING_REVIEW→ACTIVE） | 单条 run 的单个 method | orchestrator 服务凭证 permit |
| 持续 | 永久（直到改版） | 一次性（随 run 消亡） | 永久（加进凭证） |
| 防膨胀 | — | ✅ bot permit 不变 | ⚠️ 受 grant approver 把关 |

三者正交、互补：C1 管"这 workflow 能不能上线"，本节管"这一次差点权限要不要放行"，method.grant 管"要不要让它以后都不用问"。

---

## 10. 端到端目标闭环（全部落地后）

**被动源（含 webhook）：**

```
入站请求（外部 webhook / 内部业务调用）
  └─ 某服务方法处理 → 响应挂 _event: [{stream, type, payload}]
       │
   Router 提取 _event → 认证 source → 盖戳(含 actor) → xAdd 到流        (§4)
       │
   orchestrator 事件匹配器 xReadGroup 读到 → 匹配订阅该流的 ACTIVE workflow  (§6.1)
       │
   翻译成 run-command → enqueue ORCHESTRATOR:RUNQ:PENDING        (§5.1)
       ▼
   orchestrator worker 链（见下）
```

**主动源（cron）：**

```
nexus 时钟 tick（ZPOPMIN 原子捞到期项 + 循环续期）                (§6.2)
  └─ 发 _event（进流，同上）  或  直接下 run-command（点对点入队）
       ▼
   orchestrator worker 链（见下）
```

**统一 worker 链：**

```
orchestrator worker blPop ORCHESTRATOR:RUNQ:PENDING             (§5.3)
  ├─ relay 取 system.orchestrator bot token                     (§8)
  ├─ runner.run(workflow, botHeaders, botUid)
  │    ├─ C2 status===ACTIVE
  │    ├─ allowed_triggers 含该源？                              (§7)
  │    ├─ H6 footprint 预审（bot permit 全覆盖足迹？）             (§8)
  │    │    └─ permit 不足 → PAUSED_AWAITING_HUMAN + 发 NEEDS_GRANT 事件   (§9)
  │    │         → 人登录·一次性提权 → resume 重回队列 → 继续
  │    └─ 执行 steps（每步经 Router）
  └─ 真实故障 → RETRY 退避 → 超限 DEADLETTER                      (§5.2)
```

> 正常路径：bot permit 足够 → 一路跑通，零人工。例外路径：bot 差权限 → 挂起等人提权（§9 路线 A，一次性，不污染 bot 常驻 permit）。

---

## 11. 三层职责与 UI 归属（定论）

调度/事件这条线横跨三个层、两个 portal 区。常见混淆是把"定义""调度""执行"或把不同服务的界面混到一处。本节定死边界。

### 11.1 三层职责

| 层 | 是什么 | 谁定义 | 谁在运行时处理 | 关键边界 |
|----|--------|--------|---------------|---------|
| **A. 日程定义（schedule）** | "每天 2 点跑 wf_sweep" 这条**约定**（含一次性 / 循环） | 人 / AI 创建 | **nexus tasker**（扫 due-zset，到期推送 + 续期，§6.2） | nexus **不执行 workflow**，只负责"到点了，该叫了" |
| **B. 事件类型（event type）** | `order.paid` 这类**事件契约**（谁能发、payload 形态、哪些 workflow 订阅） | 声明 / 注册 | Router 写流校验（§4.2）+ orchestrator 事件匹配（§6.1） | SOLO **无业务层 → 目前流上只有 `WORKFLOW:*`**，B 这层基本是空的，portal 顶多只读展示 |
| **C. 运行实例（run / trace）** | 某次实际执行的**记录**（状态、trace、成功/失败、人在环提权痕迹） | 系统自动产生 | **orchestrator worker**（§5.3） | 真正"干活"并产出记录的是 orchestrator，不是 nexus |

> 一句话：**nexus 负责"到点叫醒谁"，orchestrator 负责"被叫醒后干了啥"。** 调度与执行是两个服务、两件事，不能合并。

### 11.2 UI 归属（portal/system）

portal/system 按**服务**分页；"跟谁运行，就在谁的页面里管"：

| 管什么 | 放哪个 portal 区 | 动作 |
|--------|-----------------|------|
| **A 日程定义** | **Event Bus**（独立栏目，`/events`） | Schedules tab：建 / 停（`enabled`）/ 改日程、看 `fire_at`、DELETE |
| **C 运行实例（Runs）** | **Event Bus**（独立栏目，`/events`） | Runs tab：状态机视图、GRANT（一次性提权）/ ABORT（§9.5）、RAW |
| **事件格式参考** | **Event Bus**（独立栏目，`/events`） | Format tab：信封字段说明、payload 约定、recurrence 透明性规则 |
| **Workflow 定义/审批** | **WorkflowManagement**（orchestrator 区） | workflow CRUD、APPROVE/DENY、运行 trace/历史 |

```
portal/system
   ├─ Event Bus（/events）  → Schedules（建/停/改）+ Runs（状态+提权）+ Stream Log + Format 参考
   └─ WorkflowManagement   → workflow 定义/审批 + event_subscriptions 配置
```

> **与原设计的差异**：原设计（上文）将 schedule 管理放在 NexusManagement，runs 放在 WorkflowManagement。实际实现新建了独立的 **Event Bus** 页，将调度、运行监控、格式文档统一收拢，与 Nexus Agent 管理（agent 注册/订阅）分开。NexusManagement 仍负责 agent 的 eventSubscriptions 配置。

**边界提醒**：调度引擎（tasker + due-zset）**跑在 nexus 服务进程里**；运行 worker **跑在 orchestrator 进程里**。Event Bus 页是两者的统一管理界面，不意味着它们在同一服务。

---

## 12. 三大设计目标对照（这套总线是否服务于 SOLO 的根本目标）

SOLO = 管理多 AI 与人协同工作的微服务框架。本协议须服务于其三个灵魂特性：

| 目标 | 本协议如何承接 | 状态 |
|------|---------------|------|
| **AI 行为可观察** | 事件信封带 `actor`（§4.3）；人在环挂起也发事件（§9.4）。任何 AI/bot 触发的动作都流过总线、可在 portal 回溯 | ✅ 核心机制已实现 |
| **人可介入及提权** | run-command 增 `PAUSED_AWAITING_HUMAN` 态（§9.3）；H6 权限不足时挂起等人、一次性提权恢复（§9，路线 A）；Event Bus Runs tab 提供 GRANT/ABORT UI | ✅ 已实现 |
| **可退化成无 AI 支持** | 触发源不挑身份：sync（人点）与 cron（时钟）是一等公民；workflow 是声明式 JSON、step 是普通 RPC，整链不依赖 `core/agent`。AI 只是"被动源里可选的 `_event`/草案生产者"。拿掉 agent，人 + cron 仍驱动全链 | ✅ 设计天然满足 |

> 第三点是 SOLO "AI 是增强不是依赖"的体现：把 `core/agent` 整个摘掉，人手建 workflow、人手 sync 触发、cron 自动跑，这套总线照转。

---

## 13. 实现状态索引（2026-06-02）

> 原差距索引已全部落地，以下记录实际实现位置与遗留问题。

#### router ✅

| 功能 | 状态 | 位置 |
|------|------|------|
| `extractEvents` + `processEvents`（认证/注册表/盖戳/xAdd） | ✅ | `router/handlers/events.js` |
| `_event` 转发后调用 | ✅ | `router/index.js` |
| `event.emit` 方法（D4） | ✅ | `router/index.js:184` |
| 事件注册表（D1 白名单） | ✅ | `router/handlers/events.js`（checkRegistry） |

#### orchestrator ✅

| 功能 | 状态 | 位置 |
|------|------|------|
| `allowed_triggers` 守门 | ✅ | `runner.js:49-60` |
| run-queue（PENDING/RETRY/DEADLETTER） | ✅ | `logic/worker.js` + config |
| worker（blPop → relay → runner.run） | ✅ | `logic/worker.js` |
| 事件匹配器（xReadGroup + event_subscriptions） | ✅ | `logic/matcher.js` |
| 人在环状态机（PAUSED/GRANT/ABORT/RESUME） | ✅ | `logic/run.js` |
| runner 结果事件写标准信封 | ✅（2026-06-02 修正） | `runner.js:262,285` |

#### nexus ✅

| 功能 | 状态 | 位置 |
|------|------|------|
| 时钟驱动器（due-zset + ZPOPMIN + 续期） | ✅ | `logic/scheduler.js` |
| Schedule CRUD（create/get/list/update/delete） | ✅ | `logic/schedule.js` + introspection |
| 双 consumer 隔离（agent投递 vs workflow触发，不同 consumer group） | ✅ | `logic/stream.js`（nexus）+ `logic/matcher.js`（orchestrator） |

#### portal/system ✅

| 功能 | 状态 | 位置 |
|------|------|------|
| Schedule 管理 UI（建/删/查） | ✅ | Event Bus → Schedules tab |
| Runs 监控 UI（状态/GRANT/ABORT） | ✅ | Event Bus → Runs tab |
| 事件格式文档 | ✅ | Event Bus → Format tab |
| Workflow event_subscriptions 配置 | ✅ | WorkflowManagement（workflow 定义内） |

#### 遗留问题 / 待对齐

| 问题 | 影响 | 建议 |
|------|------|------|
| `recurrence_ms`（ms间隔）vs 原设计 cron 表达式 | 无法表达"每天 02:00"精度，只能固定步长 | 如需 cron 精度，改用 cron 表达式 + `clock.js` 解析 |
| runner 直写 xAdd（不走 `_event` 搭响应） | 绕过 Router，虽格式已标准化，但仍不经认证/白名单 | 长期应改为搭响应 `_event`；当前直写+标准格式为可接受的折衷 |
| D10 流 trim（MAXLEN~10000） | 长期不 trim Redis 流会无限增长 | xAdd 加 `MAXLEN ~ 10000` 参数 |

> **已解决（2026-06-02，actor 正本清源）**：早期 scheduler 把 `trigger_source`/`trigger_id` 塞进事件 payload（因 `event.emit` 把 `actor` 写死成 bot），导致"判断是否定时触发"要解析 payload——范畴混乱。现修复为：`event.emit` 采信调用方声明的 `actor`（`trustEventActor`），scheduler 直接传 `actor: cron:{id}`，runner 写结果事件时 `actor` 优先取 `triggerSource`。provenance 回归信封 `actor`，payload 纯净。（`$context.trigger_source`/`trigger_id` 一直就写入了 `runner.js:124`，供 step 引用。）

> webhook **不单列**：它走被动源那条（入站方法 + `_event`），随事件匹配器一起就位，无需独立部件。

---

## 14. 与现有协议的关系

| 文档 | 关系 |
|------|------|
| `workflow.md` | workflow 定义；本文新增 `allowed_triggers` / `event_subscriptions` 两个触发相关字段 |
| `governance.md` | §2 信任根、服务凭证膨胀风险，是本文 §8 bot permit 最小化、§9 一次性提权（路线 A）的上位约束 |
| `fulfillment.md` | 已用 `_tasks` 触发跨服务协同；本文的 `_event` 是其姊妹机制（事件 vs 任务，见 §2） |
| `security.md` §7 | ADR-007 系统服务账号（relay bot），是本文 §8 无-caller 鉴权的基础 |
| `passport.md` | webhook 的**外部**来源鉴权（§1）走 passport 外部身份或方法级 HMAC |
| orchestrator `README.md` §5.3 | `method.grant`（永久授权）与本文 §9 一次性提权互补、不混用 |
| orchestrator `AUDIT.md` | 触发器相关条目在本文展开为完整设计；H6 预审是 §9 人在环的触发点 |

---

## 附：为什么"两类源 + 一执行器"是对的

README §8 把 event / cron / webhook 各列一行，容易让人误以为要建三条并行执行路径。那是反模式：三条路径 = 三套重试、三套权限、三套审计，长期必然漂移。

正确的心智模型是**触发源与执行解耦**，并进一步认识到触发源本身可以收敛：

- **被动源**（webhook、业务事件）本质都是"入站请求顺带发事件"，统一为 `_event`。
- **主动源**（cron）是唯一不可被 `_event` 吸收的硬核（无入站请求），收进 nexus 一个持时钟的部件。

于是"执行一个 workflow"永远是同一件事——同一个 worker（在 orchestrator）、同一套 H6 预审、同一套 `allowed_triggers` 守门、同一套退避/死信、同一套人在环提权。两类源各自把"由头"翻译成统一的 run-command，执行器不必关心它从哪来。这就是 §0 那张图的全部含义。
