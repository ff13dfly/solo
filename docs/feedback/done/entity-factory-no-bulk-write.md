# 反馈：Entity Factory 没有批量写入 API——每行 11 条 Redis 命令，导入型服务被逼到 Router 超时之外

> 来源：finance 会话，2026-08-30（bundle 已升 v1.2.8）。场景：insight 的导入链路改成
> 「服务端暂存 + 一次 commit 写完」之后，21000 行的导入在 Router 上游超时（10s）之外
> 才写完，实测服务端耗时 **22.0 秒**。追下去发现瓶颈不在解析、不在内存，在**逐行写入**。
>
> **依据分两类**：
> - **自查实测**（finance-dev，2026-08-30）：Redis `INFO commandstats` 前后差值、
>   同机对照基准、`api/library/entity.js` v1.2.8 源码逐行核对。数字都可复现。
> - **判断**：§三 的建议形态与优先级。
>
> 涉及：`api/library/entity.js` 的 `create()`；间接涉及 WAL archiver 的消费频率。

---

## 一、【实测】每写一行实体 = 11 条 Redis 命令，其中只有 1 条在写数据

5000 行导入（insight tbal），`INFO commandstats` 前后差：

| 命令 | 次数 | 每行 | 来自哪 |
|---|---|---|---|
| `set` | 10009 | 2.00 | ① id 占位（`SET key {} NX`）② MULTI 里的真实数据写 |
| `incr` | 5003 | 1.00 | 游标序号 `INDEX:CURSOR:SEQ` |
| `multi`/`exec` | 5001×2 | 2.00 | 每行一个事务 |
| `sadd` | 5001 | 1.00 | 主索引 |
| `zadd` | 5001 | 1.00 | 游标索引 |
| `xadd` | 5001 | 1.00 | WAL 流 |
| `xreadgroup`/`xautoclaim`/`xack` | 5001×3 | 3.00 | **WAL archiver 每行醒一次** |
| **合计** | **55085** | **11.0** | |

耗时拆分：**解析 352ms（6.1%）· 写入 5375ms（93.9%）**，写入速率 **930 行/秒**。
按此推算 21000 行 = 22.6s，与实测 22.0s 吻合。**解析不是瓶颈，逐行往返才是。**

## 二、【实测】同机对照：批量 pipeline 快 12.9 倍，且这只是下限

同一台机、同一个 Redis、同样 5000 行、同样的键结构（data + 主索引 + 游标索引）：

| 写法 | 耗时 | 速率 | 21000 行推算 |
|---|---|---|---|
| 逐行三次往返（与工厂同构，**不含 WAL**） | 1191 ms | 4198 行/秒 | 5.0 s |
| 每 500 行一个 MULTI（pipeline） | **92 ms** | **54348 行/秒** | **0.4 s** |

两点值得注意：

- **12.9x 只是同结构对照**。工厂实际 930 行/秒，比「逐行同构」基准还慢 4.5 倍——
  差额来自 WAL（4 条/行）与各层封装。所以真实可得的提速比 12.9x 更大。
- **批量版本的键结构完全一样**，不是靠偷工减料换来的：同样写 data key、同样维护
  `INDEX` 与 `INDEX:CURSOR`，只是把 N 行合并进一次往返。

## 三、【建议】给 Entity Factory 一个批量写入 API

工厂当前暴露：`create / save / get / update / delete / restore / status / list /
multiGet / migrateCursorIndex / purgeable / destroy` —— **读侧有 `multiGet`，写侧没有对位物**。
导入型服务（余额表、流水、对账单，天然按千行到万行来）只能 `for … await create()`。

1. **`createMany(rows, { chunkSize = 500 })`**（最高优先）：一次 MULTI 写一批
   （data + `sAdd` + `zAdd`），`INCR` 序号改成一次 `INCRBY n` 预分配，id 生成在内存里做、
   靠 MULTI 的原子性替代逐行 `SET NX` 占位。返回与逐行 `create` 同形状的数组。
   收益按上表是**一到两个数量级**；对 finance 而言，21000 行会从「超出 Router 上游超时」
   变成「几百毫秒返回」，整个异步/轮询的补丁都不必存在。
