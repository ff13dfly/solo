# 事件触发型 workflow 的生命周期缺一环：上线与改版的窗口里，触发事件被静默吃掉

> 两个窗口，两种吃法：**没有 ACTIVE 订阅者时** ack 后直接消失（连死信都没有，§2.1）；
> **ACTIVE 但在冷却期时**判为永久拒绝进死信——**看得见（`run.list`）但捞不回来**（`run.retry` 只收 STALLED，§一、§二）。
> 而"改一版已上线的 workflow"必须依次穿过这两个窗口——`steps` 在 ACTIVE 上是冻结的，
> 只能删了重建。⇒ **今天没有办法在不丢事件的前提下修改一个已上线的事件触发型 workflow。**

- **来源**：steward，2026-09-05。接通「外部 webhook → 履约状态机 → 下一条剧本」这条链时撞到。
  与 [`done/fulfillment-actions-have-no-business-egress.md`](./done/fulfillment-actions-have-no-business-egress.md)
  是**同一条链的两端**：那篇讲状态机的**出口**（`transition.actions` → `_tasks`），
  本篇讲**入口**（外部事件 → workflow → `fulfillment.instance.transition`）。
  两端撞到的是同一种形态——**闸在、拒得对，但被拒之后不留可用的痕迹**。
- **场景**：设计师交图这类"人在回路、跨天等待"的流程。履约实例挂起等外部输入，
  外部系统投 webhook，orchestrator 的事件匹配器把它变成一次 workflow run，
  run 推进状态机。**这是 Solo 自己指定的入站路径**（ingress GUIDE 配方三 +
  `system.orchestrator` bot permit 里明写 `fulfillment: ['*']`），不是自创用法。
- **依据分类**：
  - **本次实测**（steward 线上栈，bundle **`solo.v1.2.13.js`**，Redis 现场取证）：§一 的时序、
    §二 的三处叠加、**§2.1 的三轮对照与 4 张卡死工单**、§三 的 `0` 失效、
    §四.1 的样例不可运行、§四.2 的传递依赖。
    ⚠️ 该 bundle **早于 2026-09-05 那批修复**（lint 规则 7 / `now` / `cat` / `TASK_BLOCKED`），
    本篇结论与那批修复不冲突：改的是别的面。
  - **源码引用**（solo 仓 main，未跑）：所有 `文件:行号`。
- **涉及**：`api/core/orchestrator/logic/run.js:197`（`requeue` 只收 STALLED ⇒ 死信无法重放）、
  `api/core/orchestrator/logic/matcher.js:202`（无订阅者也照 ack）、
  `api/core/orchestrator/logic/workflow.js:451`（ACTIVE 冻结 `steps` ⇒ 改版只能删了重建）、
  `api/core/orchestrator/logic/worker.js`（`handleThrown` 的可重试判定）、
  `api/core/orchestrator/logic/runner.js:53`（冷却闸）、`api/core/orchestrator/config.js`（approval 段）、
  `deploy/seed-bots.js`（dev-only，无生产等价物）、
  `deploy/scaffold/docs/authoring/workflow-examples/03-event-webhook.json`。
- **影响面**：**每一个事件触发型 workflow 的上线与每一次改版**。窗口长度 = 审批耗时 + 冷却
  （冷却默认 **24 小时**）。而走这条路的是**每一个会干实事的 workflow**——"高风险"的判据是
  footprint 里有任何写方法（`library/risk.js`），只读 workflow 本来也不需要事件驱动。
  所以这不是边角场景，是"上线 / 改版"这个动作的**默认后果**。

> 一句话：冷却本意是"让生效晚一点"，实现出来是"把这期间的触发**判死**"（能查到、但没有翻案通道）；
> 而在它之前还有一段更暗的窗口——**没有 ACTIVE 订阅者时事件 ack 后直接消失**，连 DLQ 都没有。
> 两段合起来覆盖了 workflow 上线与改版的全过程，**没有任何一段是调用方看得见的**。

---

## 一、第二个窗口（冷却期）：激活之后、`effective_at` 之前的**每一个**事件

> 先讲这个，因为它至少还在 DLQ 里留了痕。更暗的那个窗口（审批完成之前，事件 ack 后
> 直接消失）见 §2.1——它是顺着本节挖出来的，价值更高。

实测时序（steward 线上栈，两条真实 webhook）：

```
02:01:xx  ops 签名审批通过 → workflow ACTIVE，effective_at = +24h
02:02:2x  两张履约工单挂起，等外部输入
02:02:48  外部系统 POST ingress.ingest        → {"ok":true,"stream":"EVENT:WEBHOOK:DESIGNER"}
02:02:50  ingress event.emit                  → XLEN = 4
02:02:5x  matcher 消费                        → entries-read 4 · lag 0 · pending 0
          过滤命中、入队                       → ORCHESTRATOR:FIRED:<event_id>:wf-designer-submit
          run 建出来，input 一字不差            → run_578e983456e5
          ✗ runner.js:53 冷却闸               → FORBIDDEN
          ✗ worker.js:325 判为 permanent      → DEADLETTER
```

run 记录原文：

