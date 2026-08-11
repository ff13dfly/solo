# 反馈：bundle 内置服务吃继承的 `ROUTER_URL` → 事件投进别家 Router；`ingress` 又不看 `event.emit` 的返回 → 全链路静默丢数据

> 来源：trend / overview 两个派生栈同机并跑，2026-08-06 trend 侧实测，08-08 在 solo 源码里核实根因。
> 场景：本机同时跑 5+ 个 Solo 栈，各自 `.env` 独立且 gitignore；从**起过别的 Solo 栈的 shell**
> 里启动 `deploy/run.sh`（人手敲、或经启动器），外层残留的 `ROUTER_URL` 被 bundle 继承。
> **依据分两类，本文逐处标注**：
>   · 〔trend 实测〕事件层静默停更 12 小时的现象与诊断过程，来自 trend 项目的实测记录；
>   · 〔本次核实〕solo 源码层面的根因链条（`ports.js` / 14 个 `config.js` / `ingest.js` /
>     `router/handlers/events.js`），是写本篇时逐个读过确认的。
> 涉及：`api/library/ports.js`、`api/core/*/config.js` 与 `api/apps/*/config.js`（共 14 处）、
> `api/core/ingress/logic/ingest.js:84-95,143-144`、`api/router/handlers/events.js:169-173,228`、
> `deploy/scaffold/run.sh`（缺 `unset`）。
>
> **状态：已上收**（2026-08-08，建议 1/2/3 全部采纳，见文末「处理结论」；随下一个 v1.1.x 发版下发）。

## 一、实测现象〔trend 实测〕

trend 的采集端一切正常（HTTP 200、审计记 `accepted`、去重键照写），**事件流却 12 小时零增长**，
无人报错。最终定位：trend 的 `ingress` 把 webhook 事件**全部投给了 runner 的 Router**
（`http://localhost:8600`）——因为启动 trend 那个 shell 里残留着 runner 的 `ROUTER_URL`。

链路上每一环都"成功"：

```
采集端 → trend ingress          → 200 OK，审计 accepted，写 30 天去重键
         trend ingress → relay  → runner 的 Router（!)
         runner Router          → 不认 trend 的 token，来源当 guest
                                → stream 不在自己 registry → blocked，丢弃
         唯一那行 [Events] BLOCKED ... not in registry 打在 **runner 的日志里**
下一轮同一条数据 → 命中 trend 自己的去重键 → 永久丢弃
```

本项目日志里什么都看不到。这是同族问题里代价最大的一次。

## 二、根因：两个**正交**的缺陷，各自都足以让失败变静默

### 2.1 `config.js` 把 `ports.js` 精心设计的环境隔离整个抵消了〔本次核实〕

`api/library/ports.js` 的头部注释是血泪写的，方向完全正确：

```
urlFor(name)  — a FOREIGN service's address.
  Resolution: global.__SOLO_PORTS__[name] > fallback. It MUST NOT consult
  process.env.PORT — that env is THIS process's own port, not a peer's. Honoring it
  made the Router (started with PORT=8600) resolve every peer to :8600 — itself —
  so e.g. administratorServiceUrl pointed at the Router and admin methods 404'd.
```

`urlFor()` 因此**刻意不读环境**。但所有服务的 `config.js` 都是这么写的：

```js
routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
//            ↑ 环境变量优先，urlFor 退化成 fallback
```

**共 14 个文件**：`core/{ingress,notification,user,agent,mcp,nexus,administrator,orchestrator,gateway}`
+ `apps/{collection,planner,fulfillment,market,approval}`。于是 `ports.js` 从正门挡住的
`PORT`，从 `ROUTER_URL` 这道侧门整个放了进来——而且这次的后果比当初那次 404 更坏：
**不是自指报错，是投给别人后静默丢弃**。

关键是这条继承路径**只对 bundle 内置服务有害**：它们与 Router 同进程、共享
`global.__SOLO_PORTS__`，Router 地址本就该由 `urlFor()` 解析出来；`ROUTER_URL` 的环境变量
入口是给**独立进程的私有 app** 用的（`run.sh` 第 9 节逐条显式传）。两类消费者被同一行代码
混在了一起。

