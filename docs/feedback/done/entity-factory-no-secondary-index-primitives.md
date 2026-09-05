# Entity Factory 只有 id 寻址：二级索引全靠各服务手写，于是踩过的坑不传播

- **来源**：steward，2026-08-31，从一个提问「派单的幂等槽会不会无限累积」查开
- **场景**：Entity Factory（`library/entity.js`）提供 id 寻址的 CRUD + 索引 + WAL，
  但服务普遍还需要三类**按业务键**的二级索引。它们不在 library 里，于是每个服务
  自己用裸 redis 键实现一遍。
- **依据分类**：以下**全部为本次实测**（steward 栈，bundle v1.2.3，代码统计 + hermetic
  单测复现 + N100 生产库 3102 个键的分布核对）。无引用他项目的二手结论。

## 一、这三类二级索引不是可选项

steward 三个服务（steward / scout / hive）共 30 处裸键，按用途分类后**没有一处是
「随手绕过 Entity Factory」**：

| 类别 | 数量 | 为什么 Entity Factory 顶不上 |
|---|---|---|
| 身份槽（按业务键 upsert） | 11 | `collector.save({platform, slug})` 这种 upsert 语义，用 id 表达不了；没有「按业务键 get-or-create」原语 |
| 幂等槽（按 requestId 去重） | 5 | 同上。至少是投递重试场景的刚需 |
| 枚举集合（替代全表扫） | 11 | 「这个平台有哪些 slug」若走 `entity.list` 就是全索引拉取再过滤——而 autocheck 的 `pagination-safety` **明令禁止**。这类集合是被规则要求的优化 |
| 版本环 ZSET / 消费器游标 / 短期票据 | 3 | 本就不是实体数据 |

所以这不是纪律问题，是**原语缺口**：规则一边禁止全表扫，一边不提供替代品，服务只能自建。

## 二、后果不是重复代码，是认知不传播

同一个仓库里，同类结构的处置**已经漂移**，而最能说明问题的证据出现在同一个文件内部：

**① 幂等槽的墓碑判定：5 处里只有 1 处做了**

`softDelete: true` 的实体删除后，`entity.get({id})` **仍然返回那条记录**（只是
`status: 'DELETED'`）。而所有手写幂等槽存的是 id，于是：

```
删一条工单 → 同 requestId 再 create
  → 命中槽 → get(knownId) → 返回 status=DELETED 的记录
  → 调用方拿到 state:"PENDING" 的对象，日志打印「创建成功」
  → 但它永远不会被下发（list/pending 只取 ACTIVE）
```

hermetic 复现（steward 仓 `api/apps/hive/tests/job.test.js`）。五处全中：
`hive/job` · `scout/capture` · `steward/action` · `steward/run` · `steward/page`。
各处后果不同，`scout/capture` 最重——插件拿到 `created:false` 当成功，清掉本地暂存，
而补传是它唯一的重试通道，**数据不可恢复地丢失**。

注意 `steward/run.js` 与 `steward/page.js` 都写了 `.catch(() => null)`：作者想到了
「记录可能没了」，但那只挡住**硬删**；软删的记录是**读得到**的，墓碑照样漏过去。
**`catch` 挡不住 softDelete**，这个细节要每个服务各自意识到一次。

**② 同一个文件里，认知都传不过去**

`steward/logic/page.js` 的版本环修剪里有这么一段，注释还记着踩坑日期：

```js
// 🔴 先把它的幂等槽清掉，再删记录——顺序不能反。
//    2026-08-26 迁移时实测踩到：3 条被挤掉的旧版本，重跑时全报 not found。
if (doomed && doomed.requestId) await redis.del(identityKey(doomed.requestId));
```

作者在这一处把辅助键的生命周期想透了。但这个认知既没传到另外四处幂等槽，也没覆盖到
**同一文件里**的 `routeSetKey`——12 个枚举集合中，11 个在 delete 时配了 `sRem`
（`collector` 甚至处理了「最后一个页型删掉 = 平台从名录退场」），只有 `page.routeSetKey`
漏了，只增不减。

**③ 生产数据佐证**：N100 库 3102 键，幂等槽与其记录恒为 1:1
（`SCOUT:CAPTURE:IDENT` 125 : `SCOUT:CAPTURE` 125，`STEWARD:RUN:IDENT` 26 : 26）。
说明这些槽的生命周期**本该**跟随记录——而现在没有任何机制保证这一点。

