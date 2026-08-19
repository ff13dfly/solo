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

**语义要点**：`cancel` / `hold` 是 transition 的语义包装——分别触发 `cancel_requested` / `hold_requested`，
这两个事件**必须在 profile 里定义为当前状态出发的转移**，否则报 INVALID_PARAM。`resume` 回到 `prevState`
（动态目标，跳过规则匹配，且**不产 `_tasks`**）。`override` 管理员专用，跳过条件强推、history 标 `forced: true`。

**幂等**：transition 本身不幂等，但重复调用通常因当前态已变、事件不再匹配而报 INVALID_PARAM（不会静默重复推进）。
真正的重投保护在 `_tasks`：每个 task 带 `idempotency_key`（`{transition_id}:A{idx}`，`transition_id`
按实例单调递增），Router at-least-once 重投时由下游据此去重——所以别在下游自己再记账。

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
