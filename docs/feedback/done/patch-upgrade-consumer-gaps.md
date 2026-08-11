# 反馈：补丁升级在派生项目侧的三个盲点（v1.1.10 → v1.1.14 实测）

> 来源：trend 派生项目，2026-08-06 从 `v1.1.10` 直升 `v1.1.14` 的全过程记录。
> 场景：走 runbook 的标准路径——站在 `v1.1.14` 上 `bash deploy/scaffold/upgrade.sh <proj>`，
> 先 `--dry-run` 后实跑，自检全绿、`ACTION REQUIRED` 逐条读过。
> 依据：全部为本机实测（非推演），命令与输出见各节。
> 涉及：`api/library/entity.js:238/247/253/259`、`deploy/scaffold/upgrade.sh:156` 与 `:205-229`、
> `deploy/scaffold/upgrade.sh:307`、`deploy/scaffold/run.sh:315-320`、
> `docs/planning/CHANGELOG.md` 的 v1.1.13 游标分页条目。
>
> **状态：已上收**（2026-08-06，三节全部处理，见文末「处理结论」；随下一个 v1.1.x 发版下发）。
>
> **与 [`scaffold-startup-guards-fallout.md`](./scaffold-startup-guards-fallout.md)（finance，同日）
> 的关系**：两份是同一批升级、不同项目、独立踩到的。那份讲 v1.1.14 新守卫**自身**的回归，
> 本份讲升级**流程**在消费者侧的缺口，只有 operator 一条重叠——已改成交叉引用（见第三节），
> 不重复论证。另外补一条对那份 ① 的独立验证：trend 把新守卫 merge 进定制 `run.sh` 后，
> 用同样的手法复现了「第二个实例 fail fast → EXIT trap → `cleanup()` 端口清扫误杀先起的栈」，
> 且**那份提出的 pgid 判据在 trend 上同样有效**——加上之后第二个实例照常拒绝启动，
> 原栈 8 个端口的 PID 一个没变（`8500/8920/8921/8922/3800/3850/3900/3950`）。
> 顺带确认了那份提到的退出码问题：`cleanup()` 结尾的 `exit 0` 确实把 `exit 1` 吃掉了，
> 实测 `echo $?` = 0。
>
> 一句话：`upgrade.sh` 本身跑得很干净（自检全过、`run.sh` 的 divergence 检测精准），
> 但**它保证的是「[Solo] 产物就位」，不是「这个栈还能跑」**。三个盲点都落在这条缝里，
> 而且三个都不报错：一个只让测试挂、一个只让文档少一块、一个只打一行 warn。

---

## 一、v1.1.13 游标分页：`create()` 无条件写 ZSET，派生项目的 hermetic 测试必挂，而下游 action 写的是「无强制」

### 1.1 实测现象

升级后跑派生项目自己的服务测试（升级前全绿）：

```
$ npx jest api/apps
Test Suites: 6 failed, 2 passed, 8 total
Tests:       39 failed, 9 passed, 48 total

    TypeError: redis.incr is not a function
      at Object.incr [as create] (api/library/entity.js:238:37)
      at Object.<anonymous> (api/apps/brand/tests/company.test.js:160:19)
```

挂的 6 个套件是全部使用 Entity Factory + 手写 fake redis 的那 6 个；过的 2 个是不碰 redis 的
`basic.test.js`。**生产侧完全正常**——真 Redis 有这些命令，栈照常起、采集照常写数据。

### 1.2 根因

`entity.js` 的 `create()` 里，游标索引的写入**不在任何开关后面**：

```js
238:  const seq = await redis.incr(getCursorSeqKey());     // ← 无条件
247:  multi.zAdd(cursorIndexKey, { score: seq, value: id });   // canAtomicWal 路径
253:  await redis.zAdd(cursorIndexKey, { score: seq, value: id }); // json 路径
259:  multi.zAdd(cursorIndexKey, { score: seq, value: id });   // 普通 multi 路径
```