2. **WAL 批量入流**：`xadd` 每行一条可以保留（审计要逐条），但 archiver 的
   `xreadgroup`/`xautoclaim`/`xack` **每行醒一次**（实测 3 条/行，占总命令量 27%）。
   批量写入时让 archiver 按批消费即可，无需改审计语义。
3. **`deleteMany(ids)`**：整批替换语义的实体（导入型普遍如此）删旧行同样是逐行往返，
   与 ① 是同一个问题的另一半。finance 的 `tbal.import` 重导 21000 行时，
   删 21000 + 写 21000，两头都吃满。

## 四、【背景】为什么这个缺口现在才痛

v1.1.13 的游标分页解决了**读**侧的规模问题（见
[`entity-list-fetch-all-semantics.md`](./entity-list-fetch-all-semantics.md) 那篇的落地），
写侧一直没有对位改造。在「几十几百行」的实体上逐行 create 完全合理；
一旦有导入型实体（会计/流水/对账），行数是按月成千上万地来的，逐行往返就成了
**结构性天花板**，且它撞上的第一堵墙不是内存、不是 Redis，而是
**Router 的 `ROUTER_FORWARD_TIMEOUT_MS`（默认 10s）**——症状还极具误导性：
超时那刻服务端并没有停，它会把数据写完，于是调用方收到 `-32099` 却其实成功了
（finance 侧已用「作业记录 + 状态查询」兜住，但那是补丁，不是解法）。

## 处理结论（2026-08-30，v1.2.9）

**建议 1、3 落地；建议 2 核实后划掉（已实现，且随 1 自动解决）。** 报告的实测数字与引用
逐条对得上源码，是一篇精确的报告。

### 核实结果

- **11 条命令/行 ✅ 逐条属实**（`entity.js` create()）：`SET key {} NX` 占位 → `INCR` 序号 →
  `MULTI(SET 数据 / SADD 主索引 / ZADD 游标索引 / XADD WAL)EXEC` = 工厂侧 8 条、**3 次往返**，
  加 archiver 3 条正好 11。「只有 1 条在写数据」也对（另一条 `SET` 是占位）。报告把基准建模成
  「逐行三次往返」是诚实的，没有拿失真的对照放大差距。
- **写侧无批量 API ✅ 属实**：写方法只有 create/save/update/delete/restore/status/destroy，
  全是单行；读侧的 `multiGet` 没有对位物。
- **性能主张 ✅ 独立复现**（本机 5000 行同结构对照）：工厂逐行 2,729 行/秒、批量 MULTI
  119,048 行/秒 = **43.6x**。绝对值比 finance-dev 快约 3 倍（机器差异 + 我未跑 archiver
  消费），但「一到两个数量级」的结论在两台机器上都成立。
- **Router 超时 ✅ 属实**：默认 `ROUTER_FORWARD_TIMEOUT_MS = 10s`
  （`api/router/handlers/forward.js:11`，仅 agent 90s / gateway 60s 例外），`-32099` 确是
  router 独占的 `UPSTREAM_ERROR`（`jsonrpc.js:85`）。
- **🔴「超时但其实写成功」✅ 属实且机制已定位**：`forward.js:83` 的 `axios.post` 只设了
  `timeout`、**没有 AbortController/signal** ⇒ 超时只是 router 这端不等了，下游 Express
  handler 不会被取消、会把数据写完。调用方收到失败、数据却是全的——这是「假失败」，
  比静默失败少见但同样危险。

### 🔴 建议 2 需要纠正：archiver 本来就是批量消费的

`walarchiver.js` 的 `drainOnce` 用 `COUNT: batchSize`（默认 **100**）读，整批只发**一次**
`xAck`（`:89, :98-99, :108`）。实测到的「每行 3 条命令」是**慢生产者的产物**，不是 archiver
的结构缺陷——930 行/秒逐行写时，archiver 每轮醒来只捞得到 ~1 条。写入变批量后它自然一轮捞
100 条，**那 27% 的开销会自己塌掉，不需要动 archiver 一行代码**。本轮实测佐证：
200k 行 createMany 全程 archiver 未成为瓶颈。

### 落地（`api/library/entity.js`）

