# 反馈：fulfillment 的数值条件在字段缺失时 **fail-open**，且 `meta_fields.source` 没有取数器

> 来源：colony 派生项目，2026-08-11 用 ant 交易引擎（10s 轮询的真实负载）去压测
> 「fulfillment 能不能支撑复杂场景」时实测到。
> 依据：**全部本机实测**（solo v1.1.15），每条附命令与原始返回。
> 涉及：`api/apps/fulfillment/`（transition 求值链）、`api/library/jsonlogic.js`、
> `fulfillment.profile.create` 的 `meta_fields` 契约。
> 影响面：**任何用 JsonLogic 数值条件做闸门的 profile**——而数值门槛正是风控/审批场景最常见的条件形态。
>
> 一句话：声明了条件、声明了数据来源，两者都被存下来了，但**没有任何东西去取数**，
> 而缺数据时数值条件求值为 **true** ⇒ 本该拦住的转移**无条件放行**，且不留任何痕迹。

---

## 一、🔴 数值条件在字段缺失时放行（fail-open）

最小复现（两条转移，唯一区别是比较运算符）：

```js
fulfillment.profile.create({ id: 'ff_cond_probe', name: '条件求值探针', transitions: [
  { event: 'a', from: 'DRAFT', to: 'SA', condition: { '==': [{ var: 'meta.nothing' }, 'SURELY_NOT_EQUAL'] } },
  { event: 'b', from: 'DRAFT', to: 'SB', condition: { '>=': [{ var: 'meta.x' }, { var: 'meta.y' }] } },
]})
// 两个实例都不喂任何 meta，直接 transition：
```

实测结果：

```
event=a  条件必然 false（字符串比较，字段不存在）  → ❌ 被拦: Condition not met for event "a"
event=b  数值比较，两个字段都不存在                → ⚠️  放行了！state=SB
```

**条件求值链本身是正常的**（`a` 被正确拦住，证明 `evaluateCondition` 确实被调用了）。
问题出在语义：`{var:'meta.x'}` 取不到时得到 `null`，而 JsonLogic 的 `>=` 落到 JS 的
`null >= null` —— **`true`**（两边都被转成 0）。`>`/`<`/`<=` 同理。

于是一条形如「余额 ≥ 阈值才放行」「带宽 ≥ 门槛才开仓」「金额 ≤ 上限才自动批」的闸门，
**在数据没喂进来的时候会全部放行**，而不是全部拦住。这个方向反了：
闸门缺数据时的安全默认必须是 fail-closed。

我的场景是交易：条件是「BB 带宽 ≥ 门槛才开仓」。fail-open 的含义是
**本该"波动率不够不进场"，实际变成"无条件进场"**。

**建议**（按价值排序）：

1. **`evaluateCondition` 在比较类运算符遇到 `null`/`undefined` 操作数时返回 false**
   （或抛错让转移失败）。可以在 `library/jsonlogic.js` 包一层：求值前先收集 condition 里
   引用的所有 `var` 路径，任一在 data 里 **不存在**（注意区分「不存在」与「值为 0」）就直接 false。
   现成的 `metaVarsInCondition()`（bundle:124xxx，profile 校验里已经在用）就能列出这些路径，
   不必新写遍历。
2. 若不改语义，**至少在 `profile.submit` 的静态校验里报 error**：
   「condition 引用了 `meta.x`，但它既不在 `meta_fields` 声明里，也没有任何 transition 写入它」。
   现在这种 profile 可以一路 create → 使用，没有任何提示。
3. 文档里明确写出「缺字段时各运算符的取值」——这是使用者根本不会去想、但一旦踩到就是事故的语义。

---

## 二、`meta_fields[].source` 声明了，但没有任何东西去取数

`fulfillment.profile.create` 接受并存储这样的声明：

```js
meta_fields: [
  { key: 'bbWidth',  source: { service: 'ant', method: 'ant.instance.get', pick: 'bbWidth' } },
  { key: 'minWidth', source: { service: 'ant', method: 'ant.instance.get', pick: 'minWidth' } },
]
```