三条写路径无一例外，`delete()` 同理多了 `zRem`。也就是说：**只要调用过 `create()`，就依赖
`incr` / `zAdd`**，跟调用方传不传 `cursor` 毫无关系。

而 CHANGELOG 的 v1.1.13 那条写的是：

> 下游 action：**无强制**（不传 `cursor` 行为完全不变，`migrateCursorIndex()` 不跑也不影响现有 offset 调用）。

这句话对**运行时行为**完全正确（真 Redis 上确实零变化），但它被消费者读成「我什么都不用做」，
而实际要做的事是：**所有手写 fake redis 的 hermetic 测试必须补 `incr` / `zAdd` / `zRem`**。

### 1.3 为什么这个缺口是系统性的，而不是 trend 粗心

同一批变更里，上游**自己就修了**受影响的 mock——v1.1.13 的回归说明写着「approval/collection/gateway
等服务的 hermetic fake redis 补了 `incr`/`zAdd`/`zRem`」，`api/sample/tests/item.test.js` 的
fake redis 也补上了这几个命令。**上游知道这个影响面**，只是把它当成了「仓库内部的连带修改」，
没有翻译成一条给消费者的 action。

但派生项目的 `api/apps/` 是 [Project] 所有，`upgrade.sh` **明确不碰**（这是对的）。于是：

- 上游 core 服务的 mock：修好了
- `api/sample` 的模板 mock：修好了，并且随 upgrade 下发给了派生项目
- 派生项目**照着旧 sample 抄出去的那些 mock**：没人管，也没人提醒

派生项目的服务测试恰恰是从 `api/sample/tests/item.test.js` 抄出来的（trend 的六个测试文件头部
都写着 `Mirrors api/sample/tests/item.test.js`）——**模板更新了，抄件不会自己跟着更新**。

### 1.4 失败形态：只有测试挂，生产全绿

这是它最容易被漏掉的地方。升级后的常规验证——重启、看端口、`curl /health`、跑一遍数据体检——
**全部会通过**。trend 这边是升级完主动跑了一次 `npx jest api/apps` 才发现；如果按 `upgrade.sh`
结尾 `Next:` 的提示走（只说了「重启项目」和「diff 那些 diverged 的脚本」），会带着一个红的测试
套件继续开发，直到下次有人跑测试。

### 1.5 建议

1. **（主要）改 CHANGELOG v1.1.13 那条的下游 action**，把「无强制」改成有条件的强制：

   > 下游 action：**运行时无强制**（不传 `cursor` 行为完全不变）。
   > **但 hermetic 测试有强制**：`create()`/`delete()` 现在无条件写游标 ZSET，**任何手写
   > fake redis 的服务测试必须补 `incr` / `zAdd` / `zRem`**，否则升级后立刻 `TypeError:
   > redis.incr is not a function`。照抄过 `api/sample/tests/item.test.js` 的项目全部受影响。

2. **`upgrade.sh` 的 `Next:` 里补一条「跑一遍项目自己的测试」。** runbook 的
   `upgrade-patch.md` §2 表格里其实已经写了「升级后必做：重启 + 跑一遍自有 e2e 即可」，
   但实操中人是照着脚本结尾的 `Next:` 走的，不会回头翻 runbook。这一条几乎零成本，
   而且正好能兜住本节这类「产物就位但代码不兼容」的缺口。

