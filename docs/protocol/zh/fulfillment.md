# 履约生命周期协议 (Fulfillment Lifecycle Protocol)

> [!NOTE]
> **实现状态：🟢 v1 核心与跨栈 RPA 七项协同原语已落地（`v1.3.4+`）。** 声明式状态机、Profile 投稿审批与完整性锁（`approvedDigest`）、JsonLogic 条件与证据完整性门禁（`evidence`）、`_tasks` 异步发射、声明式跨栈异步委托（`peer_rpc_with_callback`）、批量工单扇入屏障（`fulfillment.barrier.*`）、乐观并发锁（`expectedTransitionId`）、状态停留超时自愈（`stateTtls` + `reap`）、任意态人工协办断点栈（`suspend` + `resume`）、一次性安全回调令牌（`token.issue` + `callback`）及来源幂等创建（`idempotent`）均已生产可用。§6.2 `ai_hooks` 与 `type: "workflow"` 编排器直调目前仍为 **🟡 草案·未实现**（跨服务动作统一走 `type: "task"` / `_tasks`、`kind: "peer_rpc_with_callback"` 或事件总线触发）。示例中的 erp/sale/commodity 等为业务举例，SOLO 本身不含这些服务。

---

> **协议版本**: 1.7.0
> **状态**: 已实现 (v1.3.4+)
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
存储在微服务中的状态快照（由 `library/entity.js` 持久化于 `FULFILLMENT:INSTANCE:{id}`，支持 `$owner` 行级租户隔离）。

```json
{
  "id": "FL-20260311-001",
  "sourceId": "ORD-123",
  "profileId": "standard_trade",
  "state": "DEPOSIT_PENDING",
  "prevState": "DRAFT",
  "stateChangedAt": 1741660462000,
  "createdAt": 1741660412000,
  "createdBy": "uid-admin",
  "meta": {
    "payment_status": "PENDING"
  },
  "suspension": null,
  "pending_callbacks": [
    {
      "tokenId": "fltk_9f8a7b6c5d4e",
      "allowedEvents": ["payment_received", "payment_failed"],
      "expectedTransitionId": "FL-20260311-001-T1",
      "issuedAt": 1741660462000,
      "issuedBy": "uid-admin",
      "expiresAt": 1741664062000
    }
  ],
  "history": [
    {
      "transition_id": "FL-20260311-001-T0",
      "state": "DRAFT",
      "event": "created",
      "reason": "INITIAL",
      "user": "uid-admin",
      "stamp": 1741660412000
    },
    {
      "transition_id": "FL-20260311-001-T1",
      "state": "DEPOSIT_PENDING",
      "event": "order_submitted",
      "meta_update": { "payment_status": "PENDING" },
      "user": "uid-admin",
      "stamp": 1741660462000
    }
  ]
}
```

**`pending_callbacks` 字段说明（由 `fulfillment.instance.token.issue` 签发维护，单实例上限 16 条）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `tokenId` | string | 回调令牌公开标识（`fltk_...`），明文 `flcb_...` 仅在签发时返回一次，Redis 仅存 SHA-256 |
| `allowedEvents` | string[] | 允许该令牌触发的 `transition.event` 白名单 |
| `expectedTransitionId` | string\|null | 绑定的乐观锁轮次 ID（实例若已离开该轮次则回调自动失效） |
| `issuedAt` | number | 签发时间戳（epoch ms） |
| `issuedBy` | string | 签发者 uid |
| `expiresAt` | number | 过期时间戳（epoch ms） |

**`suspension` 字段说明（仅在 `fulfillment.instance.suspend` 挂起于 `ASSIST_REQUIRED` 期间非空，`resume` 后清空为 `null`）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `blockedState` | string | 挂起前所处的业务状态（`resume` 时原路恢复至此状态） |
| `prevStateBeforeSuspend` | string\|null | 挂起前的 `prevState` |
| `suspendedTransitionId` | string | 挂起时刻的 `transition_id` |
| `reason` | string | 人工可读挂起原因（如验证码、扫码登录、DOM 漂移） |
| `reasonCode` | string | 结构化原因码（如 `CAPTCHA`、`OTP_REQUIRED`、`DOM_DRIFT`、`MANUAL_INTERVENTION`） |
| `checkpoint` | object\|null | RPA 断点上下文（如 `{ step, cursor, pageUrl }`） |
| `aiSuggestion` | string\|null | 给人工协办员的排障建议 |
| `suspendedAt` | number | 挂起时间戳（epoch ms） |
| `suspendedBy` | string\|null | 触发挂起的主体 uid |