```json
{ "id":"run_578e983456e5", "workflowId":"wf-designer-submit",
  "input":{"request_id":"dsg-Q-…","data":{"instanceId":"FL-20260905-7245","confidence":0.95}},
  "triggerSource":"event:EVENT:WEBHOOK:DESIGNER", "attempts":0,
  "status":"DEADLETTER",
  "lastError":"Workflow in cooling period until 2026-09-06T02:02:19.498Z" }
```

**注意 `attempts: 0`** —— 一次都没重试。业务侧看到的现象是：webhook 返回 `ok:true`，
履约工单**原地不动**，没有任何报错到达任何调用方。

---

## 二、三处叠加，缺一都还有救

| # | 机制 | 位置 | 后果 |
|---|---|---|---|
| ① | 冷却拒绝被判为 **permanent business rejection** | `worker.js:325` 的 `handleThrown`：`isRetryable(err)` 为假 → 直接 `lPush` DLQ | 不重试、不排队等冷却结束 |
| ② | 事件已 **ack** | matcher 在 enqueue 之后 ack（`pending 0` 实测） | 流里不会再投递，`FIRED` 守卫（1h TTL）也已置位 |
| ③ | 死信**看得见、但捞不回来** | `run.list({status:'DEADLETTER'})` 能读到；而 `run.retry` → `requeue` 硬判 `run.status !== 'STALLED'` 就 FORBIDDEN（`run.js:197`） | 能查明"哪些业务动作没发生"，但**没有任何办法让它们发生** |

①决定了它不会自愈，②决定了源头不会重发，③决定了人即使发现了也无能为力。
合起来：**激活一个高风险 workflow，之后 24 小时内每一个真实触发都被吃掉。**

> ⚠️ **本篇初稿在这一格里写错过，已实测更正**：原文说"DLQ 没有任何 RPC 能读或重放"。
> 实测（admin，线上栈）：
> ```
> orchestrator.run.list {status:'DEADLETTER'}  → 2 条，含 lastError 原文   ✓ 能读
> orchestrator.run.retry {id}                  → [-32005] Only STALLED runs can be requeued (status: DEADLETTER)
> ```
> **观测面是有的，缺的只是"重放"这一个动作**——这让建议 2 变得比原来更便宜，见 §六。

`worker.js:325` 那段注释本身是对的——冷却拒绝确实是"业务拒绝不是系统故障"，
不该污染 `ERROR:QUEUE`。**问题不在归类，在于归类之后的处置**：
"业务拒绝"里混了两种完全不同的东西——

- **永久拒绝**（footprint 越权、workflow 已 DEPRECATED）：丢掉是对的，重试一万次也一样；
- **暂时拒绝**（冷却期）：**它自带一个明确的、已知的、就写在错误消息里的解除时刻**。

把后者当前者处理，是本篇唯一的核心主张。

> 对照：ingress 面对同类问题给的是**另一种答案**——`dataSchema` 违规不是丢弃，
> 而是"扣进有界复核队列 + 给 ops 发通知 + `review.list/approve/discard` 三件套"。
> 那套形状仓里已经有了，orchestrator 的 DLQ 缺的正是它。

### 2.1 更狠的一档：**没有 ACTIVE 订阅者时，事件 ack 后直接消失，连 DLQ 都没有**

`consumeOnce` 的 ack 在 workflows 循环**之外**（`matcher.js:202`，注释写的是
"Ack after all enqueues succeed"）。当 `findMatchingWorkflows` 返回空数组时，
循环体一次都不执行，然后**照样 ack**：

```js
for (const wf of workflows) { …enqueue… }        // workflows = [] ⇒ 什么都没发生
await client.xAck(stream, C.consumerGroup, entryId);   // 但这一行照跑
```

对"这个流真的没人订阅"来说这是对的（pub/sub 本该如此）。**问题是"暂时没有 ACTIVE 订阅者"
被当成了"没人订阅"**，而这个状态在正常运维里会反复出现。

**这不是理论场景——它是"改一版已上线的 workflow"的必经之路**：

```js
// workflow.js:451 — ACTIVE 的可执行字段是冻结的
if (isActive && (steps !== undefined || resolvers !== undefined || require_actor_permit !== undefined)) {
    throw jsonrpc.FORBIDDEN('Workflow locked');
}
```

改 `steps` 的唯一出路是 **delete → create → approve → 等冷却**。这条路上有**两个吃事件的窗口**：

| 窗口 | 状态 | 事件的下场 | 看得见吗 |
|---|---|---|---|
| delete → 重新 approve | 无 ACTIVE 订阅者 | 匹配为空 → **ack 丢弃**，连 run 都没建过 | ❌ 无任何痕迹 |
| approve → `effective_at` | ACTIVE 但冷却中 | 入队 → 冷却拒 → **DEADLETTER** | ⚠️ `run.list` 查得到，但重放不了 |

⇒ **今天没有办法在不丢事件的前提下修改一个已上线的事件触发型 workflow。**

**顶层等值过滤的第二笔账（2026-09-05 实测数字）**：`matchesFilter` 只比信封顶层字段，
`payload.toState` 这类条件表达不了 ⇒ 订阅 `EVENT:FULFILLMENT:TRANSITIONED` 的 workflow
**会被每一次履约跃迁唤起**，真正的分流只能靠 step 的 `condition`。一轮双工单演示实测：

