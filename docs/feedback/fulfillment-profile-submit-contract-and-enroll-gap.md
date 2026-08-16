# 反馈：`profile.submit` 被一行描述和一条通用报错双重误导，且无法把既有 profile 纳入审核

> 来源：colony 派生项目。现象最初记录于 2026-08-11 压测（见本目录
> `fulfillment-condition-fail-open.md` 第四节「附带发现」）；2026-08-16 因 colony 计划把
> 持仓生命周期建成 fulfillment 镜像（trade 模版）而回头对 solo 源码逐行核对，定性反转。
> 依据：**分两类标注**——「现象」是 2026-08-11 colony 实测（原始报错当时留档）；
> 「根因与定性」是 2026-08-16 对 solo 仓库源码的静态核对（本文所有 `文件:行号` 皆此次核对）。
> 未做新的运行时复现——问题在契约层面，代码路径静态可判。
> 涉及：`api/apps/fulfillment/logic/profile.js`、`api/apps/fulfillment/config.js`、
> `api/library/entity.js`、`api/apps/fulfillment/GUIDE.md`。
> 影响面：所有按方法一行描述（`system.service.list` 里那句）使用投稿/审核通道的调用方，
> 尤其 AI 代理——照描述办事就会复现下面的撞墙。
>
> 一句话：submit 实际是「在审核通道里**创建**新 profile」，GUIDE 写对了，但方法描述写成
> "Submit a profile for review"、撞已存在 id 时又抛工厂通用的 "already exists"——两处都把人
> 引向「提交现有 profile 进审核」这个**不存在的语义**；而真想做的「把既有 profile 事后纳入
> 审核」（追溯治理）在当前实现里没有任何路径。

---

## 一、现象回放（2026-08-11 colony 实测，引用）

对一个已用 `profile.create` 建出的 profile 调 `fulfillment.profile.submit`
（预期语义：提交它进入审核）：

```
❌ [-32602] profile id "ant_cycle_probe2" already exists
```

随后 `profile.approve` 报 `Cannot approve a profile in reviewState: (none)`。
当时的定性是「submit 走了 create 的重名校验，审核流程整条走不通」——**这个定性是错的**，见下。

## 二、源码核对：这是双通道设计，submit 是投稿通道的创建入口

fulfillment 的治理模型是两条通道（`logic/profile.js:21-24` 注释言明）：

| 通道 | 入口 | reviewState | 可用性 |
|---|---|---|---|
| 可信直建 | `profile.create` | 无 | 立即可用，免审 |
| 投稿 | `profile.submit`（带**完整定义**） | `PENDING_REVIEW` | 审批后才可用 |

- `submit` 接的是完整 profile 定义（name / transitions / meta_fields），lint 通过后
  `factory.create(...)`（`logic/profile.js:115-133`）——它本来就是创建动作，不是状态迁移；
- 实例侧的门 `if (profile && profile.reviewState && profile.reviewState !== 'APPROVED')`
  （`logic/instance.js:57-62` 与 `:159-162`，transition 与 instance.create 各一处）
  **刻意放行「无 reviewState」**＝可信直建免审，注释写明
  "direct-create profiles carry no reviewState → never gated"；
- `GUIDE.md:39-46` 的参数签名 `{ name, transitions, meta_fields?, allowedActions? }` 与此一致。

⇒ **GUIDE 是对的**。问题在另外三处。

## 三、真正的问题（三条）

1. **方法一行描述误导**（`config.js:42`）：
   `'Submit a profile for review (lint-gated → PENDING_REVIEW); not usable until approved'`
   ——完全读不出「这是创建一个新 profile」。而这句是 `system.service.list` 里调用方
   （尤其 AI 代理）最先看到、且往往唯一看的契约。中文条目 `config.js:73`
   （「投稿配置模板供审核」）稍好，但同样没有言明「创建」。
2. **报错来自实体工厂的通用重名校验**（`library/entity.js:201`
   `${entityName} id "${id}" already exists`），在 submit 语境下指向完全错误的方向：
   调用方会去查「为什么 create 被重复调了」，而不是意识到「submit 原来就是创建」。
