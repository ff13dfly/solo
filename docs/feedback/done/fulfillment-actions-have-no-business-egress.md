# fulfillment 的 `actions` 没有业务出口：默认只通 notification/gateway，且被挡时全链路静默

- **来源**：steward，2026-09-05。把仓内一份「履约状态机 × 浏览器剧本」的设计稿拿到线上
  **真跑一遍**时撞到——设计稿读起来完全接通，跑起来一张单都没派出去，而且没有任何报错。
- **场景**：拿 `fulfillment` 当长周期业务状态机（跨天挂起、JsonLogic 守卫、旁路转人工），
  用 `transition.actions` 去派一张本项目自己的工单（`hive.job.create`）。
  这是 fulfillment 的**主要用途**，不是边角用法：状态机不驱动业务动作，就只剩一张状态表。
- **依据分类**：
  - **本次实测**（steward 线上栈，Router `steward-api.w3os.net`，bundle **v1.2.13**）：
    §一的时序结论、§三的三条参数限制、以及「notification 送达 / hive 未送达」的对照。
    复现脚本可复跑：steward 仓 `integrations/demo-fulfillment.js`。
  - **源码引用**（solo 仓 main，未跑）：所有 `文件:行号`。
  - **仓内既有记录**（引用，非本次实测）：§四那条 runbook。
- **涉及**：`api/router/config.js`（`taskWhitelist`）、`api/router/handlers/tasks.js`、
  `api/router/handlers/forward.js`、`api/router/index.js`、`api/router/handlers/bootstrap.js`、
  `api/library/jsonlogic.js`（`resolveParams`/`resolveValue`）、
  `api/apps/fulfillment/logic/instance.js`（`buildLogicData`）、`api/apps/fulfillment/logic/lint.js`。
- **影响面**：任何让状态机驱动业务动作的部署。**默认白名单只有 notification 与 gateway**，
  所以「状态机推进业务」这件事**开箱即不可用**，且第一次尝试就静默失败。

> 一句话：状态机能推进、能守卫、能挂起，唯独**推不动任何业务动作**——
> `actions` 的出口默认只有两家；派到别处的 task 被丢弃，而调用方连"派过什么"都看不见。

---

## 一、什么时候触发：白名单是在**响应发出之后**才查的

这不是「错误没被传播」，是**结构上不可能传播**。逐跳时序（源码引用）：

| 时刻 | 发生什么 | 调用方看到 |
|---|---|---|
| T0 | `fulfillment.instance.transition` 条件通过、状态落库、history 追加 | — |
| T1 | 服务返回 `{ ...instance, _tasks: [...] }` | — |
| T2 | Router `extractTasks()` 把 `_tasks` **从响应里 `delete` 掉**（`forward.js:104`，注释写着 "Sanitize result before sending to client"） | — |
| T3 | `processTasks(...)` 被调用，**不 `await`**，`.catch` 只 `logger.error`（`index.js:353`） | — |
| T4 | `res.json(responseData)`（`index.js:365`） | ✅ **200 · 新状态 · history 干净** |
| T5 | 异步里才 `getWhitelist()` → 目标不在表里 → `console.warn` + `return`（`tasks.js`） | **什么都没有** |

**T4 早于 T5。** 调用方在白名单被查之前就已经拿到成功了。

三处"不留痕"叠加，缺一都还有救：

1. `_tasks` 被从响应里删掉 ⇒ 调用方**看不到派了什么**；
2. 被白名单挡下只有 `console.warn` ⇒ 日志在服务器上，且不分级；
3. 不进 `ERROR:QUEUE:router` ⇒ 事后也查不到。

**触发条件（零成本判定）**：`transition.actions` 里出现 `notification` / `gateway`
以外的任何 service。也就是说——**只要状态机想干"通知"以外的事，第一次就踩**。

### 实测对照（同一条 transition 上挂两个 action）

```
action A: { type:'task', service:'hive',         method:'hive.job.create',    ... }
action B: { type:'task', service:'notification', method:'notification.send',  ... }
```

- **B 送达**：`notification.inbox.list` 里查得到 ⇒ `_tasks` 机制本身是活的。
- **A 从未投递**：用 action 里那个 `requestId` 自己复派一次 `hive.job.create`——
  派出去过就该命中幂等返回原单，实测是**新单**。
- 而 `transition` 的返回：`200`，`DRAFT → CREATING_DRAFT`，`history` 一条不少，**无 `_tasks` 字段**。

> 判据可复用：**用下游的幂等键自己复派一次**，看是不是新单。这是目前唯一能从外部
> 判断"action 到底发没发生"的办法。

### 一个附带的升级陷阱

`bootstrap.js:68` 播种白名单用的是 `if (!exists)`——**只在 Redis 里没有那个 key 时写一次**。