**`history` 字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `transition_id` | string | 实例内单调递增的跃迁序号（如 `FL-xxx-T0`、`FL-xxx-T1`），用于 `_tasks` 幂等键派生与 `expectedTransitionId` 乐观并发锁 |
| `state` | string | 进入该记录时的目标状态 |
| `event` | string | 触发本次状态变更的事件名（初始创建为 `created`，协办挂起为 `assist_requested`，恢复为 `resume`） |
| `reason` | string? | 初始创建（`INITIAL`）、超时收割（`TIMEOUT` 或自定义）、强推（`override`）、挂起（`suspend`）的原因说明 |
| `resolution` | string? | `resume` 恢复时记录的人工排障结论 |
| `forced` | boolean? | `fulfillment.instance.override` 管理员强制跳过条件推进时标记为 `true` |
| `reaped` | boolean? | `fulfillment.instance.reap` 超时自动收割推进时标记为 `true` |
| `viaCallbackToken` | string? | 经 `fulfillment.instance.callback` 令牌推进时记录消费的 `tokenId` |
| `meta_update` | object? | 本次跃迁随 `metaUpdate` 传入的增量快照（已递归剔除 `callbackToken` 等敏感键），供事后审计回放当跳守卫输入 |
| `user` | string | 操作者 uid |
| `stamp` | number | Unix 时间戳（毫秒） |

### 2.2 履约配置模板 (Fulfillment Profile)
定义合法的状态切换、触发事件、证据完整性门禁、状态停留超时与关联动作。Profile 是声明式配置，不含任何业务逻辑代码。

```json
{
  "id": "standard_trade",
  "name": "标准业务履约",
  "status": "ACTIVE",
  "meta_fields": [
    { "key": "payment_status", "label": "支付状态", "type": "string" },
    { "key": "amount_received", "label": "已收金额", "type": "number" },
    { "key": "deposit_required", "label": "应付订金", "type": "number" },
    { "key": "receipt_url", "label": "水单凭证链接", "type": "string" }
  ],
  "stateTtls": {
    "DEPOSIT_PENDING": {
      "ttlMs": 86400000,
      "event": "deposit_timeout",
      "reason": "TIMEOUT"
    }
  },
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
      "evidence": {
        "requiredFields": ["receipt_url", "amount_received"],
        "rejectMasked": true,
        "rejectLoopbackUrls": true,
        "minBytes": { "receipt_url": 12 }
      },
      "actions": [
        {
          "type": "task",
          "service": "notification",
          "method": "inbox.send",
          "params": {
            "title": "订金已确认",
            "instanceId": { "var": "instance.id" },
            "sourceId": { "var": "instance.sourceId" }
          }
        }
      ]
    },
    {
      "event": "deposit_timeout",
      "from": "DEPOSIT_PENDING",
      "to": "CANCELLED"
    }
  ]
}
```

**`transition` 字段说明：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `event` | 是 | 触发本次切换的事件名，同一 `(from, to)` 可有多个 event；同一 `(event, from)` 可有多条带不同 `condition` 的分支（按顺序取第一条满足条件的规则） |
| `from` | 是 | 来源状态 |
| `to` | 是 | 目标状态（由引擎根据命中规则派生，调用方从不传目标状态） |
| `condition` | 否 | JsonLogic 条件，缺省则无条件允许；数值比较（`<`/`<=`/`>`/`>=`）遇缺失字段（`undefined`/`null`/`""`）一律 fail-closed 判假 |
| `evidence` | 否 | **反静默假成功证据门禁**（`v1.3.3`）：在状态落定前校验 `instance.meta` 证据完整性（见下方 `evidence` 字段表） |
| `actions` | 否 | 切换成功后发射的动作列表（见下方 Action 类型） |

