# fulfillment 服务任务配方

> 由 fleet-standard `guide` 方法下发（经 Router：`system.guide { service: "fulfillment" }`）。
> 与服务代码同目录、同 commit 更新。方法签名与参数约束以 `methods` 自省为准，
> 本文只讲自省说不出的**任务流程与语义**。

## 这是什么

声明式状态机履约引擎。**profile** 是状态机模板（一组 `transitions`，转移条件用 JsonLogic），
**instance** 是挂在某 profile 上的运行实例。实例只能在 profile 定义的 `(event, from)` 转移间流转，
目标状态由命中规则的 `to` 派生——**调用方推事件，从不指定目标状态**。

## 配方一：直建模板 → 起实例 → 推进（可信路径）

1. `fulfillment.profile.create { id, name, transitions }` — 直建的 profile **无 reviewState → 立即可用**。
   `transitions` 每条 = `{ event, from, to, condition?, actions? }`；实例初始态固定是 `DRAFT`，
   至少要有一条 `from: 'DRAFT'` 的转移，否则实例起来就卡死。
2. `fulfillment.instance.create { sourceId, profileId, meta? }` — 新实例落在 `state: 'DRAFT'`。
   `sourceId` 是外部订单号，`profileId` 指向上一步的模板。
3. （条件读 `instance.meta.<X>` 时）先把这些值备好：`fulfillment.instance.update { id, meta }` 把值
   **合并**进 meta（不是替换），或在下一步用 `metaUpdate` 一次带上。
4. `fulfillment.instance.transition { id, event, metaUpdate? }` — 引擎按 `(event, from=当前state)` 匹配规则，
   `metaUpdate` 在**校验条件之前**合并进 meta，JsonLogic 条件通过才切到规则的 `to`，并把规则 `actions`
   解析成 `_tasks` 交 Router 异步派发。同一 `(event, from)` 可有多条不同 `condition` 的规则 = 分支，
   取第一条条件成立的。
   **数值比较缺字段 = 拦住**（fail-closed）：`<` `<=` `>` `>=` 引用的 `instance.meta.<X>` 任一缺失（undefined / null / 空串；**0 不算缺失**），该条件即为 false，转移报 `Condition not met`。要显式给缺省值写 `{ "var": ["instance.meta.x", 0] }`。`==` / `!=` / `!` 不受影响。

**语义要点**：`cancel` / `hold` 是 transition 的语义包装——分别触发 `cancel_requested` / `hold_requested`，
这两个事件**必须在 profile 里定义为当前状态出发的转移**，否则报 INVALID_PARAM。`resume` 回到 `prevState`
（动态目标，跳过规则匹配，且**不产 `_tasks`**）。`override` 管理员专用，跳过条件强推、history 标 `forced: true`。

**幂等**：transition 本身不幂等，但重复调用通常因当前态已变、事件不再匹配而报 INVALID_PARAM（不会静默重复推进）。
真正的重投保护在 `_tasks`：每个 task 带 `idempotency_key`（`{transition_id}:A{idx}`，`transition_id`
按实例单调递增），Router at-least-once 重投时由下游据此去重——所以别在下游自己再记账。
⚠️ 下游若把去重字段叫**别的名字**（`requestId` 之类），引擎注入的 `idempotency_key` 接不上，要自己在
`action.params` 里拼一个每实例唯一的键：`{ "requestId": { "cat": ["fx-", {"var":"instance.id"}, "-publish"] } }`。
**别写成字符串** `"fx-{instance.id}"`——参数模板不做字符串插值，会原样发出去，于是所有实例共用一个键、
第一张单之后每一张都命中下游幂等返回旧单，**看起来次次成功，实际一次都没派**。

### 🔴 actions 的出口有白名单，默认只有两家

Router 只把 `_tasks` 派给它 task 白名单里的目标，**出厂默认只有 `notification` 与 `gateway`**。
派给别的服务（业务派单、`agent.chat` 等）会被丢弃，而且——

- **看不出来**：白名单是在 `res.json()` **之后**才查的。transition 返回 200、新状态、history 干净，
  响应里连 `_tasks` 字段都没有（Router 发送前删掉了）。被挡下只在服务器上留一行 `console.warn`。
- **判据**：拿 action 里那个幂等键**自己复派一次**下游方法，看回来的是原单还是新单——新单 = 从没派出去过。

要派给别的服务，先改白名单（admin）：

```js
const wl = await call('setting.task.get');            // ← 必须先读
wl.hive = { allowFrom: ['fulfillment'], allowMethods: ['hive.job.create'] };
await call('setting.task.update', { whitelist: wl }); // ← 整体替换，不是合并
```

**`setting.task.update` 是整体替换**：直接写一项会把 notification/gateway 一起抹掉。
`profile.submit` / `profile.update` 的 lint 会**在激活前**把这类不可达的 action 报成 error（规则 7），
所以正常路径下你会先看到明确报错，而不是线上静默丢活。

