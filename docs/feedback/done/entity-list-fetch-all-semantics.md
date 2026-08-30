# 反馈：Entity Factory 的「取全量」缺一等语义——应用被迫用 magic number 顶替，截断永远静默

> 来源：finance 会话，2026-08-30。场景：insight 服务（bundle v1.1.14）的数据量上来后
> （本策客户科目余额 2,715 行/月），排查「财务数据增长带来什么隐藏问题」时把
> `list({ limit: config.maxList })` 这个模式量了个底朝天。
>
> **依据分两类，请按类采信**：
> - **自查实测**：dev 实例 Redis（finance-dev，6383）2026-08-30 现扫的键数与状态分布；
>   `api/publish/solo.v1.1.14.js` 与 `api/library/entity.js` 源码逐行核对；
>   finance 仓 `api/apps/insight/logic/listall.js` + `tests/import-pipeline.js`（34 断言全绿）
>   是本篇建议的**已运行验证**。
> - **判断**：§3 的建议排序。
>
> 涉及：`api/library/entity.js` list()/multiGet()/_listByCursor()、`soft-delete` 全队标准。

---

## 一、【实测现象】三件事叠在一起，形成「静默错账」的定时炸弹

1. **「取全量」没有一等语义。** `list()` 默认 `limit=50`，想要全部的调用方只能传一个
   「够大了吧」的数（insight 传 `maxList: 20000`）。`multiGet` 对过滤后的结果
   `slice(start, start+limit)`——超出的行**无声丢弃**（`total` 诚实，但 `allOf` 类调用方
   只拿 `items`）。按本策的量，第 8 个月起报表 YTD 开始悄悄少算，无任何报错。
2. **churn 型实体 + softDelete 全队标准 = 墓碑无界积累。** 「整批替换」语义的实体
   （科目余额/流水）每次重导都把整期间旧行软删。dev 实测：TBAL 21,819 个键里
   **19,071 个（87%）是 DELETED**，ENTRY 3,951 里 1,976（50%）。软删的行留在 INDEX 集合里，
   每次 `list()` 都要 `sMembers` + `mGet` 全部读出来再按 status 扔掉——渲染成本被死数据主导。
   对这类实体，回收站语义**什么都没买到**（恢复单行余额没有业务意义，恢复只会整期间重导）。
3. **过滤即全扫。** filter 在读全量之后跑（cursor 路径也一样，只是分页读）。报表要一个
   月的数据，也得翻完该实体的全部历史 + 全部帐套。有二级索引前这是结构性成本。

## 二、【实测现象】v1.1.13 的 cursor 路径能解 ①，但有两个采納摩擦

- `_listByCursor` 设计正确（有界 ZRANGE、cursor 永远前进、fail-loud 的迁移检查）。
  finance 已包一层 `listAll()`（cursor 循环到 `nextCursor` 耗尽）替换六个实体的全量读，实测可用。
- 摩擦 ①：**存量实体缺 ZSET 时直接 throw**，要求人肉跑一次 `migrateCursorIndex()`。
  fail-loud 的理由成立（见源码注释），但「每个部署环境都要记得跑一次迁移脚本、忘了就是
  全站报表 500」在多环境（dev/生产/未来新机）下是真实成本。finance 的 `listAll` 做了
  **就地自愈**：捕获那个特定错误 → `migrateCursorIndex()`（幂等）→ 重试，一次性付全扫成本。
  实测（含 hermetic 用例）可行，建议上收。
- 摩擦 ②：每个应用都要自己写这个循环 + 自愈。它应该是框架的一等 API。

## 三、【建议】按价值排序

1. **给 `list()` 一个显式的「全量」形态**（如 `listAll({filter})` 或 `limit: 'all'`）：
   内部走 cursor 分页 + 迁移自愈，返回无上限、峰值内存一页。让「20000」这类数字从应用层消失。
2. **给 offset 路径的截断加响亮开关**（如 `list({ limit, onTruncate: 'throw' })` 或至少在
   返回里带 `truncated: true`）：财务/报表类服务里「错的数字」比「崩溃」危害大一个量级，
   静默 slice 是最坏的默认。
3. **软删标准补一个出口：允许 churn 型实体声明硬删。** autocheck 的 soft-delete-check
   只查 logic↔entities.js 一致性（合理），但 solo-service 文档写的是「never hard-delete」。
   建议文档改为「默认软删；**整批替换语义**的实体（导入型、重导幂等靠整批覆盖）应显式声明
   `softDelete: false` 并在 entities.js 说明理由」。finance 已这么做（tbal/entry），
   34 断言含「重导后 INDEX 基数 = 活跃行数」。
4. **二级索引**（按声明的字段维护 `SERVICE:ENTITY:BY:<field>:<value>` 集合之类）：
   解 §一-3 的「过滤即全扫」。成本最高、收益依赖量级，排最后——但账面上它是唯一
   让「报表只读一个期间」成本与期间大小成正比的路。

## 处理结论（2026-08-30）

**四条建议：1/2/3 当日落地（只加不破，进 v1.x），4 记 v2。** 核实逐条对得上源码，
是一篇引用精确的报告。

