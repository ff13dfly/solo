# 反馈：Entity Factory 绕开 `clock.js` —— 「No scattered `Date.now()`」是唯一没有门禁的红线

> 来源：finance 派生项目，2026-08-25。起因是排查「生产服务器（64.176.61.210）跑 UTC 时区
> 会不会算错账」，顺着「Solo 到底怎么规定时间存储」查下去，撞到这条。
> 依据：**全部自查实测**——`clock.freeze()` 探针在 finance 所用 bundle **v1.1.14** 与
> solo 仓 HEAD **v1.2.3**（`5c8f49b`）上各跑一次，双向复现；根因行号为 solo 仓 HEAD 源码。
> 无二手引用。
> 涉及：`api/library/entity.js`（实体时间戳）、`api/library/clock.js`（被绕开的时间源）、
> `.claude/skills/solo-service/SKILL.md:67`（约束条文）、`api/autocheck/static/`（缺检查器）。
>
> 一句话：约束说「别散落 `Date.now()`，用 `clock.js`」，而**所有实体的必经之路
> `entity.js` 自己就是散落的 `Date.now()`**——于是 `clock.freeze()` 冻不住
> `createdAt/updatedAt`，时间敏感逻辑的 E2E 测试拿到的是真实墙钟。

---

## 一、实测：freeze 到 2020，实体时间戳仍是 2026

探针：`CLOCK_TEST_MODE=true` → `clock.freeze('2020-01-01T00:00:00Z')` → 用 fake redis 起一个
Entity Factory → `create({ name: 'hello' })`，读回 `createdAt`。

| 版本 | `clock.now()` | `entity.createdAt` | 偏差 |
|---|---|---|---|
| finance bundle **v1.1.14** | `2020-01-01T00:00:00.000Z` ✅ 冻住 | `2026-08-25T08:00:57.076Z` | **2428 天** |
| solo 仓 HEAD **v1.2.3** | `2020-01-01T00:00:00.000Z` ✅ 冻住 | `2026-08-25T08:01:14.593Z` | **2428 天** |

`clock` 本身工作正常（`isFrozen() = true`，`now()` 返回冻结值）；漏的是实体这一层。
两个版本行为完全一致 ⇒ **不是旧 bundle 的问题，上游 HEAD 同样如此**。

存储格式倒是对的：`typeof createdAt === 'number'`，epoch ms，符合 factory standard。

## 二、根因：`entity.js` 的 require 列表里没有 clock

`api/library/entity.js`（solo v1.2.3）：

1. **require 列表 1–6 行**：`async_hooks` / `generator` / `jsonrpc` / `constants` / `logger` /
   `optimistic` —— **没有 `clock`**。
2. **直接调 `Date.now()` 的 5 处**：`175`（WAL stamp，String 化）· `203`（WAL stamp）·
   `250`（`create()` 的 `now`，写进 `createdAt`/`updatedAt`）· `341` · `360`
   （两处 `update()` 的 `updatedAt`）。

`create()`/`update()` 是**所有实体的唯一入口**，所以这不是某个服务的疏忽，
是框架层把自己的约束整个架空了：业务代码再怎么老实用 `clock.now()`，
只要数据落进实体，时间戳就换回了墙钟。

## 三、为什么会漂到这一步：这条红线没有执行机制

`.claude/skills/solo-service/SKILL.md` 的红线清单里，条目基本都挂了门禁：

```
:66  Entities go through the Entity Factory …  (autocheck `entity-factory` / `soft-delete-check`)
:67  No scattered `Date.now()` — use `api/library/clock.js` (injectable, freezable in tests).
:68  No `console.log` — use the built-in logger …  (autocheck `logging`)
```

**第 67 行是这份清单里唯一没有 autocheck 标注的一条**，夹在两条有门禁的中间。
`api/autocheck/static/` 下 30+ 个检查器里也确实没有对应项（`task-throttle-check.js`
里出现的 `Date.now()` 是在检查 ping 路由的节流，与本条无关）。

⇒ 纯文档约束 + 框架自己第一个破例 = 必然漂移。这不是「有人不守规矩」，是**规矩没有执行面**。

## 四、漂移的既成事实：三套时间表示并存

- **`clock.now()`（约束要求的）**：20 个文件在用——ingress（audit/review/ingest/source）、
  gateway（delivery/sms/probe/webhook/index）、orchestrator（trace-audit）、
  collection（payment）、market（order/shipment）、approval（record/gate）。
  ⇒ **业务层其实是听话的**，问题真的只在 library。
- **`Date.now()`**：`entity.js` 的 5 处（见上）。
- **ISO-8601 字符串**：`api/core/user/logic/bot.js:77`（`createdAt`）·
  `api/core/administrator/logic/identity.js:243`（`updatedAt`）·
  `api/apps/storage/logic/asset.js:399`（`createdAt`）·
  `api/router/handlers/report.js:98`（`createdAt`）。

第三套的代价已经付过一次了：`entity.js:15-25` 的 `toSortableMs()` 就是为它写的兜底，
注释自陈——对 ISO 字符串做裸减法得到 `NaN`，而**返回 `NaN` 的比较器会让 `Array.sort`
静默变成 no-op**，于是「最新在前」降级成 Redis SET 的无序返回，**不报错、不抛异常**。
这个补丁修的是症状；病根（时间表示不统一）还在。

## 五、建议（按价值排序）

1. **`entity.js` 引入 clock**（改动最小、收益最大）：加一行 `require('./clock')`，
   把 250/341/360 三处 `Date.now()` 换成 `clock.now()`。生产行为**零变化**
   （`clock.now()` 在非测试模式下就是 `Date.now()`），但 E2E 从此能冻住实体时间戳。
   175/203 的 WAL stamp 建议一并换，理由同上。
2. **补一个 autocheck 检查器**（`clock-check`），扫 `api/apps/*/logic/` 与 `api/core/*/logic/`
   下的裸 `Date.now()` / `new Date()`，WARN 级即可。**没有门禁的红线迟早会漂**，
   而这条已经漂了——第 67 行的标注也该跟着补上。
3. **ISO 那 4 处收敛到 epoch ms**（可选，低优先）：有存量数据迁移成本，且 `toSortableMs()`
   已兜住排序。若不收敛，建议反过来在 `entity.js:17` 的注释里把「factory standard」
   的措辞改成「factory standard，例外见 X/Y/Z」——现在的写法读起来像是没有例外。

## 六、附带说明：这条为什么是从时区问题引出来的

finance 的生产机跑 UTC，一开始担心财务数据算错。查下来结论是**不会**——
因为 Solo 的存储标准是 epoch ms，绝对时间，与时区无关。
**这条标准本身是对的、有价值的**，本篇不是要推翻它，恰恰相反：
它值得有一个真正贯彻到底的执行面，而不是止步于 SKILL.md 的一行字。

---

## 处理结论

（待 triage）