**`transition.evidence` 证据门禁字段说明（`v1.3.3` 已实现，静态由 Lint 规则 9a 校验）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `requiredFields` | `string[]` | 必填的 `instance.meta` 点分路径列表；值不得为 `undefined`/`null`/空白串/空数组 `[]`/空对象 `{}`/`NaN`/函数，且严禁命中 `__proto__`/`constructor`/`prototype` |
| `rejectMasked` | `boolean` | 为 `true` 时递归扫描证据字符串，拦截 `****`、`••••`、`[REDACTED]`、`138****1234` 等脱敏掩码乱码 |
| `rejectLoopbackUrls` | `boolean` | 为 `true` 时拦截指向 `localhost`、`127.0.0.0/8`、`0.0.0.0/8`、`::1`、`::`、`[::ffff:127.x.x.x]`（含十六进制 `[::ffff:7f00:1]`）及 `.local`/`.localhost` 的死链 URL |
| `minRows` | `Record<path, number>` | 指定数组字段的最小行数（如 `{ "items": 1 }` 防空表回执伪装成功） |
| `minBytes` | `Record<path, number>` | 指定字符串/对象字段的最小 UTF-8 字节数 |

**`profile.stateTtls` 状态停留超时配置说明（`v1.3.3` 已实现，静态由 Lint 规则 8 校验）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `stateTtls[STATE].ttlMs` | `number` | 允许在该状态停留的最大毫秒数（正数） |
| `stateTtls[STATE].event` | `string` | 超时后自动触发的 `transition.event`（必须在该状态出发的 `transitions` 中真实存在） |
| `stateTtls[STATE].reason` | `string?` | 写入 `history[].reason` 与 `meta.timeout_reason` 的原因码（默认 `'TIMEOUT'`） |

**Action 类型说明：**

| `type` / `kind` | 说明 | 实现状态 |
|--------|------|----------|
| `task`（默认） | 通过 `_tasks` 交 Router 异步派发单个本栈 RPC（自动注入 `idempotency_key: "{transition_id}:A{idx}"`） | 🟢 已实现 |
| `peer_rpc_with_callback` | 声明式跨栈异步委托：引擎在状态落盘时自动签发绑定当前 `transition_id` 的单次 `flcb_...` 回调令牌，经 `library/peer-relay` 向对端 SOLO 栈（如 `steward.bridge.dispatch`）投递并注入 `upstream.callbackToken` | 🟢 已实现 |
| `workflow` | 调用编排器执行多步 workflow，支持 `on_complete` 回调 | 🟡 草案·未实现（当前统一通过 `type: "task"` 或 `EVENT:FULFILLMENT:TRANSITIONED` 事件触发编排器） |

**`type: "task"` 专属字段：**

| 字段 | 说明 |
|------|------|
| `service` | 目标服务名（须在 Router `setting.task` 白名单中授权 `allowFrom: ['fulfillment']`） |
| `method` | RPC 方法名（可写短名 `inbox.send` 或全名 `notification.inbox.send`） |
| `params` | 调用参数，支持 JsonLogic 变量注入（`var`、`cat`、`+`） |

**`kind: "peer_rpc_with_callback"` 专属字段：**

| 字段 | 说明 |
|------|------|
| `peer` / `endpoint` | 对端 SOLO 栈标识（映射环境变量 `SOLO_PEER_<PEER>_URL` 或 `config.peers[peer]`）或显式 JSON-RPC 端点 URL |
| `method` | 对端 RPC 方法名（如 `steward.bridge.dispatch`） |
| `callback.allowedEvents` | 必填非空数组，允许对端回调触发的 `transition.event` 白名单（Lint 强制核验这些事件在目标态 `to` 下有定义） |
| `callback.ttlMs` | 可选，回调令牌有效期（毫秒，默认 30 分钟，上限 7 天） |
| `paramsFromMeta` | 可选，从 `instance.meta[paramsFromMeta]` 读取业务派单参数并与 `params` 合并，自动附加 `idempotencyKey` 与 `upstream: { instanceId, profileId, sourceId, transitionId, expectedTransitionId, callbackToken, tokenId, allowedEvents, expiresAt, callbackUrl }` |

### 2.3 Profile 存储与双轴治理规范
Profile 由 `library/entity.js` 存储在 Redis 中（支持软删除与投稿审批双轴）：

