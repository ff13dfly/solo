# 架构协调性债 —— "长歪了"清单（非 bug，是不一致）

> **这是 [`BACKLOG.md`](./BACKLOG.md) 的一条 drill-down**（仿 [`return-contract-debt.md`](./return-contract-debt.md)）。
> 收的不是"缺功能"也不是"有 bug"，而是**长期只加不破加出来的不一致 / 同一件事多处各写一遍 / 约定与实践打架**——
> 系统能跑，但"看着不协调"，且是"下次加功能最容易再踩"的地方。典型代表 = 已收敛的"public method 太多"。
>
> **来源**：2026-07-01 会话架构协调性走查（带 `file:line` 证据）。**校对基准**：2026-07-01（v1.1.8）。
> **归属标注**：🔒 = 触及 `api/router/`（受保护，改动需明确授权）；➕ = 可在 v1.1.x「只加不破」顺手做；💥 = 干净修需破坏性窗口（v2 候选，喂 [`VERSION.v2.md`](./VERSION.v2.md)）。

---

## 汇总

| # | 不协调点 | 咬人程度 | 归属 |
|---|----------|----------|------|
| 1 | 四份各自为政的 60s 进程内缓存，多数无 bust | 🟡 **功能面已修**（写即 bust）；DRY 合并留 v2 | 🔒➕（本轮已授权改 router）|
| 2 | 两份必须手工同步的 bot 权限图 | ✅ **已修**（单一真源 `deploy/bot-permits.js`）| ➕ |
| 3 | `public` 声明散在 3 层，无单一真源 | 🟠 收敛面反复踩的结构根因 | 🔒💥（systemApi 层在 router）|
| 4 | 服务内 admin 校验深浅不一（8 服务 vs 纯 Router）| ✅ **误诊/已澄清**（是数据面 vs 运维面的一致切分，保留不动）| ➕ |
| 5 | services.json 端口 ≠ config.js `portFor` 默认 | ✅ **已修**（CI 守门强制 === services.json）| ➕ |
| 6 | 返回契约债（list 形状不统一）| 🟡 已有专档 | ➕（见 return-contract-debt.md）|
| 7 | 桩方法与真方法混排在同一 introspection | ⚪ 认知负担 | ➕ |

> **一句话性质**：#2/#3/#5 是同一家族——**同一份事实存在于多处、靠手工/注释同步**（"没有单一真源"）；
> #1 是**复制粘贴的缓存模式没有共享抽象、且写路径不 bust**；#4 **经核实是误诊**（数据面信 Router / 运维面 handler 硬门是一致切分，非"实践没跟"）；#6/#7 是已知诚实债。

---

## 1. 🔴🔒💥 四份各自为政的 60s 进程内缓存，多数没有 bust

**现象**：至少 4 处用**同一套 copy-paste**（`CACHED_X` + `LAST_FETCH` + `CACHE_TTL = 60_000` + read-through）缓存 Redis 配置，各写一遍、**无共享抽象**：
- `api/router/handlers/events.js:59-81`（事件注册表）🔒
- `api/router/handlers/tasks.js:8-40`（`_tasks` 白名单）🔒
- `api/router/handlers/ratelimit.js:3-30`（限流规则）🔒
- `api/core/agent/logic/model_config.js:11,44-71`（AI 模型映射）➕

**为什么不协调**：更糟的是**写路径不 bust 缓存**——`setting.task.update` / `setting.limit.update`（`router/handlers/system.js`）写了 Redis 却不失效对应缓存 → "运行时可 RPC 覆盖"是**半真话**（要么等最多 60s，要么竞态）。
**这不是理论问题**：[`BACKLOG.md §5.6③`](./BACKLOG.md) 那个全量 e2e flaky，根因就是 taskWhitelist 缓存无 bust + 多写者致值翻转（已用"固定单一超集"绕过，但**缓存本身的半成品性质没动**）。`model_config` 本轮加了写后 `_cache=null` bust（`model_config.js:52`），是四处里唯一"写即生效"的——反而凸显另外三处的不一致。

**修法方向**：抽一个 `library/cached-config.js`（read-through + TTL + 显式 `invalidate(key)`，或 Redis pub/sub 广播 bust）；`setting.*.update` 写后调 `invalidate`。

