# 反馈：事件总线 xAdd 无修剪 —— `eventMaxLen` 是死配置，且注释里的前提早已失效

> 来源：colony 派生项目，2026-08-16 部署事件总线阶段一（K 线闭合事件 1m/5m）后，
> 2026-08-18 首轮验收时定量核实。
> 依据：**流增长数字为 N100 线上实测**（31.2h 窗口，`XLEN` + `MEMORY USAGE`）；
> 根因引用为 solo 仓 HEAD 源码 + colony 所用 v1.1.15 bundle 双向核对，均自查。
> 涉及：`api/router/handlers/events.js`（事件写入）、`api/router/config.js`（死配置）、
> `api/core/nexus/logic/stream.js`（DLQ 流，同型）。
>
> 一句话：Router 的事件写入是裸 `xAdd`，永不修剪；`config.eventMaxLen: 10000`
> 全仓唯一引用就是它的定义处；而注释里「等 node-redis 确认后再启用 MAXLEN」的
> 前提早已失效——**同一个 client 在同一个 bundle 里（WAL）已经在用
> `TRIM MAXLEN ~` 且跑在生产上**。

---

## 一、实测：第一个真实高频源接上来之后的增长斜率

colony 把 OKX K 线闭合做成了总线事件（这正是事件总线设计里期望承接的那类
外部驱动源），2 个 symbol、1m + 5m 两档。N100 线上 31.2h 实测：

| 流 | 条数 | 节拍 | `MEMORY USAGE` | 每条均摊 |
|---|---|---|---|---|
| `EVENT:MARKET:CANDLE_1M` | 3748 | 2 条/分钟（精确，按首末条目跨度反算零缺口） | 886,288 B | ≈ 236 B |
| `EVENT:MARKET:CANDLE_5M` | 748 | 24 条/小时（精确） | 238,711 B | ≈ 319 B（含 BB 快照） |

⇒ 两流合计 **≈ 0.86 MB/天（仅 2 symbol）**，一年 ≈ 310 MB，线性随 symbol 数 /
流数增长，且**没有任何机制会让它停下**：无 TRIM、无 TTL、消费侧（nexus consumer）
只读不删。斜率是时钟驱动的确定值，观测窗口再拉长只会缩小误差、不会改变结论，
所以没有等满一周才来写。

单看这个数字不吓人——问题在于**方向**：总线的价值主张就是接真实驱动源
（colony 的 K 线只是第一个），接得越成功、这条曲线越陡，而现在每一个字节都是永久的。

## 二、根因：一个从没被接线的配置

1. **写入点裸 xAdd**：`api/router/handlers/events.js:231`
   `await redisClient.xAdd(stream, '*', envelope)`，无 TRIM 选项。
2. **`eventMaxLen` 是死配置**：`api/router/config.js:78` `eventMaxLen: 10000` ——
   全仓 grep（排除 publish 产物）**唯一命中就是定义处**，没有任何消费者。
3. **注释里的启用前提已经失效**：`config.js:76-77`（bundle v1.1.15 同文，24404-24405）
   写的是 *"placeholder; xAdd currently unbounded. Set to a positive number to enable
   MAXLEN trim once confirmed with node-redis version."*——两处都不成立：
   ① 它**已经是**正数（10000），照注释的说法应该已生效，实际没有；
   ② 「等 node-redis 确认」早已被同仓库自己确认：`api/library/entity.js:184`（WAL 流）
   用同一个 client 写着 `TRIM: { strategy: 'MAXLEN', strategyModifier: '~',
   threshold: WAL.MAXLEN }`，v1.1.15 bundle 里同样在跑（bundle:77665）。
4. **同型：nexus DLQ 流也是裸 xAdd**：`api/core/nexus/logic/stream.js:229`
   （`moveToDLQ`）。notification 与 orchestrator 的 DLQ **list** 都已经加了硬上限
   （`notification/logic/worker.js:8` 自己的注释就写着 *"no bound = unbounded poison
   accumulation"*），同一个 rationale 对这个 stream 版 DLQ 同样成立，但它漏了。

