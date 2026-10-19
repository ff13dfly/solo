# 履约状态机在「外部哨兵自愈环路 + 大批量巡检」下的四处缺口：ABA 并发竞态、`list` 缺过滤维度、`resume` 漏发事件与受限账号自省盲区

- **来源**：steward 派生项目，2026-10-19。在推进「由外部 Agent（WorkBuddy 定时任务）驱动 `fulfillment` 跑大批量复杂交互任务，并由外部 Agent 充当实时外部哨兵（External Sentinel）接管 `needs_assist` 排障自愈」的架构核验与源码对账中发现。
- **依据分类**：
  - **源码核实**（solo 仓当前代码，对应 bundle **v1.3.1**）：所有 `文件:行号` 均对照 solo 主仓实时核对。
  - **关联历史反馈**：
    - 承接 [`docs/feedback/done/fulfillment-meta-write-leaves-no-trace.md`](./done/fulfillment-meta-write-leaves-no-trace.md) §六处理结论中标记为 `⏸ 建议 3（乐观锁）` 的待定项——当时结论为*“等真出现并发覆盖的场景再上，那时才知道该锁在 `updatedAt` 还是 `meta` 的某个子键上”*，本次给出了自愈环路下的确凿 ABA 竞态场景与锁键答案（`transition_id`）。
    - 承接 [`docs/feedback/fulfillment-condition-fail-open.md`](./fulfillment-condition-fail-open.md) §三*“超时检测由外部定时任务扫描完成”*——当调用方真去写这个外部超时扫描循环时，撞上 `instance.list` 的过滤与排序瓶颈。
- **涉及**：
  - `api/apps/fulfillment/logic/instance.js`（`advance` `:77-184`、`list` `:239-255`、`resume` `:303-327`、`update` `:342-355`）
  - `api/apps/fulfillment/handlers/introspection.js`（`fulfillment.instance.list` `:69-82`、`transition` `:84-95`、`update` `:144-158`）
  - `api/apps/fulfillment/handlers/events.js`（`:5-22`）
  - `api/router/handlers/system.js`（`system.capabilities` 对非 admin 调用方的 `ai:true` 过滤）

> 一句话：当 `fulfillment` 从「单向线性推进」进入「带 `EXECUTING <-> needs_assist` 自愈环路 + 多车道并发 + 外部哨兵巡检」时，现有的 `(event, fromState)` 匹配防不住跨轮次晚到回调（ABA 竞态），`instance.list` 筛不出单车道超时僵尸单，`resume` 违背 `events.js` 契约漏发了 `TRANSITIONED` 事件，且获授权的非 admin 哨兵账号无法通过 `system.capabilities` 自省写方法 Schema。

---

## 一、自愈环路（`EXECUTING <-> needs_assist`）下的 ABA 竞态：`t.from === fromState` 防不住跨轮次晚到回调

### 1.1 为什么会出现自愈环路
在复杂浏览器 RPA 履约（如结汇申报、跨域改价、商品巡检）中，状态机不是单向走到底的，而是标准的主干 + 旁路自愈环：

```text
EXECUTING_TASK  ──(task_failed)──►  needs_assist
       ▲                                  │
       └────────(assist_resolved)─────────┘
```

当任务遇到弹窗遮挡、验证码或临时 DOM 漂移时，跃迁到 `needs_assist`；外部哨兵（WorkBuddy）介入完成排障（或微调剧本参数）后，触发 `assist_resolved` 把实例**推回 `EXECUTING_TASK`** 重新执行。

### 1.2 源码现状与 ABA 竞态复现过程
`api/apps/fulfillment/logic/instance.js:98-100` 的状态校验仅检查当前 `instance.state` 是否等于规则的 `from`：

```js
const fromState = instance.state;
...
const candidates = (profile.transitions || []).filter(
    t => t.event === event && t.from === fromState
);
```

在无环状态机里，`fromState` 隐式充当了幂等保护（走过 `S1 -> S2` 后，迟到的 `S1` 回调因 `fromState === 'S2'` 被拒）。但在自愈环路里，**同一个状态名 `EXECUTING_TASK` 会在第 1 轮和第 2 轮重复进入**：