### 核实结果（引用逐条对源码）

- **静默截断 ✅ 属实**：`list()` 默认 `limit=50`（`entity.js:460`），`multiGet` 用
  `filtered.slice(start, end)` 截断（`:546`），`total` 诚实而 `items` 无声少行（`:550`）。
- **墓碑积累 ✅ 机制属实**：软删行留在 INDEX，每次 list 全读后才按 status 丢弃（`:529-533`）。
  ⚠️ **Redis 数字（TBAL 87% DELETED）本轮未复核**——finance-dev 6383 未监听（本机已无常驻栈），
  按报告方自查实测采信。
- **过滤即全扫 ✅ 属实**：offset 路径 `sMembers` 全读（`:488`）+ mGet 全读后过滤；cursor 路径
  的 filter 也在有界读之后按页应用（`:567` 注释自陈）。
- **cursor 路径与两处摩擦 ✅ 属实**：v1.1.13 引入、缺 ZSET 时 fail-loud（`:583-588`）、
  `migrateCursorIndex` 幂等（`:626`）。finance `logic/listall.js` 实现与描述一致。

### 落地

1. **建议 1 —— `listAll()` 成为一等 API**（`entity.js`）：内部走 cursor 分页逐页取尽，
   结果无上限、峰值内存一页；**含就地迁移自愈**（捕获 "sorted index not migrated" →
   跑幂等的 `migrateCursorIndex()` → 重试），省掉「每个环境都要记得跑一次迁移、忘了就是
   全站 500」。自愈逻辑**上收自 finance 的 `insight/logic/listall.js`**，语义等价。
2. **建议 2 —— 截断响亮化**（`entity.js` multiGet）：返回新增 **`truncated`** 布尔
   （offset 路径任何非末页为 true），并支持 **`list({ onTruncate: 'throw' })`** 把截断升级为
   `INVALID_PARAMS` 报错，错误文案直接指向 `listAll()`。**只加不破**：新增字段，既有调用方
   读 `items`/`total` 行为零变化（白名单 130 套 2113 例全绿佐证）。
3. **顺带 —— `batchSize` 的隐藏语义写进契约**：设了 `batchSize` 时 `limit`/`offset`
   **被整个无视、返回全部匹配**（`:493-509` 的长期行为，此前一字未写）。这其实是框架已有的
   「半个全量形态」，但它仍是 sMembers 全扫，且「悄悄不分页」本身就是另一个坑 ⇒ JSDoc 写明
   并指向 `listAll()`，加一条测试钉住。
4. **建议 3 —— 软删标准补出口**（`deploy/scaffold/.claude/skills/solo-service/SKILL.md`）：
   改为「默认软删；**整批替换语义**的实体（导入型、重导幂等靠整批覆盖）应声明
   `softDelete: false` 并在 `entities.js` 写明理由」，并点出「软删 churn 数据会把墓碑永久
   堆进 INDEX，每次 list 都要为死数据付读取成本」。⚠️ 报告说的「全队标准」需校正：**工厂
   代码默认其实是 `softDelete = false`**（`entity.js:58`），"never hard-delete" 只存在于
   这份 skill 文档 ⇒ 建议 3 是纯文档修正，机制早就在。同处顺手修掉一个与实现不符的写法
   （文档写 `is_deleted`，真实机制是 `softDelete: true` → status `DELETED`）；并补一句
   「取全量用 `listAll()`，别写 `list({ limit: <大数> })`」。
5. **建议 4 —— 二级索引：不做，记 v2**（`BACKLOG.md §3`）。与报告的排序一致：成本最高、
   收益依赖量级；且 `listAll()` 落地后「取全量」这条最痛的路已经不再截断，剩下的是纯性能。

### 本轮扫出的两处「框架自己犯同款病」

- ✅ **已修 `api/library/search.js:14`**——它在 `@usage` 示例里**教**服务作者写
  `list({ limit: 9999 })`。教材级传播，改成 `listAll()` 并注明原因。
- ⏳ **未修 `api/core/orchestrator/logic/workflow.js:777`**：`build()`（给 agent 建
  workflow 快照）用 `list({ limit: 1000 })`，超出部分静默丢失 = AI 能力面悄悄缺项。
  **本轮刻意不动**：orchestrator 的 `list` 是手写实现（直接 `redis.json.get` + 自有索引，
  `:360`），**不走 Entity Factory**，`listAll()` 够不着它——属另一条同病代码路径，需要它自己的
  修法。已记 `BACKLOG.md §3`。当前 workflow 量远小于 1000，是潜伏风险不是现症。

### 验证

- **白名单全跑绿**：130 套 / 2113 例通过（5 skipped），临时 redis-stack :6399，跑完即关。
  新增 8 条用例（listAll 三条含自愈、truncated 三条、onTruncate throw、batchSize 契约）。
- `entity-coverage.test.js` 三处严格形状断言（`toEqual({items,total})`）已同步补 `truncated`。
- autocheck static 绿（sample / collection，警告均为既有项）。
- **未验证**：finance 侧升级后能否删掉自己的 `listall.js` 包装——需 finance 升 bundle 后自测。