## 三、一个需要一并想清楚的语义问题：事件流正在被当第三本账用

colony 的 fulfillment 镜像验收就是拿 `XLEN EVENT:FULFILLMENT:TRANSITIONED` 的
**绝对总数**与账本开/平笔数对账的（三本账互核，2026-08-18 实测 11 = 探针 3 + 真实 8，
严丝合缝）。一旦开始 MAXLEN 修剪，这类「拿流当审计日志」的用法会静默失真——
对账必须改成按窗口对。这不是不修剪的理由，而是**修剪上线时必须写进文档/
CHANGELOG 的行为变更**，否则下游会把「被修剪掉了」误读成「事件丢了」，
和真正的丢事件故障（token 过期那类）混在一起没法排查。

## 四、建议（按价值排序）

1. **把 `eventMaxLen` 接进 `processEvents` 的 xAdd**：
   `TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: config.eventMaxLen }`。
   实现模式抄 `entity.js:184` 即可，client 能力已在生产验证。近似修剪（`~`）
   性能开销可忽略。
2. **给高频流留 per-stream 覆盖口**：全局 10000 对 `EVENT:ANT:*` 这类低频流很富余，
   对 1m K 线流只够 3.5 天（2 symbol）——不同流的合理保留窗口差两个数量级。
   最小做法是 env（`EVENT_MAXLEN_<STREAM>`）或 EVENT_REGISTRY 里挂可选字段
   （registry 本来就是 per-stream 粒度的配置面）。没有这个口子，全局值要么
   截断高频流的回看窗口、要么让低频流白占内存。
3. **`moveToDLQ` 的 stream 补上限**，对齐 notification/orchestrator 两个 DLQ list
   已有的做法（默认值也可以直接沿用它们的）。
4. **（文档）修剪语义写进 events.md**：明确「流是投递通道 + 有限回看窗口，
   不是审计账本」，需要长期审计的下游自己落库。配合第三节那个真实用例说明
   为什么这句话值得写。

---

## 处理结论（solo 侧）

2026-08-18 triage。四条事实指控经源码核实**全部属实**：`events.js:231` 裸 xAdd；
`eventMaxLen` 全仓唯一引用即定义处（死配置），且 `config.js:76-77` 注释两个前提都不成立
（值已是正数；node-redis TRIM 已被同仓 `entity.js:184` WAL 流生产验证）；`moveToDLQ`
是三个 DLQ 里唯一没封顶的（notification/orchestrator 的 list 版都有硬上限）。

- ⏸ **建议 1/2（Router 接线 TRIM + per-stream 覆盖）**：确认该做，但涉及 `api/router/`
  修改保护区，**用户明确决定本轮不动 router**，留待其审阅后另行授权。已定的实现取向
  （授权后照此做）：TRIM 模式抄 `entity.js:184`；per-stream 覆盖口选**单个 env 列表**
  （`EVENT_MAXLEN_OVERRIDES='EVENT:MARKET:CANDLE_1M=100000,…'`——流名原样写、不动
  registry 数据结构），不用逐流 env（流名字符改造有歧义）也不用 registry 挂字段（改动面大）。
- ✅ **建议 3（NEXUS:DLQ 封顶）**：`stream.js` `moveToDLQ` 的 xAdd 加
  `TRIM: MAXLEN ~`，上限 `NEXUS_DLQ_MAXLEN`（默认 1000），对齐 notification/orchestrator
  两家的做法与默认值。stream.test.js 新增 1 例（驱动 consumeOnce 过 maxDeliveries，
  断言停车 xAdd 携带 TRIM）。
- ✅ **建议 4（修剪语义文档）**：events.md 新增 §6.5「流的保留语义：投递通道，不是审计账本」
  ——契约（长期审计自己落库）、现状（Router 侧尚未修剪是待修缺口而非承诺 + DLQ 已封顶）、
  对账按窗口做 + 「被修剪 ≠ 丢事件」的排查区分；§7 自查清单加第 6 条。第三节的对账用例
  已按「修剪上线时的行为变更」记入该节。