```
KEY:   FULFILLMENT:PROFILE:{profileId}
TYPE:  String (JSON)
TTL:   无（持久化）
```

**两条独立生命周期轴：**
- **实体软删轴（`status`）**：`ACTIVE` / `DELETED`。`fulfillment.profile.delete` 执行软删（`loadProfile` 自动拦截 `status === 'DELETED'` 的模板），`restore` 恢复为 `ACTIVE`，`destroy` 物理删除。
- **内容投稿审批轴（`reviewState`）**：
  - 管理员直建（`profile.create`）：无 `reviewState` 字段，创建后立即可用。
  - 投稿或追溯纳入审核（`profile.submit` / `enroll: true`）：通过静态 Lint 后置为 `PENDING_REVIEW`，此时任何 `instance.create` 与 `instance.transition` 均被激活闸拦截（`FORBIDDEN`）。
  - 审批激活（`profile.approve`）：校验职责分离（审批人不得在累积 `contributors` 贡献者列表中），置为 `APPROVED` 并记录可执行定义的 SHA-256 摘要 `approvedDigest`。
  - 编辑回审锁（`profile.update`）：一旦修改已审批模板的可执行字段（`transitions` / `meta_fields` / `stateTtls`），引擎强制重跑 Lint 并将 `reviewState` 重置为 `PENDING_REVIEW`、清空 `approvedDigest`，冻结在途实例直至重新审批。

---

## 3. 运行机制

### 3.1 状态切换与并发安全逻辑 (`fulfillment.instance.transition`)
当调用 `fulfillment.instance.transition`（或语义包装方法 `cancel` / `hold` / `override` / `callback` / `reap`）时，引擎在进程内实例锁 `withInstanceLock(id)` 与 Redis `WATCH/MULTI/EXEC` 乐观事务保护下按以下步骤操作：

1. **挂起锁与乐观锁核验**：
   - 若实例当前处于 `suspension` 协办挂起态（如 `ASSIST_REQUIRED`），拒绝常规 `transition`（仅允许 `resume`、`cancel_requested`、`override` 或 `reap` 超时迁出）。
   - 若调用方传入了 `expectedTransitionId`，强制核验其与 `instance.history.at(-1).transition_id` 完全一致，否则立即拒绝（`-32602`），阻断自愈环路中的 ABA 迟到回调覆盖。
2. **加载并核验 Profile**：从 Redis 读取 `instance.profileId`；若不存在或 `status === 'DELETED'` 报 `NOT_FOUND`（`-32004`）；若存在 `reviewState` 且不为 `'APPROVED'` 报 `FORBIDDEN`（`-32003`）。
3. **合并 `metaUpdate`**：若传入 `metaUpdate`（或别名 `meta`），先递归剔除 `callbackToken` / `callback_token` 及原型污染键，再浅合并入 `instance.meta`（使其对第 4、5 步的守卫立即可见）。
4. **匹配规则与 JsonLogic 条件校验**：在 `transitions` 中寻找 `event` 和 `from === instance.state` 匹配的候选规则，注入上下文运行 JsonLogic（见 3.2），取第一条条件成立的规则（`override` 管理员强推跳过条件）。
5. **证据完整性门禁（`rule.evidence`）**：若命中的规则声明了 `evidence`，调用 `evaluateEvidenceGate(rule.evidence, mergedMeta)` 校验必填字段、最小行数/字节数、反掩码与反回环 URL（`override` 跳过）。
6. **状态原子持久化与事件广播**：更新 `state`、`prevState`、`stateChangedAt`，生成单调递增 `transition_id`（`{id}-T{n}`）追加至 `history`，清理已过期的 `pending_callbacks`，经 `entity.optimisticUpdate` 原子落盘，并向事件总线广播 `EVENT:FULFILLMENT:TRANSITIONED`。
7. **动作发射 (`_tasks`)**：将命中规则的 `actions` 解析为带 `idempotency_key: "{transition_id}:A{idx}"` 的 `_tasks` 数组随响应返回，由 Router 异步投递（后台 `reaperTimer` 则经 `relay.call` 直接投递）。

### 3.2 变量解析作用域
在 `condition` 与 `actions.params` 中，JsonLogic 的数据上下文为：

