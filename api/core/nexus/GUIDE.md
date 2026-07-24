# nexus 服务任务配方

> 由 fleet-standard `guide` 方法下发（经 Router：`system.guide { service: "nexus" }`）。
> 与服务代码同目录、同 commit 更新。方法签名与参数约束以 `methods` 自省为准，
> 本文只讲自省说不出的**任务流程与语义**。

## 这是什么

Sentinel（事件订阅式、声明式、可选 AI 驱动的反应体）注册表 + 事件路由中枢。
一个 Sentinel 声明"订阅哪些事件流 → 触发后怎么装配上下文 / 要不要自主决策 / 要不要回抛新事件"；
nexus 的 stream consumer 消费 `EVENT:*` 总线、按订阅把事件路由给它，物理投递走 notification（写 Agent inbox 或 webhook）。

## 配方一：注册一个 Sentinel，订阅事件并被触达

生命周期方法多为 admin 动作（一般经 portal/system 操作），次序：

1.（可选身份）先在 user 建 bot 账号 + 签 token，uid 取 `system.*`（见 user 的 guide）。
2. `nexus.sentinel.create { name, authorityRole, eventSubscriptions:[...], reachability, webhookUrl?, context? }`
   - `eventSubscriptions` = **精确的 stream key 列表**（如 `"EVENT:WORKFLOW:STATUS"` 或更细的 `"EVENT:WORKFLOW:STATUS:PENDING_REVIEW"`）。**没有通配 / 模式订阅**——要"只收某状态"，要么订更细的 key，要么用 `context.guard` 过滤（配方二）。
   - 改 `eventSubscriptions`（create/update）会即时重同步订阅集 + 在新流上建 consumer group，**无需重启** nexus。
3.（§1.2 身份）`nexus.sentinel.token.set { authorityRole, token, expiresAt }` 注入 bot token——此后该 Sentinel 的 `data_fetchers` / `agent.decide` 以它自己的窄 permit 发起（`relay.callAs`），审计归属到它。`authorityRole` 非 `system.*` 或没注 token → 退回共享 nexus 身份（legacy，非破坏）。
4.（仅 sse/webhook 需要）`nexus.sentinel.broadcast { id }`——显式把投递配置推给 notification，否则消息只进 inbox 不外投。polling / built-in 无需 broadcast；`sse` 目前无投递通道，broadcast 会报错。

**事件流转（触发后）**：producer 经 Router `event.emit` / `_event` 往 `EVENT:*` 流 XADD（**不要**直接 `redis.xAdd` 绕过 Router——Router 校验 `(source, stream, type)` 白名单并盖信封戳）→ nexus consumer 读到 → 对每个 ACTIVE 订阅者装配 context → `notification.send` 落 inbox。`built-in` reachability 由宿主进程内触发，不走这条路径。

## 配方二：声明式反应（context 装配 → 自主决策 → 回抛事件）

Sentinel 的 `context` 字段（全部可选）按序执行；`context` 全空 = 收到原始事件、不装配：

1. `guard`（JsonLogic）：不满足 → 跳过，不唤醒。**这才是"按条件过滤事件"的地方**（subscription 只能选流，选不了内容）。变量袋含 `{{event.*}}` / `{{sentinel.*}}`。
2. `data_fetchers[]`：按 `depends_on` DAG 分层拉只读数据挂到 `{{fetch.<key>}}`。**方法必须是只读后缀**（get/list/query/search/count/resolve/info）——写方法配进来在 create 期就被拒；DAG 必须无环。每个 fetcher 8s 超时，`on_error` = abort|skip|fallback。
3. `system_prompt_template`：用 `{{event.*}}` / `{{fetch.*}}` / `{{sentinel.*}}` 插值渲染。
4. `autorun`（`true` 或 `{ choices?, schema?, confidence_threshold?, risk_tolerance? }`）：把渲染好的 prompt 交 `agent.decide`，结构化决策 `{ decision, confidence, reason, escalate, fields? }` 挂到 `{{output.*}}`。**INVERTED GATE**：choices/schema 建档时固定，模型只选/填值，绝不命名目标动作。
5. `emit`（`{ stream, type, emit_when?, payload_template? }`）：把一个**新事件**回抛总线（下游 orchestrator 匹配器或另一 Sentinel 消费）。同为 INVERTED GATE——stream/type 建档固定，模型只填 payload 值。

## 坑与约定

- **时间戳是 epoch 毫秒数字，不是 ISO 字符串**：`createdAt` / `lastSeenAt` / `updatedAt`、schedule 的 `fire_at` / `created_at` / `last_fired_at` / `recurrence_ms` 全是 `number`（entities 里标 "datetime" 是展示语义，实际存 `Date.now()`）。
- **事件信封字段**（无 context 时直接透传给你）：`type` / `source`（Router 认证、不可伪造）/ `actor`（触发主体：`uid-*` / `cron:{id}` / `event:{stream}` / bot 名）/ `trace_id`（贯穿全链）/ `event_id`（消费侧幂等 key）/ `emitted_at` / `depth`。provenance 看 `actor`，别翻 payload。
- **depth 熔断**：每 emit 一跳 `depth+1`，Router 在 `depth > EVENT_MAX_DEPTH`（默认 16）时**阻断**——自喂事件环的断路器。Sentinel 的 emit 继承触发信封的 depth，别造环。
- **幂等三处**：① consumer 是 at-least-once（consumer group），失败指数退避重试，超 `maxDeliveries`（默认 5）进 DLQ（`nexus.dlq.list/retry`，admin）；② notification 按 `(targetId, ref=流条目 id)` 去重，重投不重复落 inbox；③ `context.emit` 按 `(ref, sentinel)` SETNX at-most-once，重试不重复回抛。**你的下游消费仍须按 `event_id` 自做幂等去重。**
- **软删 / 状态**：Sentinel 仅 `ACTIVE` / `DISABLED`。`disable` = 停投递 + 从订阅集摘除 + 软吊销 nexus 持有的 token（硬吊销活 session 需 admin 另调 `user.token.revoke`）；`enable` 复原；`delete` 是硬删（管理记录，非用户数据）。
- **排障**：`nexus.trace.get { traceId }` 一次拉全链（跨所有 `EVENT:*` 流 + 实体 WAL，时序，WAL 是环形缓冲只覆盖近期写）；`nexus.event.streams` / `nexus.event.recent` 看总线。均为只读 admin 视图。
- schedule / dlq / event / trace / token / control 系列均为 admin；`nexus.control.pause` 停自动化（consumer + scheduler）但手动 RPC 照常。
