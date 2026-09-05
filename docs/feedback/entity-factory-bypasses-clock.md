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

## 处理结论（2026-08-30 核实，**结论=暂缓,不改代码**）

**报告属实,但严重性需要重新定性;本轮刻意不动代码**——`entity.js` 刚在 v1.2.9 有较大改动
（`createMany`/`deleteMany` + WAL 落盘面重写),此时再翻全文件的时间源,是把两件不相关的
风险叠在同一个未发布版本里。**留待单独一轮处理。**

### 核实结果

- **现象属实**：`clock.js` 的 require 不在 `entity.js` 里,实体时间戳走裸 `Date.now()`,
  `clock.freeze()` 冻不住 `createdAt/updatedAt`。
- **🔴 违规点已从 5 处涨到 7 处,新增的两处是 v1.2.9 加的**（照着 `create()` 的现成写法抄的,
  当时没意识到这条正躺在待处理队列里）：
  | 行 | 位置 | 来源 |
  |---|---|---|
  | 175 · 203 | WAL stamp（`walFields` / `walFile`） | 原有 |
  | 304 | `create()` 的 `now` | 原有 |
  | **399** | **`createMany()` 的 `now`** | **v1.2.9 新增** |
  | 473 · 492 | `update()` 的 `updatedAt` | 原有 |
  | **591** | **`deleteMany()` 的 `now`** | **v1.2.9 新增** |

### 严重性定性（与报告的措辞有出入,按实测校正）

- **生产不会算错**。未冻结时 `clock.now()` 直接返回 `Date.now()`（`clock.js:63-66`）,
  两个时间基完全等价 ⇒ 这不是「生产账目会错」的 bug。报告的标题容易被读成那个意思。
- **真正的损失是「本该能测的东西测不了」**：冻结后同一条记录里**两个时间基**——
  `approval` 的 `expiresAt/signedAt/approvedAt` 走 `clock.now()`（2020）,而同记录的
  `createdAt/updatedAt` 走 `Date.now()`（2026）。想验「记录建立满 N 天后过期」这类逻辑,
  拿到的 `createdAt` 是真实墙钟,用例立不住。
- **外加一个埋着的陷阱**：本轮全量扫过,**当前没有**生产代码做
  `clock.now() - entity.createdAt` 这种跨基比较（只有 orchestrator 手写实体的
  `updatedAt: Date.now()`,它本就不走 Factory）。但将来一旦有人写「这条记录多老了」,
  **生产正常、一冻结就错**,且错得安静——测试绿着、逻辑是坏的。
- **clock 的真实消费面**（15 个生产文件,供判断影响范围）：approval（`gate`/`record`,
  到期与签名时刻）· gateway（`delivery`/`sms`/`webhook`/`probe`,重试窗口与幂等 TTL）·
  ingress（`audit`/`review`/`ingest`/`source`）· orchestrator（`trace-audit`）·
  collection（`payment`）· market（`order`/`shipment`）。
  ⚠️ **nexus 一处都没引 clock**——别按「这是给 nexus 测试用的」来判断优先级。

### 处理时该做什么（留给下一轮）

1. `entity.js` 引入 `clock`,7 处 `Date.now()` 全换 `clock.now()`（含 v1.2.9 新增的两处）。
   生产行为零变化（两者等价）,风险集中在「有没有测试断言依赖了当前的真实时间戳」,
   动手前先全量扫一遍断言。
2. 补 autocheck 静态规则堵复发——这正是报告标题「唯一没有门禁的红线」的要害:
   约束写在 `SKILL.md:67`,却没有任何检查器拦得住。
3. WAL stamp 那两处（175/203）要单独判断:账本时间戳跟着冻结走是否合适,
   与「审计必须反映真实墙钟」可能有张力,别一刀切。

### 附:这篇为什么积压了 5 天

**没有被 triage 过,是漏的**——它搭着 `57896ef`（v1.2.4,正事是修 npm ci 锁文件）进的仓库,
那个 commit 的 message 一个字没提它;之后 8-26 转 steward、8-27~29 转论文,再没人回看。
`docs/feedback/` 的积压队列**没有任何机制会主动捞出来**（会话开头的 hook 只推 overview 的
捕获队列）。同批积压的还有 8 篇,最老的 8-16。

---

## 部分落地（v1.2.13，2026-09-04）—— **建议 2 已做，建议 1 仍未做**

触发者不是这篇本身，是 steward 的一个新问题：「实体里的时间字段存的是时间串不是时间戳，
autocheck 检测不出还是漏掉了？」——问的是**存储形态**，而本篇讲的是**时间源**。
两条独立的病，共用本篇 §三点出的那一个缺口：`SKILL.md` 的红线里，时间那一块没有执行面。