⚠️ **升级不会带来新的默认白名单**：Router 只在这个 key **不存在**时播种一次。好处是运维改过的白名单
不会被重启/升级覆盖；代价是框架将来往默认值里加一家，**存量部署一个都拿不到，且没有任何提示**。

**条件里可以用 `now`**（epoch ms，与 factory 时间字段同形态）：`{ ">": [{"var":"now"}, {"var":"instance.meta.deadline"}] }`
写停留超时 / 相对死期。action 的 `params` 里同样可用，别把死期烤成绝对时刻。

## 配方二：外部投稿模板 → 人审激活（投稿闸）

外部 agent **不能自建即用的 profile**，必须走投稿闸（对齐 workflow 的 C1 审批）：

1. `fulfillment.profile.submit { name, transitions, meta_fields?, allowedActions? }` — 先过 lint（静态校验：
   `source`/`action` 方法是否已注册、`source.pick` 路径是否真实、状态机能否离开 DRAFT 等；给 `allowedActions`
   还查动作是否越权）。**lint 有 error 直接拒、什么都不存**（返回 `{ ok:false, lintReport }`）；
   通过则落 `reviewState: PENDING_REVIEW`，**此时仍不可用**。
2. （可选先探路）`fulfillment.profile.generate { requirement }` — 用自然语言让 LLM 产候选 + lint + 有界修复，
   返回**候选** `{ ok, profile, lintReport }`，**不创建**；人审后再 submit/create。
3. `fulfillment.profile.approve { id }` — 管理员审批，**审批人必须 ≠ 投稿人**（职责分离），
   PENDING_REVIEW → APPROVED，落 `approvedDigest`（绑定"批的是哪一版"）。此后 profile 才能被实例使用。
   驳回用 `fulfillment.profile.reject { id, reason? }`。
4. 追溯治理（enroll）：`fulfillment.profile.submit { id, enroll: true }`（管理员）把一个**既有的
   可信直建** profile 转入审核通道——重新 lint（结构坏的拒收、profile 原样保持可用）、置
   PENDING_REVIEW、其实例立即被激活闸冻结，直到 approve。记 `enrolledBy/enrolledAt` 而非
   `submittedBy`：enroll 不算内容投稿（定义早已存在），否则「审批人 ≠ 投稿人」会让单管理员
   系统 enroll 之后无人能批。这是「先跑起来、后补治理」的唯一入口。

**激活闸（关键）**：`fulfillment.instance.create` **和** `fulfillment.instance.transition` 都会拒绝 reviewState 存在且 ≠ APPROVED
的 profile（FORBIDDEN）——新建和 in-flight 实例都拦。改一个已 APPROVED 模板的**可执行字段**
（`transitions`/`meta_fields`）会**重新 lint + 回落 PENDING_REVIEW + 清审批**，其 in-flight 实例随之冻结待重审；
只改 `name` 等元数据不触发。

## 坑与约定

- **两条生命周期轴别混**：instance 的业务态是 `state`（DRAFT→…，**无 `status` 键**）；profile 记录是
  `status`（ACTIVE/DELETED 软删轴，**无 `state` 键**）；profile 的审批轴是独立的 `reviewState`
  （PENDING_REVIEW/APPROVED/REJECTED，**直建的没有这个键**）。取错静默走错分支。
- **`submit` 是在审核通道里创建新 profile，不是「提交已有 profile 进审核」**——撞已存在的 id
  会明确报错并指向 enroll。可信直建的 profile 想事后补一道审核，只有
  `submit { id, enroll: true }`（管理员）这一条路，转入即冻结其实例。
- **附带元数据：transition 用 `metaUpdate`，create/update 用 `meta`**（两者语义相同，都是浅合并进
  `instance.meta`）。v1.1.17 起 transition 也收 `meta` 作别名，但**别指望「传错了会报错」**——
  Router 不校验未声明参数，写错的字段既不报错也不进日志，只是悄悄不见（colony 的镜像就这么丢了
  一天多的 `closeReason`/`realizedPnl`，而状态机、事件、history 全绿）。
- **profile 软删**：`delete` 是软删，返回**整条记录**（`status: DELETED`），不是 `{ success: true }`；
  `restore` 复活为 ACTIVE；`destroy` 才是真删、返回 `{ success: true }`。instance **不软删**。
- **写方法对 AI 关闭**：只有 create/get/list 类是 `ai:true`（LLM 可自主调）；所有 transition/cancel/hold/
  override/审批类是 `ai:false`——状态推进走人工或明确授权的执行层，不由 LLM 直接触发（决策/执行分层）。
- **时间戳是 epoch 毫秒数字**（`stateChangedAt`/`createdAt`），不是 ISO 字符串；例外：`hold` 的
  `expectedResume` 参数按 ISO 8601 字符串传。
- **外键 `{targetService}Id`**：`profileId` 指模板；`sourceId` 是外部订单号，刻意不带命名空间（来自任意上游）。
- **Router 全局限流**：错误码 `-32029`，退避重跑；批量操作串行或小并发。
- 本服务满足不了的缺口，提到 `system.report`（用法见 Router guide），别静默绕路。
