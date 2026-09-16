# 反馈：中文全文检索两条路都堵着 —— 示例那条静默截断，正确那条 `indexer.js` 拼不出来

> 来源：bence 派生项目，2026-09-15。起因是给本策（全渠道家居电商，5 万 SKU 量级）
> 设计商品主数据服务，`landing-plan.md:64` 有一条可证伪的验收判据——「5 万 SKU 导入后
> 按名称 / 编码 / 属性查询 < 1s（RediSearch）」。为了核这条判据能不能达成，拿客户当天
> 给的两份真实 ERP 导出建索引实测，撞到这条。
> 依据：**全部自测实测**，redis-stack-server 7.4.0-v8（search 21020 / ReJSON 20809），
> 数据是聚水潭商品资料导出的真实商品名 **73,820 条**，本机临时实例（用完即焚）。
> 根因行号为 solo 仓 HEAD **v1.2.14** 源码。无二手引用。
> 涉及：`api/library/indexer.js`（建索引的唯一入口）、`api/sample/config.js:128-141`
> （框架给出的唯一索引示例）、`deploy/scaffold/docs/authoring/service.md`（未覆盖该场景）。
>
> 一句话：对中文数据，**默认 `TEXT` 分词直接返回 0 条**；框架示例的 `TAG WITHSUFFIXTRIE`
> 在小样本上 100% 正确、上了量**静默只返回 9.7%**；而唯一正确的 `LANGUAGE chinese`，
> `indexer.js` 硬编码的命令拼装**没有它的位置**。

---

## 一、实测：同一个词，三种 schema，三种结果

73,820 条真实商品名。真值取自原始 JSON 的 `grep -c`（商品名字段含该词的记录数）。

| 查询词 | 真值 | 默认 `TEXT`<br>`@name:词` | 示例的 `TAG WITHSUFFIXTRIE`<br>`@name:{*词*}` | `LANGUAGE chinese` + `TEXT`<br>`@name:词` |
|---|---:|---:|---:|---:|
| 收纳 | 5,821 | **0** | **563**（9.7%） | 5,804（99.7%） |
| 不锈钢 | 2,226 | **1** | **435**（19.5%） | 2,184（98.1%） |
| 热水袋 | 98 | 4 | 98（100%） | 98（100%） |
| 丝巾 | 5 | 0 | — | 6 |

三件事同时成立，而且**没有一个会报错**：

1. **默认 `TEXT` 对中文等于没建索引**。RediSearch 默认分词器按空格与标点切词，
   中文商品名整串是一个 token，搜任何子串都是 0。
2. **框架示例那条会「部分正确」**——这是三者里最危险的一个，见 §二。
3. `LANGUAGE chinese` 才是对的（差的 1–2% 是分词边界，如「收纳」与「收纳盒」被切成
   不同的词），而它**建不出来**，见 §三。

## 二、示例那条的根因：`MAXPREFIXEXPANSIONS` 默认 200，且 `ensureAll` 没解它

`api/sample/config.js:128-141` 是框架给出的**唯一**索引示例，`$.name` 用的正是：

```js
'$.name',      'AS', 'name',       'TAG', 'WITHSUFFIXTRIE',
```

对 CJK 这其实是**被迫的合理选择**——默认 TEXT 既然返回 0，作者只剩 TAG 中缀通配这一条。
但 `@name:{*收纳*}` 是通配查询，受 `MAXPREFIXEXPANSIONS` 限制，**默认 200**：

| `MAXPREFIXEXPANSIONS` | 「收纳」命中 | 「不锈钢」命中 |
|---|---:|---:|
| 200（默认） | 563 | 435 |
| 5000 | **5,821** ✅ | **2,226** ✅ |
| 200000 | 5,821 | 2,226 |

而 `indexer.js` 的 `ensureAll()` / `rebuild()` **只解了另外一半**：

- `indexer.js:138`、`indexer.js:152`：`FT.CONFIG SET MAXSEARCHRESULTS -1`
- **没有** `MAXPREFIXEXPANSIONS`

两个参数管的是不同的墙：`MAXSEARCHRESULTS` 管「结果能返回多少条」（框架解了），
`MAXPREFIXEXPANSIONS` 管「通配符能展开多少个词」（框架没解）。示例推荐的恰恰是
唯一依赖后者的查询形态。

🔴 **为什么这条特别阴**：截断量与「有多少个不同的词命中通配」成正比，所以
**词越冷门越正确**。上表「热水袋」（98 条）100% 正确、「收纳」（5,821 条）只有 9.7%
——开发期拿几百条样本测，每个词都是满分；上量之后高频词开始静默丢，而高频词
恰恰是运营最常搜的那些。示例注释写的是「uncomment when your entity reaches
**1000+ records**」（`api/sample/config.js:129`），也就是说，**它被建议启用的时刻，
正是它开始出错的时刻**。