**✅ 功能面已修（2026-07-01，已授权改 router）**——采最小方案，只补"写即 bust"，不动读路径、不做共享库抽取：
- `router/handlers/tasks.js` + `ratelimit.js`：各加 `invalidate()`（重置 `CACHED_X`/`LAST_FETCH`），导出。
- `router/handlers/system.js`：`updateTaskWhitelist` / `updateRateLimits` 两个 admin 写路径 `redisClient.set(...)` 后各调一次 `invalidate()`（惰性 require 免循环依赖）→ 配置写即生效，不再等 ≤60s / 竞态。
- `router/handlers/events.js`：**无需改**——全仓无运行时写者（`EVENT_REGISTRY` 只在 boot 播种一次），缓存不可能陈旧。
- `agent/logic/model_config.js`：本轮早先已加 bust（`init`/`set`/`reset` 置 `_cache=null`），是四处里的样板。
- 影响面：读路径（`getWhitelist`/`getRules`）一字节未动 + 60s TTL 兜底保留（双保险）；触发面仅 admin 低频配置写 RPC。+2 hermetic（`tasks.test.js`/`ratelimit.test.js`），CI 子集 109 套/1729 绿、全量 e2e 复跑绿。

**剩（💥 v2）**：把四处 copy-paste 收敛成一个共享 `library/cached-config.js`（DRY + 统一 pub/sub bust，多机部署时才真正需要跨进程 bust）——纯一致性收敛，无功能缺口，留破坏性窗口一并做。

---

## 2. 🟠➕ 两份必须手工同步的 bot 权限图

**现象**：`system.*` bot → permit 的映射**存在两份**，靠注释保持一致：
- `deploy/seed-bots.js:30-48`（生产/dev 播种，9 个 bot）
- `e2e/harness/setup.js:189-209`（e2e mesh 播种，19 处，含事件注册表 bot）

**为什么不协调**：本轮加 `system.user`（passport OTP 投递）就得**在两处各写一遍**（CHANGELOG [v1.1.8]）；谁改一处忘另一处即漂。注释里明写"镜像 e2e harness seedBots"——**需要注释来提醒同步的东西，本身就该抽单一真源**。

**修法方向**：抽一份共享的 `deploy/bot-permits.js`（或 JSON），两处 `require` 同一份（e2e 若需额外的注册表 bot，做成 base ∪ e2e-extra）。与本轮把 taskWhitelist 收成 `e2e/lib/whitelist.js` 单一真源同一招。
**归属**：纯增量、不碰 router、可随时做。

**✅ 已修（2026-07-01）**——两份 `BOTS` 经比对**逐字节相同**（同 8 个 bot、同 permit），故为纯重构、零行为变化：
- 新增 `deploy/bot-permits.js` 导出 `BOT_PERMITS`（纯数据、零依赖，可从 `deploy/` 与 `e2e/` 两处安全 require）。
- `deploy/seed-bots.js` + `e2e/harness/setup.js` seedBots() 各 `require` 同一份 —— **两处 seeding 流程刻意保留不同**（dev 直写 `RELAY:TOKEN:{svc}` / e2e 走 `{svc}.token.set` RPC），只共享 permit 数据。加新 relay bot 从此只改一处。
- 验证：`deepStrictEqual` 对齐重构前快照（证零漂移）+ 全量 e2e 66/66 套绿（bot-relay 三链 nexus 投递 / refund 审批门 / orchestrator 审批实际经 `BOT_PERMITS` 播种通过）。
- 未动 `deploy/scaffold/e2e/harness/setup.js`（下游脚手架模板，刻意自包含，不引 solo 内部路径）。

---

## 3. 🟠🔒💥 `public` 声明散在 3 层，无单一真源

**现象**：一个方法算不算匿名可达，分散在**三处**：
- router `logic/system.js` `systemApi`（Phase-2 公开标志）🔒
- 服务 `handlers/introspection.js` 的 `capMap`（Phase-3 `public:true/false`）➕
- 服务 `handlers/auth.js` 的 `publicMethods` 列表（`library/auth.js` best-effort 身份解析）➕

**为什么不协调**：这**正是"public method 太多"难收的结构根因**——收窄一个方法要三处对齐（本轮 storage / user / agent 收敛都各动了多层），漏一层就是洞或不一致（如身份解析层放行但 capMap 已 `false`）。没有"这个方法是否 public"的单一权威。