```json
{
  "instance": { },
  "now": 1788488514012,
  "user": "uid-xxx",
  "permit": "admin",
  "constraints": { }
}
```

`now` = 求值时刻的 epoch ms（与 Factory 时间字段同形态，经 `library/clock.js`，测试可冻结）。

引用方式均使用 JsonLogic 标准 `{ "var": "path.to.field" }` 语法：

```json
{ "var": "instance.meta.payment_status" }
{ "var": "permit" }
{ "var": "constraints.maxAmount" }
```

**`actions.params` 的求值面比 `condition` 窄**：只有整字段写成 `{"var": …}`、`$` 前缀键、或**唯一键是 `cat` / `+`** 的对象才求值（`library/jsonlogic.js` 的 `RESOLVE_OPS`，与 `orchestrator` 共享单一真源）。**字符串不做插值**——要拼字符串用 `cat`，要算相对死期用 `+`：

```json
{
  "requestId": { "cat": ["fx-", { "var": "instance.id" }, "-publish"] },
  "expireAt": { "+": [{ "var": "now" }, 7200000] }
}
```

### 3.3 长周期协同与五项 RPA 原语 (`v1.3.3`)

**核心原则：跨小时/跨天的等待发生在持久化状态节点上，不发生在单次 HTTP 请求内部。**

围绕长周期业务与外部 RPA 执行手（如 `steward` 千手插件/桌面手）的闭环协同，协议提供五项原生原语：

1. **来源幂等创建（`fulfillment.instance.create { sourceId, profileId, meta?, idempotent: true }`）**：
   - 按 `($owner, profileId, sourceId)` 生成无碰撞 SHA-256 索引键并以 Redis `SET NX` 抢占。
   - 定时巡检或上游重试重复建单时，直接返回已绑定的存量实例并标记 `deduplicated: true`。
2. **最小权限一次性回调凭证（`fulfillment.instance.token.issue` + `fulfillment.instance.callback`）**：
   - 派单方调用 `token.issue({ id, allowedEvents, ttlMs?, bindCurrentTransition? })` 签发高熵一次性令牌 `flcb_...`（Redis 仅存 SHA-256，上限 16 个待决令牌，终态实例禁止签发）。
   - 外部 RPA 执行手无需持有全局推进权限，直接向公开端点 `fulfillment.instance.callback` 提交 `Authorization: Bearer flcb_...`（或 `X-Callback-Token` 头）与 `{ event, metaUpdate }`。
   - 引擎以 `GETDEL` 原子消费令牌；若因 `evidence` 或 `condition` 门禁未通过而拒收且实例仍停在原轮次，引擎自动按剩余 TTL 恢复该令牌，允许执行手补齐证据后重试。
3. **任意态人工协办断点栈（`fulfillment.instance.suspend` + `fulfillment.instance.resume`）**：
   - 当 RPA 遇到验证码、扫码或 DOM 漂移时，无需在 Profile 中为每个业务状态穷举 `N × M` 条暂停边，直接调 `suspend({ id, reason, reasonCode?, checkpoint?, aiSuggestion?, metaUpdate?, expectedTransitionId? })`。
   - 引擎验证当前状态非终态、非 `ON_HOLD`，且目标挂起态（默认 `ASSIST_REQUIRED`）不与 `profile.transitions` 中的任何业务状态重名后，保存 `suspension` 断点栈并切入挂起态。
   - 人工排障后调用 `resume({ id, resolution?, metaUpdate?, expectedTransitionId? })`，原路恢复至 `suspension.blockedState` 并广播 `EVENT:FULFILLMENT:TRANSITIONED`。
4. **状态停留超时自愈（`profile.stateTtls` + `fulfillment.instance.reap`）**：
   - Profile 在 `stateTtls` 中声明某状态的最大停留毫秒数 `ttlMs` 与超时迁出事件 `event`。
   - 由外部定时任务调用 `fulfillment.instance.reap({ profileId?, dryRun?, limit? })` 或配置环境变量 `FULFILLMENT_REAP_INTERVAL_MS` 启动服务内置周期扫描器，自动将超时实例推进至超时分支并派发下游补偿 `_tasks`。