| 时刻 | 动作主体 | 发生什么 | 实例状态与 `transition_id` |
|---|---|---|---|
| **T1** | 调度器 | 触发 `start_task`，派发第 1 轮浏览器工单 `Job-A` | `state = EXECUTING_TASK` (`FL-xxx-T1`) |
| **T2** | 外部哨兵 | 发现 `Job-A` 长时间未结案/页面卡住，触发 `task_failed` 挂起排障 | `state = needs_assist` (`FL-xxx-T2`) |
| **T3** | 外部哨兵 | 排障完成，触发 `assist_resolved` 重回执行态，派发第 2 轮工单 `Job-B` | `state = EXECUTING_TASK` (`FL-xxx-T3`) |
| **T4** | 旧执行器 (`Job-A`) | `Job-A` 终于超时报错返回，旧回调拿着第 1 轮上下文调 `transition({ id, event: 'task_failed', metaUpdate: { error: 'Job-A timeout' } })` | ⚠️ **`fromState` 恰好又是 `EXECUTING_TASK`！校验全绿放行！** |

**后果**：
1. 正在正常执行的第 2 轮工单 `Job-B` 被第 1 轮 `Job-A` 的晚到尸体回调**直接打断并误杀回 `needs_assist`**（`FL-xxx-T4`）；
2. `instance.meta` 里的当前轮次证据被 `Job-A` 的过时错误覆盖；
3. 同理，若旧执行器在 T3 之后调 `instance.update({ id, meta })`（`instance.js:342-355`），也是无锁浅合并，直接把旧轮次的脏数据写进新轮次。

### 1.3 回应 `fulfillment-meta-write-leaves-no-trace.md` §六的提问：乐观锁该锁在哪个键上？
上次 triage 时留下的问题是：*“那时才知道该锁在 `updatedAt` 还是 `meta` 的某个子键上。”*

在这个场景下，答案非常清晰：**不需要新造版本号字段，实例上现成的 `transition_id`（即 `instance.history.at(-1).transition_id`，格式 `FL-xxx-T{N}`）就是天然的单调因果游标**：
- 每一次跃迁（含 `transition` / `cancel` / `hold` / `resume` / `override`）都会生成唯一且严格递增的 `transitionId = ${id}-T${instance.history.length + 1}`（`instance.js:119, 314`）；
- 第 1 轮派发 `Job-A` 时处于 `FL-xxx-T1`，第 2 轮派发 `Job-B` 时处于 `FL-xxx-T3`；
- 只要 `transition`（及 `update`）支持可选参数 **`expectedTransitionId`**（或 `expectedState`）：
  - 调用方不传：行为与现在 100% 相同，零破坏；
  - 调用方传了 `expectedTransitionId: "FL-xxx-T1"`：若当前 `instance.history.at(-1)?.transition_id !== expectedTransitionId`，立即拒绝并返回冲突错误（如 `INVALID_PARAM` / `CONFLICT`），T4 的晚到回调当场被拦下。

---

## 二、`fulfillment.instance.list` 缺少 `profileId` 与驻留时长过滤，外部哨兵无法高效巡检

### 2.1 源码现状
`api/apps/fulfillment/logic/instance.js:239-255`：

```js
async list({ state, sourceId, limit = 50, offset = 0 } = {}, req) {
    const ids = await redis.sMembers(INDEX);
    if (!ids || ids.length === 0) return { items: [], total: 0 };

    const keys = ids.map(id => `${PREFIX}${id}`);
    const results = await redis.mGet(keys);

    let items = results.filter(r => r !== null).map(r => JSON.parse(r));
    const owner = resolveOwner(req);
    if (owner && owner.field) items = items.filter(i => i[owner.field] === owner.value);
    if (state)    items = items.filter(i => i.state === state);
    if (sourceId) items = items.filter(i => i.sourceId === sourceId);
    items.sort((a, b) => b.createdAt - a.createdAt);

    const total = items.length;
    return { items: items.slice(offset, offset + limit), total };
}
```

### 2.2 两个直接卡点
1. **不能按 `profileId` 过滤**：
   `instance.create` 必填 `profileId`（`:192`），每个实例都存了 `instance.profileId`（`:210`），而且服务端已经在内存里把所有实例 `mGet` + `JSON.parse` 出来了（`:244-246`），却没有提供 `if (profileId) items = items.filter(i => i.profileId === profileId)`。
   当系统同时跑多条业务车道（如财务结汇 `finance_fx_settlement_v1`、Temu 巡检 `temu_stockout_v1`、Catalog 制图 `catalog_studio_v1`）时，某条车道的巡检器想看自己车道的实例，只能把全库所有车道的实例全拉下来在客户端过滤。