## 三、根因

`library/entity.js` 的 `softDelete` 只改记录的 `status` 字段，**不通知任何二级索引**；
而 library 又不提供二级索引原语，所以「谁在什么时候清它」这个问题，每个服务、每个键
都要重新回答一次。回答对了不会传播，回答错了要等线上出事才知道
（steward 这次是靠一次无关的键分布盘点才发现，五处已经带病运行数月）。

## 建议（按价值排序）

1. **Entity Factory 增加声明式的二级索引**，create/get/delete 自动维护，墓碑判定收在
   一处：
   ```js
   createEntity(redis, {
     identity: ['platform', 'slug'],        // 身份槽：自动 upsert 语义 + 删除时清槽
     idempotency: 'requestId',              // 幂等槽：命中墓碑自动当作没建过
     enumerate: { slugs: ['platform'] },    // 枚举集合：sAdd/sRem 配对，空集自动退场
   })
   ```
   价值最大：30 处手写归零，且「softDelete 之后 get 仍返回记录」这个陷阱只需在框架里
   处理一次。
2. **退一步：给 delete 一个同事务的 hook**（`onDelete(rec, redis)`），让服务把自己的
   二级索引清理挂进去。不解决重复实现，但至少让「删除时要清什么」有一个固定的落点，
   不再散落在各 logic 的 delete 方法里。
3. **再退一步：文档 + 门禁**。`docs/authoring/service.md` 明写「softDelete 之后
   `entity.get` 仍返回记录，任何存 id 的二级索引都必须自行判 `status !== 'DELETED'`」；
   autocheck 加一条静态规则——**`redis.sAdd`/`zAdd` 若在同文件找不到配对的
   `sRem`/`zRem`，报 WARN**。这条规则成本极低，本次 12:1 的漏配率一扫即得。
4. 顺带：`library/README.md` 的能力清单里明确「二级索引不在框架职责内」，好让服务作者
   知道这是自己的责任——目前它既不在框架里、也没说不在，作者只能各自摸索。

## 处理结论

**2026-08-31 triage（solo 会话）：主体属实，采纳建议 4 + 建议 3 的文档半边；
建议 3 的静态规则经实测推翻、不做；建议 1/2 不做，理由见下。两处依据需修正。**

### 一、核实：框架侧主张全部属实（可指行）

| 主张 | 核实 |
|---|---|
| Entity Factory 只有 id 寻址、无二级索引原语 | ✅ 15 个方法（create/createMany/save/get/update/delete/deleteMany/restore/status/list/listAll/multiGet/migrateCursorIndex/purgeable/destroy）全部按 id 或全索引寻址 |
| `softDelete` 后 `get` 仍返回记录 | ✅ `entity.js:512` `if (softDelete) return this.update({ id, status: STATUS_DELETED })`；`entity.js:446-452` 的 `get` 只判 `if (!data) throw NOT_FOUND`，不看 status |
| `softDelete` 不通知二级索引 | ✅ 删除走 `update`，全程无 hook |

**补一条原文没点破、但更精确的表述**：坑不在「`get` 返回墓碑」，而在**不对称**——
`entity.js:680` 的 `list` 默认 `status = STATUS_ACTIVE` 会过滤，`get` 不过滤。存 id 的
幂等槽走的恰好是不过滤的那一侧。文档按这个表述写。

**且这个不对称不能就地抹平**：`entity.js:636` 的 `restore()` 正是靠 `this.get({id})` 读出
DELETED 记录再翻回 ACTIVE。让 `get` 默认过滤会当场废掉 restore ⇒ 它是要绕开的契约，不是 bug。

### 二、依据修正两处

1. **「规则一边禁止全表扫，一边不提供替代品」不准确。**
   `autocheck/static/pagination-safety.js:36-39` 的建议原文明确给了替代品：「改成维护一个
   SET/ZSET 索引（Entity Factory 已经替你维护好了，直接用它的 `list({limit, cursor})`）」。
   但**实质论点仍成立且更尖锐**：那个替代品是**按 id 的游标遍历**，解决内存问题，
   覆盖不了**按业务键寻址**。论据要改，结论不变。