补充一处结构性原因〔本次核实〕：bundle 主进程启动时只传 `SOLO_SERVICES_JSON`
（`run.sh` 第 8 节），不传 `ROUTER_URL`——因为 `ROUTER_PORT` 要到第 9 节之前才解析出来。
所以 bundle 从来没有一个"正确的 `ROUTER_URL`"去覆盖继承来的那个，只能靠外部环境干净。

### 2.2 `ingress` 丢弃 `event.emit` 的返回值〔本次核实〕

**先纠正一处此前的表述**：Router 并非"无论 blocked 与否都返回 ok"。
`api/router/handlers/events.js:228` 如实返回 `{ written, blocked, deduped }`，
blocked 分支（`:169-173`）也确实打了日志。**Router 是诚实的，只是没人听。**

`api/core/ingress/logic/ingest.js:84-90`：

```js
async function emit(sourceName, requestId, data) {
    await relay.call('event.emit', { ... });   // ← 返回值没有接
}
```

`:143-144`：

```js
await emit(src.name, reqId, data);
await source.recordFire(src.id, { outcome: 'accepted' });   // ← 无条件 accepted
```

于是 `{written:0, blocked:1}` 和 `{written:1}` 在 ingress 眼里毫无区别，一律记
`accepted`、回 200、写去重键。

**这个缺陷独立成立**：即使没有跨栈错投，只要本项目的 stream 忘了进 registry，
同样会得到"采集端一切正常、事件永远不到"的静默丢失。2.1 只是把它放大到了跨项目。

## 三、建议

### 建议 1（根治 2.1）：bundle 内置服务不该吃继承的 `ROUTER_URL`

两种改法，任选：

- **A：反转优先级**——内置服务的 `config.js` 改成 `urlFor('router', 8600) || process.env.ROUTER_URL`。
  改动面 14 个文件但每处一行，语义与 `ports.js` 头部注释一致。
- **B：入口处清理**——`deploy/gen-entry.js` 在填完 `global.__SOLO_PORTS__` 之后、加载任何
  服务 `config.js` 之前 `delete process.env.ROUTER_URL`。一处改动覆盖全部内置服务，且
  天然只作用于 bundle 进程、不影响独立进程的私有 app。

倾向 B：改一处、语义明确（"bundle 内部一律走端口表"），也不必逐个盯新增服务有没有照抄那行。

### 建议 2（根治 2.2，价值独立于建议 1）：`ingress` 必须检查 `emit` 的返回

`event.emit` 已经把 `blocked` 报出来了，接住即可：

```js
const stats = await relay.call('event.emit', { ... });
if (!stats || stats.written < 1) {
    // 别记 accepted、别写去重键 —— 让采集端能重试
    throw jsonrpc.INTERNAL_ERROR('EVENT_NOT_WRITTEN', { stats });
}
```

要点是**不写去重键**：现在的行为是"投递失败 + 写下 30 天去重键"，导致下一轮同一条数据
命中去重被永久丢弃——**失败本身可恢复，是去重键让它变成了永久损失**。

### 建议 3：scaffold 的 `run.sh` 补 `unset`（防御层，不能替代 1/2）

`deploy/scaffold/run.sh` 至今（v1.1.14）**没有任何 `unset`**〔本次核实〕。派生项目现在各自
打本地补丁（trend、overview 已打），这类补丁会变成 `upgrade.sh` 的永久 `DIVERGED`。建议
stock 在第 1 节 `.env` 加载之后加上：

```bash
unset PORT ROUTER_URL ADMINISTRATOR_SERVICE_URL
```

## 四、同族：`unset PORT`（同一批实测，至今未上收）〔trend 实测〕

同一个"继承污染"家族的第一例，2026-08-05 发现：外层残留 `PORT=8422` 时，bundle 十几个内置
服务**全部挤到同一个端口**（`portFor()` 的 `process.env.PORT` 优先是**有意为之**且对独立进程
正确，但对 bundle 主进程就成了灾难）。主控台照常打印 "All services running"，只有 bundle 日志
里刷 `Failed to introspect service ...`，而且第一个绑上的那个服务还能用——又是一个静默形态。

这条和 2.1 是同一个设计缝隙的两面：**`PORT` / `ROUTER_URL` 这类"单进程语义"的环境变量，
在 bundle 这个"多服务同进程"的形态里语义失效了**，但代码里没有任何地方标出这条边界。
建议 1 的 B 方案（入口处统一清理）可以把两者一并解决。

## 处理结论（solo 侧，2026-08-08）

