# 事件与触发 · 下游契约指南（AI / 人都能照着写）

> 本文件让你（或一个 AI）**只凭脚手架交付的信息**，就能让你的服务正确地**发事件 / 收事件 / 触发自动化**，并与 Router 的事件总线 wire 兼容。
> 校准基准：与 `{{PROJECT_NAME}}` 随附的 Solo v{{SOLO_VERSION}} 的 **Router 事件管线**逐字段对齐（`event.emit` / `_event` / `_tasks` / run-queue）。
>
> ⚠️ Solo 仓 `docs/protocol/zh/event.md` 是更完整的协议，但部分字段（如 `parent_event_id` / `depth`）文档已**落后于代码**。
> **冲突时以本文件 + 代码为准**（event.md 自己也写了"以代码为准"）。
> workflow 侧的 `allowed_triggers` / `event_subscriptions` 语法见 `workflows.md`，本文讲**服务级**事件。

---

## 0. 先分清两件事：事实 vs 副作用

服务**永不直接 POST 另一个服务**。要让别处发生事情，只有三条合法路径：

| 你想要 | 用什么 | 语义 | 谁消费 |
|--------|--------|------|--------|
| 广播一个**已发生的事实** | `_event`（搭响应顺风车）/ `event.emit` | 过去式、**扇出**给 N 个订阅者 | orchestrator matcher（触发 workflow）+ nexus（触发 agent/sentinel） |
| 让另一个服务**做一件副作用** | 返回 `_tasks` | 点对点、由 Router 派发 | 目标服务 |
| **同步**拿另一个服务的返回 | `relay.call(...)`（带 bot token，经 Router） | 阻塞调用 | 目标服务 |

`_event` = "订单付款了"（事实）；`_tasks` = "去 ERP 同步这单"（命令）。选错语义是最常见的设计走偏。

---

## 0.5 发事件之前：通路怎么开通

开箱状态下，你服务的 relay bot token 是**空的**——`init.sh` / `run.sh` 都不会自动配置它，
`relay.call(...)`（含 §5 的 `event.emit` 路径）在这个状态下一律抛 `NO_TOKEN`。四步一步都不能少：

```
1. user.bot.create      { uid: 'system.<service>', permit: { allow_all: false, services: { user: ['user.token.refresh'], ... } } }
2. user.bot.issue.token { uid: 'system.<service>' }  →  返回 { token, expiresAt }
3. <service>.token.set  { token, expiresAt, sub: 'system.<service>' }   ← 调你自己服务的这个方法
4. <service>.token.status 验证 hasToken:true
```

- `uid` 必须**恰好**是 `system.<serviceName>`（`library/relay.js` 的 `expectedSub` 这么拼），不匹配抛 `SUB_MISMATCH`。
- 第 1 步的 `permit` 不能给 `allow_all:true`（`user.bot.create` 会拒绝——bot 权限必须显式枚举 `services.method`），按你的服务实际要调的 Router 方法（通常至少要有 `event.emit`）来写。
- 🔴 **`services` 里必须含 `user: ['user.token.refresh']`，不论你的服务实际要调什么方法**——这一条不是业务权限，是 `library/relay.js` 自身续期机制（`rotateBeforeMs` 默认到期前 2 小时）要用的，`event.emit` 本身虽然不查 permit，但 relay 每隔一段时间会自己去调 `user.token.refresh`，那次调用跟普通方法一样过权限检查。**漏了这条，token 到期前 2 小时开始悄悄轮转失败，24 小时后彻底失效，之后所有 `event.emit`/`relay.call` 都静默丢事件**——RPC 返回、日志、账本全部正常，只有事件消失，且要等满一个 token 生命周期才会暴露（colony 2026-08-10 实测踩过，丢了 3 条真实事件才发现，详见 `docs/feedback/done/relay-provisioning-and-event-registry.md` §五）。
- 🔴 **permit 配齐只保证轮转不被「拒」，不保证轮转被「触发」**——relay 的轮转是惰性的，只在
  `relay.call()`/`getToken()` 被走到时才检查。调用稀疏的服务（事件驱动、可静默数小时的）完全可能在
  到期前 2h 的轮转窗口内一次调用都没有，token 静默过期，之后所有调用 `TOKEN_EXPIRED`——四步做全也一样。
  **v1.1.17 起 relay 已内建轮转心跳**（`createRelay` 的 `rotationHeartbeatMs`，默认 10 分钟走一次
  `getValidToken()`，无 token 时静默、不发业务 RPC、不需要额外 permit），这条坑自动解除。
  **若你的 bundle 是 v1.1.16 及更早**（没有心跳），必须自己安排保底调用，两个实测可用的做法：
  ① 服务内 10 分钟定时器调 `relay.getToken()`（内部走 refreshIfNeeded，够触发轮转）；
  ② 用 `nexus.schedule` 建 30 分钟递归的 `emit_event` 心跳（stream 落 `EVENT:SENTINEL:*`，内置白名单免登记）。
  （colony 2026-08-14/16 两次实测踩到：持仓静默 9.5h 盖住轮转窗口 → token 静默过期 → 之后
  `event.emit`/`agent.decide` 全部 -32001，详见 solo 仓 `docs/feedback/nexus-relay-lazy-rotation-sparse-callers.md`。）