**修法方向**：以服务 introspection `capMap` 的 `public` 为唯一真源，Router 侧从各服务 introspection 派生 systemApi、服务 auth 的 publicMethods 也从 capMap 派生（而非手维护列表）。
**归属**：systemApi 派生逻辑在 router（受保护）；capMap/publicMethods 侧可先统一。干净收敛建议放 v2 窗口。

---

## 4. 🟢➕ 服务内 admin 校验：起初记作"深浅不一"，核实后是**误诊**

**原记法（存疑）**：多个服务在 handler 里**又做了一层** admin/`needAdmin` 校验，其余纯靠 Router `checkAccess`；疑似冗余（belt-and-suspenders 违约定）或"为什么是这几个"的随机性。

**✅ 已核实（2026-07-01）——不是"深浅不一"，是一条一致的两平面切分；结论：保留现状（不动）**：

按方法（而非服务名）归类,in-handler `if(!isAdmin)` 拦的**全是运维/基础设施面**方法,数据面从不拦:
- **relay token 生命周期** `{svc}.token.set/status/clear`(7 服务:ingress/notification/nexus/orchestrator/collection/fulfillment/approval)——写 `RELAY:TOKEN` = 冒充该服务的 bot 身份
- **运行时急停** `control.pause/resume`(nexus/orchestrator)、**死信重投** `deadletter/dlq.*`、**调度 CRUD** `nexus.schedule.*`、**事件取证** `nexus.event/trace.*`、**入站源+密钥轮换** `ingress.source.*`、**Sentinel 注册管理** `nexus.sentinel.*`、**履约档审批门** `fulfillment.profile.approve/reject`
- **user**（异类）= 身份权威,刻意的四态策略矩阵:public(register/login/passport.otp)/ self-or-admin(permit.get)/ permit-gated **不硬门**(role.*/passport.* 故意交 Router 委派)/ hard-admin(account/permit.update/bot/key.revoke)

**为什么"删掉交给 Router"是错的（关键）**：Router `checkAccess` 结构上只有**两档**——`public`(匿名可达) / 非 public(调用者 permit 的 `services` 里**列了该方法**或 `permit==='admin'` 即放行)。introspection 里**没有机读的 admin 字段**（admin-ness 只活在 description 散文里）。于是 **Router 表达不了"硬 admin-only、不可委派"这一档**:一个 scoped `user` permit 只要在映射里列了 `nexus.control.pause` 就能过 Router——真正把它挡在"必须完整 admin"的正是那句 in-handler `if(!isAdmin)`。
**故删掉 ≠ 行为保持的清理,而是悄悄放松安全**:任何被授予该方法的 scoped permit 就能急停自动化 / 改 relay token / 重投死信。

**为什么是"一致"而非"随机的这几个"**：连 orchestrator——`AUDIT.md H1` 里"**故意不做** in-handler permit"的样板——都照样硬 admin 门它的 `token/control/run`(运维面),只对 `workflow.*`(数据面)交 Router+constraints。所以真规律是 **数据面信 Router；运维面/基础设施面 handler 硬门(不可委派)**,不是随机。"为什么是这几个"的答案 = 谁有 ops-plane/token 方法谁就有。

**结论**：这不是协调性债,是 Router 二档模型的**必要补足**,**保留不动**即为正确默认。
**剩下唯一(可选、低优、留 v2)的化妆项**：admin-ness 没有机读标志,消费者/AI 只能读散文分辨。若要根治"看着随机",可给 introspection 加 `tier:'admin'` 之类机读字段供能力发现过滤——非阻塞、非增量急需,与 #7(桩/真机读标志)同族,可一并做。

---

## 5. 🟡➕ services.json 端口 ≠ config.js `portFor` 默认

**现象**：`deploy/services.json`（运行权威）与各服务 `config.js` 的 `portFor(name, fallback)` 兜底默认**不完全一致**，靠 env 覆盖对齐。`CLAUDE.md §2` 得专门写一句"以 services.json 为准"。

**为什么不协调**：**需要文档警告才能避坑的东西，本身就是两份端口真源**。`library/ports.js` 的 `portFor` 兜底值和 services.json 各活各的。