- 好的一半：运维用 `setting.task.update` 改过的白名单**不会被重启/升级覆盖**。
- 坏的一半：**升级 bundle 也不会把新的默认白名单带给已有部署**。将来若在
  `config.taskWhitelist` 里加一家，所有存量部署都拿不到，而且不会有任何提示。

---

## 二、被挡不留痕，是**同一个函数里的不一致**

`handlers/tasks.js` 的 `dispatchOne` 里，三处白名单拒绝全是 `console.warn(...)` + `return`：

```js
if (!rule)                     { console.warn(`[Security] BLOCKED task: Target '${targetService}' is not in the task whitelist.`); return; }
if (!allowedSources.includes(sourceService)) { console.warn(`[Security] BLOCKED task: Source ...`); return; }
if (!allowedMethods.includes(method))        { console.warn(`[Security] BLOCKED task: Method ...`); return; }
```

而**紧接着的下一段**，参数校验失败**是写 `ERROR:QUEUE:router` 的**：

```js
if (validationError) {
    console.error(...);
    await redisClient.rPush(`${config.redis.errorQueuePrefix}router`,
        JSON.stringify({ code: 'TASK_VALIDATION_ERROR', service, method, error, stamp }));
    return;
}
```

同一个 `dispatchOne`、同样是"这个 task 不会执行"、两种处置。而且投递失败
（`postWithRetry` 耗尽重试）也进 `ERROR:QUEUE`——**只有"被安全策略挡下"这一类没有留痕**，
偏偏它是最需要留痕的一类：投递失败是运维问题，被策略挡下是**配置与设计不匹配**，
后者不告诉人就永远不会被发现。

这条建议的成本几乎为零：照着隔壁那几行写。

---

## 三、就算白名单开了，profile 里也拼不出必需的参数

把白名单打开只解决了第一道。真要让状态机派单，还差三样，**全部实测**：

### 3.1 `params` 没有字符串插值 ⇒ 幂等键拼不出来

`resolveValue`（`library/jsonlogic.js`）只对**含 `var` 键或 `$` 前缀键**的对象求值，
其余原样递归。于是 profile 里写：

```json
"requestId": "fx-{instance.id}-publish"
```

会**原样当字面量**发给下游——**所有实例共用同一个幂等键**。后果比"没有幂等"更坏：
第一张单建成之后，后面每一张都命中幂等、返回那张旧单，**调用链看起来次次成功，
实际一次都没派**。

`{ "cat": [...] }` 也不行：它既没有 `var` 键也没有 `$` 前缀，`resolveValue` 不会对它调
`jsonLogic.apply`，只会递归进去把里面的 `{var:…}` 换掉，最后发出去一个
`{"cat": ["fx-", "FL-20260905-1234", "-publish"]}` **对象**。
⇒ 现状等于**把 JsonLogic 砍成了只剩取值**，算子一个都用不上。

引擎其实**已经**在注入一个每实例唯一的键：`idempotency_key = {transition_id}:A{idx}`
（`instance.js`，`transition_id` 按实例单调递增）。但下游各服务的去重字段各叫各的
（hive 叫 `requestId`），**名字对不上就接不上**。

### 3.2 求值上下文里**没有时钟** ⇒ 相对死期算不出来

`buildLogicData` 造的上下文是 `{ instance, user, permit, constraints }`——没有 `now`。

实测（三条转移，唯一区别是读哪个变量；数据侧 `meta.deadline` 确实存在）：

```
by_meta   condition: { ">": [ {var:"instance.meta.deadline"}, 0 ] }   → 通过（A）
by_now    condition: { ">": [ {var:"now"},                    0 ] }   → 拒：Condition not met
by_now2   condition: { ">": [ {var:"instance.now"},           0 ] }   → 拒：Condition not met
```

`by_meta` 通过证明比较链本身正常，所以两条 `now` 被拒**只可能是上下文里没有这个键**。

两个直接后果：

- **action 的 `expireAt` 只能烤成绝对时刻**。而下游普遍要求"进入待办队列的东西必须有死期"，
  状态机要跑几周，烤死的值当天就过期了。
- 🔴 **`protocol/zh/fulfillment.md` 自己写的超时机制今天写不出来**：§3.4 的 `max_stay_duration`
  停留超时、以及「守卫判 `now > expireAt` 跃迁到催办状态」这类用法，**没有时钟就无法表达**。
  协议里已经把它当成既有能力在描述了。

### 3.3 小结：三样里两样是一行的事

`buildLogicData` 里加 `now: Date.now()`，`resolveValue` 放开标准算子——
这两处改完，3.1 与 3.2 一起没了。

---

## 四、这不是第一次（**引用**，非本次实测）

仓内 runbook 已经记着同款症状，只是换了个目标服务：