我自己就先踩了一遍：300 条小样本上 TAG 方案 300/300 全中，据此差点下了「可行」的结论，
回到 73,820 条全量才发现是 563/5,821。

## 三、正确那条建不出来：`FT.CREATE` 的拼装里没有 `LANGUAGE` 的位置

`indexer.js:68-80`（`createIfMissing`）与 `:89-105`（`buildIndex`）是**仅有的两处**
建索引代码，命令写死：

```js
await redis.sendCommand([
    'FT.CREATE', def.name,
    'ON', 'JSON',
    'PREFIX', '1', def.prefix,
    'SCHEMA',
    ...def.schema,
]);
```

RediSearch 的语法要求 `LANGUAGE` **在 `SCHEMA` 关键字之前**，而调用方唯一能注入的
`def.schema` 整个展开在 `SCHEMA` **之后** ⇒ 无论怎么写 schema 数组都拼不出
`LANGUAGE chinese`。改 `SYSTEM:INDEX_SCHEMA:{service}`（`indexer.js:20`）也没用，
`loadSchemas` 只换 `{name, prefix, schema}` 三个字段的值，拼装顺序是写死的。

⇒ 中文项目要么绕过 `indexer.js` 自己 `sendCommand` 建索引（那就放弃了
`api/library/README.md` 说的 "single source of truth for index schemas"，
`rebuild` / `schemas` 两个 RPC 也一并失效），要么接受 §二 那个静默截断。

## 四、为什么至今没人撞到

现扫（v1.2.14 工作树）：

- `createIndexer` 全框架**只有 `api/sample/index.js:15,64,66` 接过线**，而 sample 自己的
  `indexes` 块整段是注释（`config.js:128-141`），实际值 `{}`。
- 其余服务全是 `indexes: {}`：`api/core/{ingress,notification,mcp,nexus}/config.js`、
  `api/apps/{collection,market}/config.js`。
- 派生项目里同样是空的：wavely `erp/api/apps/catalog/config.js:178` `indexes: {}`
  （它是 POD 印品，几百个 SKU，`entity.list` + 内存过滤就够）。
- 框架自己记着这笔账：`api/apps/storage/logic/asset.js:296-298`
  「A real fix needs RediSearch (`api/library/indexer.js` already exists,
  **wired only into `api/sample/` so far**) — intentionally deferred」。

⇒ **生产用例数 = 0**。这条路没人走过，所以中文这两个坑一直没现形。bence 是第一个
必须走它的项目：5 万 SKU 商品名全中文，且「按名称查询」是写进验收判据的。

## 五、建议（按价值排序）

1. **`ensureAll()` / `rebuild()` 补一行 `FT.CONFIG SET MAXPREFIXEXPANSIONS`**
   （`indexer.js:138`、`:152` 紧挨着现有那行）。既然框架已经决定替使用者解
   `MAXSEARCHRESULTS`，就该把同一类墙一次解完——只解一半比两个都不解更坏，
   因为使用者会以为这类事框架管了。值给个可配的大数（如 `-1` 或 10000），
   别让默认 200 成为静默上限。
2. **`FT.CREATE` 拼装开一个 `LANGUAGE` 口子**：在 def 里加可选字段
   `language`，`['FT.CREATE', name, 'ON','JSON','PREFIX','1',prefix,
   ...(def.language ? ['LANGUAGE', def.language] : []), 'SCHEMA', ...schema]`。
   向后兼容（不传就是现在的行为），改动两处各一行。
3. **`api/sample/config.js` 的示例补一条中文注释**：说明 `TAG WITHSUFFIXTRIE`
   的中缀通配受 `MAXPREFIXEXPANSIONS` 约束、CJK 文本字段应当走
   `LANGUAGE chinese` + `TEXT`。示例是教材，它现在把所有人引向那条会静默截断的路。
4. **`service.md` 加一节「中文数据建索引」**：现在通篇没有 CJK 相关内容，而
   Solo 的使用者基本都在做中文业务。最小内容就是上面那张三行对照表。

## 处理结论

### 复核（2026-09-16）

四条结论全部复现，用的是**另一批数据**（5,860 条合成中文商品名，redis-stack 7.4.0-v8 /
search 21020 —— 与本文同版本），机制与数字方向一致：

| 词 | 真值 | ①默认 TEXT | ②TAG 中缀 | ③LANGUAGE chinese |
|---|---:|---:|---:|---:|
| 收纳 | 2,000 | 0 | **200 (10.0%)** | 2,000 (100%) |
| 不锈钢 | 1,307 | 0 | **188 (14.4%)** | 862 (66.0%) |
| 热水袋 | 60 | 0 | 60 (100%) | 56 (93.3%) |