5. **反静默假成功证据门禁（`transition.evidence`）**：
   - 在状态迁移落盘前拦截空表（`minRows`）、过短内容（`minBytes`）、`****` 脱敏乱码（`rejectMasked`）与 `127.0.0.1`/`localhost` 本地死链（`rejectLoopbackUrls`），防止外部脚本把报错页或残缺采集团体伪装成履约成功。
6. **声明式跨栈异步委托（`transition.actions[].kind = "peer_rpc_with_callback"`）**：
   - 消灭各业务仓重复手写的跨栈登录续期与 `token.issue` 胶水：状态跃迁落盘时自动签发绑定当前 `transition_id` 的 `flcb_...` 令牌，合并 `instance.meta[paramsFromMeta]` 与 `upstream.callbackToken`，经 `library/peer-relay`（支持 `X-API-Key`、Bearer JWT 或 `user.login` 自动续期）投递至对端 SOLO 栈。
7. **批量工单扇入汇聚屏障（`fulfillment.barrier.{create,checkin,get,reap}`）**：
   - 针对「定时任务组扇出 N 张采集子单 → 全员终局汇聚 → 触发下游履约」场景：
     - `fulfillment.barrier.create({ barrierKey, expectedCount, ttlMs?, onSettled?, meta? })`：按 `barrierKey` 幂等登记汇聚屏障；
     - `fulfillment.barrier.checkin({ barrierKey, itemId, outcome: 'DONE'|'FAILED'|'SKIPPED', result? })`：子任务终态幂等打卡，当 `completedCount === expectedCount` 时原子结算为 `SETTLED` 并**唯一一次**触发 `onSettled`（支持推进本栈 `fulfillment` 实例、派发本栈 `_tasks` 或通过 `peer-relay` 回调对端 SOLO 栈）；
     - `fulfillment.barrier.reap({ dryRun?, limit? })`：扫描超过 `expiresAt` 仍未齐套的 `PENDING` 屏障，原子结算为 `EXPIRED`（`timedOut: true`）并触发超时分支。

---

## 4. 安全与约束

### 4.1 租户隔离与权限过滤
- **行级租户隔离（`$owner`）**：当调用方携带受限 Passport 约束（`constraints.$owner`）时，`instance` 的创建、读取、列表、推进、挂起、恢复与幂等索引均严格限制在该 `$owner` 作用域内。
- **管理面权限门禁**：`fulfillment.profile.{create,update,delete,restore,destroy,approve,reject}`、`fulfillment.instance.{override,reap}` 在 RPC 入口强制校验 `isAdmin`。

### 4.2 软删除一致性（🟡 草案·未实现）
当 `sourceId` 对应的外部业务实体被删除时，未来规划支持根据配置自动将关联履约实例置为 `CANCELLED` 并记录 `reason: SOURCE_DELETED`（当前版本需由上游业务主动调用 `fulfillment.instance.cancel`）。

---

## 5. 错误处理

履约服务统一采用 [`library/jsonrpc.js`](../../../api/library/jsonrpc.js) 标准错误码：

| 错误场景 | 错误助手 / 错误码 | 说明 |
|----------|-------------------|------|
| 条件不满足 / 证据门禁拒收 / 未找到匹配 transition / 乐观锁 `expectedTransitionId` 失配 | `invalidParams` (`-32602`) | 参数或状态机前置守卫拒绝，状态不发生跃迁 |
| 实例或 Profile 不存在（含 Profile 已软删 `status === 'DELETED'`） | `notFound` (`-32004`) | Redis 中无对应记录或跨 `$owner` 不可见 |
| 非管理员调用管理方法 / Profile `reviewState !== 'APPROVED'` / 审批人自审 / 回调令牌无效或过期 | `forbidden` (`-32003`) | 权限或治理门禁拦截 |
| Profile ID 已存在 / 实例高并发写冲突 | `conflict` (`-32009`) | 唯一键冲突或乐观锁 CAS 重试耗尽 |
| `_tasks` 下游异步 Action 失败 | 仅记录，不回滚状态 | 由 Router 记录至 `ERROR:QUEUE`，不影响已落盘的状态跃迁 |

---

## 6. AI 治理与安全边界 (AI Governance & Safety)