- 全新 scaffold 出来的栈，Solo 自带的 nexus / orchestrator 这两个服务同样没有 token（它们的 `event.emit`/调度事件功能因此不可用），需要同样手工走一遍这四步——这条尚无自动化，见 `docs/feedback/done/relay-provisioning-and-event-registry.md`。**v1.1.17 起 `nexus.sentinel.create`/`enable` 会在 nexus relay 无可用 token 时在返回体里带 `warning` 预警**（不阻止创建，token 可后配）；此前版本没有预警，第一个事件到达时才在 nexus 日志里看到 `NO_TOKEN`。

## 1. `_event` 信封：你给什么 vs Router 盖什么

**(a) 你提供的**（`_event` 数组项，或 `event.emit` 的参数）：
```jsonc
{
  "stream":   "EVENT:ORDER:CREATED",   // 必填 —— 目标 Redis stream（命名见 §2）
  "type":     "order.paid",            // 必填 —— 消费端的过滤键
  "payload":  { "orderId": "ORD-1" },  // 对象（写入时 JSON.stringify）| 字符串 | 省略→'{}'
  "event_id": "a1b2c3d4...",           // 可选 —— 幂等去重槽（见 §6）
  "actor":    "cron:daily-sweep"       // 可选 —— 仅 event.emit 路径会采信
}
```

**(b) Router 盖章后写进 stream 的**（`processEvents`，**所有值都是字符串**）：

| 字段 | 来源 / 规则 |
|------|-------------|
| `type` | 透传 |
| `source` | **Router 鉴权得出、不可伪造** —— 响应服务（`_event` 路径）或调用者 bot 身份（`event.emit` 路径） |
| `actor` | 来源主体。`_event` 路径 = 鉴权用户（**逐事件 actor 不采信**）；`event.emit` 路径 = 你给的 `actor`，否则回退 `source` |
| `trace_id` | 从调用链 trace 上下文传播 |
| `event_id` | 你给的（须配 `/^[A-Za-z0-9_-]{8,64}$/` 且去重槽空闲）否则随机 hex |
| `depth` | `caller depth + 1`；超过 `EVENT_MAX_DEPTH`(默认 16) 整批**被拦**（自喂循环刹车） |
| `emitted_at` | `Date.now()` 的字符串 |
| `payload` | 对象则 `JSON.stringify`，字符串原样，否则 `'{}'` |

> 消费端（matcher/nexus）会把以 `{` 或 `[` 开头的字段值 JSON.parse 回对象。

---

## 2. `EVENT:*` 命名 + 注册白名单（不注册就被拦）

- **stream 名**：`EVENT:{DOMAIN}:{ACTION}`，全大写、冒号分隔。真实例：
  `EVENT:WORKFLOW:STATUS`、`EVENT:FULFILLMENT:TRANSITIONED`、`EVENT:WEBHOOK:{source}`、`EVENT:PAYMENT:RECEIVED`。
