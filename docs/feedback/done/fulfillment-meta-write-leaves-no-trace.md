# 履约的 `instance.meta` 是守卫的唯一判据，却既不留痕也不防覆盖

> 来源：steward，2026-09-07。起因是一次全链路数据对账：一条已经跑通的履约车道
> （外部 webhook → 状态机 → workflow 派单 → 浏览器执行 → 探针回读 → 终态），
> 问的是「定义的状态能不能答完所有问题」。**依据全部本次实测**（bundle **v1.2.14**，
> N100 生产库真实记录：43 张 instance、50 条工单、40 条 run 逐条拉取核对 + 代码走查）。
> 涉及：`api/apps/fulfillment/logic/instance.js` —— `advance`（`:73` 合并 meta、`:106` 落 history 条目）
> 与 `update`（`:305-320`）。行号按本仓 v1.2.14；下文引到的 bundle 行号是 steward 侧那份产物，
> **以本仓源码为准**。
>
> 一句话：**JsonLogic 守卫判的是 `instance.meta`，而 meta 的每一次写入都是
> 无版本、无留痕、原地覆盖的 read-modify-write** —— 于是「这次跃迁当时读到的是什么值、
> 谁写的」在事后**查不出来**，而这恰恰是这套设计（AI 出证据、守卫判数据）最需要回答的问题。

---

## 一、设计立场与实现之间差了一格

fulfillment 的核心立场（也是它值得存在的理由）是：

> 探针把外部世界的事实**变成结构化字段**写进 `instance.meta`；
> JsonLogic 守卫拿 meta 里的字段判定能不能跃迁——**判据是数据、可评审、可回放**。

前半句成立。后半句的「可回放」不成立，因为 meta 没有历史：

| 想回答的问题 | 现在能不能答 | 为什么 |
|---|---|---|
| 现在 meta 是什么 | ✅ | `instance.get` |
| 状态怎么走过来的 | ✅ | `history[]`（state / event / transition_id / user / stamp） |
| **这一跳的守卫当时读到的是什么值** | ❌ | history 条目**不含本次 metaUpdate**；meta 是覆盖写 |
| **这个字段是谁写的、什么时候** | ❌ | `update` 只更新 `updatedAt`，不记 user、不进 history、不发事件 |
| 上一次为什么没过 | ❌ | 第二次提交把第一次的值覆盖了 |

## 二、代码走查（两处，形态不同但结果一样）

**① `advance`（transition）—— 写了 meta，但 history 不记它写了什么**
（`logic/instance.js:73` 与 `:106`）

```js
const mergedMeta = { ...instance.meta, ...metaUpdate };
const logicData  = buildLogicData(instance, mergedMeta, req);   // ← 守卫读的是这个
...
instance.meta = mergedMeta;
const entry = { state: toState, event, transition_id, user, trace, stamp };  // ← 没有 metaUpdate
instance.history.push(entry);
```

`metaUpdate` 在守卫求值**之前**合并（这是对的，外部送证据、守卫判），但那一刻的输入
**不进 history**。事后只能看到「T3 走了 image_submitted 到 NEEDS_HUMAN」，
看不到「当时 confidence 是 0.55」。

**② `update` —— 裸 read-modify-write**（`logic/instance.js:305-320`）

```js
async update({ id, meta, ...updates }) {
    const instance = await getInstance(id);
    ...
    const updated = { ...instance, ...updates, updatedAt: Date.now() };
    if (meta && typeof meta === 'object') updated.meta = { ...instance.meta, ...meta };
    await redis.set(`${PREFIX}${id}`, JSON.stringify(updated));
    logger.info(`Instance updated: ${id}`);
    return updated;
}
```

三件事都没有：**没有 `req`**（所以连"谁写的"都拿不到，签名里根本没接这个参数）、
没有版本/CAS（并发写后到者全胜）、没有事件或 history。
而这是**探针写事实的唯一入口**——也就是说，整条「AI 出证据」的链路，
证据是**匿名落库**的。

## 三、实测代价

steward 的演示车道 profile：`image_submitted` 有两条分支（confidence ≥ 0.9 放行，否则转人工）。
线上实例 `FL-20260906-6658` 的真实经过是「第一版图 0.55 被拒 → 人工 recheck → 第二版 0.95 通过」，
而现在库里 `meta.confidence` **只有 0.95**。history 记得它去过 NEEDS_HUMAN，
**记不得为什么**——而"为什么"正是评审这条守卫时唯一要看的东西。

⚠️ 值得注意的是：**同一个项目里，人自己写的那半刻意做对了。** 探针回读工单结局时用的是
按尝试次数编号的键（`publishJobId_1` / `publishOutcome_1` / `publishJobId_2`…），
代码注释写着「否则重试那一轮会把上一次的失败原因抹掉」。
也就是说这个坑**踩过、认识、并在自己够得着的那一半绕开了**；
够不着的那一半（webhook 经 workflow 走 `metaUpdate` 的那条）就绕不开——
**workflow step 的 params 里键名是静态的，拼不出 `confidence_${n}`**
（`resolveVariables` 只做整值引用与 `cat`/`+`，不做动态键）。
⇒ 这不是"应用层再小心一点"能解决的，闸门在框架这一侧。

## 四、建议（按价值排序，都不改契约）