```
run 按 workflow: { wf-publish-dispatch: 10, wf-designer-submit: 7 }
其中 wf-publish-dispatch 真正派单只有 3 次 ⇒ 7 次空转（70%）
```

空转的 run 是完整的实体（写 `ORCHESTRATOR:RUN:*`、占 `FIRED` 守卫、进 run 索引），
**随履约实例数线性增长**。建议 filter 支持一层 payload 路径（如 `{"payload.toState": "X"}`），
把分流提前到"要不要建 run"，而不是"建了再跳过"。

⚠️ 还有一处不确定性：`knownStreams` 这个进程内缓存**只增不减**
（只在 NOGROUP 时 `clear()`）。所以同一个窗口里，**进程期间没重启过**就照读照 ack（事件丢失）；
**中间重启过**则该流不再被 discover、压根不读，事件留在流里等复活后再投（然后撞冷却进 DLQ）。
同一个操作，两种结局，取决于中间有没有重启——排查时会非常费解。

**实测佐证**（steward 线上栈，三轮同样的 webhook）：

| 轮次 | 当时 workflow 状态 | 结果 |
|---|---|---|
| 01:34 | PENDING_REVIEW（还没批） | 2 条事件**无任何痕迹**（消费组建组晚于它们，按 `'$'` 跳过） |
| 02:02 | ACTIVE 但冷却中 | 2 条进 DLQ |
| 02:23 | ACTIVE 且冷却已过 | ✅ 两张工单正确分流 |

**代价是 4 张履约工单永久卡在 `AWAITING_DESIGN`**：它们的外部输入到过、被系统收下过
（`ingress.ingest` 回的是 `ok:true`），然后消失了。没有任何东西会重试，
也没有任何界面显示它们在等一个永远不会再来的事件。

---

## 三、`APPROVAL_COOLING_MS_HIGH=0` 关不掉冷却（`||` 把 0 当缺省）

```js
// api/core/orchestrator/config.js
coolingMsHigh: parseInt(process.env.APPROVAL_COOLING_MS_HIGH) || (24 * 60 * 60 * 1000),
```

`parseInt('0')` 得 `0`，在 `||` 里是**假值** ⇒ 显式写 `0` 反而落回 24 小时默认。
**想关只能写 `1`**（我们 dev 栈用的是 `1000`）。这是个纯粹的静默陷阱：配置写了、进程重启了、
行为一点没变，而且没有任何日志说"你这个值被忽略了"。

同一个 config 块里 `requiredSignersHigh` / `gateExpirySec` / `submission.*` 全是同款写法。
`requiredSignersHigh=0` 落回 1 在语义上无害，但 `gateExpirySec=0` 同样关不掉。
建议统一换成 `Number.isFinite(n) ? n : DEFAULT`。

---

## 四、附带两条（都属于"照文档做会撞墙"）

### 4.1 下发的样例 workflow **建不出来**

`deploy/scaffold/docs/authoring/workflow-examples/03-event-webhook.json` 写的是：

```json
"category": "example",
```

而自省声明是 `{ name: 'category', type: 'object' }`（`orchestrator/handlers/introspection.js:35`，
注释还写着 "submitter-supplied; may be string in legacy docs"）。Router 按自省校验参数 ⇒
**照抄样例直接 `-32602 type mismatch for 'category' (expected object, got string)`**。

有意思的是**服务逻辑两种都收**（`workflow.js:377,756` 到处是
`typeof category === 'string' ? … : JSON.stringify(…)`），且 `authoring/workflows.md:49`
的表里写的也是 `string`。所以三处说法两两不一致，**唯一说了算的是自省**，
而它恰好是三处里唯一不面向作者的。

这与 `runbook-browser-extension-ai-extraction-not-runnable.md`（**仍在队列里**）是同一类：
**下发物是拿来照抄的，照抄跑不通就等于没下发**。建议把样例改成对象，或把自省放宽成
`string|object`（服务逻辑本就支持）——两者选一，别让三份说法继续并存。

### 4.2 没有生产可用的 bot 播种路径，于是每个消费者各挑各的，必漏传递依赖

`deploy/seed-bots.js` 头注明写 **dev-only**，且它**往 Redis 直写一个 `solo-dev-admin` 会话**
绕过登录——生产上不能用。于是每个下游项目自己写一份，而写的时候的自然做法是
"按我这条链会用到哪些服务来挑 bot"。

这个做法必然漏掉**传递依赖**。实测：我们挑了 orchestrator / fulfillment / ingress / notification，
漏了 `system.approval`——因为这条链里**没有任何一步直接调 approval**，
是 `workflow.approve` 经 relay 调 `approval.gate.sign`，**approval 自己**再去 `user` 服务
读审批人公钥验签。

失败点极靠后：投稿成功、gate 开了、`user.key.sign` 算出签名了，**提交签名那一刻**才报：

```
[RPC_FAILED] Could not fetch approver public key: No service token configured for "approval".
```

**这条报错本身是范例级的好**——点名了是哪个服务、要调哪个方法、去哪看文档。
问题不在报错，在于"到那一刻才知道"。