- **type 名**：点分小写 `{名词}.{过去式动词}` —— `order.paid`、`instance.transitioned`、`webhook.received`。type 与 stream 名独立，是消费端过滤键。
- 🔴 **注册门（D1 白名单）**：Router 只放行登记在 `SYSTEM:CONFIG:EVENT_REGISTRY` 里的 `(source 服务, stream, type)` 三元组，**未登记的直接拦截 + 审计，不写入**：
  ```jsonc
  { "{{PROJECT_NAME}}": { "EVENT:ORDER:CREATED": ["order.paid", "order.refunded"] },
    "ingress":          { "EVENT:WEBHOOK:*":     ["webhook.received"] } }   // 末尾 '*' 前缀通配
  ```
  匹配规则：先精确，再单个末尾 `*` 前缀通配（`EVENT:WEBHOOK:*` 覆盖运行时命名的 `EVENT:WEBHOOK:GITHUB`）。**你的服务发新事件前，先把它登记进 registry。**

  🔴 **`SET SYSTEM:CONFIG:EVENT_REGISTRY` 是整体替换，不是与内置默认合并**（Router 读取逻辑见
  `api/router/handlers/events.js` 的 `getRegistry()`）。写这个键之后，Router 只认你写进去的内容——
  下面这 7 条内置默认（`orchestrator`/`system.orchestrator`/`system.nexus`/`system.ingress`/
  `system.fulfillment`/`gateway`/`system.gateway`）会**全部失效**，且失效是静默的：被拦的事件只计入
  返回值里的 `blocked` 计数，不抛错、不影响调用方的 RPC 返回，你的服务照常"工作正常"，只是这些
  事件再也没人收到。**写这个键时必须把下面 7 条原样一起写进去**，只加你自己的一条：

  ```jsonc
  {
    "orchestrator":        { "EVENT:WORKFLOW:STATUS": ["*"], "EVENT:WORKFLOW:RESULT": ["*"] },
    "system.orchestrator": { "EVENT:WORKFLOW:NEEDS_GRANT": ["workflow.needs_grant"], "EVENT:WORKFLOW:STATUS": ["*"], "EVENT:WORKFLOW:RESULT": ["*"] },
    "system.nexus":        { "EVENT:SENTINEL:*": ["*"] },
    "system.ingress":      { "EVENT:WEBHOOK:*": ["webhook.received"] },
    "system.fulfillment":  { "EVENT:FULFILLMENT:*": ["*"] },
    "gateway":             { "EVENT:GATEWAY:DELIVERY": ["*"] },
    "system.gateway":      { "EVENT:GATEWAY:DELIVERY": ["*"] },

    "{{PROJECT_NAME}}": { "EVENT:ORDER:CREATED": ["order.paid", "order.refunded"] }
  }
  ```

  这份清单校准到 solo v{{SOLO_VERSION}}；若怀疑已过期，去源码核对
  `api/router/config.js` 的 `eventRegistry` 才是权威（这份 bundle 是单文件，找不到就 grep
  `eventRegistry`）。这条目前只能靠手工核对——没有只读方法能返回"当前生效的合并结果"，
  见 `docs/feedback/done/relay-provisioning-and-event-registry.md`。

---

## 3. 四种触发源（各自怎么到达）

`triggerSource` 是 `{kind}:{id}` 串；workflow 的 `allowed_triggers` 取 `:` 前的前缀做闸（见 `workflows.md` §4）。

| 源 | `triggerSource` | 怎么到达（一句话） |
|----|-----------------|--------------------|
| **sync** | `sync` | 调用方直接调 `orchestrator.workflow.run`，引擎 inline 执行（低延迟，无 run 实体） |
| **event** | `event:{stream}` | 服务发 `_event` → Router 写 stream → orchestrator matcher 匹配 ACTIVE workflow 的 `event_subscriptions` → 入 `ORCHESTRATOR:RUNQ:PENDING` |
| **cron** | `cron:{schedule_id}` | nexus 调度器 `ZPOPMIN` 到期项 → `run_command` 推 run-command，或 `emit_event` 调 `event.emit` |
| **webhook** | `webhook:{...}` | 外部 POST → `ingress.ingest`（API-key 鉴权 + request_id 去重）→ `event.emit` 到 `EVENT:WEBHOOK:{source}` → 同 event 路径 |

> matcher（触发 workflow，确定性地板）和 nexus（触发 agent/sentinel，AI 增强）是同一批 `EVENT:*` 流上的**两个独立消费组**。

---

## 4. 声明事件面（handlers/events.js）

`handlers/events.js` 导出 `{ emits, subscribes }`，经公开方法 `events` 暴露（`events` 是 base public 方法，免 permit；Router 握手时抓取存进 capability map）。