3. **没有 enroll 路径**：`update` 对无 reviewState 的 profile 直接放行且不改通道
   （`logic/profile.js:80`）⇒ 一个可信直建的 profile **永远无法事后纳入审核**。
   治理是建档时一次性 opt-in 的——想给已在用的 profile 补一道审核，做不到。

## 四、对本目录旧 feedback 的更正（`fulfillment-condition-fail-open.md` 第四节）

triage 时请以本文为准：

- 附带发现 #1 说「submit 的语义是提交现有 profile 进入审核，不该走创建路径的重名校验」
  ——**前提错了**，submit 就是创建。该修的是描述与报错（上面 1、2），不是 submit 的路径。
- 附带发现 #2 建议「把守卫改成缺 reviewState 视为未审核」——**这条建议请忽略**：
  它会把可信直建通道整个打死（所有 `profile.create` 出来的 profile 立即不可用）。
  守卫按双通道设计工作正常，不是 bug。

## 五、建议（按价值排序）

1. **submit 撞已存在 id 时给专用报错**（一行改动，价值最高）：明说
   「submit 在审核通道**创建**新 profile；id "X" 已存在（可信直建、免审）。换一个 id，
   或参考 enroll（若目的是把它纳入审核）」。现在这个报错是整场误会的引爆点。
2. **改 `config.js:42` 的一行描述**（`config.js:73` 中文同步）：
   「投稿一个**新** profile 供审核（在审核通道创建；lint 把关 → PENDING_REVIEW；审批前不可用）」。
3. **补 enroll 能力**（missing_capability）：给 submit 或 update 加参数
   （如 `submit { id, enroll: true }`），把既有可信 profile 转入 `PENDING_REVIEW`。
   转入即冻结其实例——复用现有 activation gate（`instance.js:57`），机制全是现成的。
   没有它，「先跑起来、后补治理」这条最常见的演进路径不存在。
4. （文档）GUIDE 双通道处显式写一句「可信直建的 profile 无法事后纳入审核」——
   在 #3 落地前，把这个边界从隐式变显式。

---

## 处理结论（solo 侧）

**triage 2026-08-16：全部核实属实，四条建议全部采纳落地。**

引用核对：`config.js:42/73` 的描述、submit 走 `factory.create`（`logic/profile.js`）、
`update` 对无 reviewState 直接放行、`entity.js` 通用重名报错、instance 守卫刻意放行无
reviewState——逐条与源码一致；对旧 feedback（`fulfillment-condition-fail-open.md` §四）
的两条更正也成立，已在旧文该节头部加注「以本文为准」。

已做：

1. **专用报错**（建议 1）：submit 撞已存在 id 时捕获工厂的 "already exists" 并翻译成
   通道契约语言——点名「submit 是在审核通道里创建」、报出对方所在通道（可信直建 /
   reviewState），并指路 enroll。
2. **描述改写**（建议 2）：`config.js` 英中两条都明示「创建新 profile」+ enroll 用法；
   `handlers/introspection.js` 同步加 `enroll` 参数声明、改注释。
3. **enroll 落地**（建议 3）：`submit { id, enroll: true }` 把既有可信 profile 转入
   PENDING_REVIEW——重 lint（坏的拒收、原样保持可用）、清 approvals/approvedDigest、
   实例经现有激活闸立即冻结。两个设计决策：
   - **handler 层 admin 门**：enroll 会冻结实例，不能让普通投稿人当 DoS 开关；
   - **记 `enrolledBy` 而非 `submittedBy`**：enroll 是治理请求不是内容投稿，记成
     submittedBy 会触发 approve 的「审批人 ≠ 投稿人」而让单管理员系统 enroll 后无人能批。
4. **文档**（建议 4）：GUIDE.md 配方二加第 4 步（enroll），坑与约定里显式写明
   「submit 是创建；直建 profile 事后纳管只有 enroll 一条路」。

验证：新增 `tests/profile-lanes.test.js`（7 用例：创建语义 / 专用报错内容 / enroll 正反路径 /
单管理员可自批 / lint 拒收不改状态）全绿，已入 CI 白名单；autocheck --static 通过。
