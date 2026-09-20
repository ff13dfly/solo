# `softDelete` 不释放载荷：带大字段的实体「删了」之后仍在付内存，且三处文档都只讲索引

> 来源：steward，2026-09-20。起因是一句盘点提问「来看下数据的冗余情况」——线上 Redis
> 44.64MB 里有 **10.39MB 是已软删的记录**（占那个实体的 81%），其中 8.92MB 与另一条轴的
> 内容逐字相同（md5 比对），躺了近一个月没人知道。
> 依据：**全部本次实测**（steward 栈，bundle **v1.2.14**，N100 生产库逐 key `MEMORY USAGE`
> 汇总 + 记录级 md5 比对 + 硬删前后 `used_memory_human` 对照）。唯一的引用已标注：
> `entity-factory-no-secondary-index-primitives.md`（steward，2026-08-31）——那篇讲**二级索引
> 没有原语**，本篇讲**载荷没被释放**，两件事，但病根同源（见第三节）。
> 涉及：`api/library/entity.js:511`（`delete` 的软删分支）· `:949`（`destroy`）· `:636`
> （`restore` 依赖 `get` 读得到墓碑）· `:139`（`sensitiveFields` 剥 WAL）、
> `docs/authoring/service.md:304-329`（软删唯一的成文警告，**两条都是索引**）、
> `api/autocheck/static/soft-delete-check.js`（只校验 logic 与 `entities.js` 声明是否一致）。
>
> 一句话：`delete` 只改 `status`，**载荷一字不动**；对 `html` / `sample` / `content` 这类
> 上限几百 KB 的字段，「删除」实际是「从 list 里消失，继续按原样付内存、继续进备份包」——
> 而框架、文档、autocheck 三处都只盯着索引一致性，载荷这一维**一个字都没有**。

---

## 一、实测：一次「迁移 + 清理」之后，被清理掉的数据一个字节都没少

2026-08-26 steward 把整页 DOM 从 `scout.capture` 拆到 `steward.page`，迁移脚本带 `--purge`，
调的是 `scout.capture.delete`。一个月后盘点线上库：

| | 条数 | 体积 |
|---|---|---|
| `SCOUT:CAPTURE` 全部 | 148 | 12.89 MB |
| └ `status: DELETED` | **85** | **10.39 MB（81%）** |
| └ 其中与 `steward.page.html` **逐字相同**（md5） | 56 | 8.92 MB |

`sample` 字段上限是 400000，`capture` 声明 `softDelete: true`。于是「迁走并清理」的真实结果是：
**同一份 DOM 在库里存了两份，旧的那份只是被打了个 `status` 标记。**

硬删（数据 key + `INDEX` + `INDEX:CURSOR` + 各自的幂等槽）之后：**44.64MB → 24.03MB**，
整库少掉近一半。

## 二、根因：软删的成文警告写得很细，但两条都是索引

`docs/authoring/service.md:304-329` 为软删专门写了一节，两个小标题：

- **(a) `get` 不过滤墓碑，`list` 过滤——存 id 的索引必然踩这个不对称**（含
  `.catch(() => null)` 挡不住、`restore` 靠 `get` 读墓碑所以这个不对称不能就地抹平）
- **(b) 删记录不会碰你的键**（`sAdd`/`zAdd` 要自己撤，父项要从枚举集合退场）

写得足够细，细到把「为什么不能修」都解释清楚了。**但两条都在讲索引与读取正确性，
没有一条讲这条记录本身还占着多少内存。** 一个把 400KB html 软删进坟墓的服务，
照着这一节逐条检查，会得到「全部合规」的结论——而它正在泄漏。

`api/library/entity.js:511` 的头注也只在「能不能恢复」这一维上区分两者：

```js
/**
 * @strategy If softDelete=true, marks status as 'DELETED'. Otherwise purges the key.
 */
async delete({ id }) {
```