**修法方向**：让 `portFor` 在缺 env 时直接读 `services.json` 作兜底（单一真源），而非各 config.js 硬编码 fallback。
**归属**：`library/ports.js` + 各 config，纯增量可做。

**✅ 已修（2026-07-01）——但没走"让 portFor 读文件"那条路（它与 `ports.js` 的既有不变量冲突）**：
- `api/library/ports.js` 头注明确其**零运行时依赖、刻意不读 services.json**——bundle 里由 gen-entry 把 services.json 播进 `global.__SOLO_PORTS__`，`portFor` 只读那个 global。让它 `fs`/`require` 读文件会破坏 bundle 安全性（下游打包路径不存在）。故原"读文件"建议**作废**。
- 现状核实：13 个 canonical 服务的 `portFor` 兜底**当前已全部 === services.json**（无活跃漂移）；问题是"对齐靠手工 + 一句 CLAUDE.md 注释、无机制防未来漂移"。且 `monolith-entry.js` 不播 `__SOLO_PORTS__` → 兜底在 monolith/单服务 from-source 启动时是**载荷性**的，更该守住。
- 采**强制而非合并**：`deploy/check-doc-drift.js` 加 §2.5——对 services.json 每个服务，正则抓其 `config.js` 的 `portFor('name', N)` 兜底，断言 `N === services.json.port`；缺 config.js / 缺 portFor 调用亦报错。services.json 成为**强制单一权威**，config 兜底降为 CI 校验的镜像。
- 影响面：**零运行时改动**（不碰 `ports.js` / 任何 config.js / router），纯加一道 CI 守门。三态验证：干净 PASS、注入漂移（user 8710→8711）被抓、还原 PASS。顺修 `CLAUDE.md §2` stale 注释（"不完全一致"→"CI 守护 === services.json"）。
- `collection`/`market`/`sample` 不在 services.json（非 canonical 13），守门不校验它们——范围正确。

---

## 6. 🟡➕ 返回契约债（list 形状不统一）

**现象**：~47 条非阻塞形状不一致（裸数组 list vs `{items:[]}` 对象、同族方法形状分歧、agent provider 返回分歧、条件键）。
**详情**：已有专档 [`return-contract-debt.md`](./return-contract-debt.md)（2026-06-18 审计，带 file:line）。**本条只作交叉引用，不重复。** 守卫已建（`library/contract.js` + ai:true 覆盖闸 + `fulfillment/logic/lint.js`）。

---

## 7. ⚪➕ 桩方法与真方法混排在同一 introspection

**现象**：诚实标注的桩和真方法排在**同一个方法目录**里，消费者扫 introspection 分不清"能用 vs 占位"，得逐条读描述：
- `library/vector.js`（纯桩、零生产引用、`vector.test.js` 自标 vacuous）
- `apps/planner` `todo.analyze`/`todo.schedule`（`introspection.js` 标 `STUB_RETURN`）
- `agent` `openai`/`bitexing` 的 `focus`/`identifyPurpose*`（选中即 throw "not implemented"）、`gemini.focus`（未完成桩）

**为什么不协调**：introspection 是消费者/AI 发现能力的权威目录，但**"实现完成度"没有机读标志**——`ai:true` 的桩尤其危险（可能被 autorun 选中）。

**修法方向**：introspection 加 `status: 'stub'|'partial'|'ready'` 机读标志（或复用既有 `STUB_RETURN` 约定统一化），能力发现时可过滤。
**归属**：introspection schema 增字段，纯增量。

---

## 怎么用这份文档

- **v1.1.x 顺手做**（➕、不碰 router、纯增量）：~~#2（bot 图单一真源）~~ ✅ 已修、~~#4（admin 深浅定性）~~ ✅ 误诊已澄清·保留不动、~~#5（端口单一真源）~~ ✅ 已修、#7（introspection 完成度标志）。
- **留给 v2 破坏性窗口**（💥）：#1（统一缓存 + bust，3/4 在 router）、#3（public 单一真源，systemApi 派生在 router）——这两个是"加功能最容易再踩"的，最值得在能破坏时一次理顺，已登记为 v2 候选（见 [`VERSION.v2.md`](./VERSION.v2.md)）。
- #6 走既有 [`return-contract-debt.md`](./return-contract-debt.md)。
