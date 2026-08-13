# sample 服务任务配方（模板）

> 这是 GUIDE.md 的模板。新服务从 sample 复制后，把本文改写成你的服务的**任务配方**。
> 它会经 fleet-standard `guide` 方法下发（外部经 Router：`system.guide { service: "<name>" }`），
> 与服务代码同目录、同一次 commit 更新——**改了代码里的流程/约定，同 commit 改这里**。
>
> 写什么（introspection 说不出的那层）：
> - **任务配方**：跨方法的操作顺序（"先 A 拿 id，再 B 挂上"）、幂等键、失败重跑策略
> - **约定与限制**：字段语义、保留字、上限、建议的来源标记
> - **分页**：每个 `*.list` 方法都要交代——**无界集合怎么翻页、有界集合明说不分页**（见下面 §分页，
>   这一节不是可选的：省掉它，调用方拿到默认 50 条会当成全集）
> - **坑**：调用方第一次接入最容易踩错的地方
>
> 不写什么：方法签名、参数类型、必填性——那些在 `methods` 自省里机读，写这儿必过时。

## 这是什么

（一句话：本服务管什么、核心实体是什么。）

## 配方一：<最常见的外部任务>

1. `sample.item.create { ... }` — （步骤与语义说明）
2. （下一步…）

**幂等性**：（重跑安全吗？幂等键是什么？）

## 分页

**`sample.item`（无界，会随使用无限增长）→ 必须翻页取。** 两种模式，按用途选：

| 模式 | 怎么调 | 返回 | 成本 |
|------|--------|------|------|
| offset（默认） | `{ limit, offset }`，**不带 `cursor` 键** | `{ items, total }` | O(集合全量)——每次都要把整个索引拉进内存排序再切片 |
| cursor（推荐） | 首页 `{ limit, cursor: null }`，之后把上一页的 `nextCursor` 传回 | `{ items, nextCursor }` | O(limit)——只读一个 ZRANGE 窗口 |

```jsonc
// 首页
{"method": "sample.item.list", "params": {"limit": 50, "cursor": null}}
// → { items: [...], nextCursor: "1734" }
// 下一页：把 nextCursor 原样传回
{"method": "sample.item.list", "params": {"limit": 50, "cursor": "1734"}}
// → { items: [...], nextCursor: null }   ← null 表示到底了，停
```

四个坑，按踩到的概率排：

1. **不传 `limit` 也会分页**——`entity.list()` 默认 `limit = 50`。拿到 50 条不等于只有 50 条，
   对着 `total` 核一眼，或直接用 cursor 模式翻到 `nextCursor === null` 为止。
2. **cursor 模式没有 `total`**。keyset 分页不知道"共几页"，除非另外维护计数器（那是每次写入
   都要付的代价）。要"第 X / Y 页"就用 offset 模式并接受它的成本，要"加载更多"就用 cursor。
3. **cursor 模式下一页可能少于 `limit` 条**。`status`/`filter`/`keyword` 是在取回窗口**之后**
   才过滤的，一窗里大部分不匹配时这页就短。**短页不等于到底了**——只有 `nextCursor === null`
   才是结束信号。游标始终越过所有已考察的 id，不会漏也不会卡住。
4. **老数据要先迁移一次**。cursor 模式靠 `create()` 维护的排序 ZSET，比它更早写入的实体不在
   里面。没迁完就调会**直接抛 `INVALID_PARAMS`**（有意为之：静默退回慢路径的话，"cursor 到底
   快不快"就没人说得清了）。跑一次维护脚本调 `entity.migrateCursorIndex()` 即可，幂等、可重跑。
   全新服务不需要——从第一条数据起 ZSET 就是齐的。

**`sample.category`（有界）→ 不分页，`sample.category.list` 一次返回裸数组。** 一个服务的分类
是设计期就定死的有限集合，翻页只是噪音。有界集合也要在这里写明这一句——不写的话，调用方无法
区分"这里不需要分页"和"作者忘了分页"。

## 坑与约定

- （调用方需要知道、但机读面上没有的事实。）
- **别为了绕开分页去扫 keyspace。** 服务内部实现 list 时，`redis.keys('PREFIX:*')` 会阻塞
  整个 Redis 遍历全库，`sMembers` 会把整个索引拉进 V8——两者都是"数据少时看不出、上线三个月
  后突然拖垮全栈"的写法。正确做法是让 `library/entity.js` 的 Entity Factory 替你维护索引，
  或自己维护 SET/ZSET 索引；`KEYS` 只在 boot 期一次性重建索引时可用，且必须在那行写明理由。
  （autocheck 的 `pagination-safety` 规则会拦，别用 `// SAFE:` 敷衍过去。）
- 本服务满足不了你的任务时，把缺口提到 `system.report`（用法见 Router guide §6），
  不要静默放弃或绕野路子。