📎 姊妹篇：[`time-field-shape-no-single-source.md`](./time-field-shape-no-single-source.md)
（steward，同日）。那篇给出了「形态」这条线的代价实测——**一个仓库 7 处线上静默 bug**，
并促成了本版**读侧**判据（`Date.parse()` 打在数值时刻字段上）；本篇则是「时间源」那条线。
两篇的建议 2/3 由 v1.2.13 一并结案，两篇各自的建议 1 / 建议 4 都仍未做。

### 做了什么

1. **补上本篇「建议 2」的检查器**：`api/autocheck/static/clock-check.js`，已注册进
   `static/index.js` 与 `checker.js`，随 `api/autocheck/` 整目录下发给所有消费项目。
   同时给 `SKILL.md` 的两条时间红线都标上 `(autocheck clock-check)`——本篇 §三说的
   「这份清单里唯一没有 autocheck 标注的一条」，从此不再是。
   ⚠️ 检查器覆盖的是**时间字段**上的裸 `Date.now()`（WARN 级），**不覆盖** `entity.js` 自己——
   `api/library/` 不在 per-service 循环里（CI 只对它跑 `--lib` 的 redis 子集）。
   本篇 §二那 7 处仍然一个都没有门禁看着。
2. **`clock.js` 导出 `toMs()` / 新增 `toMsOr(v, fallback)`**，`entity.js:toSortableMs()` 委托过去。
   这回应的是 §四「三套时间表示并存」的**读侧**代价：那段兜底此前被独立写了两遍
   （`entity.js` 一次、steward `hive/logic/node.js:lastSeenMs()` 一次），没有共同原语，
   踩过的坑不会传播。顺带补掉 `toSortableMs` 的两个原有窟窿（`NaN` 输入原样返回、
   `Date` 对象落 0）。
3. **`entities.js` 字段新增可选 `format: 'iso' | 'epoch-ms'`**（缺省 = epoch ms）。
   这是对 §五「建议 3」的**机制性**回应，不是存量收敛：`type:'datetime'` 只是 Portal 的渲染
   提示，从来没说过存什么；`format` 把「存什么」单独说清。已给 `apps/storage.asset.createdAt`
   与 `core/user.user.last` 标注——**形态一个字没改，只是把既有契约声明出来**。

### 明确**没**做的（边界，别误判）

- **建议 1（`entity.js` 引入 clock，7 处 `Date.now()` → `clock.now()`）原样保留未做。**
  2026-08-30 triage 的暂缓理由（v1.2.9 刚重写 `createMany`/`deleteMany` + WAL 落盘面，
  不该把两件不相关的风险叠进同一个未发布版本）在 v1.2.13 依然成立。
  ⚠️ v1.2.13 给 `entity.js` 加了一行 `require('./clock')`——**那是读侧归一（`toMsOr`），
  不是写侧时间源**。文件里已就地留注说明这一点，别看见这个 require 就以为建议 1 做完了。
- **建议 3 的存量收敛（core/user · core/administrator · apps/storage 的 ISO 字段改 epoch ms）没做。**
  本轮查清了为什么它比本篇原文估的贵：这些字段**在 introspection 字段表里被显式声明成
  `type:'string'` 并注了 `// ISO string`**（`core/user/handlers/introspection.js:45,84,96,108`、
  `apps/storage/handlers/introspection.js:18,42`），`core/administrator/GUIDE.md:42` 也明写
  「时间字段都是 ISO-8601 字符串」。那不是漂移，是**已发布的 RPC 契约**——改它要动
  introspection 类型、GUIDE、以及每个既有部署里的存量数据，远超 patch 的量级。
  ⇒ 建议把本篇 §五建议 3 的措辞从「可选，低优先」改判为「**需要单独一版 + 迁移脚本**」。
- **本轮实测校正一处数字**：§四说 ISO 只有 4 处，实际在 CI 扫描面内有 ~14 处
  （core/user 9 · core/administrator 4 · apps/storage 2，另有 router/report 3 处不在 per-service 循环里）。

### 剩余待办（下一轮接手时看这里）

- [ ] 建议 1：`entity.js` 7 处 `Date.now()` → `clock.now()`（含 v1.2.9 新增的 399/591）。
      动手前先全量扫断言，见上一节「处理时该做什么」。
- [ ] `library/` 的时间源没有门禁：`--lib` 模式只跑 redis 子集，考虑把 `clock-check` 的
      时间源那一档也纳入 `--lib`（做了这条，建议 1 才有防复发的闸）。
- [ ] 建议 3 存量收敛：单独一版 + 数据迁移，先定 introspection 契约怎么变。