建议：给 `deploy/seed-bots.js` 一个**生产形态的同胞**（走 admin 登录 + `<svc>.token.set` RPC，
不碰 Redis，即 e2e harness 那条路），或者至少在 `events.md §0.5` 写一句判据——
**给某个服务发 token 时，连它「为了完成这次调用还要再打给谁」一起看**。
`BOT_PERMITS` 已经是单一真源了，缺的只是"整份播种"这个动作的生产入口。

---

## 五、提炼：两个声明面，同一个作者，两套规则

前面四节里有一条线索反复出现，值得单独拎出来——**它不是本篇的症状，是本篇好几个症状的共同来源**。

Solo 有**两个声明面**，都在回答同一类问题（"这个值从哪来"、"这一步该不该走"）：

- **fulfillment profile**：`transition.condition` + `action.params`
- **orchestrator workflow**：`step.condition` + `step.params`

同一个人、同一天、为同一条业务链路写这两样东西。但它们**不共享原语**：

| 能力 | fulfillment | orchestrator workflow |
|---|---|---|
| 条件语言 | JsonLogic，**经 `library/jsonlogic.js` 包装** | JsonLogic，`runner.js:6` **直接 `require('json-logic-js')`** |
| 数值比较遇到缺失操作数 | fail-**closed** ✅ | fail-**open** 🔴 |
| 条件里读"现在几点" | ✅ `buildLogicData` 的 `now`（v1.2.13） | ❌ context 只有 `{input, config, step, context}` |
| 参数里拼字符串 | ✅ `RESOLVE_OPS` 的 `cat`（v1.2.13） | ❌ `$` 只做**整值引用**，`"fx-$input.x"` 原样传 |
| 参数里算「此刻 + 2 小时」 | ❌ | ❌ |

### 5.1 🔴 fail-open 那一格：已经修过的 bug，在另一个服务里原样活着

[`fulfillment-condition-fail-open.md`](./fulfillment-condition-fail-open.md)（colony，2026-08-11）报的是
「数值条件在字段缺失时放行」，修法是给 `library/jsonlogic.js` 加 `failClosedOnMissing`。
**但 orchestrator 不走那个 library**，于是同一个 bug 在 workflow 的 step condition 里原封不动。

本机对照（hermetic，未碰线上）：

```
规则                              raw(orchestrator)   library(fulfillment)
{">=": [{var:input.a}, {var:input.b}]}    true              false     ← 分歧
{">=": [{var:input.a}, 0.9]}              false             false
{"===":[{var:input.toState}, "..."]}      false             false
```

⇒ 一条形如 `{">=": [{var:"input.score"}, {var:"input.threshold"}]}` 的 step 守卫，
**在两个字段都没喂进来时会放行**。而 step condition 的典型用途正是"够不够格才执行下一步"。

**这一条与本篇其余部分无关，可以单独拿去修**——放在这里只是因为它是查"为什么 workflow 和
profile 写法不一样"时撞出来的。

### 5.2 缺失原语：**求值时刻 + 最小组合**，在本篇里现形了四次

| # | 位置 | 想表达 | 现状 |
|---|---|---|---|
| ① | fulfillment `condition` | `now > expireAt` 做超时催办（协议 §3.4 已按既有能力描述） | ✅ v1.2.13 补了 `now` |
| ② | fulfillment `action.params` | `expireAt = 此刻 + 2h` | ❌ 只能烤绝对时刻 |
| ③ | fulfillment `action.params` | `requestId = 实例id + 目标状态` | ✅ v1.2.13 补了 `cat` |
| ④ | orchestrator `step.params` | 同 ②③（本篇 §五表格最后两行） | ❌ 两样都缺 |

四处不是四个 bug，是**同一个缺口的四次现形**：声明面**不知道"现在"，也不会"拼一下"**。

🔴 **而 v1.2.13 只修了 fulfillment 那一侧，所以缺口从"两边一样缺"变成了"两边不一样"——这更坏。**
作者会把在 profile 里刚学会的 `{"cat": [...]}` 和 `{"var":"now"}` 直接搬进 workflow step，
然后**静默失效**：`cat` 那个对象原样当字面量传下去，`now` 读成 undefined。
两处都不报错。缺口对称时人还能记住"这里不行"；不对称时只能靠踩。

**判据（给将来加声明面时用）**：凡是给人写的声明面，作者默认它至少能表达
**"现在"**与**"把两个值接起来"**。这两样任缺其一，用的人就会去别处兑现——
写死一个绝对时刻、或者干脆把该声明的东西挪回代码里，两条都在悄悄拆掉"配置即数据"这个前提。

### 5.3 补一句：字符串模板**代码已经写好了**，只是没开给参数面

`runner.js` 里有个 `interpolate(template, context)`，注释写着
"handles templates like `comp-$context.trigger_id-rollback`"，但下一句是
**"Used only for idempotency_key, so general param-resolution semantics are unchanged"**。

⇒ 建议 8 里"参数面能拼串"这一半**不用新写函数**，是把已有的 `interpolate` 从
`idempotency_key` 一处放宽到 `params`（是否放宽、怎么控爆炸半径由维护者定；
这里只是指出成本比看上去低）。