### 6.1 决策与执行分层（`ai: true` vs `ai: false`）
在 SOLO·AI 架构中，履约引擎严格区分只读感知与状态推进：
- **只读与候选生成方法（`ai: true`）**：`instance.{create,get,list}`、`profile.{get,list}` 允许 AI Agent 自主调用以感知状态与上下文。
- **状态写操作与治理方法（`ai: false`）**：`instance.{transition,cancel,hold,suspend,resume,reap,override,update,token.issue,callback}` 及 `profile.{create,update,delete,restore,destroy,generate,submit,approve,reject}` 均设为 `ai: false`，禁止 LLM 在自由对话中擅自推进状态机；外部自动化哨兵须通过明确授权的 RBAC 方法白名单或单次 `callbackToken` 触发。

### 6.2 AI 介入合约 (AI Hook Contract)（🟡 草案·未实现）
> **状态说明**：以下 `ai_hooks` 结构为协议预留设计，当前版本（`v1.3.3`）尚未在 `instance.js` 内置执行器，AI 协同目前通过 `EVENT:FULFILLMENT:TRANSITIONED` 事件总线触发 `nexus`（Agent 上下文组装协议）或外部哨兵实现。
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
7. **出口可达（可选，`options.taskWhitelist`）**：每个 `task` action 能通过 Router 的 `_tasks` 白名单（目标服务在表内、`fulfillment` 在其 `allowFrom`、方法在其 `allowMethods`，两处 `*` 通配与运行时同义）。**与规则 4 是两道互不相干的闸**：4 问"这个方法存不存在"，7 问"状态机够不够得着它"。7 之所以必须提前到激活前，是因为它在运行时**结构上不可能被观察到**——白名单是在响应发出**之后**才查的（Router 先 `res.json()`、再异步 `processTasks`），调用方拿到的是 200 + 干净 history，响应里连 `_tasks` 字段都被删了，被挡下只留一行服务器 `console.warn`。服务侧由 `profile.submit` / `profile.update` 自动读取当前白名单供给；读不到则该规则关闭（不阻断创作）。
8. **AI 挂钩与辅助路由校验（Rule 8 / 9a / 9b）**：
   - **Rule 8（`ai_hooks` 结构与可达性）**：每个 `ai_hook.invoke` 必须是已注册方法且通过 `allowedActions` 校验；`disposition` 必须为 `human_confirm` / `auto_execute` / `log_only`；非 `log_only` 时 `outcome_map` 映射到的目标 `event` 必须存在于 `transitions` 中。
   - **Rule 9a（`assist.invoke` 存在性）**：若转移配置了 `assist.invoke`，该方法必须是已注册方法且通过 `allowedActions` 校验。
   - **Rule 9b（`assist` 双出口对称性）**：若转移配置了 `assist`，必须同时在 `transitions` 中提供从 `assist.waiting_state` 出发的 `assist.resume_event`（继续推进）与 `assist.fallback_event`（降级兜底）两条出口，防止实例困死在等待态。

**机器不保证（必须人审 / 真 LLM eval）：**
- **业务意图**：lint 证明"接线对、图能通"，**不证明"这条流程符合需求"**。阈值写反（`≤` 写成 `≥`）、状态语义错配、把"放行"接到"冻结"——lint 一律看不出来。
- **运行时副作用边界**：action 方法存在 ≠ 该 Profile 有权调它。运行时仍由 **§6.3 三层防线**（Profile actions 白名单 → Router `_tasks` 白名单 → RPC permit）兜底；`allowedActions` 与规则 7 都只是激活前的镜像预审，**不替代**运行时校验（白名单可被运维随时改窄）。
  > 🔴 **Router `_tasks` 白名单出厂只有 `notification` 与 `gateway` 两家**，即「状态机推进业务动作」**开箱即不可用**。要派给别的服务，先 `setting.task.get` 读出整张表、合并后 `setting.task.update` 写回（**整体替换语义**，直接写一项会把原有两家一起抹掉）。另注意 Router 只在该配置键**不存在**时播种一次——运维改过的白名单不会被升级覆盖，代价是**框架往默认值里加一家时，存量部署一个都拿不到，且没有提示**。