profile 校验甚至会检查 `source.method` **是不是一个已注册的 API 方法**
（bundle:124681 `meta_field '<key>' source method '<m>' is not a registered API method`），
读起来完全像是运行时会去调它。

实测：建实例 → 直接 `fulfillment.instance.transition`（不喂任何数据）：

```
转移后 meta = {}      state = DRAFT → HOLDING（放行）
```

**`meta` 始终是空的**，没有任何一次对 `ant.instance.get` 的调用。
与之矛盾的是同一份 bundle 里的两处措辞：

- `fulfillment.instance.update` 的描述：「caches `meta_fields.source` values **pulled by the frontend**」
  ⇒ 取数是**前端**的责任；
- profile 校验的警告文案：「…… **skipped by the runtime fetcher**」
  ⇒ 暗示存在一个 runtime fetcher。

两处对不上，而实测支持前者：**没有服务端取数器**。

这本身可以是一个设计选择，但它与第一节叠加就成了陷阱：
**声明 source（以为会自动取）→ 实际不取 → meta 空 → 数值条件 fail-open → 状态机无条件推进。**
三步全部静默，最终结果是一个「配了闸门但闸门不存在」的状态机。

**建议**：

1. 如果取数确实由调用方负责，**把 `meta_fields[].source` 的契约写清楚**：
   它是给前端/调用方看的**取数说明书**，不是服务端行为；并统一那句 "skipped by the runtime fetcher"
   的措辞（它现在读起来像服务端会做）。
2. 更好的做法是**真的实现它**：transition 前按 `meta_fields[].source` 逐个 `relay.call` 取数填入 meta。
   fulfillment 已经持有 relay（转移事件就是用它发的），差的只是这一步。
   这样 `condition` 才真正是声明式的——否则「声明式状态机」的承诺只兑现了一半：
   状态和转移是声明式的，**数据却要靠调用方手工搬运**。

---

## 三、没有任何时间驱动设施

fulfillment 的全部 26 个方法里，**没有一个**与 timer / schedule / cron / expire 相关：

```
instance.{create,get,list,transition,cancel,hold,resume,override,update}
profile.{create,get,list,update,delete,restore,destroy,generate,submit,approve,reject}
ping methods entities token.{set,status,clear}
```

这与协议里「超时检测由独立的定时任务扫描 Redis 完成（**不在此协议范围内**）」是一致的，
所以不算实现缺陷。但它决定了**能力边界**，值得在文档里直说：

> fulfillment 建模的是**由外部事件推进**的流程。任何「过了 N 小时自动转移」的语义
> 都必须由调用方自己跑循环来推——fulfillment 不会自己动。

我的场景里，ant 的三条核心规则全是时间驱动的（`timeoutHours` 超时降级、`cooldownMin` 冷冻解除、
`phase1MaxHours` 移交人工），**没有一条能交给 fulfillment**。这也是这次压测最终的结论：
fulfillment 撑不起这个场景，不是因为它不好，而是**驱动模型不匹配**——它等人推，而这个场景没有人推。

---

## 四、两个附带发现

> ⚠️ **本节两条的定性已被后续源码核对推翻，triage 时以
> `fulfillment-profile-submit-contract-and-enroll-gap.md` 为准**（2026-08-16）：
> #1 的前提错了——submit 本来就是审核通道里的**创建**（双通道设计），该修的是描述与报错
> （已修，并补了 enroll 路径）；#2 的建议请忽略——「缺 reviewState 视为未审核」会把可信
> 直建通道整个打死，守卫按设计工作正常。本节按纪律保留原文不删。

1. **`fulfillment.profile.submit` 报 "profile id already exists"**
   对一个已存在的 profile 调 submit（提交审核）时：

   ```
   ❌ [-32602] profile id "ant_cycle_probe2" already exists
   ```

   submit 的语义是「提交现有 profile 进入审核」，不该走创建路径的重名校验。
   连带后果：`profile.approve` 随后报 `Cannot approve a profile in reviewState: (none)`，
   **审核流程整条走不通**。