### 5.4 履约实例没有地方记"每一跳的产物"，于是重试会抹掉上一次的失败原因

`instance` 只有两个容器：`history[]`（追加式，但只记 `state / event / user / stamp`，
**不记产物与原因**）与 `meta{}`（可写，**浅合并覆盖**）。跨层产物只能落 `meta`。

实测（一张工单：派剧本失败 → 人工换剧本 → 重试成功）：写第二轮结局时把
`publishError` / `publishJobId` 覆盖了 ⇒ **失败原因和失败工单号在实例上彻底查不到**，
`history` 只剩一条"曾经进过 PUBLISH_FAILED"。证据其实还在 hive 与 `steward.run` 里，
但**没有回指字段**能从实例找过去（本项目侧的 `sourceRef` 至今是提案）。

绕法是使用方自己按 attempt 编号（`publishOutcome_1` / `_2`），我们已经这么改了。
但这属于**每个消费者各自发明一遍**的东西：状态机天生就会重试，
"这一跳产出了什么"是通用需求。⇒ 建议给 `history[]` 一个可选的 `outcome` 字段
（转移时随 `metaUpdate` 一起收，只进 history 不进 meta），或明确在文档里写
"meta 是当前快照、不是台账，产物要自己编号"——**两者选一，别让人以为 meta 是台账**。

**建议见 §六 的 7 / 8。**

---

## 六、建议（按价值排序）

0. 🔴 **让"改一版已上线的 workflow"有一条不丢事件的路**（§2.1）。这是前两条的前提——
   前两条修的是"丢了之后能不能捞回来"，这条修的是"为什么每次改版都要丢一批"。
   两个方向，任选其一即可：
   - **暂停订阅而不是丢弃**：`findMatchingWorkflows` 为空时，先看这个流**是否存在
     非 ACTIVE 的订阅者**（PENDING_REVIEW / 冷却中）。有就**不 ack**（或转存待投），
     让事件留到它可用为止；只有真的无人订阅才 ack 丢弃。
   - **或者允许原地改版**：给一条"改 `steps` → 回 PENDING_REVIEW 并保留订阅"的路
     （fulfillment 的 `profile.update` 就是这么做的：改可执行字段 → 重新 lint +
     回落 PENDING_REVIEW + 冻结 in-flight 实例）。**同一个仓里两个服务对同一个问题
     给了两种答案**，orchestrator 这边是 `FORBIDDEN('Workflow locked')` + 只能删了重建。
1. 🔴 **冷却拒绝改成"延后"而不是"丢弃"**。worker 本来就有三段结构
   （PENDING list + **RETRY zset** + DEADLETTER list，见 `worker.js:23` 头注），
   所以这是复用现成机制：冷却拒绝 → 进 RETRY zset，`nextAttemptAt = workflow.effective_at`（+ 抖动）。
   ⚠️ 要注意它与常规退避的差别：**冷却是一个已知的绝对时刻，不是指数退避**，
   别套 `maxAttempts`（24 小时会把次数耗光）。判据很干净——
   **错误里带着解除时刻的，就不是永久拒绝**。
2. 🔴 **让 DEADLETTER 可以重放**——**别新建 DLQ API，那部分已经有了**。
   观测面现成：`run.list({status:'DEADLETTER'})` + `run.get` + `run.trace` 都能用（实测，见 §二 ③）。
   而重放的机器**也已经写好了**：`requeue` 保留 `triggerId`（重跑时幂等键对得上，
   已提交的步骤自然去重）与 `actor`/`actorSource`（同一道 `require_actor_permit` 预检）——
   **这正是重放一条死信需要的全部语义**。
   挡在中间的只有一行：

   ```js
   // run.js:197
   if (run.status !== 'STALLED') throw jsonrpc.FORBIDDEN(`Only STALLED runs can be requeued (status: ${run.status})`);
   ```

   ⇒ 要么把 DEADLETTER 纳入可 requeue 的状态（配一个"重放次数"上限防打转），
   要么加一个显式的 `run.revive`（语义上更干净：STALLED 是"卡住了继续跑"，
   DEADLETTER 是"已经判死、人工翻案"，两者的审计含义不同，值得分成两个词）。
   做了建议 1 之后 DEADLETTER 里剩下的才是真·永久失败，那时"人工翻案"这个动作才更需要。
   ⚠️ 唯一真正缺观测的是 `ORCHESTRATOR:RUNQ:DEADLETTER` **这个 list 本身**（run 实体之外的
   投递信封），但 run 实体已经覆盖了排查所需的一切，不必为它单独开 API。
3. **`parseInt(x) || DEFAULT` → `Number.isFinite(n) ? n : DEFAULT`**（approval 段 + submission 段）。
   顺带：被忽略的配置值应当 warn 一句。
4. **`approve` 成功时把冷却讲清楚**：返回里带 `effective_at`，并在文档里写明
   "这段时间内的触发会被拒"。现在 approve 只回 APPROVED，
   **没有任何东西提示接下来 24 小时是空窗**——我们就是这么白跑了一整轮。