3. **`api/sample` 的 fake redis 补齐游标**读**路径，并注明它是随版本更新的模板。**
   现在 sample 的 mock 有 `incr`/`zAdd`/`zRem`/`zCard`，但**没有 `sCard` 和 `zRange`**——
   而 `_listByCursor` 两个都要用（`entity.js:539` 的 `sCard`+`zCard` 一致性校验、`:557` 的
   `zRange(key, max, min, {BY:'SCORE', REV:true, LIMIT})`）。也就是说：派生项目照着新 sample
   写一个 cursor 模式的 hermetic 测试，仍然会撞墙。

   顺带一提，`zRange` 在 `REV` 下入参是 `(max, min)` 而不是 `(min, max)`——这正是
   v1.1.14 复盘里「**假实现的语义错了比没有假实现更危险**」的同一类陷阱（hermetic 全绿，
   错误假设藏到真 Redis 才炸）。sample 的 mock 是所有派生项目的抄写源头，它把语义写对，
   收益是全生态的。

   建议在 sample 的 mock 上方加一句：

   ```js
   // ⚠️ 这份 mock 的命令集跟着 api/library/entity.js 的依赖走。抄到自己服务里之后，
   //    每次升级 Solo 都要回来对一次差（v1.1.13 加了 incr/zAdd/zRem，v1.1.x 还会再加）。
   ```

4. **（可选，更彻底）把 fake redis 变成 [Solo] 下发的产物**，例如
   `api/library/tests/utils/fake-redis.js`，让派生项目 `require` 而不是抄。这样命令集永远
   跟 `entity.js` 同步，代价是派生项目的服务测试多一个对 `api/library` 的依赖——
   要不要付这个代价，交给上游判断。trend 这边的临时解是每个服务一份
   `api/apps/<svc>/tests/utils/fake-redis.js`（六份逐字节相同的内联实现抽成三份共用，
   顺带把 `sCard`/`zRange` 按真实语义补全），48 个测试恢复全绿。

---

## 二、`upgrade.sh` 整份覆盖 `docs/README.md`，与它自己对 deploy 脚本的 divergence 策略不一致

### 2.1 实测现象

升级后 `git diff docs/README.md`，项目自己加的一整节没了：

```diff
-## 集成方案（`docs/integrations/`，项目自己的，不会被 upgrade 覆盖）
-
-| 文档 | 内容 |
-|------|------|
-| [`integrations/apollo.md`](./integrations/apollo.md) | ... |
-| [`integrations/goods.md`](./integrations/goods.md)   | ... |
```

（那句「不会被 upgrade 覆盖」是项目作者当初写的，理解错了——但这个误解本身也说明：
**README 在消费者心智里就是「我可以往里加东西」的文件**。）

`docs/integrations/` 下的文档本身没事，丢的只是这张索引表。但索引没了，等于那几份文档
在手册入口里消失了。

### 2.2 根因：同一个脚本里两套策略

对 deploy 脚本，`upgrade.sh:205-229` 做得非常好——`cmp -s` 比对，改过就不覆盖、存成
`<name>.solo-{ver}.new` 等人 diff，还在报告里标 `DIVERGED`：

```
• script      ! deploy/run.sh  (DIVERGED — NOT overwritten; stock staged as deploy/run.sh.solo-v1.1.14.new)
```

对 docs，`upgrade.sh:156` 是无条件重定向覆盖：

```bash
sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" -e "s|{{SOLO_VERSION}}|$SOLO_VERSION|g" \
    "$SCRIPT_DIR/docs/README.md" > "$PROJ/docs/README.md"
```

脚本注释里给的理由是「Distilled contracts that track the execution engine, so a stale copy is
WRONG; re-sync the WHOLE docs/ pack every upgrade」。**这个理由对 `authoring/{service,events,
workflows}.md` 完全成立**——它们是与引擎逐字段对齐的契约，陈旧即错误，整份重下发是对的。

但 `README.md` 不是契约，是**索引**。它天然会被项目扩展（挂自己的集成文档、架构决策、
运维手册），而且 Solo 模板本身也鼓励这么用。把它和三份契约文档归成同一类处理，是这个盲点
的根源。

### 2.3 建议

1. **`README.md` 也走 divergence 检测**（跟 deploy 脚本同一套 `cmp -s` 逻辑）：改过就不覆盖，
   新模板存成 `docs/README.md.solo-{ver}.new`，在报告里标 `DIVERGED`。
   代价是版本号、目录结构这些也不会自动刷新——但这正是 `run.sh` 已经在付的代价，
   且有 `.new` 文件兜底。