2. **外部超时哨兵找「卡死最久的实例」被 `createdAt` 倒序挡在最后一页**：
   如 [`fulfillment-condition-fail-open.md`](./fulfillment-condition-fail-open.md) §三所述，`fulfillment` 本身不做内部定时器，超时推进由外部定时任务扫描完成。
   每个实例在每次状态变更时都已经维护了精确的 `stateChangedAt: Date.now()`（`:123, :213, :318`）。但当外部哨兵想扫描「在 `EXECUTING_TASK` 状态驻留超过 10 分钟（`stateChangedAt < now - 600000`）的卡死实例」时：
   - `list` 没有 `stateChangedBefore`（或 `staleMs`）过滤参数；
   - 更糟的是，`list` 硬编码按 `b.createdAt - a.createdAt`（最新创建优先）排序，且 `limit` 默认 50。**创建时间最早、卡死时间最长的僵尸实例永远沉在分页的最末尾**。

### 2.3 建议（改动极小，因为全量数组已在内存中）
在 `fulfillment.instance.list`（`logic/instance.js:239` 与 `handlers/introspection.js:69`）中增加两个可选过滤参数（不传完全兼容现状）：
- `profileId`（`string, optional`）：`if (profileId) items = items.filter(i => i.profileId === profileId);`
- `stateChangedBefore`（`number, optional`，epoch ms）：`if (Number.isFinite(stateChangedBefore)) items = items.filter(i => i.stateChangedAt <= stateChangedBefore);`

---

## 三、`fulfillment.instance.resume` 违背 `events.js` 契约：漏发 `EVENT:FULFILLMENT:TRANSITIONED` 且漏记 `trace`

### 3.1 契约声明 vs 实际代码
在 `api/apps/fulfillment/handlers/events.js:5-11` 中，明确声明 `resume` 会发出 `EVENT:FULFILLMENT:TRANSITIONED` 事件：

```js
emits: [
    {
        stream: 'EVENT:FULFILLMENT:TRANSITIONED',
        type: 'instance.transitioned',
        trigger: 'fulfillment.instance.transition / cancel / hold / resume / override',
        description: '每次实例状态成功转换后发出（fire-and-forget，不阻塞 transition 响应）',
```

然而在 `api/apps/fulfillment/logic/instance.js:303-327` 中：
- `transition`、`cancel`、`hold`、`override` 都复用了 `advance()`，因此都会记录 `trace: walContext.getStore()?.trace || null`（`:133`）并通过 `relay.call('event.emit', ...)` 发出 `EVENT:FULFILLMENT:TRANSITIONED`（`:144-161`）；
- 唯独 `resume()` 自己手写了状态恢复逻辑（因为它的目标态是动态的 `instance.prevState`），写完 `redis.set` 直接 `return instance`：
  1. **完全没调 `relay.call('event.emit', ...)`**——订阅了 `EVENT:FULFILLMENT:TRANSITIONED` 的 Nexus Sentinel 或 Orchestrator Workflow 在实例被 `hold` 时能收到事件，被 `resume` 恢复时却收不到任何事件；
  2. `history.push`（`:319-322`）也漏掉了 `trace: walContext.getStore()?.trace || null` 字段。

### 3.2 建议
在 `resume()`（`logic/instance.js:319-326`）中补齐与 `advance()` 一致的 `trace` 字段和 `relay.call('event.emit', { stream: 'EVENT:FULFILLMENT:TRANSITIONED', ... })` 调用，使实现与 `handlers/events.js:9` 声明严格一致。

---

## 四、受限外部哨兵账号在 `system.capabilities` 中的自省盲区

### 4.1 现象
`fulfillment` 将 `instance.create / get / list` 标为 `ai: true`，将所有写方法（`transition / update / hold / resume / cancel`）标为 `ai: false`（`handlers/introspection.js:84-158`）。
这在「防止内置 LLM 在自由对话中失控改状态」的语义下是对的。

但当我们将外部 Agent（如 WorkBuddy）配置为**专职外部哨兵**时，安全最佳实践是给它分配一个最小权限的受限账号（`permit: 'user'`，并在 `permissions` 中显式授予 `fulfillment.instance.transition`、`fulfillment.instance.update` 等方法），**绝不给它 `admin` 权限**。