5. **`03-event-webhook.json` 的 `category` 与自省对齐**（§4.1）。
6. **生产形态的 bot 播种入口 + "连传递依赖一起看"的判据**（§4.2）。
7. 🔴 **`runner.js` 改用 `library/jsonlogic.js`**（§5.1）。一行 require 的事，
   把已经修过的 fail-open 带到 workflow 侧；顺带在 workflow 的 condition context 里加 `now`
   （与 `buildLogicData` 同源，走 `clock.now()`）。
   ⚠️ **这是行为变更**：现存的 step condition 里若有"靠 fail-open 才走得通"的分支，会开始被拦。
   那些分支本来就是错的，但值得在 CHANGELOG 里点名，别让人以为是新 bug。
8. **给参数面补"求值时刻 + 最小算术"**（§5.2）。不必开放全部算子——
   `now` 进 context、`RESOLVE_OPS` 加个 `+`，`{"+": [{"var":"now"}, 7200000]}` 就够表达相对死期了；
   同一套原语**两个声明面都要有**，否则只是把不对称挪个位置。

---

## 七、附：这次是怎么发现的

不是读代码读出来的。是把链路真接通之后**跑了一遍、发现工单没动**，然后逐跳取证：
Redis 里数事件条数 → 看消费组 `entries-read/lag/pending` → 读事件信封确认过滤器该命中 →
找 `ORCHESTRATOR:FIRED:*` 确认入队了 → 最后读 `ORCHESTRATOR:RUN:*` 才看到 `DEADLETTER`
和那句 `Workflow in cooling period`。

**前四步全是绿的**——这正是本篇的要点：这条链上每一环都"工作正常"，
包括冷却闸拒得完全正确。坏的是拒绝之后那条路的形状。

**链路本身已经跑通**（2026-09-05 02:23，冷却调小并重新审批之后）：同一个 webhook 事件、
同一条 workflow，两张工单被 JsonLogic 守卫正确分流——

```
FL-20260905-8717  conf=0.62  AWAITING_DESIGN → NEEDS_HUMAN        ←image_submitted  user=system.orchestrator
FL-20260905-3718  conf=0.95  AWAITING_DESIGN → READY_TO_PUBLISH   ←image_submitted  user=system.orchestrator
```

`user=system.orchestrator` 那一跳就是 webhook 推动的——不是人点的，也不是轮询查出来的。
**所以本篇不是"这条路不通"，而是"这条路通了，但它的失败模式会静默吃掉生产事件"。**

复现（steward 仓，可复跑）：`deploy/webhook-lane-up.sh`
（接线三步 + 演示；`--dev-no-cooling` 会先把冷却调小再强制重走审批）。

---

## 八、处理结论（2026-09-05，**建议 0/1/2 + 7/8 已落地；3/4/5/6 未做，逐条说明**）

**逐条核过源码，主张全部成立**（`worker.js` 的 `isRetryable` 只认 `-32603`；`runner.js:53` 的冷却
闸消息里带 ISO 解除时刻；`matcher.js:202` 的 `xAck` 在 `for (const wf of workflows)` **循环之外**；
`findMatchingWorkflows` 第 69 行 `status !== 'ACTIVE'` 直接 continue；`workflow.js:451` 的冻结；
`run.js:197` 的 STALLED 硬守卫；`xGroupCreate` 用 `'$'`；`config.js` 六处 `parseInt(x) || D`；
`risk.js` 的「有写方法即 HIGH」）。本篇的决定性贡献是 **§2.1**——没有它，这一版只会修冷却那半，
而更暗、更常发生的那半（连 run 都没建过）会原样留着。

### 两处必须先记下来的校正，其中一条会让人把建议 0 实现错

1. 🔴 **建议 0 选项一的"不 ack"按现状实现会比丢弃更糟**。`matcher.js` 只用 `id: '>'` 读，
   **全仓没有 `XAUTOCLAIM` / `XCLAIM` / pending 重读**——所以 `consumeOnce` 里那句注释
   "No xAck → re-delivered after consumer restart" **本身就是错的**：重启也不会重读 PEL。
   不 ack 的结果是把事件**永久钉死在 PEL 里**，而 ack 掉的至少还留在流里。
   ⇒ 落地取的是括号里那半：**ack + 转存**。
2. **`EVENT:` 流是无界的**（`router/config.js:76-77` 自己写着 "xAdd currently unbounded"，
   全仓对 `EVENT:` 流无 MAXLEN/XTRIM），且 `xAck` 只标记消费、不删条目。
   ⇒ §2.1 结尾那句「4 张工单永久卡死」**前半句不成立**：事件都还在 Redis 里，`FIRED` 守卫
   TTL 只有 1 小时早已过期。这条直接变成了建议 0 之外的第三件事——见下面的 `event.replay`。

### 已落地（见 CHANGELOG [Unreleased]）