而 `:949` 的 `destroy` 头注是 `@on_demand Use with caution. Bypasses soft-delete logic.`
——**措辞是纯警告**，读起来像「这是危险操作，正常别用」。而对一个 400KB 载荷的实体，
它恰恰是唯一正确的清理方式。

`soft-delete-check` 校验的是「logic 的 `softDelete` 配置与 `entities.js` 的声明一致」
（规则头注原文：不一致 → ERROR / CRITICAL）。两边一致就绿，与载荷大小无关。

⚠️ 另外记一笔文档分工：**`docs/authoring/modeling.md` 里「软删」两个字一次都没出现**
（`grep` 实测 0 处）。「这个实体该不该软删」是**建模决策**，按 modeling/service 的分工
应该在建模那篇里有一句，现在它只活在 service.md 的「二级索引」小节里——
于是只有正在写二级索引的人才会读到它。

## 三、这个坑有「一处做对、一处漏了」的典型形状

steward **同一个仓库里**：

- `api/apps/steward/logic/page.js:283`，版本上限修剪时用的是 `destroy`，注释原话：
  > 硬删不软删：这是被版本上限挤出去的原料，留一条软删记录只是继续占着那 150KB
- `deploy/migrate-raw-pages.js` 的 `--purge`，调的是 `scout.capture.delete`（软删）。

作者**想明白过这件事**，还把结论写在注释里了，但那个判断没能传播到十几行之外的另一个脚本。
这和 `entity-factory-no-secondary-index-primitives.md` 是同一个病根：**没有共同原语时，
踩过的坑不会传播**——每个调用点都要靠人重新想一遍，而多数时候不会想。

## 四、建议（按价值排序）

1. **`delete` 在软删时清空「大载荷字段」，把这件事变成框架行为。**
   已经有一个现成的声明面可复用：`sensitiveFields`（`entity.js:139`，本来就是「不该进 WAL
   的东西」）。语义上两者高度重合——那些字段正是大载荷。若怕语义混淆，另开一个
   `purgeOnDelete: ['html']` 更直白。
   ⚠️ **这是个取舍，不是无损**：`restore`（`:636`）恢复出来的记录会少掉那些字段。
   所以更稳的形态可能是「默认不动、声明了才清」，把选择权交给建模的人——但**必须让它
   成为一个要显式回答的问题**，而不是像现在这样压根不出现。
2. **退一步：`entity.delete` 软删一条载荷超过阈值（比如 100KB）的记录时 `logger.warn` 一次**，
   带上字段名与字节数。零行为变更、零取舍，但把「你正在付这笔内存」说出口。
3. **文档补两处**：① `service.md:304` 那节加第 (c) 条「删了不等于不占——载荷原样留着，
   还会进备份包；实体有 >100KB 的载荷字段时清理走 `destroy`」；② `modeling.md` 补一句
   软删的建模判据（现在它零提及，见上一节末尾）。
4. **`destroy` 的头注改措辞**：现在是纯警告，读起来像「正常别用」。补一句它的正当用途
   （被保留上限挤出的流水、已迁走的历史数据），人才会在对的场合想起它。
5. **autocheck 可以判**：`entities.js` 里某字段声明了 `maxLength >= 100000` 且实体
   `softDelete: true` ⇒ WARN，提示确认清理路径。零误报成本——真需要软删的，注释一句即可。

## 五、顺带一条与本篇同源、但独立成立的判据

清理这条轴时，真正的问题其实比内存更靠前：**那条轴只写不读**（执行链不碰、生成侧不读、
声明为「回读入口」的方法产品代码零调用）。判据是：**判断一条数据轴是不是「原料」，
看有没有代码读它，不是看设计文档说它是什么**。这条不是框架问题，记在这里只是因为
它是同一次盘点里更上游的那个发现——没有它，上面这些内存都花得理直气壮。

## 处理结论

**triage 2026-09-20：核实属实（每一处行号与事实均现查复核）。建议 ③④⑤ 采纳落地（⑤ 的判据
位置做了修正）；建议 ① 留待拍板，建议 ② 判定被 ⑤ 取代、不做。**