1. **history 条目带上本次 `metaUpdate`**（一行）。
   `advance` 里已经有 `metaUpdate` 这个变量，`entry` 里加一个字段即可：

   ```js
   const entry = { state: toState, event, transition_id: transitionId, user, trace, stamp: Date.now(),
                   meta_update: Object.keys(metaUpdate).length ? metaUpdate : undefined };
   ```

   这一条就把「守卫当时读到什么」补回来了，且**只在有 metaUpdate 时占空间**。
   审计价值上它与 `user`（谁推的）同族，不是遥测。
   ⚠️ 若担心体积：可只记键名 + 值的摘要（截断），或给一个 `meta_update_keys`。
   但**记键名不记值** 解决不了本文的问题——0.55 与 0.95 键名一样。

2. **`update` 接 `req` 并记 `updatedBy`**（一行）。
   同一模块里 `create` 与 `advance` 都收 `req` 并落 `createdBy` / `history[].user`，
   只有 `update` 的签名里没有——看起来像疏漏而不是决定。
   「探针写的」与「人工改的」现在完全分不开，而这套设计恰恰最在意这个区分。

3. **给 `update` 一个可选的乐观锁**（`expectedUpdatedAt` / `version`，不给就是现在的行为）。
   探针与人工、多个探针之间并发写 meta 时，现在是后到者全胜且无声。
   有了它，调用方**可以选择**要不要防；不写的路径一字不变。

4.（可选）**`instance.update` 也发一条 `EVENT:FULFILLMENT:META_UPDATED`**。
   `advance` 已经在发 `TRANSITIONED` 了，meta 变更是同一条审计轴上的另一半。
   ⚠️ 这条价值最低、代价最高（要登记事件注册表 + relay token），
   **等真的出现订阅者再说**——放在这里只是记下它存在，不建议现在做。

## 五、附带发现（不属于本文主张，供参考）

- `advance` 里 `event.emit('EVENT:FULFILLMENT:TRANSITIONED')` 的失败是
  `.catch((err) => logger.warn(...))`（`logic/instance.js:117-132`）。跃迁照样成功、照样返回 200，
  但订阅这条流的 workflow **永远不会被唤起**。steward 这条车道的「派单」正挂在那条流上，
  ⇒ emit 失败一次 = 一张业务工单静默地停在中间状态，没有任何调用方可见的痕迹。
  这条与本文是同一族问题（**写成功了但没人知道发生过什么**），但改法不同（要么重投、
  要么把失败写进 history），所以只作为附注。

---

## 六、处理结论

**2026-09-07 核实：三节事实指控逐条属实。** `advance` 的 `mergedMeta`（`logic/instance.js:73`）
与不含 `metaUpdate` 的 `entry`（`:106`）一字不差；`update`（`:305-320`）确实没有 `req`、没有 CAS、
没有 history；`resolveVariables`（`orchestrator/logic/runner.js:491-531`）只解析**值**不解析**键**，
所以「应用层自己拼 `confidence_${n}`」这条路在 workflow 那一侧确实走不通。

补一条本文没写、但让「像疏漏不像决定」更实锤的：**`index.js:109` 一直在传 `req`**
（`(p) => Methods.instance.update(p, req)`），只是 logic 的签名没接。

### 落地（v1.2.15）

- ✅ **建议 1：`history[]` 条目带 `meta_update`**（`logic/instance.js`，非空才落）。守卫的**输入**
  和**输出**（`state`）从此记在同一条里。`cancel`/`hold`/`override` 走的也是 `advance`，
  于是 `cancel_reason`/`hold_reason` 一并留痕。
- ✅ **建议 2：`update` 接 `req` 并落 `updatedBy`**，同时 `delete updates.updatedBy`
  ——出处是 Router 的话，不是调用方能填的字段。introspection 的 `INSTANCE_BASE` 同步声明
  （typed，not required：未鉴权调用方为 null）。
- ⏸ **建议 3（乐观锁 `expectedUpdatedAt`）**：本轮不做。它是唯一需要新参数的一条，
  且现在有了 `updatedBy` + `updatedAt`，「谁最后写的」至少查得出来了——等真出现并发覆盖的
  实例再上，那时才知道该锁在 `updatedAt` 还是 `meta` 的某个子键上。
- ❌ **建议 4（`EVENT:FULFILLMENT:META_UPDATED`）**：不做，本文自己也不建议。
- ⏸ **§五 附带发现（emit 失败静默）**：单独一族，本轮不动。⚠️ 但要指出：steward 那次
  「派单没被唤起」大概率**不是**这个 catch 的锅——同一时段该栈五个 relay token 全是死的
  （见 `relay-token-lazy-refresh-dies-when-idle.md`），emit 根本发不出去。
  真要处理它得连「重投 or 写进 history」一起设计，且得先有一次**排除了 token 因素**的复现。

### 一句没被本文写出来、但值得单记的

本文最有价值的半句在 §三：同一个项目里，**人自己写的那半（探针按尝试次数编号 `publishOutcome_1/2`）
刻意做对了，框架够得着的那半没有**。判据因此可以零成本地一般化：
**凡是「守卫读它、而它是覆盖写」的字段，都要问一句「这一跳读到的值事后查得出来吗」**——
答不出就是本文这个坑。与 `entity-factory-no-secondary-index-primitives.md` 的
「每建一个辅助键，当场回答谁在什么时候删它」是同一族判据。