| 建议 | 做法 |
|---|---|
| **0**（不丢事件的改版路） | **两个方向都做了，因为它们互补、不是二选一**：① matcher 把「有非 ACTIVE 订阅者但无 ACTIVE 订阅者」的事件 **ack + 转存**到 `ORCHESTRATOR:EVENTQ:PARKED`，订阅者一 ACTIVE 就自动释放重投；② `workflow.update` 新增 `revise:true`，改 `steps` 不再 `FORBIDDEN`，而是回落 PENDING_REVIEW + 清空签名 + **保留 `event_subscriptions`**。**②让①有东西可检测**——delete→create 之间那一瞬没有任何订阅者，①就无从判断"暂时没人"还是"真没人"。另外 `discoverStreams` 现在也发现 PENDING_REVIEW 的流，于是消费组在 **create** 时就建好，`'$'` 不再跳过审批期间的事件（这正是本篇实测表里 01:34 那一轮"无任何痕迹"的成因）。 |
| **1**（冷却延后） | 冷却拒绝 → RETRY zset，`score = effective_at + 抖动`，**`attempts` 一动不动**（cooling 与失败退避是两条轴，混算就会在 24h 里耗光 5 次然后照样进 DLQ）。判据按本篇给的那条，但**不解析错误串**——从 workflow doc 读 `effective_at`（jsonrpc 错误只有 `{code,message}`，用正则从人类可读消息里捞时间戳是会静默烂掉的耦合）。run 落新状态 `DEFERRED_COOLING`：留在 RUNNING 会被 stall 扫描在 10 分钟后翻成 STALLED，给 ops 发一条假的"worker 死了"。 |
| **2**（死信可重放） | 采纳本篇给的第二个选项：**新动词 `orchestrator.run.revive`**，不放宽 `requeue` 的守卫。`commandFor()` 抽出来给两者共用，所以 `triggerId` / `actor` / `actorSource` 不可能只在其中一条路上丢。带 `maxRevives` 上限。两边的 FORBIDDEN 文案互相指路。 |
| **（本篇未列）** | 🔴 **`orchestrator.event.replay { stream, from, to, limit }`**（admin）：按 id 区间重读流、重跑匹配。这是校正 2 推出来的——它捞得回**建组之前就到达**的事件（本篇 01:34 那一轮），而 park 队列只能保护它上线之后到达的。幂等守卫照旧生效，重放已跑过的事件报 `suppressed`，**不会二次触发副作用**。 |

**验证**：新增 e2e `106-workflow-rollout-window`，真栈四条断言——窗口① park→审批→释放→副作用可见；
窗口② 落 `DEFERRED_COOLING` + RETRY zset 且 DLQ 不增；`run.retry` 拒绝并指向 `run.revive`，
而 `revive` 真把它跑成 DONE；`event.replay` 捞回建组前的事件、二次重放被幂等守卫拦住。
全量 e2e **68 套 / 358 passed** 全绿；api CI 白名单 133 套 / 2220 passed；16 目录 autocheck ERROR=0。

### 未做（**不是漏了，是本轮范围之外**——按用户指示只落地 0~2 对应的那套方案）

- **建议 3**（`parseInt(x) || D` 六处）：属实，`config.js:58,59,60,66,67,68`。
  **顺带校正**：同一文件的 83/98/99/106 用的是安全写法 `parseInt(x || 'default', 10)`，
  所以这是那六行的局部病、不是全仓风格。零争议，随时可做。
- **建议 4**（approve 讲清冷却）：**代码那半其实已经有了**——multisig lane 的 `approve` 早就
  `return { …, effective_at: updated.effective_at, … }`，`introspection.js:327` 的
  returns_schema 里也已声明。缺的只是**文档没写"这段窗口里的触发会被拒"**。
  做了建议 0/1 之后紧迫性也降了（触发不再被吃掉），但仍该补。
- **建议 5**（样例 category）：属实，且**比本篇写的更广——01/02/03 三个样例全是字符串**。
  ⚠️ 方向只能是「样例与 `workflows.md:49` 改成对象」：`library/validate.js:102-106` 是严格
  相等比较、**不支持联合类型**，"把自省放宽成 `string|object`"这条路走不通，除非动共享校验库。
- **建议 6**（生产 bot 播种入口）：属实。**建议拆成独立一篇**——它与事件生命周期无关，
  只是同一条链上一起撞到的；混在本篇里，等 0~5 结案归档时它会跟着一起消失
  （`entity-factory-bypasses-clock.md` 的建议 1 至今没做，就是这个形状）。
- ✅ **建议 7**（`runner.js` 改用 `library/jsonlogic.js`）：**已落地**（单独一批，见下节）。
- ✅ **建议 8**（参数面补 `now` + `+`）：**已落地**，与建议 7 同批（见下节）。

### 建议 7 的落地（2026-09-05，单独一批 —— 它是行为变更，不能混进上面那批纯增量）

`runner.js:6` 的裸 `require('json-logic-js')` 换成 `library/jsonlogic.js` 的 `evaluateCondition`。
危险形状比"fail-open"三个字更具体：**出事的是阈值那一侧缺失**——`var` 取不到得 `null`，
JS 在 `< <= > >=` 里把 `null` 转成 `0`，于是「够格才放行」变成「恒放行」，**恰好在阈值没送到
那一刻**。缺失方在左边、或右边是字面量（`> 0`）时反而恰好是 false，所以它不是随机乱放，
是专挑最该拦的那一种情况放行。