```js
// handlers/events.js
module.exports = {
  emits: [{
    stream:      'EVENT:ORDER:CREATED',
    type:        'order.paid',
    trigger:     '{{PROJECT_NAME}}.order.pay',          // 哪个方法会发它
    mechanism:   '_event piggyback',                    // 或 'relay → event.emit'
    payload:     { orderId: 'string', amount: 'number' },
    description: '订单付款成功',
  }],
  subscribes: [],   // 见下：业务服务通常留空
};
```

🔑 **关键事实**：普通业务服务 `subscribes: []` —— 这份声明是**文档性**的。真正的运行时订阅不在服务里，而在：
- **per-workflow** 的 `event_subscriptions`（orchestrator matcher 匹配）——你要"事件触发自动化"就写在 workflow 里；
- **per-agent/sentinel** 的 `eventSubscriptions`（nexus 匹配）。

workflow 订阅形（详见 `workflows.md` §4）：
```jsonc
"allowed_triggers": ["event"],
"event_subscriptions": [{ "stream": "EVENT:ORDER:CREATED", "filter": { "type": "order.paid" } }]
```

---

## 5. 发事件 + `_tasks` 派发

**发事件 · 路径 A（搭响应顺风车，首选）**——你正在回一个 RPC 时：
```js
return { ...businessResult, _event: [{ stream: 'EVENT:ORDER:CREATED', type: 'order.paid', payload: { orderId } }] };
```
Router 在回客户端前剥掉 `_event`，盖章后写 stream。

**发事件 · 路径 B（`event.emit`）**——后台循环 / worker / 调度器没有响应可搭：
```js
await relay.call('event.emit', { stream, type, payload, actor: `cron:${id}` });   // bot token，经 Router
```

**`_tasks`（让 Router 派发副作用 RPC）**——服务返回：
```js
return { ...instance, _tasks: [{
  service: 'erp',                       // 目标；省略则取 method.split('.')[0]
  method:  'erp.order.sync',
  params:  { sourceId, idempotency_key: `${transitionId}:A0` },   // 见 §6
}] };
```
Router 剥掉 `_tasks`，核对**任务白名单**（`allowFrom`/`allowMethods`）+ 校验目标参数 schema，再发一个**不等待、Router 签名**的 `context:'task'` 调用。

> 🔴 **绝不直接 POST 另一个服务。** 要么返回 `_tasks`（Router 派发），要么 `relay.call`（同步、经 Router），要么 `_event` / `event.emit`（事实扇出）。

---

## 6. 重投幂等（三层，各管一层）

| 层 | 机制 |
|----|------|
| **事件重投** | 你给 `event_id`（配 `/^[A-Za-z0-9_-]{8,64}$/`）→ Router `SET EVENT:DEDUP:{event_id} NX EX`（默认 3600s），TTL 内重发**被压制**。不给则每次随机 id，不去重。 |
| **run 队列** | run-command 带确定性 `trigger_id`：event 源 = stream 条目 ID（天然唯一）；cron = `{schedule_id}:{fire_at}`。去重的是 **workflow 执行**。 |
| **`_tasks` 下游** | `idempotency_key` 放进 `params`（普通下游参数）。约定如 `` `${transitionId}:A${idx}` `` —— 跨重试稳定，目标服务据此去重副作用。 |

> 另：`depth` + `EVENT_MAX_DEPTH`(默认 16) 是**自喂循环刹车**，不是去重——超额整批被拦并入错误队列（`EVENT_DEPTH_EXCEEDED`）。

---

## 7. 写完自查（最常踩）

1. **发了没登记的 stream/type** → 被 registry 拦截、静默不写。先把它加进 `SYSTEM:CONFIG:EVENT_REGISTRY`。
2. **事实 / 副作用选错语义** → "已发生"用 `_event`，"去做"用 `_tasks`（§0）。
3. **想"事件触发"却写进 `handlers/events.js` 的 subscribes** → 那是文档性的；真订阅写在 workflow 的 `event_subscriptions`（§4）。
4. **直接 POST 别的服务** → 改 `_tasks` / `relay.call` / `_event`（§5）。
5. **后台循环发事件却没幂等** → 给 `event_id`，下游给 `idempotency_key`（§6）。