2. **或者用标记块**：模板里圈出 Solo 拥有的区域，覆盖时只替换标记块内的内容：
   ```markdown
   <!-- solo:begin (自动生成，upgrade.sh 会整块覆盖，别在这里面写项目自己的东西) -->
   ...三份契约文档的表格 + 配套说明...
   <!-- solo:end -->
   ```
   块外的内容原样保留。这个方案更贴合 README 的实际用法（一份 Solo 段 + 一份项目段），
   但实现成本比方案 1 高。
3. 无论哪种，**三份 `authoring/*.md` 维持现在的无条件整份覆盖**——那是对的，不要改。

---

## 三、`operator` tarball 升级后失配 —— 与 finance 同题，补一条它没覆盖的分支

**主论证见 [`scaffold-startup-guards-fallout.md`](./scaffold-startup-guards-fallout.md) 的 ③**
（finance，同日独立发现）。那份把机制、`upgrade.sh` 自检独独跳过 operator、以及两条改法
都写清楚了，这里不重复。trend 是第二个独立撞到的项目，现象一致：

```
⚠   operator: port 3800 set but bundle missing (operator.v1.1.14.tar.gz) — skipping.
```

只补一条那份没覆盖、但直接决定改法可行性的分支：

### finance 的「零改动 → 直接拷上游 tarball」在 trend 上不成立

那份的建议之二是：「是否定制过是可判定的（跟对应 tag 的 `portal/operator/` 逐文件比一次）——
finance 这次就是比完确认零改动，才放心直接拷了 solo 的 `operator.v1.1.14.tar.gz`」。

trend 比完的结果相反：

```
$ diff -rq trend/portal/operator/src solo/portal/operator/src
Files ... /layouts/OperatorLayout.tsx differ
Files ... /locales/en.ts differ
Files ... /locales/zh.ts differ
Files ... /pages/Login.tsx differ
Files ... /pages/default/EntityEditModal.tsx differ
Files ... /pages/default/GenericCardList.tsx differ
Files ... /pages/default/index.tsx differ
Only in solo/portal/operator/src/utils: branding.ts
```

拷上游 tarball 会**静默抹掉这些定制**——而且抹的是构建产物，项目侧 `git status` 干净、
下一次谁去看都以为一直如此。所以：

1. **「拷上游 tarball」这条路必须以「逐文件比对确认零改动」为前置条件，不能做成默认行为。**
   两个派生项目一个零改动、一个七个文件有改动，说明这两种情况都常见。若上游要在
   `upgrade.sh` 里自动化，判定逻辑得先跑、且**判定不通过时明确拒绝拷贝并提示项目侧重建**，
   而不是拷了再说。
2. **定制过的项目需要的是一条能直接复制的重建命令。** trend 实测走通的（与
   `deploy/build-frontend.sh:37,43` 的流程一致，只是在项目侧执行）：

   ```bash
   (cd portal/operator && npm install && npx vite build --base /)
   rm -f portal/publish/operator.v*.tar.gz
   tar -czf portal/publish/operator.v{ver}.tar.gz -C portal/operator/dist .
   ```

   建议无论采用那份的哪条改法，输出里都带上这三行——「知道自己该重建」和「知道怎么重建」
   之间还隔着一次翻源码。

### 附议一条

那份最后一条建议（把 stock `serve_frontend` 里的两段端口检查抽成函数，好让派生项目自有的
非 tarball 前端也接得上）trend 这边独立得出了同样的结论并已落地：抽成
`fe_assert_port_free` / `fe_confirm_bound` 两个 helper，项目自有的单页前端（不走 tarball
流程，直接 serve 源目录）接上后与 tarball 前端受同等保护。**两个项目各自撞到同一个需求，
建议优先级可以提一档。**

---