### 核对（全部现查，2026-09-20）

- `entity.js:511` 软删分支确为 `update({ status: DELETED })`、`:949` `destroy` 头注确为纯警告、
  `:636` `restore` 确实依赖 `get` 读墓碑、`:139` `sensitiveFields` 确为 WAL 剥离——**四处行号精确**。
- `service.md:304-329` 两条小标题确实都是索引维度（(a) 墓碑不对称、(b) 删记录不碰你的键），
  载荷维度零提及。
- `modeling.md` 里「软删 / softDelete」**grep 确为 0 处**——本文第二节末尾那笔记得准。
- `soft-delete-check.js` 确实只比对 logic 与 `entities.js` 的声明一致性，与载荷无关。
- ⚠️ **一处修正**：建议 ⑤ 说判据落在「`entities.js` 里某字段声明了 `maxLength >= 100000`」，
  但 `entities.js` 的字段 schema 只有 `type/description/required/format`，**没有长度维**；
  真正的上限声明在 `handlers/introspection.js` 的**方法参数**里（steward 那个 400000 即是，
  见 `scout/handlers/introspection.js:56`）。规则已按修正后的位置实现。

### 已做

1. **autocheck 规则 5**（建议 ⑤）：`api/autocheck/static/soft-delete-check.js` 新增
   「软删实体 + 方法参数 `maxLength ≥ 100000` ⇒ **WARN**」。方法名按 `{service}.{entity}.{action}`
   拆出实体段做交叉，同一字段在 create/update 重复声明时去重。
   **实测**：approval / planner（仓里仅有的两个真软删服务）报 `✅ [载荷] 未发现`，**零误报**；
   fixture（`thing` 实体 + 400000 的 `html` 参数）命中 1 条，128 字节的 `title` 不报、`ping` 跳过。
2. **文档两处**（建议 ③）：
   - `deploy/scaffold/docs/authoring/service.md` §6.6 补第 **(c)** 条「删了不等于不占」，带实测数字与 `destroy` 指引；
   - `deploy/scaffold/docs/authoring/modeling.md` 新增「★ 要不要软删：先看载荷」一节——**把两个判据分开问**
     （要不要能恢复 / 有没有 ≥100KB 载荷），并收录本文第三节那条「没有共同原语时，踩过的坑不会传播」。
     这一节补上了本文指出的零提及缺口。
3. **`destroy` 头注改措辞**（建议 ④）：`api/library/entity.js` 从纯警告改为 `@when` 说明正当用途
   （保留上限挤出的流水、已迁走的历史数据、不需恢复的原料），并带上本次实测数字。

### 未做，各有理由

- **建议 ①（`delete` 软删时清空大载荷字段）留待拍板。** 它是**框架行为改动**且不无损——
  `restore`（`:636`）恢复出来的记录会缺字段，而 restore 的存在正是软删的理由。本文自己也说
  「必须让它成为一个要显式回答的问题」——**规则 5 已经实现了这个「显式提问」，且零行为风险、
  提问时机还更早**（写代码时，而不是删了一个月后盘点时）。真要做，形态应是显式的
  `purgeOnDelete: ['html']`，**不复用 `sensitiveFields`**：那是 WAL 脱敏轴，两个轴撞在一起会让
  「脱敏」和「省内存」互相绑架（想省内存就被迫脱敏，反之亦然）。
- **建议 ②（运行时超阈值 `logger.warn`）判定被 ⑤ 取代，不做。** 两点：① **时机更晚**——它在
  删除那一刻才响，而那时数据已经在堆了；② **有真实成本**——批量迁移（本文起因正是一次
  `--purge` 迁移）会把日志刷满，而刷屏的告警等于没有告警。⑤ 零运行时开销、零日志噪音，
  覆盖同一个判据。
- **本文第五节那条判据（「判断一条数据轴是不是原料，看有没有代码读它」）不属于框架问题**，
  按本文自己的定位不处理；但它值得留在档案里——**只写不读的轴是上游问题，内存只是它的账单**。