2. **建议 3 的路径不对**：solo 没有 `docs/authoring/`，真身在
   `deploy/scaffold/docs/authoring/service.md`（下发件）。改错地方不会随 `upgrade.sh` 到下游。

### 三、【实测】建议 3 的静态规则推翻——不做

提议的「`sAdd`/`zAdd` 在同文件找不到配对 `sRem`/`zRem` 就 WARN」，实测**又漏又吵**：

| 验证 | 结果 |
|---|---|
| 能抓到它本要抓的 bug 吗 | **不能。** 修复前 steward `page.js` 在 157/209 行已有 `zRem` ⇒ 文件级配对判「已配对」放行，151 行 `routeSetKey` 的 `sAdd` 照样漏网 |
| 打在 solo 自身 | **10 个框架文件报 WARN**（nexus/notification×2/orchestrator×2/user×2/fulfillment/planner×2） |
| 打在 steward | **0 命中** |

抽查 `core/user/logic/key.js`：`historyKey` 是**只增不删的历史集合**（设计如此），真正的删走
`redis.del(keyKey(uid))`——误报。⇒「12:1 漏配率一扫即得」不成立：漏配的抓不到、抓到的不是漏配。
要做得按「同一 key 构造函数的 add/rem 配对」，需要标识符追踪，不再是低成本正则。

### 四、【判断】建议 1/2 不做，走 storage 那条路

**判据：做不到用原语治，不知道用文档治。** `storage.asset.external`（v1.2.11）之所以该加，
是因为大文件**根本塞不进** upload，不给原语就是死路；这里**没有做不到的事**——服务照样能写
自己的索引，写了 30 次都成功了，缺的只是「不知道有这个坑」。同一条「各家形态差太远」的理由，
当初砍掉了分片/断点续传/进度/CDN，这次同样砍掉 identity/idempotency/enumerate：
收进框架只会把 30 种手写变成 30 种配置，SOLO 越来越重而不是够轻够用。

- **建议 1（声明式二级索引）**：不做。另有三个未答的设计问题（`restore()` 时索引怎么恢复、
  CAS 重试循环里索引维护怎么保持原子、既有数据怎么迁移），且它是新交付物 ⇒ minor。
  按 `CLAUDE.md` §4「阶段一只加不破、新发现默认进 v2」，归 v2 或专门排期的 v1.3。
- **建议 2（`onDelete` hook）**：不做。不解决重复实现，却要在 `entity.js` 的 MULTI/EXEC
  事务里开一个外部注入点——它是全框架最吃重的文件，为不彻底的方案开扩展点不划算。

### 五、已落地：边界声明三层（照 storage `4cac9f3` 的「决策 → 划分 → 使用」）

| 层 | 文件 | 内容 |
|---|---|---|
| 决策（写码前最早拦截） | `deploy/scaffold/.claude/skills/solo-service/SKILL.md` | 红线区新增一条，紧接「禁止扫 keyspace」之后——那条说「别扫、用索引」，下一个问题正好是「按业务键怎么找」，缺口就在这个接缝上 |
| 划分 | `deploy/scaffold/docs/authoring/service.md` | 新增 §6.6「按业务键找记录」+ §7 自查第 9 条（8 条 → 9 条） |
| 使用 | `api/library/README.md` | 新增「Entity Factory 的边界」对照表（维护什么/不维护什么） |

三份都随 `upgrade.sh` 下发（`api/library` 见 `upgrade.sh:146` 整目录覆盖），触达全部下游。
`node deploy/check-doc-drift.js` 通过（模块 5 契约文档包 + 模块 6 下游 skill 均绿）。

### 六、时效性（原文未标，读者需知）

- **框架侧仍成立**：反馈基于 bundle v1.2.3，现 v1.2.11。核过 `v1.2.3..HEAD` 期间 `entity.js`
  的 2 次提交（`createMany/deleteMany`、`listAll`）——`softDelete`/`get`/二级索引一字未动。
- **steward 侧症状当天已全修**：`863dc59 fix(steward): 幂等槽指向已删记录会静默丢活——五处
  统一自愈`；`page.routeSetKey` 的 `sRem` 在其未提交工作树里（`page.js:218`，注释标「2026-08-31 补」）。
  ⇒ 原文「五处已经带病运行数月」现为过去时，无下游止血的紧迫性。