- 结论：**人审是本协议的一部分，不是可选项**——lint 把"机器能判的"判到位，"机器判不了的意图"留给人签名背书。

### 7.2 生成路径（NL → 候选）

`fulfillment.profile.generate({ requirement, profileId?, maxRepairs? })`：
1. 服务经 relay 调 `agent.chat`，以「能力上下文（可用方法及其返回字段）+ schema + 需求」为提示词，产出候选 JSON（提示词受 `agent.chat` 4000 字上限约束，目录过大时按预算截断 + 标注省略）。
2. 立即跑 §7.1 lint；有 error 就把 error 回喂 LLM 做**有界修复**（默认 ≤2 轮，硬上限 `maxRepairs <= 5`）。
3. 返回 `{ profile, lintReport:{errors,warnings}, attempts, ok }`，**`ok` = 0 errors = 可激活**。
4. **永不自动创建**——返回候选，由人审后另行 `fulfillment.profile.create` 或 `fulfillment.profile.submit`。

operator 门户「✨ 描述生成」即此路径的人审 UI：展示判定 + 错误/警告 + 候选，**「创建」按 lint 干净与否门控**。

### 7.3 投稿生命周期（外部 AI → ACTIVE）

受信外部 agent（B 档，见 [VERSION.md §3.4](../../planning/VERSION.md) / [governance.md](./governance.md)）以**窄 permit bot** 投稿 Profile，流程对齐 workflow 的 C1 审批：
1. 外部 AI 产出 Profile JSON（或经 §7.2 generate）→ 调用 `fulfillment.profile.submit`（或 `fulfillment.profile.create(..., { enroll: true })`）。
2. 服务跑 §7.1 lint（带 `allowedActions` = 投稿身份的允许方法集）→ 任一 error 即拒。
3. 通过则落 `PENDING_REVIEW`，进入审批队列，记录 `submittedBy` 与历史贡献者集合 `contributors`（含创建人及历次修改可执行字段的编辑人）。
4. 人工调用 `fulfillment.profile.approve` 激活（校验 `approver !== submittedBy` 且 `!contributors.includes(approver)`，杜绝串谋自审）；执行发生在审批背书后的身份下，**投稿身份永不执行**；失败随时退回人工。

> ✅ **实现状态**：§7.1（lint 九规则：1~7 + 8 + 9a/9b）+ §7.2（generate，含 `maxRepairs <= 5` 上限）+ §7.3 投稿面**核心已落地**（`api/apps/fulfillment/logic/{lint,generate,profile,instance}.js`）：
> - `profile.submit`（lint 把关 → `PENDING_REVIEW`，broken 直接拒、不入队）/ `profile.create({ enroll: true })` / `profile.approve`（管理员，**审批人 ≠ 投稿人且不在 `contributors` 列表内**）/ `profile.reject`；
> - `reviewState` 审批轴（独立于 Factory 的 `status`）+ **激活闸**：`instance.create` **与** `instance.transition`(advance) 都对非 `APPROVED` 的 profile 拒 `FORBIDDEN`（新建 + in-flight 实例都拦）；直建 profile（未传 `enroll: true`）无 `reviewState` → 仍即用，向后兼容；
> - **激活后完整性闸**：`profile.update` 改可执行字段（`transitions`/`meta_fields`/`ai_hooks`）→ **重新 lint + 回落 `PENDING_REVIEW` + 将编辑者追加进 `contributors` + 清审批**（其 in-flight 实例随之冻结，待重审）；元数据改（name/desc）不触发。`approve` 落 **`approvedDigest`**（可执行定义的 sha256 规范化摘要，绑定「批了哪一版」，改一字即变、可验不可抵赖）。

---

## 附录 A. 状态命名约定

Protocol 不强制规定状态枚举，各 Profile 自定义完整状态集。命名遵循以下约定：

- 全部大写，单词间用下划线连接：`DEPOSIT_CONFIRMED`
- 终态建议以 `CLOSED` 或 `CANCELLED` 结尾
- 旁路态建议用 `ON_HOLD`、`DISPUTE`、`ASSIST_REQUIRED` 等语义明确的名称

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
| `ASSIST_REQUIRED` | 等待外部节点回执（§4.3 混合过渡态） | 旁路 |
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