> `docs/runbook/browser-extension-ai-extraction.md:50`
> | 4 | Router task 白名单默认**没有 agent**（只有 notification/gateway），`_tasks: agent.chat` 会被当场拒 | `api/router/config.js` `taskWhitelist` |

⇒ 两个互不相干的场景（浏览器抽取、履约派单）各自撞了一次，**都只能靠人去翻 router 源码
才知道**，而且那条记录停在"踩过了、绕过去了"，没有回到机制上。
这说明它不是某一种用法的问题，是**「fulfillment 有 actions」这个能力与「actions 只能到两家」
这个默认值之间的落差**——文档、lint、运行时三处都没有人提这一句。

---

## 五、建议（按价值排序）

1. 🔴 **被白名单挡下的 task 写 `ERROR:QUEUE:router`**（新错误码如 `TASK_BLOCKED`，
   带 `sourceService` / `targetService` / `method` / 命中的是哪一道）。
   照抄同函数里 `TASK_VALIDATION_ERROR` 那几行，**不改任何语义**，只是让静默变成可查。
   这是五条里唯一"纯增量、零争议"的。
2. 🔴 **`profile.submit` 的 lint 加一条规则：action 的 `(service, method)` 能不能过 `_tasks` 白名单。**
   lint 契约（`protocol/zh/fulfillment.md` §7.1）已经有"action 方法必须已注册"这条规则 4，
   这是它的自然延伸——**把运行时的静默提前成激活前的明确 error**，
   正是 §7.1 自己声明的目的（「把会在运行时静默走错分支/失败的结构错变成激活前的明确报错」）。
   ⚠️ 注意 `allowedActions` 那个可选参数解决的是**另一件事**（投稿身份越权预审），
   不覆盖"这个目标根本不在出口白名单里"。
3. **`buildLogicData` 加 `now`**（epoch ms，一行）。解锁 condition 里的时间判定与 action 里的
   相对死期，让协议 §3.4 描述的停留超时真的可写。
4. **`resolveValue` 放开标准 JsonLogic 算子**（至少 `cat` / `+`）。现在只认 `var` 与 `$` 前缀，
   等于把 JsonLogic 砍成只剩取值；放开后 `requestId` 这类"业务单 id + 意图"的幂等键才拼得出来。
   若不想放开全部算子，退一步的做法是**只把 `cat` 加进 `resolveValue` 的白名单**。
5. **文档写明两件事**：① 默认白名单只有 notification/gateway，状态机要派别的必须先
   `setting.task.update`（**整体替换语义，必须先 `setting.task.get` 再合并**，直接写会把
   现有两项一起抹掉）；② `bootstrap` 只在 key 缺失时播种，**升级不会带来新的默认值**。

> 关于 1 与 2 的关系：2 是"别让人跑到那一步"，1 是"真跑到了也得留下痕迹"。
> 两条不重复——lint 只看得到 profile 里声明的 action，运行时白名单是可以被运维改窄的。

---

## 六、附：这次是怎么发现的

不是读代码读出来的，是**照着自己写的设计稿在线上跑了一遍**：真建 profile、真起实例、
真挂起等外部输入、真派两次剧本、真走一次旁路。设计稿里每一条"用现有契约就能接"的断言
都写成了可证伪的断言，跑完自动打印"设计稿与实况的差"。

履约层本身**逐条成立**（零算力挂起、守卫拒了三次、旁路转人工、history 完整），
断的全在"状态机 → 外部动作"这一跳。

复现脚本（可复跑，`--no-dispatch` 只跑履约层）：steward 仓 `integrations/demo-fulfillment.js`。

---

## 七、处理结论（2026-09-05 核实，**结论=采纳，五条建议全部落地**）

**逐条核过源码，九条断言全部属实**（时序 `forward.js:104` / `index.js:353,365`；三处 BLOCKED 只
`console.warn` 而紧邻的参数校验写 `ERROR:QUEUE:router`；默认白名单只有两家且 `allowFrom` 只有
fulfillment；`bootstrap.js:68` 的 `if (!exists)`；`resolveValue` 只认 `var`/`$`；`buildLogicData`
无 `now`；`idempotency_key` 的注入形状；lint 规则 4 与 `allowedActions` 各管别的事；
runbook:50 那条记录）。本篇最有价值的是 §一那张时序表——**它证明的不是"错误没被传播"，
而是"结构上不可能传播"**，这决定了修法必须是"提前到激活前"，而不是"把错误往上抛"。

### 三处补充 / 校正

1. **`max_stay_duration` 在 `api/` 里一处实现都没有**（grep 零命中）——协议 §3.4 描述的整套
   globalReview 机制都还没实现。所以本篇 §3.2 说「协议已把它当既有能力描述」是对的，但
   **「加个 `now` 就能写出来」不成立**：那节缺的不止时钟。`now` 真正解锁的是**用户自己写的**
   时间守卫与相对死期——价值仍然成立，只是别按"补回一个已声明的能力"来定级。