## 处理结论（solo 侧，2026-08-06）

三节实测全部复核属实（含对 finance 那份 ① 的交叉验证）。逐条：

**§一（游标分页的 hermetic 测试盲区）——四条建议采纳三条，一条缓：**

1. ✅ CHANGELOG v1.1.13 的下游 action 已在原条目**就地补正**为「运行时无强制，但 hermetic
   测试有强制（补 `incr`/`zAdd`/`zRem`）」——就地改而不是另发新条，是因为 `upgrade.sh` 的
   ACTION REQUIRED 横幅扫的是"比消费者当前版本新的所有条目"：从 ≤v1.1.12 直升的项目
   看到的就是这条，它必须自己说真话。已用合成项目实跑 upgrade 确认横幅带出补正后的全文。
2. ✅ `upgrade.sh` 的 `Next:` 固定加了第 2 步「跑项目自己的测试」（含"upgrade 保证的是
   产物就位、不是你的代码还兼容"的说明）。
3. ✅ sample mock 补齐 `zRange`（真语义：REV 下 `(max,min)`、`+inf/-inf/"(n"` 边界）。
   复核时**发现比反馈说的还多缺一个**：`_listByCursor` 的 `entity.js:575` 还用了 `zScore`，
   一并补了；反馈说缺的 `sCard` 其实 v1.1.14 的 sample 里已有。mock 上方加了「命令集跟着
   entity.js 走、升级要回来对差」的显式提示，并新增 cursor 翻页用例钉住语义——做了辨别力
   验证（把 REV 语义临时写反，用例当场红）。
4. ⏸️ 「fake redis 变成 Solo 下发件」**缓**：v1.1.x「只加不破」窗口内不想新增派生项目对
   `api/library` 的测试期依赖面；先靠 3 的模板标注 + 1 的 CHANGELOG 合同兜住。若 v1.1.x
   周期内再出现一次"模板更新了、抄件没跟上"的实锤，升格为 v2 正式项。

**§二（README 被整份覆盖）——采纳方案 2（标记块），实现中踩到并修掉一个坑：**

- 模板加 `<!-- solo:begin -->` / `<!-- solo:end -->`（独占一行、逐字），升级只替换块内、
  块外原样保留；无标记的存量 README 不覆盖，新模板 staged 成 `docs/README.md.solo-{ver}.new`
  并在 `Next:` 里给合并指引（与 deploy 脚本 DIVERGED 策略一致）。三份 `authoring/*.md`
  维持无条件整份覆盖（同意反馈：那是对的）。
- 实现坑：第一版标记匹配用子串（`/solo:end/`），而模板说明文字里就有"solo:end"字样，
  awk 在说明行提前判定块结束→过期块被原样留下、还报告成"已重下发"。合成项目实测抓到，
  改为整行精确匹配（`grep -qxF` / awk `==`）后三轮场景全过：无标记→staged `.new`、
  有标记→块内替换块外保留（项目正文里出现 solo:end 字样也不干扰）、README 缺失→补全新。

**§三（operator 掉线）——与 finance 那份合并处理：**

- 自检补 operator 扫描 + ACTION + **输出里带上你们验证过的三行重建命令**（采纳"知道该重建
  和知道怎么重建之间隔着一次翻源码"）。自动拷贝不做，理由正是本节提供的反例——判定依据
  与决策记录见 [`scaffold-startup-guards-fallout.md`](./scaffold-startup-guards-fallout.md) 处理结论。
- 附议的 fe 守卫抽函数已落地（`fe_assert_port_free` / `fe_confirm_bound`，采 trend 命名）。

落地位置：`deploy/scaffold/{run.sh,init.sh,upgrade.sh,docs/README.md}` + `api/sample/tests/item.test.js`
+ CHANGELOG。全部记入 `[Unreleased]`，随下一个 v1.1.x tag 下发；trend 本地已打的补丁与
新 stock 语义同款，merge 时以 stock 为准。