§二那条「**词越冷门越正确**」复现得干净：低于 200 上限的冷门词满分，高频词只回 10%。
`MAXPREFIXEXPANSIONS` 调到 10000 后 ② 恢复 2,000/2,000。

**三处需要更正本文：**

1. 🔴 **建议 1 里的 `-1` 不是合法取值**。实测 `FT.CONFIG SET MAXPREFIXEXPANSIONS -1` →
   `Value is outside acceptable bounds`，`0` 同样被拒，下界是 **1**。
   —— `MAXSEARCHRESULTS` 那套 `-1 = 无限` 的约定**在这个参数上不成立**
   （顺带：`MAXSEARCHRESULTS -1` 回读是字符串 `"unlimited"`，不是 `-1`）。
   所以取了一个大数 **200000** 做默认，并允许 env 覆盖。
2. **§三说 `loadSchemas` 只换 `{name, prefix, schema}` 三个字段的值** —— 实际它是
   `{ ...localDefs, ...remote }` 的**整对象 per-entity 覆盖**（`indexer.js:37`），
   所以新增的 `language` 字段天然能经 Redis 覆盖带过去，`loadSchemas` 一行都不用改。
   这让建议 2 比本文估计的还小。
3. **`LANGUAGE chinese` 的损耗比本文说的「1–2%」大得多**：合成数据里「不锈钢」只有 66%，
   因为"不锈钢锅"被切成一个词，而查询词「不锈钢」是它的**前缀**、不是同一个 token。
   本文的 1–2% 大概是真实商品名里该词多以独立词出现。⇒ **不能把 `LANGUAGE chinese`
   宣传成「中文就该这么建」而不提它的边界**：要精确子串仍然要 TAG 那条。
   已按这个口径写进文档与示例（两条可并存，各查各的）。

### 落地（v1.2.15）

- ✅ **建议 1：`MAXPREFIXEXPANSIONS` 一并解掉**。`indexer.js` 把两条 `FT.CONFIG` 收进
  `applyGlobalLimits()`，`ensureAll()` / `rebuild()` 各调一次（原先两处各写一行
  `MAXSEARCHRESULTS`）。默认 200000，`REDISEARCH_MAXPREFIXEXPANSIONS` 可覆盖；
  取值 `< 1` 时**响亮退回默认**（console.warn），不把非法值发给 RediSearch。
  本文那句「只解一半比两个都不解更坏」照抄进了常量注释——判据留在代码里才不会再漂。
- ✅ **建议 2：`FT.CREATE` 开 `LANGUAGE` 口子**。抽出 `buildCreateCommand(def)`，
  `LANGUAGE` 落在 `SCHEMA` **之前**；`def.language` 不传时 argv 与改动前**逐字节一致**
  （有断言钉住）。`createIfMissing` / `buildIndex` 两处都走它——本文指出的「仅有的两处」。
  ⚠️ 顺带把一个**本文没提、但同族**的坑写进注释：`ensureAll()` 对已存在的索引直接跳过，
  所以改 `language` 后光重启没有任何效果，必须 `rebuild()`；症状同样是搜索结果静默不对。
- ✅ **建议 3：`api/sample/config.js` 示例补中文说明**，并新增一条被注释的 `cnItem`
  示例（TEXT + `language: 'chinese'`），把「查询写 `@name:收纳` 而不是 `{*收纳*}`」
  写在旁边。原来那条 TAG 示例保留——它不是错的，只是被推荐的场景要说清楚。
- ✅ **建议 4：`service.md` 新增 §6.7「中文数据建索引」**，三行对照表 + 三条坑
  （默认 TEXT 为 0 / TAG 静默截断且冷门词满分 / language 改了要 rebuild）。
  §7 自查加第 10 条。**另外补了本文没点到的一个声明面**：`deploy/scaffold/.claude/skills/solo-service/SKILL.md`
  ——下游 AI 写服务时读的是它，只改 service.md 的话那边仍然只说「走 Entity Factory + indexing」。
- ✅ **回归测试**：`library/tests/indexer.test.js` +10 例（LANGUAGE 位置、不传时逐字节兼容、
  ensureAll/rebuild/Redis 覆盖三条路径都透传、取值边界与非法值退回）。
  白名单 134 套 / 2262 例全绿。

### 一句值得单记的

本文的判据可以一般化：**「框架替你解了同族限制里的一个」本身就是一个陷阱**——
使用者会据此认为这一类事框架管了，于是另一个限制的静默截断比「两个都没解」更难被发现。
⇒ 凡是替使用者设了某个上限/开关，就要问一句「**同一族里还有没有别的**」，
要么一次解完，要么在文档里显式说明哪些没解。
与 `entity-factory-no-secondary-index-primitives.md` 的「每建一个辅助键，当场回答谁在什么时候删它」
是同一族判据：**都是"做了一半"比"没做"更危险**。