2. **`resolveValue` 这个坑已经被记过两次了**，本篇是第三次：`jsonlogic.js` 的 `@attention`
   注释里就写着，并直接指向 `docs/feedback/done/runbook-browser-extension-ai-extraction-not-runnable.md`
   （那篇**至今还在待办队列里**）。记了三次都没修，正是本篇 §四那句"没有回到机制上"的实例。
3. **本篇漏了一处同款静默**：`tasks.js:145` 的 `[Tasks] Target service not found` 也是
   `console.warn` + return。归进建议 1 一起收。

### 落地（见 CHANGELOG v1.2.13）

- **建议 2 ✅ lint 规则 7「出口可达」**。实现上有一处本篇没预料到的障碍：lint.js 是**纯函数、
  零 I/O**（头注明写"equally usable from a CI test or a dev script"），要判断白名单就得跨服务读
  Router 的配置键——**不能把 I/O 塞进 lint**。做法是照抄规则 6 的形状：规则由
  `options.taskWhitelist` 驱动，**由 `profile.js` 供给**（只读 `config.redis.routerTaskWhitelistKey`，
  读不到就关掉这条规则、不阻断创作）。匹配逻辑与 `dispatchOne` 逐条同义，含两处 `*` 通配——
  这里漂了就会反过来拦住能跑的 profile。10 例测试覆盖三道闸、两处通配、显式 `service` 覆盖、
  workflow 豁免、畸形白名单。
- **建议 3 ✅ `buildLogicData` 加 `now`**，走 `clock.now()` 不是 `Date.now()`（v1.2.13 刚把这条
  立成门禁，且让冻结时钟能到达 profile 条件）。
- **建议 4 ✅ 但只放 `cat` 一个**（新增 `RESOLVE_OPS` 白名单），走的是本篇自己给的退路。
  **放开全部标准算子是行为变更**：参数模板里任何以算子命名的字面量字段会突然被当算子执行。
  再加一层收窄：只在该算子是**对象唯一键**时才求值，`{cat:[...], note:'…'}` 这种业务对象照旧不动。
- **建议 5 ✅ 文档两处**：`GUIDE.md` 新增「actions 的出口有白名单」一节（含"用下游幂等键复派一次"
  这个判据、`setting.task.get` → 合并 → `update` 的读改写序、以及升级不带新默认值），
  `protocol/zh/fulfillment.md` §3.2 / §7.1 同步。

### 建议 1 —— ✅ 已做（用户明确授权改 router，CLAUDE.md §5）

`api/router/handlers/tasks.js` 三处 BLOCKED 分支 + 本篇没提的第四处（`Target service not found`）
统一写 `ERROR:QUEUE:router`，新 code `TASK_BLOCKED`，信封与同函数里的 `TASK_VALIDATION_ERROR`
同形（`stamp` 照旧 ISO——同一个队列里保持一种可读形状比对齐 epoch ms 标准更要紧）。
额外带 `gate`（`target` / `source` / `method` / `resolution`）让运维直接知道该改白名单的哪一半，
`error` 里直接写明修法。Redis 不可用时静默跳过，**绝不因记账影响派发**。

**本篇说它"纯增量、零争议"基本对，但不是零输出变化**，两处已核：
① e2e 的 `assertNoErrors` 按套断言 `ERROR:QUEUE` 增量（BACKLOG §5.6②）——扫过 `e2e/suites/`，
没有用例在触发被挡的 task（e2e 用 `lib/whitelist.js` 的联合超集，本就不该有被挡的）；
② 按队列长度告警的运维面板会开始报警——**那正是它该报的**，每一条都对应一次真的没发生的业务动作。
已作为下游 action ④ 写进 CHANGELOG。

新增 6 例断言（四道闸各一 + 放行路径不留痕 + Redis 关闭时不炸），
钉住"被挡下必须留痕"这件事本身。

**做了建议 2 之后它的紧迫性下降但没消失**——本篇 §五末尾那句判断成立且重要：
**lint 只看得见 profile 里声明的 action，运行时白名单是可以被运维随时改窄的**。两条不重复。

### 剩余待办（下一轮接手时看这里）

- [ ] `bootstrap.js:68` 的升级陷阱本轮只写进了文档，**机制没动**。它今天不咬人，但意味着
      **将来任何一次改 `config.taskWhitelist` 默认值的动作，存量部署全都拿不到且无提示**——
      真要改默认值就必须配一个迁移动作，别指望升级带过去。
- [ ] `docs/feedback/done/runbook-browser-extension-ai-extraction-not-runnable.md` 仍在队列里未 triage，
      本篇 §四引的就是它。同一个缺口第三次现形，那篇该一并了结。