**另一半是防复发**：新增 autocheck 规则 `[jsonlogic]`（ERROR），服务代码直接
`require('json-logic-js')` 即报错。上一次（colony 那轮）只修了 library，**没有任何东西阻止
别处再开一个求值器**——本篇就是那个"别处"。全队实扫零命中（6 个下游项目的 json-logic-js
引用**全部**是 bundle 自带的 `library/jsonlogic.js` 本身，不在 per-service 扫描面内），
所以升级不会让任何现有服务变红；非闸门用途可在该行标 `// SAFE:` 豁免（正反两向已实测）。

顺带订正 `orchestrator/README.md` 的技术选型条：此前写的是「必须用 `json-logic-js`」，
**runner 照做了，也就照抄了这个坑**；改成「必须经 `api/library/jsonlogic.js`，禁止直接 require 裸库」。

### 📌 关于"为什么没被测出来"——这条值得单独记住

问过一次「是不是 jsonlogic 在代码里没法测」。**恰恰相反：它极好测，而且两边都测了。**

- `api/library/tests/jsonlogic.test.js:219` 有一整段 `describe('evaluateCondition fail-closed
  on missing operands …')`，把 fail-closed 钉得很死；
- `api/core/orchestrator/tests/condition.test.js` 有十条 condition 用例，覆盖 `===` / `>` /
  `and` / 字符串条件拒收 / 数组条件拒收 —— **但没有一条喂缺失操作数**。
  （它里面那两条名字带 "fail closed" 的，说的是"字符串/数组条件被拒收"，是另一件事。）

**两份测试都是绿的，各自描述各自的实现，谁也不知道对方存在。** 所以这不是"测试没写全"能概括
的——即使当时给 orchestrator 补了缺失操作数的用例，它也只会**如实记录裸库的 fail-open 行为**
并变成绿的（测试描述现状，不描述意图）。真正的成因是**同一份契约有两个实现**。

⇒ **修法是"只有一个求值器"，不是"多写一条测试"。** 本版两样都做了：换实现（消除分叉）+
autocheck 规则（阻止再分叉）；那五条缺失用例也补了——但它们的作用是**锁住已经统一的语义**，
不是当初能发现问题的手段。实测：对修复前的实现跑这五条，红 2 条。

**这条判据可复用**：凡是"同一个 bug 在另一个服务里又出现一次"，先问**是不是有第二个实现**，
再问测试。（同期还有一例同形：`entity.js:toSortableMs` 与 steward 手写的 `lastSeenMs()`，
v1.2.13 已收敛成 `clock.toMsOr`。）

### 建议 8 的落地（2026-09-05，与建议 7 同批）

§5.2 的判断成立且是本篇提炼里最有复用价值的一条：**v1.2.13 只修了 fulfillment 一侧，
缺口从"两边一样缺"变成"两边不一样"——这更坏。**

做法比本篇提的多一步。本篇说「`now` 进 context、`RESOLVE_OPS` 加个 `+`」，但那默认
orchestrator 的参数面能求值 JsonLogic ——**它不能**：`runner.js` 的 `resolveVariables` 只认
`$` 前缀的**整值引用**（`"$input.x"`），`"fx-$input.id"` 原样透传，算术根本无从表达。
所以真正落地的是三件：

1. `RESOLVE_OPS` 加 `+`（`cat` + `+` = 给人写的声明面的最小可用集：一个拼幂等键，一个写相对死期）；
2. workflow 执行上下文补顶层 `now`（条件 `{"var":"now"}`、参数 `$now`，各自对齐两个面的惯用法）；
3. **workflow 的 `step.params` 接上 JsonLogic 节点求值**——判据用 `library/jsonlogic.js` 导出的
   `isLogicNode`，**不是各抄一份**。这一点是刻意的：本篇整节讲的就是"两个面各写各的"，
   如果修法本身又在第二个面抄一份判据，加下一个算子时不对称会立刻长回来。
   ⇒ **加算子永远只改 `RESOLVE_OPS` 一处，两个面同时生效。**

⚠️ 这是行为变更（唯一键为 `cat`/`+`/`var` 的**字面量**对象会开始被求值），已在 CHANGELOG
写明下游 action；沿用 v1.2.13 的收窄——只有**唯一键**才算算子，多键业务对象不动。

### 剩余待办（下一轮接手时看这里）

- 本篇建议 0~2、7、8 已全部落地；**3 / 4 / 5 / 6 仍未做**，见上面「未做」一节的逐条说明。
  其中建议 6（生产 bot 播种入口）建议**拆成独立一篇**再 triage，否则本篇归档时它会跟着消失。
- [ ] 建议 3：六处 `parseInt(x) || D`，顺带被忽略的配置值 warn 一句。
- [ ] 建议 5：三个样例 + `workflows.md:49` 的 category 改成对象。
- [ ] 建议 4：文档补"冷却窗口里的触发会被延后"（代码已具备）。
- [ ] 建议 6：拆成独立一篇再 triage。
- [ ] `ORCHESTRATOR:RUNQ:DEADLETTER` 那个 list 在 revive 之后会留下**孤儿信封**（run 实体已翻案、
      list 里那条还在）。本篇说得对——run 实体覆盖了排查所需，list 无人读且有 MAXLEN 上限，
      所以**不阻断**；但真给它开 API 时要连带清理。