此时撞上一个自省断层（`api/router/handlers/system.js`，bundle `:45083-45092`）：
- 当该受限账号调 `system.capabilities { all: true }` 时，因为 `isAdmin` 为 `false`，`all: true` 被忽略；
- Router 退回只返回 `val.ai === true || val.public === true` 的方法；
- 结果：**这个账号明明在 RBAC 里被显式授予了 `fulfillment.instance.transition` 的执行权（直接调 RPC 能通），却无法从 `system.capabilities` 里自省到这个方法及其参数 Schema**。

### 4.2 建议
- **轻量方案（文档约定）**：在 `fulfillment/GUIDE.md` 中明确提示：外部受限执行器/哨兵若需了解 `ai: false` 写方法的完整参数契约，应调用 `system.guide { service: "fulfillment" }`（公开可读），不要依赖非 admin 态的 `system.capabilities`。
- **机制方案（Router 自省对齐 RBAC）**：在 `system.capabilities` 过滤时，若调用方已认证且其 `req.permissions` 显式包含了某方法（即便 `val.ai === false`），也将其纳入该调用方可见的 `discoveryMap`。这样「能调的方法就能自省到参数契约」，无需为了看 Schema 而被迫给外部 Agent 开 `admin`。

---

## 五、汇总优先级（供 Solo 侧 Triage 参考）

| 优先级 | 事项 | 改动位置 | 预估改动量 | 兼容性 |
|---|---|---|---|---|
| **P0 (Bug)** | §三 `resume` 补发 `EVENT:FULFILLMENT:TRANSITIONED` + 补 `trace` | `fulfillment/logic/instance.js:319-326` | ~15 行 | 纯修复，对齐 `events.js` 既有声明 |
| **P1 (功能/性能)** | §二 `instance.list` 增加 `profileId` 与 `stateChangedBefore` 可选过滤 | `fulfillment/logic/instance.js:239` + `introspection.js:69` | ~6 行 | 可选参数，100% 向后兼容 |
| **P1 (并发安全)** | §一 `transition` 与 `update` 增加可选 `expectedTransitionId` 乐观锁 | `fulfillment/logic/instance.js:77,270,342` + `introspection.js` | ~15 行 | 可选参数，不传与现状完全一致 |
| **P2 (自省体验)** | §四 `system.capabilities` 对齐调用方已授权方法（或写明走 `system.guide`） | `router/handlers/system.js` 或 `fulfillment/GUIDE.md` | ~5 行 | 纯增量 |

---

## 六、处理结论（solo 侧）

**2026-10-19 核实并全部落地：**

- ✅ **§一 `expectedTransitionId` 乐观锁**（`api/apps/fulfillment/logic/instance.js` + `handlers/introspection.js`）：
  `advance()`（由 `transition` 调用）与 `update()` 均新增可选参数 `expectedTransitionId`。传入时校验 `instance.history.at(-1)?.transition_id === expectedTransitionId`，不匹配立即抛 `INVALID_PARAM (-32602)` 拦截跨轮次晚到回调；不传则与原行为 100% 一致。
- ✅ **§二 `instance.list` 增加 `profileId` 与 `stateChangedBefore` 过滤**（`api/apps/fulfillment/logic/instance.js` + `handlers/introspection.js`）：
  支持按 `profileId` 精确过滤单条业务车道，以及按 `stateChangedBefore`（epoch ms，`stateChangedAt <= stateChangedBefore`）筛选驻留超时的卡死实例。
- ✅ **§三 `instance.resume` 补齐 `trace` 与 `EVENT:FULFILLMENT:TRANSITIONED` 事件发射**（`api/apps/fulfillment/logic/instance.js`）：
  `resume()` 的 `history.push` 补记 `trace: walContext.getStore()?.trace || null`，并在落库后通过 `relay.call('event.emit', ...)` 发射 `EVENT:FULFILLMENT:TRANSITIONED`（`event: 'resume'`），与 `handlers/events.js` 契约声明完全对齐。
- ✅ **§四 受限外部哨兵账号自省对齐 RBAC + 文档指引**（`api/router/handlers/service.js`、`api/router/index.js`、`api/apps/fulfillment/GUIDE.md`）：
  Router `system.capability.list`（`serviceHandlers.capabilities`）接收 `sessionUser.permit`，对非 admin 调用方除返回 `ai: true || public: true` 外，额外通过 `auth.checkPermission(permit, val.service, key)` 将该调用方在 RBAC 中被显式授权的方法纳入 `discoveryMap`；同时在 `fulfillment/GUIDE.md` 补充了说明。