根因逐项复核成立：`ports.js` 头部注释与 `urlFor()` 实现一致（刻意不读 `process.env.PORT`）；
14 个 `config.js` 逐个 grep 确认（`core/{ingress,notification,user,agent,mcp,nexus,
administrator,orchestrator,gateway}` + `apps/{collection,planner,fulfillment,market,approval}`，
与反馈列的清单精确对上；另有 `orchestrator/logic/runner.js` 命中 `process.env.ROUTER_URL`
但是不同的内部执行引擎回退路径，不计入这 14 个）；`ingest.js:84-90` 确认 `emit()` 丢弃
`relay.call` 返回值、`:143-144` 确认无条件 `recordFire('accepted')`；`router/handlers/events.js`
确认反馈对"Router 是诚实的"这条纠偏准确（`:170-173` 记 blocked 并打日志，`:228` 如实
`return {written,blocked,deduped}`，`relay.call()` 直接把这个对象透传给调用方，逐层追踪确认）。

三条建议全部采纳：

1. **✅ 建议 1，选 B 方案（入口处清理）**：`deploy/gen-entry.js` 在 `global.__SOLO_PORTS__`
   填完、任何服务 `config.js` 加载前 `delete process.env.PORT; delete process.env.ROUTER_URL`。
   与反馈的判断一致——B 比 A（逐个反转 14 处优先级）更彻底，一处改动保护现在和未来所有
   bundle 内置服务，不必盯着新服务有没有照抄那行。用真实 `deploy/build.sh` 端到端跑过：
   产物 5.3M、生成的 `_entry.js` 语法检查通过、`grep` 确认两处 `delete` 落进了最终 bundle。
2. **✅ 建议 2**：`ingest.js` 的 `emit()` 改为返回 `relay.call` 的结果；`handle()` 检查
   `stats.written`（要求是数字且 ≥1，比反馈原文的 truthy 检查更严——过程中用真实 CI 测试
   fixture 验证过：一个只返回 `{ok:true}` 的 fake relay 在宽松检查下会被判定"送达"，
   而真实 Router 永远返回数字 `written`，收紧后更贴近生产语义且不放过畸形响应），失败时
   **释放 dedup 声明**（新增 `dedup.release()`）+ 记 `outcome:'delivery_failed'` + 返回
   `{ok:false}`/502，不再无条件 `recordFire('accepted')`。要点采纳反馈原文强调的那句：
   "失败本身可恢复，是去重键让它变成了永久损失"。顺带把 `ingress.source.test`（admin 手动
   测试 wiring 的入口）也接上 `written`/`blocked`，直接服务反馈自己描述的排查场景——
   下次再撞上同类问题，admin 一次 `ingress.source.test` 调用就能看到"送达了没有"，
   不用再去猜、去翻可能是别的项目的 Router 日志。
3. **✅ 建议 3**：`run.sh` 在 `.env` 加载后加 `unset PORT ROUTER_URL ADMINISTRATOR_SERVICE_URL`
   ——按反馈定位为防御层，不替代 1；`ADMINISTRATOR_SERVICE_URL` 复核后发现当前代码库里
   **没有任何地方**读取这个变量（应是 `ports.js` 注释提到的历史 404 bug 遗留的变量名），
   保留在 unset 列表里无害，随手按反馈原文一并清了。

落地位置：`deploy/gen-entry.js`、`api/core/ingress/logic/{ingest,dedup}.js`、
`api/core/ingress/handlers/introspection.js`（补充 502 路径 + test-fire 新字段的文档）、
`deploy/scaffold/run.sh`。回归：`core/ingress` 新增 3 个用例（含一次失活测试验证辨别力）+
`returns-contract.test.js` 的共享 fake relay 补全成真实 Router 形状（原来只返回 `{ok:true}`，
是这次改动过程中才发现的、同类"假实现语义漂移"的另一个实例）；CI 白名单 123 套/1939 测试
全绿。记入 CHANGELOG `[Unreleased]`，随下一个 v1.1.x tag 下发。

派生项目现状：trend 与 overview 的 `deploy/run.sh` 已各自打了 `unset PORT` /
`unset ROUTER_URL ADMINISTRATOR_SERVICE_URL` 的本地补丁并标了 `[Project]`；
上收后按 DIVERGED 流程 merge 新 stock（内容同款），之后删除本地补丁标记即可。