1. **`createMany(rows, { chunkSize = 500 })`**（建议 1）：一个 chunk 一次 MULTI，
   **键结构与 create() 完全相同**（data key + 主索引 SET + 游标 ZSET + 每行一条 WAL）。
   两处关键设计：① 序号用**一次 `INCRBY n`** 预分配（取代每行一次 `INCR`），分配区间连续
   且严格递增——这正是游标 ZSET 唯一依赖的性质；② **唯一性按 chunk 证明而非按行**
   （`assignBulkIds`：内存生成 → 去重 → 一次 pipelined `EXISTS` 探测 → 只重生成撞上的），
   保持了 `SET NX` 的同等保证，往返从 N 次降到 1 次。client-supplied id（`clientId` opt-in）
   照旧支持，重复/已存在均如实抛错。
2. **`deleteMany(ids, { chunkSize = 500 })`**（建议 3）：重导的另一半。缺失/非本会话所有的
   行**跳过并计数、不抛错**（批量删除必须可重跑；对 owner-scoped 会话，「不是你的」与
   「不存在」给同一个答案，不泄露存在性）。软删实体走标记 DELETED，**不带 update() 的 CAS
   重试**——批量语义下是 last-write-wins，已在 JSDoc 写明。
3. **顺带修 `destroy()` 的游标索引泄漏**（核实时发现，非报告所指）：它 `sRem` 主索引却从不
   `zRem` 游标索引，被 purge 的 id 永久留在 ZSET 里。读侧不会错（孤儿取到 null 被过滤掉），
   但 ZSET 无界增长、且每页游标窗口都被已消失的 id 占掉一部分。已补 `zRem`，加回归测试。

### 20 万行 e2e 评测（`api/bench/entity-bulk-write.bench.js`）

新增独立评测脚本，跑**真 Redis + 真工厂**的完整导入生命周期（写 → 读回 → 重导 → 校验 →
清理）。本机实测（N=200,000，chunk=500，redis-stack :6399）：

| 阶段 | 耗时 | 速率 |
|---|---|---|
| （对照）逐行 create()，3000 行抽样外推 | **75.0s** | 2,642 行/秒 |
| `createMany()` 200k | **4.41s** | 45,968 行/秒 |
| `listAll()` 读回 200k | **478ms** | 417,327 行/秒 |
| `deleteMany()` 200k | **3.22s** | 62,133 行/秒 |
| **重导一整轮（删 200k + 写 200k）** | **7.46s** | — |

结构校验全绿：返回条数、id 唯一性、主索引 SET、游标 ZSET 四项均 = 200,000，抽样行内容正确；
重导后两个索引仍精确等于 200,000（无残留、无重复）。

**对 Router 10s 预算的意义**：重导一整轮 7.46s **落在预算内**（余量 2.54s），单向写入
可处理约 45 万行；而逐行 create 外推 75s = **超时 7.5 倍**。报告的 21000 行场景从
「超时之外」变成「亚秒级」。⚠️ 但注意：`createMany` 只是把撞墙的行数区间推远了，
**「router 超时不取消下游」这个假失败机制本身仍在**，已记 BACKLOG。

### 验证

- 新增 hermetic 用例 17 条（`library/tests/entity-bulk-write.test.js`，已进 CI 白名单）：
  键结构等价、跨 chunk id 唯一、游标顺序、listAll 往返一致、与 create() 输出同形状、
  client id 冲突、WAL 每行一条、行隔离盖章/跨 owner 跳过、软删可恢复、重跑幂等、
  destroy 游标索引回归。
- **白名单全绿：131 套 / 2130 例**（5 skipped），临时 redis-stack :6399，跑完即关。
  ⚠️ 过程中踩到一个值得记的坑：WAL 断言最初写成 `xLen` 前后差值，**单跑绿、全量跑红**——
  `WAL:STREAM` 是 MAXLEN ~10000 的环形缓冲，全量跑完已饱和（实测 10012），差值恒为 0。
  改成校验流**尾部内容**（op + key 前缀），对裁剪免疫。
- 版本 1.2.8 → **1.2.9**，两个 lock 均按 §6.1 隔离 `npm ci` 复验（309 / 521 包干净装入）。
- **未验证**：finance 侧接入后的真实收益——需 finance 升 bundle 后自测；本轮只在框架侧
  用等价数据形状（科目/期间/借贷/摘要）评测。