2. **未审核的 profile 可以直接使用**
   `advance()` 里的守卫是：

   ```js
   if (profile && profile.reviewState && profile.reviewState !== "APPROVED") throw FORBIDDEN(...)
   ```

   `reviewState` 为 `undefined`（create 出来的 profile 默认就是）时**整个检查被跳过**，
   实例照常转移——我这次全部实测都是在未审核的 profile 上跑的，一次都没被拦。
   结合第 1 条（submit 走不通、无法进入审核态），实际效果是：
   **审核机制既无法启用，也不拦截未审核的 profile。**
   建议把守卫改成「缺 `reviewState` 视为未审核」，并同时修掉 submit，否则会变成
   「所有人都在用未审核 profile，而没人知道有审核这回事」。

---

## 五、与另一篇 feedback 的交叉印证

`relay-provisioning-and-event-registry.md` 第一节推断「Solo 自带服务因为没有 bot token
而发不出 `event.emit`」，当时标注为**未验证**。这次顺带拿到了直接证据：

```
fulfillment.token.status → {"hasToken":false}
转移成功后 EVENT:FULFILLMENT:TRANSITIONED 长度 = 0
```

fulfillment 的转移事件是 fire-and-forget（`relay.call` 不阻塞 transition 响应），
所以 token 缺失时**转移正常、事件全丢、无任何提示**。
那篇的推断可以升级为已验证——至少 fulfillment 这一条是确凿的。

---

## 处理结论（solo 侧）

**2026-09-04 triage。§一 复现属实，已修；§二/§三 待做，本篇留顶层。**

- ✅ **§一 fail-open → fail-closed**（按建议 1，落在 `api/library/jsonlogic.js` 的 `evaluateCondition`）。
  求值前改写规则树：`<` `<=` `>` `>=` 子树里引用的 `{var: path}`（不带缺省值形态）任一缺失
  （json-logic `missing` 语义：undefined / null / 空串）→ 该比较为 false。值为 0 / false 不算缺失；
  `{var: [path, default]}` 是显式缺省、照旧取缺省；`==` `!=` `!` 不改（`{'!': {var:'meta.cancelled'}}`
  「没设过就当 false」是合法惯用法）。裸 `apply()` 不改写，只有守卫带这层语义。
  **没用 `jsonLogic.add_operation` 覆盖内建算子**——那会改掉进程内 json-logic-js 单例的全局语义，
  `core/orchestrator/logic/runner.js` 直接 require 了 json-logic-js 做 step condition，不该被隐式带走。
  **影响面**：fulfillment transition 守卫 + nexus 上下文装配的 guard（都走 `evaluateCondition`）。
  orchestrator step `condition` 走自己的 jsonLogic.apply，**未纳入**（登记 BACKLOG §3）。
  测试：`api/library/tests/jsonlogic.test.js` 新增 11 例（含「裸 apply 仍为 true、守卫为 false」的对照钉）；
  `api/apps/fulfillment/tests/logic.test.js` 新增 `release` 转移 4 例，复现本文 event=b 场景。
  文档：`api/apps/fulfillment/GUIDE.md` 配方一第 4 步补了缺字段语义（建议 3）。
- ⏸ **建议 2**（profile 静态校验报 error）：`logic/lint.js:156-160` 已对「condition 引用了未声明 meta_field 的
  变量」发 **warning**，与建议只差级别。不升级为 error：`metaUpdate` 在转移时补值是文档承认的合法模式
  （GUIDE 配方一第 3 步），静态无法证明它没被喂。fail-closed 之后这条的风险从「静默放行」降为
  「转移被拦并报 Condition not met」，warning 级够用。
- ⏸ **§二 `meta_fields[].source` 无取数器、§三 无时间驱动设施**：属实，都是功能缺口而非 bug，
  另行排期（与 BACKLOG 「cron-to-service」条相关）。

`下游 action`（随下一 tag 的 CHANGELOG 一起发）：用 JsonLogic 数值比较做闸门、且依赖「字段没喂就放行」
的 profile（应该没有——那正是本文报的事故）现在会被拦；要缺省值就写 `{var: [path, default]}`。
