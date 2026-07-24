# Changelog

SOLO 各发布版本的变更记录。**消费者升级前读这个。**
格式参考 [Keep a Changelog](https://keepachangelog.com/)。**每打一个 tag,加一条**(发版流程见 [`../runbook/release-and-branching.md`](../runbook/release-and-branching.md))。
>
> **约定(必填字段)**:每个版本条目结尾写一行 **`下游 action：<无 | 具体要做什么 + 迁移指南链接>`**。`deploy/scaffold/upgrade.sh` 升级时会自动扫描比消费者当前版本新的所有条目,把非「无」的 `下游 action` / `BREAKING` 弹成红色 ACTION REQUIRED 横幅——覆盖 bundle 是静默的,这行是给下游的合同,别省。

---

## [Unreleased]

> main 上已合入、尚未打 tag 的改动（下一发布点 = 从 main 打下一个 `v1.1.x`）。

---

## [v1.1.12] — 2026-07-24

> 观测性 + 自描述面收尾 + 一个静默排序哑雷修复。纯框架内改动,**零 wire 破坏**。CI 绿色子集 116 套(entity/search 直接相关 4 套 112 测试全绿;唯一红点是 `decide.test.js` 的 `liveGemini` 段——本机有 Gemini key 才跑的真实 LLM 调用,输出不确定,与本次无关)。全程不碰 `api/router/`。

### Fixed
- **entity 列表排序对 ISO / 毫秒时间戳混排健壮**(`api/library/entity.js`)。Entity Factory 的 `list`/`multiGet` 默认按 `createdAt` 数字降序,但 storage/user 等服务把 `createdAt` 存成 ISO-8601 字符串 → `(b.createdAt||0)-(a.createdAt||0)` 得 `NaN` → 比较器 no-op → "newest-first" 静默退化成 Redis SET 的无序。新增非抛错的 `toSortableMs()` 归一(数字原样 / ISO 走 `Date.parse` / 缺失或垃圾→0),两处排序改用之;对既有纯数字数据结果逐字节不变。回归:`entity-list-order.test.js` +3 用例(纯 ISO / ISO+毫秒混排 / 垃圾值垫底),5/5 绿。

### Added
- **14 个服务 GUIDE.md 全覆盖**(fleet-standard `guide` 任务配方)。此前只有 agent/storage 有内容文件,其余 11 个服务(user/planner/fulfillment/approval/orchestrator/nexus/notification/administrator/mcp/gateway/ingress)`guide` 方法虽已接线,但无 GUIDE.md → `system.guide {service}` 返回 `available:false`。本次逐个照真实 introspection/logic 补齐(禁编造),外部 AI 代理现可经 `system.guide {service}` 拿到每个服务的跨方法配方 / 幂等键 / 字段约定。
- **autocheck `guide-check` 门禁**(`api/autocheck/static/guide-check.js`,WARN 级)。查两点:`index.js` 接线了 `'guide'` 方法 + 服务根有 `GUIDE.md`。已挂 PostToolUse 钩子 → 新建服务缺 guide 会当场提示。非阻断(warnings→exit 0)。
- **scaffold `upgrade.sh` 破坏性变更横幅**。升级时扫描 CHANGELOG 里比消费者当前版本新的所有条目,把非「无」的 `下游 action` / `BREAKING` 弹成红色 ACTION REQUIRED——补上"覆盖 bundle 是静默的、下游不知道自己还得改代码"这个通知缺口。

### Docs
- Move B(时间戳格式统一到 `clock.now()` 毫秒)登记为 v2 债,见 `BACKLOG.md §3`——破坏性 wire 变更 + 存量迁移,不在 v1.1.x 翻格式。

> 下游 action：无 —— `bash deploy/scaffold/upgrade.sh <proj>` 后自动生效,无需改消费者代码。

---

## [v1.1.11] — 2026-07-23

> AI 自描述面与需求回流(源起 wavely 反馈)。fleet-standard `guide` 方法 + `system.guide` 匿名第一跳 + `system.report` 闭环增强(去重计数 / triage 状态 / Portal AI Reports 页);并含 `_task` fire-and-forget 丢投修复(router 有限重试退避)与 orchestrator `deprecate`/`restore` 生命周期(新增 `DEPRECATED` 状态)。详见 `CLAUDE.md §4` / git tag `v1.1.11`。
>
> 下游 action：无(只加不破)。
>
> ⓘ 本条目为回填——`v1.1.11` 已打 tag 但当时漏写 CHANGELOG。

---

## [v1.1.10] — 2026-07-03

> 新增 MCP adapter（第 14 个服务，workflow-first）+ v2 出版清单拆分拉回两项落地（AI prompt injection 防御第二轮 · Saga durable 补偿 + 重试上限）+ `agent.decide` risk_tolerance 具名容忍度档 + orchestrator 执行轨迹持久化 + 若干治理/收敛项。**全程不碰 `api/router/`**。CI 子集 **114 套 / 1794 测试**绿；相关 e2e（`72-saga-compensation` / `73-saga-recovery`，含新增的持久化重试上限用例）对真实 17 进程全栈跑通 2 套/7 测；`check-doc-drift` / `check-error-codes` / `build` 均通过。

### Added（MCP adapter — workflow-first，2026-07-03）
> 收 `VERSION.v2.md` D 线判定只加不破、拉回 v1.1.x（见下方 Docs 一条）。
- 新增 `api/core/mcp/`，第 14 个服务，端口 8091（`deploy/services.json` / `CLAUDE.md §2` / `api/monolith-entry.js` 已登记）。`POST /mcp` 实现 MCP JSON-RPC 2.0 的 `initialize`/`tools/list`/`tools/call`（+`notifications/initialized`）：`tools/list` 把 `status:'ACTIVE'` 的 orchestrator workflow 映射成 MCP tool（`input_schema` 转标准 JSON Schema），`tools/call` 转发到 `orchestrator.workflow.run`。
- **鉴权**：adapter 自身不持有服务身份、不做鉴权——外部消费方自带窄 bot session token（`user.bot.create/issue.token`，一消费方一 bot，`permit` 显式枚举方法），`/mcp` 把 `Authorization: Bearer` 原样透传给 `relay.callAs(token, method, params)`，Router `checkAccess` 是唯一执行点（与 nexus 给每个 Sentinel 发独立 bot 身份同一机制）。
- **范围**：workflow-first——其余 RPC 方法汇入同一 `tools/list` 出口（能力表）是后续可加项，这轮未做。
- 验证：`core/mcp/tests/tools.test.js`（8 例，schema 转换 + isError 分支）+ 实机冒烟（5 条 `/mcp` 路径）+ autocheck 静态门通过。

### Added（AI prompt injection 防御 · 第二轮 — 基础检测，2026-07-03）
> 收 `VERSION.v2.md` C 线相邻项 + toFix.md"AI 当执行器"条目续作。
- 新增 `api/library/injection-detect.js`：4 类启发式注入话术模式扫描（ignore-instructions / role-override / role-tag-injection / guardrail-override），共享库，非 ingress-only。
- 接入 `ingress/logic/ingest.js` 的 dataSchema 校验管线——declared `type:'string'` 字段过完白名单后再过这层扫描，命中即走既有 dataSchema 违规同一条路径（`review.push()` 进人工审核队列），零新状态机、零新通道。
- 明确不做（这轮）：语义级检测、`data_fetchers` 等非 ingress 注入面、结构化信任标记。
- 验证：`library/tests/injection-detect.test.js`（10 例）+ `ingress/tests/ingest.test.js`（+2 例：命中→422+审核队列；正常自由文本不误报）。

### Added（Saga durable 补偿 — 跨重启续跑 + 重试上限，2026-07-03）
> 收 `VERSION.v2.md` B 线判定只加不破、拉回 v1.1.x（见下方 Docs 一条）。
- `orchestrator/logic/run.js` 新增 `compensationCheckpoint()`：把补偿游标（`compensationProgress`：按 forStep 键控的 `status/attempts/lastError`）持久化到 run 实体，在每次补偿尝试**前后**都写，故进程中途真崩溃也不丢已完成的尝试计数。
- `logic/runner.js` 的 `runCompensations()` 据此改造：已成功的补偿条目直接跳过（不重复调用下游）；`attempts` 达到 `config.worker.compensationMaxAttempts`（新配置，默认 3，跨重启不清零，`RUN_COMPENSATION_MAX_ATTEMPTS` 可覆盖）后标记 `exhausted`、停止自动重试（`compensation.failed` 仍触发既有 DEAD_LETTER 语义），避免"重启→失败→再重启→再失败"的无声循环。`logic/worker.js` 接线跨轮持久化透传。
- **零破坏边界**：无游标时（同步 RPC 路径 / 异步首轮）行为与改造前逐字节一致。
- 验证：`orchestrator/tests/run.test.js`（+2 例）+ 新文件 `compensation-durable.test.js`（5 例，runner 层 + worker/run 全链路层）+ `e2e/suites/73-saga-recovery.e2e.test.js`（新增 1 例，对真实全栈反复模拟"STALLED→`orchestrator.run.retry`"直到 `exhausted`，已跑通）。

### Added（`agent.decide` risk_tolerance 具名容忍度档，2026-07-03）
- `risk_tolerance`（`permissive`/`balanced`/`strict` → 0.6/0.8/0.95，`decide.js` `RISK_TOLERANCE_LEVELS`）替代硬编码 `confidence_threshold=0.6`，按 Gemini/Qwen 实测置信度聚在 1.0/0.9 标定档位；不传时行为与之前完全一致（只加不破）。`nexus context.autorun.risk_tolerance` 透传到 `agent.decide`。
- `governance.md §3` 双轨审批（orchestrator C1 vs approval 服务）方向拍板为方向 2——orchestrator 继续自建 C1，approval 专注非工作流类敏感变更；核实现状其实早已是方向 1+2 混合（HIGH 风险 workflow 走 `approval.gate.*` 多签，collection 退款走 `approval.record.*`），决策不回退既有路由，只管以后不再把 LOW 风险 C1 并入 approval。
- 顺带核实修正 toFix.md 三条陈旧未同步项（approval 消费者数量 / passport 自助注册状态 / workflow ACTIVE 绕过路径不存在）。
- 验证：`agent/tests/decide.test.js`（+4）+ `nexus/tests/context.test.js`（+1）。

### Added（public 面白名单守门，2026-07-03）
- 新增 `autocheck/static/public-surface-check.js`：把已核实、必要的 14 个 `public:true` 方法钉成显式白名单（按服务分），CI static 门逐服务扫描 introspection，出现白名单外的新 `public:true` 方法直接拦停。不改 `api/router/`（`access.js` 本身仍无机制性上限，红线未授权不动）——服务侧等效防线，非根治。

### Fixed（administrator `setting.config.*` in-handler admin 硬门，2026-07-03）
> 收 `coherence-debt.md` #4 政策落地。
- `get/set/del/list/schema` 五个方法加 `if (!p.isAdmin) throw UNAUTHORIZED()`，对齐同文件 `setting.automation.*` 既有写法——运维面方法不再纯靠 Router permit 下发保护。顺带核实澄清 toFix.md"自锁无门"记录为误诊：`admin.self.lock` 早有 in-handler 门，只是实现方式不同（`identity.js` 独立重读 session 校验，比简单透传更强）。

### Fixed（orchestrator 执行轨迹落盘，2026-07-03）
- 新增 `orchestrator/logic/trace-audit.js`（镜像 `ingress/logic/audit.js`）：`runner.js` 每次跑完 workflow 攒出的完整 step trace 此前只在返回值里，从未落盘（DONE 的 run 一点 trace 都留不下）。按天分区 JSONL，写盘前统一过 `redactSensitive`；同步/异步两条执行路径都覆盖；新增 admin RPC `orchestrator.run.trace`。toFix.md"执行轨迹持久化"条目已关；deprecate/reactivate 独立生命周期状态仍需先拍板，故意留着未动。
- 验证：`trace-audit.test.js`（7 例）。顺带修 `tests/utils/harness.js` 的 `LOG_DIR` 隔离（未修前整套 orchestrator 测试会真的往 repo `logs/` 目录写文件）。

### Docs
- `VERSION.v2.md` 六条主线重新过了一遍"能否只加不破"：A 线多租户开放档**已取消**（用 E 线 SOLO Bridge 联邦隔离替代，非拉回）、多机部署硬化拉回；B 线拆分为 `_task` 丢投窄义修法（真 bug，不分版本，**仍未实现，见 P0**）+ Saga durable 补偿（拉回，已实现于本版）+ 完整 at-least-once（降级为可选，仍留 v2）；C 线 autorun 置信判据重设计整体拉回（`risk_tolerance` 是其先行缓解，完整重设计仍未做）；D 线（passport TOTP / SSE / MCP adapter / 外部 agent SDK / metrics 正式档）全部拉回，MCP adapter 已实现于本版，其余未动。`VERSION.md`/`BACKLOG.md` 同步。新增 [`docs/planning/v1-implementation-plan.md`](./v1-implementation-plan.md)：把 toFix.md 剩余项 + v2 拉回项整理成 P0–P5 优先级清单，供后续推进依据（P1 注入检测 + P2 Saga durable 已从该清单勾掉）。

---

## [v1.1.9] — 2026-07-02

> 架构协调性债清理（[`coherence-debt.md`](./coherence-debt.md) #1 缓存写即 bust · #2 bot 权限图单一真源 · #4 服务内 admin 校验误诊澄清 · #5 端口单一真源 CI 守门）+ actor-claim 最小可行档（预审 + 透传 + 审计，AUDIT C4 / confused deputy 最小面闭合）。**#1 功能面修复触及 `api/router/`**（用户明确授权改动，范围仅限缓存 bust）；其余四项全部服务侧 + CI 守门，不碰 router。CI 子集 **110 套 / 1751 测试**绿；全量 e2e 66 套复跑绿；`check-doc-drift` + `check-error-codes` 守门通过。

### Added（actor-claim 最小可行档 — confused deputy 最小面闭合，2026-07-02）
> 收 CLAUDE.md §4 推进顺序第 4 条（预审 + 透传 + 审计，**暂不上服务凭证签名**）/ toFix §二.事件链 confused deputy（major）/ orchestrator AUDIT C4 最小档。**纯 orchestrator 服务侧，不碰 router**；默认行为零变化（只加不破）。
- **问题**：事件路径的 run 在共享 `system.orchestrator` bot 下执行，H6 足迹预审查的是 **bot 的宽 permit**（trivially pass）；信封里的 `actor` 被 matcher 直接丢弃——谁能往被订阅的流 emit，谁就借到 bot 的权限驱动下游动作。
- **透传**：`matcher.js` 把信封 `actor`（引发者）+ `source`（Router 认证发射者）带进 run-command → run 实体新增 `actor`/`actorSource` 字段（永久归属审计）→ runner `$context.trigger_actor`（只读溯源，禁作鉴权输入）；`run.grant` / `run.retry` 恢复路径全程保留（grant 重入队顺带补上此前会丢的 trace/parentEventId）。
- **opt-in 预审**：workflow 新字段 **`require_actor_permit: true`**（默认 `false` = 现状）→ 事件触发的 run 在 H6 之后加查 **actor 本人 permit 是否覆盖全足迹**（`user.permit.get` 同时解析 user/bot uid）。Fail-closed：actor 缺失或不可解析形态（`sentinel:{id}` / `cron:{id}` / `anonymous`）直接 FORBIDDEN；**刻意不走 NeedsGrant**（运营 grant 补 bot 的权限缺口，不能洗白 actor 的）。字段 ACTIVE 期冻结（同 steps/resolvers）、审中改动作废在途签名闸；introspection 声明↔注册同步（workflow doc/create/update + run doc/enqueue）。
- **审计 + 毗邻修复**：ops 通知（needs_grant / run_failed）payload 带 actor；worker 永久拒绝 / 重试耗尽时 **run 实体同步收尾 `DEADLETTER`**——修掉"被拒 run 滞留 RUNNING → stall 扫描 ~10min 后假报 worker died"的既有噪音。
- **验证**：新 hermetic `orchestrator/tests/actor-precheck.test.js`（11 用例：默认关零影响 / 无 claim 拒 / 前缀形态 fail-closed / 足迹缺口 403 列清单 / 覆盖放行 / bot-uid actor 解析 / sync 跳过 / 瞬时故障可重试）入 CI 白名单 + matcher/worker/run/static-workflow-hardening 扩展（透传 / DEADLETTER 收尾 / 字段冻结 / 闸作废）。CI 子集 **110 套 / 1751 测试**绿；全量 e2e 66 套复跑绿；orchestrator autocheck 静态门过。
- **顺修（e2e 既有笔误，非本改动引入）**：`suites/96-full-pipeline` test-2 的状态白名单把 `RUNNING` 写成小写 `'running'`（初始提交 a977856 即如此；run.js 状态机全大写）——轮询一发现 run 文档即 break，500ms tick 落进 run 执行的短窗口就假红（本轮复跑首次抓现行）。改正大小写。
- **剩（跨信任域档，仍暂缓 = AUDIT C4 原判断）**：X-Actor-Claim 签名头、orchestrator 服务凭证、`library/actor-claim.js`。

### Fixed（Router 配置缓存写即 bust — 架构协调性债 #1 功能面，2026-07-01）
> 收 [`coherence-debt.md §1`](./coherence-debt.md)：Router 把 `_tasks` 白名单 / 限流规则缓存在进程内 60s，但 admin 写路径**不 bust 缓存** → "运行时可 RPC 覆盖"最多陈旧 ≤60s / 竞态（§5.6③ flaky 的根因）。**用户明确授权**改 router。
- `router/handlers/tasks.js` + `ratelimit.js`：各加 `invalidate()`（重置 `CACHED_X`/`LAST_FETCH`），导出。
- `router/handlers/system.js`：`updateTaskWhitelist` / `updateRateLimits` 两个 admin 写路径 `redisClient.set(...)` 后各调一次 `invalidate()`（惰性 require 免循环依赖）→ 配置写**立即生效**。
- **最小影响面**：读路径（`getWhitelist`/`getRules`）一字节未动 + 60s TTL 兜底保留（双保险）；触发面仅 admin 低频写 RPC。`events.js` 无运行时写者、不需要改；`agent/logic/model_config.js` 本轮早先已带 bust（样板）。+2 hermetic（`tasks`/`ratelimit`），CI 子集 109 套/1729 绿、全量 e2e 66 套连绿、零回归。
- **剩（v2）**：四处 copy-paste 缓存收敛成共享 `library/cached-config.js`（DRY + 多机 pub/sub bust）—— 纯一致性、无功能缺口，留破坏性窗口。

### Changed（bot 权限图单一真源 — 架构协调性债 #2，2026-07-01）
> 收 [`coherence-debt.md §2`](./coherence-debt.md)：`system.*` relay-bot 的 `uid → permit` 映射历史上**存在两份**（dev 播种 `deploy/seed-bots.js` + e2e mesh 播种 `e2e/harness/setup.js`），靠注释"镜像 seedBots"手工同步——本轮加 `system.user` 就得两处各写一遍，漏一处即漂。
- 新增 [`deploy/bot-permits.js`](../../deploy/bot-permits.js) 导出 `BOT_PERMITS`（纯数据、零依赖），两处 `require` 同一份。**两处 seeding 流程刻意保留不同**（dev 直写 `RELAY:TOKEN:{svc}` / e2e 走 `{svc}.token.set` RPC），只共享 permit 数据。
- **纯重构、零行为变化**：两份 `BOTS` 经比对逐字节相同（8 bot / 同 permit）；`deepStrictEqual` 对齐重构前快照 + 全量 e2e **66/66 套绿**（bot-relay 三链 nexus 投递 / refund 审批门 / orchestrator 审批实际经 `BOT_PERMITS` 播种通过）。未动 `deploy/scaffold/`（下游模板刻意自包含）。不碰 router。

### Added（端口单一真源 CI 守门 — 架构协调性债 #5，2026-07-01）
> 收 [`coherence-debt.md §5`](./coherence-debt.md)：`deploy/services.json` 是端口运行权威，但各服务 `config.js` 的 `portFor(name, fallback)` 兜底靠手工 + 一句 CLAUDE.md 注释保持一致、无机制防漂移（monolith / 单服务 from-source 启动时兜底是**载荷性**的 → 不是死代码）。
- **没走 coherence-debt 原建议的"让 portFor 读 services.json"**——`library/ports.js` 头注明确其零运行时依赖、刻意不读文件（bundle 由 gen-entry 播 `global.__SOLO_PORTS__`），让它 `fs` 读会破坏下游打包。改为**强制而非合并**：`deploy/check-doc-drift.js` 加一段，对 services.json 每个服务断言其 config.js `portFor('name', N)` 兜底 `N === port`。
- **零运行时改动**（不碰 `ports.js` / 任何 config.js / router），纯加 CI 守门。三态验证：干净 PASS、注入漂移（user 8710→8711）被抓、还原 PASS；顺修 `CLAUDE.md §2` stale 注释（"不完全一致"→"CI 守护 === services.json"）。现状 13 服务兜底本就全对齐（此为**防未来漂移**）。

### Docs
- 新增 [`docs/planning/coherence-debt.md`](./coherence-debt.md)：「架构协调性债」清单（7 条"长歪了"的不一致，带 file:line + 归属标注 🔒/➕/💥），从 BACKLOG §3 索引。**已修 #1（缓存写即 bust）+ #2（bot 图单一真源）+ #5（端口单一真源 CI 守门）**。
- coherence-debt **#4（服务内 admin 校验）经核实为误诊、已澄清·保留不动**：原记作"深浅不一/随机的 8 服务"，按方法归类后是一条一致切分——**数据面信 Router `checkAccess`；运维/基础设施面（relay token / control / schedule / dlq / source / sentinel 管理 / 审批门）在 handler 硬 admin 门**。因 Router 只有两档（public / permit-listed），**结构上表达不了"硬 admin-only、不可委派"**，故删掉 in-handler 层 ≠ 清理而是悄悄放松安全（scoped permit 一旦列了该方法即可达）。连 orchestrator（AUDIT.md 里"故意不做 in-handler permit"的样板）都照样硬门其 ops-plane token/control/run，佐证是**一致而非随机**。唯一可选化妆项（低优、留 v2）：introspection 加机读 `tier:'admin'` 标志（与 #7 同族）。

---

## [v1.1.8] — 2026-07-01

> 测试基础设施硬化 + 收敛收尾。全量 e2e 的三个共享-mesh flaky 机制（BACKLOG §5.6 ①poll 超时 / ②`ERROR:QUEUE` 跨套污染 / ③新发现的 Router taskWhitelist 60s 缓存竞态）**结构性清零** —— 连跑两轮 **66 套/349 测试稳定绿**（耗时 ~303s→~117s，不再空耗超时）。附带收尾：passport `otp.request` per-anchor 请求限流、`storage.asset.get/resolve` 转 permit 门控（**公开方法 19→17**）、passport OTP 生产投递接线（`system.user` relay bot），新增 `agent.model.*` admin RPC + 门户 Models 面板（去掉"模型选择只能 redis-cli"）。CI hermetic **109 套/1727 测试**绿；`check-error-codes` + `check-doc-drift` 守门通过；**全程不碰 router**。

### Fixed / Tests（全量 e2e 共享-mesh 隔离硬化 — BACKLOG §5.6 三机制清零，2026-07-01）
> v1.1.7 立项的既有 flaky 全部结构性修复。三个机制均为**共享-mesh 串行**下的隔离缺陷、与产品代码无因果、不在 CI 阻塞门（CI 走 hermetic 白名单)。修完全量 e2e **66 套/349 测试稳定绿**（连跑复现，耗时从 flaky 时的 ~303s 降到 ~117s——不再空耗超时）。
- **§5.6① 最终一致性轮询超时**：根因是 `jest.config.js` `testTimeout`（60s）**小于**套内最长 poll 预算（90s，`suites/54/101/102/103` 的 `pollOrderState`）——满载下 jest 在 poll 跑满预算前先掐死用例。抬 `testTimeout` 60s → **150s**（对齐套内注释早已假定的值；串行 harness 下对通过用例零成本）；顺修 3 处 stale 注释（"120s"→"150s"）。
- **§5.6② 全局 `ERROR:QUEUE` 跨套污染**（真隔离 bug）：`110-governance` 的 workflow 冷却期错误合法入 `ERROR:QUEUE:orchestrator`，后跑的 `93-service-events` 广口 `assertNoErrors` 撞上。修法 = **每套开跑前抓 `ERROR:QUEUE` 长度基线，`assertNoErrors` 只断"本套新增"delta**（`e2e/lib/verify.js` `captureErrorBaseline` + `assertNoErrors` delta；新 `harness/reset-errors.js` setupFilesAfterEnv 每套 beforeAll 刷新）。非破坏性（不清库 → DLQ 告警扫描器语义不变）、不改 ~20 处调用点。
- **§5.6③ Router taskWhitelist 60s 缓存竞态**（本次新发现）：Router `handlers/tasks.js` 把 `_tasks` 白名单在进程内缓存 60s 且**无写时 bust**；5 个 pipeline 套各自把 `WL_KEY` 改写成自己的窄子集 + 还原，值在套边界翻转 → 缓存偶发读到前值、市场 `_task` 被误判 `BLOCKED`（如 `market.order.pay is not allowed`），订单卡 PLACED。修法 = **把白名单固定为一个联合超集**（新 `e2e/lib/whitelist.js` 单一真源），harness 开机播种、5 套（54/101/102/103/104）统一引用 → 值全程不变、缓存永远命中含市场的白名单。（核实无任何套断言 `_task` 被 BLOCKED，故宽超集不掩盖安全测试。）不碰 router。

### Security / Hardening（passport OTP 请求限流 + storage 读收窄 + 生产接线，2026-07-01）
> 承接 v1.1.6/v1.1.7 公开面收敛与 passport 自助的留项（CHANGELOG v1.1.6 §Added 剩余、[`BACKLOG.md §1.4`](./BACKLOG.md)）。
- **`user.passport.otp.request` per-anchor 请求限流**（`api/core/user/logic/passport.js`）：定窗计数（默认 3 次/60s，`PASSPORT_OTP_REQUEST_{MAX,WINDOW_SEC}`）钝化对受害者 anchor 的**投递轰炸** + OTP 窗口 churn；键基于调用方给的 anchor 串（与是否存在无关 → 不破防枚举）；卡死计数器（INCR 后缺 TTL）自修；超预算抛 `RATE_LIMIT_EXCEEDED (-32029)` 带 `retry_after`。放在 closed-gate 之后（禁用 app 不耗额度）。+3 hermetic（`passport-otp.test.js`，15/15）。
- **storage 公开读收窄**（`api/apps/storage/handlers/{introspection,auth}.js`）：`storage.asset.get` / `storage.asset.resolve` 翻 `public:true → false` + 清空服务侧 `publicMethods`。匿名公开资产的既定路径是**独立 `/file/:id` 路由**（自带 visibility 门、302→CDN，不读 RPC `public` 标志），故 RPC 读无合法匿名消费者；对象级授权早已挡匿名读 internal/private，收窄不削弱安全。**公开方法 19 → 17**。`suites/112` 补断言（匿名拒 / admin 抵达 handler → `NOT_FOUND`）；不碰 router。
- **passport OTP 生产投递接线**（`deploy/seed-bots.js` + `e2e/harness/setup.js` 双镜像）：新增 `system.user` relay bot（permit `gateway.email.send`/`gateway.sms.send`）——user 服务的 passport OTP 经 relay 出站发码（user/index.js 早已构造 relay，此前 dormant 因缺 `RELAY:TOKEN:user`）。默认关（issuance=closed）→ 只加不破。

### Added（AI 模型选择 admin RPC + 门户面板 — 去 redis-cli-only，2026-07-01）
> 关掉 [`BACKLOG.md §2 Tier3`](./BACKLOG.md) 的"模型选择只能 `redis-cli`"（`SYSTEM:CONFIG:AI_MODELS` 无 RPC/portal 写路径）。
- **`agent.model.list` / `agent.model.set` / `agent.model.reset`**（`api/core/agent/logic/model_config.js` + introspection ↔ index 同步注册，autocheck --static 过）：per-capability 模型覆盖读/写/清；`set` 校验 capability ∈ 已声明键（挡拼错 key）、写后 bust 进程内缓存 → 立即生效（非 60s TTL 后）；admin-only（`public:false`，Router permit 门）。+8 hermetic（`agent/tests/model-config.test.js`）。
- **门户 Models 面板**（`portal/system/src/pages/Settings/ModelPanel.tsx` + Settings 导航）：per-capability effective/default/override 表 + 就地编辑/Save/Reset，内联反馈（无系统弹窗，遵 CLAUDE.md §8）。portal tsc 绿。

### CI
- CI hermetic 白名单增 3 套（`apps/collection/tests/logic.test.js`、`apps/market/tests/logic.test.js`、`agent/tests/model-config.test.js`；均实跑绿）→ **109 套/1727 测试**。planner 的 logic 走 entity factory（需 RedisJSON fat-mock）、已有 returns-contract + e2e 22/59 冗余覆盖 → 暂缓（[`BACKLOG.md §5.4`](./BACKLOG.md)）。

### Deferred（评估后不做，记录理由）
- **nexus 写侧 §2.5**：`notification.send` 走 Sentinel 自身 token（`relay.callAs`）需给**每个** Sentinel bot 的 permit **加** `notification.send` → 反最小权限，且既有设计明注"投递不计、共享 `system.nexus`"；autorun **结构化产出已做**（走 `agent.decide` 契约，非裸 chat）；tool-call 产出 + nexus 自动发证（需 guard-railed 非-admin `user.bot.*`，安全高危）= v2 尺寸。
- **orchestrator M6 前端冲突提示**：引擎侧乐观 CAS + `expected_version` 已防丢更新（并发编辑得 `Version conflict` 而非静默覆盖），前端仅缺"提示刷新"UX、散落 7+ section 组件、无 CI 运行时覆盖 → 低 ROI，暂缓。

---

## [v1.1.7] — 2026-07-01

> 公开面收敛收官：passport 身份线（device/bot/upgrade）+ 二次收窄 6 法 + `user.profile` 转 permit 门控（tier 改随 `login.verify` 下发）。公开方法从 ~20 收到 19（仅剩有意公开的 `storage.asset.get/resolve` 读路径）。收敛专项 e2e（111/112/113）+ router 契约 40/40 + CI hermetic 106/1697 全绿。全量 e2e 的既有**共享-mesh flaky**（最终一致性轮询超时 + 全局 `ERROR:QUEUE` 跨套污染）经查证**与本次改动无因果、不在 CI 阻塞门**，立项 [`BACKLOG.md §5`](./BACKLOG.md) 待硬化。

### Added（passport 身份线收敛：device → upgrade，权限走 bot account，2026-06-30）
> 落地 [`spec-passport-identity-line.md`](./spec-passport-identity-line.md)：把**匿名 → 访客 → 注册 → 外部**整条身份线收敛到**一套 passport**;权限不再每张 passport 单独配,而是**路由到已配好权限的 bot account**(`role`/`bot` → permit)。纯增量、默认关、不碰 router。
- **Authority 路由**（`api/core/user/logic/passport.js` `resolveAuthority`）：passport 实体可绑 `bot`（bot account id）**或** `role`。bot 路由 = 读 `user:bot:{bot}`.permit（永不 allow_all）+ 注入 `$owner={field:ownerField,value:anchor}` 行隔离 → 不同 passport 绑不同 bot = 不同权限集。fail-closed：解析出的 permit 必须行隔离否则拒签（`-32603`）。
- **device 模式（TOFU，免 OTP）** `user.passport.device.issue`（public）：anchor = 客户端生成的 device id，无 email/手机可发码 → 首次信任直发 deviceToken，路由到 `config.passport.defaultBot`。匿名/访客入口。
- **upgrade** `user.passport.upgrade`（public）：device-anchor → email/手机 anchor，**双重证明**（设备 token + newAnchor OTP），carry `role`/`bot`/`meta` + 记 `upgradedFrom`，退役旧 device passport（吊销其 session）。**匿名→注册不丢身份**;业务行数据 re-own 由应用按 `upgradedFrom` 改 `$owner`。
- **config**：`config.passport` 增 `defaultBot.{default,byApp}`（`PASSPORT_DEFAULT_BOT_BYAPP`）+ `ownerField`（默认 `ownerId`）+ issuance 增 `device` 取值。`verify`/`otpVerify` 改走 `resolveAuthority`（bot 或 role），签名不变。声明↔注册同步（introspection ↔ index）。
- **验证**：e2e `suites/113-passport-identity-line.e2e.test.js`（full profile，**5/5 绿**）——本地写入 bot account 数据(`user.bot.create` seed `system.e2eguestbot` 带 collection permit)：device.issue → verify(会话 permit=bot services + `$owner=deviceAnchor`)→ 调 bot 允许的方法通/不允许的拒 → upgrade(email OTP)→ 新会话仍是同 bot 权限 + `upgradedFrom`、旧 device 退役。hermetic 22/22(passport+otp+introspection 同步)、CI 子集 106 套/1702 绿、doc-drift ✓。
- **留项**：device.issue 的 per-IP 请求级限流（防批量造号，同 otp.request）；mobile/前端接入（匿名 device → 登录 upgrade）。

### Security / Changed（公开面二次收敛，2026-06-30）
> 延续 passport 收敛思路（人人有会话 → 匿名面收窄到登录/健康/发现 + 有意公开的可见性门控读）。审计全部 ~30 个 public method，**收窄 6 个无合法匿名消费者的方法**：
- **5 个 Phase-3**（service introspection `public:true → false`，不碰 router）：`storage.asset.upload`（匿名写关闭——写需带 owner 会话）、`fulfillment.instance.get` / `fulfillment.instance.list`（业务实例读需会话）、`orchestrator.workflow.snapshot`（能力快照需会话）、`agent.providers`（provider 拓扑不对匿名）。
- **1 个 Phase-2**（router `system.js`，**用户明确授权**）：`agent.chat` 翻 `public:false`——关闭匿名 AI 调用（成本/滥用面）。匿名/访客聊天走 **bot account**（机器主体持 token + agent permit，SOLO 既有机制，无需新代码）；mobile 客户端走登录会话。
- **保持公开**（有意）：`storage.asset.get` / `resolve`——服务内按 visibility 门控（`public` 资产 CDN 式可读、`internal`/`private` 抛 FORBIDDEN）；登录/注册/passport/health/discovery 面。
- **验证**：新增 e2e `suites/112-public-method-convergence.e2e.test.js`（每个收窄方法：匿名 → `AUTH_REQUIRED -32001`；admin 会话 → 抵达 handler，非 denial；`agent.chat` 仅验匿名拒以免触 LLM）；回归 storage 21/60 + fulfillment 23/53 + orchestrator 54 + injection 30 全绿（既有调用者本就带 permit/admin token，无 e2e 匿名调 agent.chat）。

### Security / Changed（`user.profile` 收窄 → permit 门控，2026-07-01）
> 收敛面第三步（用户拍板「严格门控」）：`user.profile` 此前 `public:true` = 任何人可凭 uid 拉任意用户全量资料（含 email/categories 等 PII）。翻 `public:false` → 读 profile 需显式 permit（读**他人**需授权，无自读豁免）。纯 core/user + portal 改动，不碰 router。
- **`user.profile` → `public:false`**（`api/core/user/handlers/introspection.js`，Phase-3 capMap；不在 Phase-2 systemApi）：匿名 → `AUTH_REQUIRED`；登录无授权（含读自己）→ 拒；有 `user.profile` permit / admin → 通。
- **tier 随登录下发**（`api/core/user/logic/user.js` `login.verify`）：返回体增 `categories`（tier 轴，`categories.POWER` 门户门禁读它）。语义：调用者**无需** permit 即可读**自己**的 tier——把门户登录门禁从"另调 permit 门控的 user.profile"改为"从登录返回直接读"，否则新 operator（空 permit）读不到自己 tier → 谁都进不了运维台。声明同步（introspection `login.verify` returns 增 `categories`）。
- **门户对齐**（`portal/operator/src/pages/Login.tsx`）：删除登录后单独的 `user.profile` 调用，改从 `verifyRes.categories` 读 `POWER`。system 门户走 `admin.login.verify`，不受影响；`EntityResolver` 的 profile 解析属 operator 工具面（需授权，非登录阻塞路径，未动）。
- **验证**：`suites/112` 增 `user.profile`（匿名拒 / admin 抵达 handler → `USER_NOT_FOUND`）；`suites/00-login` 授予自读 permit 后仍证 token 经 Router 解析会话；`suites/70-operator-tier` 改证新契约（`login.verify` 带 tier；新增 harness `loginOnly` 重登录助手）。full profile 实跑：**00+70+112 = 12/12 绿**，hermetic user 41/41。

---

## [v1.1.6] — 2026-06-30

> passport 自助发证 + 公开面收敛（头条）、UI e2e 框架转阻塞门禁、错误处理统一 + 错误码守门、脚手架契约文档收进 `docs/` + 下游守门 skill、部署瘦身 + 内核移除 @solana。全量 e2e 64/64 + CI 子集 106 套/1702 测试绿。

### Added（passport 自助发证 + 公开面收敛，2026-06-30）
> 落地 [`spec-passport-self-issuance.md`](./spec-passport-self-issuance.md) 第一阶段（core/user，纯增量、默认 closed），并据此**收窄一个公开方法**作为收敛验证。
- **自助 OTP 发证**（`api/core/user/logic/passport.js`）：新增 public 方法 `user.passport.otp.request` / `user.passport.otp.verify`——OTP 证明 anchor 归属 → 服务端生成 deviceToken + 绑 `config.passport.defaultRole`（**永不信客户端 role**）。`register`/`otpVerify` 共用 `_provision()` 公因子。**fail-closed**：`config.passport.issuance` per-app 默认 `closed`（= 现状）；`defaultRole` 必须行隔离（$owner），否则发证拒（`-32603`）。防枚举（存在/新 anchor 响应一致）、OTP 哈希+TTL、错码 `maxAttempts` → anchor 锁定。OTP 经 relay best-effort 投递（user 服务接入 relay）：`email` 走 `gateway.email.send`（自由文本），`sms` 走 `gateway.sms.send` **模板契约** `{phone,templateId,variables:{code,ttl}}`（Aliyun/Twilio 拒自由文本，需 `config.passport.otp.smsTemplateId` + 预建模板，未配则 SMS 空转 fail-soft）；`config.passport.otp.echo`（默认 OFF）仅 dev/test 回显码。
- **公开面收敛**（`api/router/logic/system.js` + `api/apps/storage/handlers/introspection.js`）：`storage.asset.multi` 翻 `public:true → false`（两道 gate：system.js Phase 2 + introspection capMap Phase 3）。匿名调用 → `AUTH_REQUIRED`；自助 passport 会话 → 通。证明"passport 模式 → 人人有会话 → 可收窄匿名暴露面"。
- **测试**：hermetic `core/user/tests/passport-otp.test.js`（12 测试，含 SMS 模板形态 + 无模板空转两条，已入白名单）；e2e `suites/111-passport-self-issuance.e2e.test.js`（7 测试，full profile 实跑绿：otp.request→otp.verify→passport.verify→行隔离会话→storage.asset.multi 匿名拒/会话通→fail-closed）。e2e 套 60（storage-ops，持 `storage:['*']`）回归 5/5 绿。
- **接线**：`harness/setup.js` 给 user 服务注入 `PASSPORT_ISSUANCE_BYAPP`/`PASSPORT_DEFAULT_ROLE_BYAPP`/`PASSPORT_OTP_ECHO`（仅 e2e）。
- **剩余**（留后续，spec §9/§10）：`otp.request` 的 per-anchor/IP **请求级**限流（当前已有错码锁定，缺请求限流）、TOTP 第二档、报头硬化、`agent.chat` 是否收窄（产品决定）。
- passport 在 `core/user`（不受 router 保护）；仅 `system.js` 翻 public 属 router 改动，由用户 `/goal` 明确授权"收缩部分 public method"。

### Added / Tests（UI e2e 测试框架，2026-06-30）
> 对照 `septopus/world` 的 Playwright 做法补强既有 `e2e/ui`（不是从零搭——SOLO 多 portal/RPC 结构本就更全），并把 UI e2e 升为**阻塞**门禁。
- **移植 septopus 模式**：`playwright.config.ts` `webServer` 自起两 portal（mesh opt-in `UI_E2E_BOOT_MESH=1`，`meshup.js` 加 HTTP 就绪端点）；`helpers/rpc.ts` RPC-call 录制器（septopus `serverHits` 模式）+ `tests/system/rpc-surface.spec.ts`（**浏览器层证实 passport 收敛**：匿名不发越权 RPC、登录后每条带 Bearer）；`helpers/portals.ts` page-object + 两 portal 登录 `data-testid` 契约（替代 i18n 脆弱选择器）；`global-setup` state origin + project baseURL 可 env 覆盖。
- **进 CI + 转阻塞**：`meshup.js` 播种 operator-POWER 用户；`ci.yml` `ui-e2e` 跑 system+operator 稳定核（`--grep-invert @quarantine`）**阻塞** + 不稳深流程（`--grep @quarantine`）非阻塞步骤;新增 `ui-e2e-mobile`（route-mock）阻塞;移除 job 级 `continue-on-error`。
- **triage 全部 quarantine（0 产品 bug）**：7 个原隔离 spec 逐个 root-cause + 修复 + 解隔离——NexusHub 路由漂移（`/nexus`→`/nexus/sentinels`）、i18n 漂移（断言中文 vs en portal，顺修 `en.ts` 误混的中文 `revokeTitle`）、operator 空 permit（meshup 播种真实 permit；`nexus.sentinel.create` admin-gated 属正确行为 → setup 改用 admin token）、测试间隐藏依赖 + 选择器/幂等健壮性。clean redis 全量跑 **49 passed / 0 failed**，mobile 9/9。

### Changed / Fixed（错误处理统一 + 错误码覆盖率守门，2026-06-30）
> 15 服务后审计"统一错误处理是否漂移"。结论:客户端可见层无漂移(目录单源、抛错→信封 14 服务逐字一致、router 对下游 503 归一化);漂移只在内部表示层,本批消除。**纯增量/只加不破,bundle 运行时对客户端零变化。**
- **统一「服务未就绪」路径**：12 服务 `if (!Methods)` 守卫从 3 种写法（8 个裸 `{error:string}` / 3 个 `INTERNAL_ERROR` / 1 个自定义）→ 全部 `jsonrpc.error(res, jsonrpc.SERVICE_NOT_READY(), null, 503)`；新增 `SERVICE_NOT_READY`(-32006) 进共享目录。
- **解除 `-32099` 三重撞码**：`UPSTREAM_ERROR`(router) 留 -32099 唯一主；`SERVICE_NOT_READY`(admin→目录) -32006；`RETRY_LATER`(agent) -32007。
- **router 访问拒绝码命名 + 单源**：`-32604`（permission-system.md 文档化的访问拒绝码，**故意区别于 -32005**）从散落 12 处 inline 收敛为 router shim 的 `ACCESS_DENIED()` 助手；`access.js` errorCode + `system.js` 9 处手搓信封改走 helper（行为字节级保留，`access.test.js` 18/18）。
- **中央码表 + CI 守门**：`library/jsonrpc.js` 新增 `CODES` 登记表（全系统 18 在用码唯一真源）；新增 `deploy/check-error-codes.js`（断言每码已登记 + 无未登记撞码，正是当年 -32099 偷偷三重撞的那种 → 现变 CI 红线），接进 static gate。
- 验证：CI 子集 **106 套 / 1702 测试绿**；未碰 router 转发/catch 逻辑。**留项**：router ~38 处手搓信封纯风格归一 + `system.js` `-32000` 兜底，behavior-equiv，未碰（protected）。

### Changed（脚手架）
- **契约文档统一收进 `docs/`。** 脚手架下发的三份 authoring 契约此前散落两处（`api/AUTHORING.{service,events}.md` + `workflows/AUTHORING.md` + `workflows/examples/`），下游没有统一手册入口、`docs/` 还是空的。现合并到项目根 **`docs/`**：`docs/README.md`（手册索引 / 唯一入口）+ `docs/authoring/{service,events,workflows}.md` + `docs/authoring/workflow-examples/`。
  - **`init.sh`**：原 step 6a/6b 合为一个 `docs/` 下发步；初始 git commit 纳入整个 `docs/`（此前 `workflows/` 根本没进初始 commit，属顺带修复）。
  - **`upgrade.sh`**：step 3d 改为整体 re-template `docs/`，并**迁移既存项目**——把旧的 `api/AUTHORING.*.md` + `workflows/`（仅 Solo 自己下发的文件）清掉，团队自加的 workflow 文件保留，目录非空则不删。
  - **`check-doc-drift.js`**（CI 守护）：路径迁到 `docs/`，并扩展为校验整包（README 索引 + service/events/workflows 三份 + ≥1 workflow 示例引擎合法）。
  - **`README.md` / `SETUP.template.md`**：目录图 + 「之后/Next」指引同步到 `docs/`；文档内交叉引用（events↔workflows、service↔events）随之改为同目录相对名。
- 纯文档 / 脚手架交付逻辑增量，对 bundle / 消费者运行时**零 wire 影响**。`v1.1.5` 可平滑升级；升级既存项目（如 wavely）`bash deploy/scaffold/upgrade.sh <proj>` 会自动迁移到 `docs/`。

### Added（脚手架）
- **下游守门 skill `.claude/skills/solo-service/`。** 把可读的契约（`docs/authoring/*`）变成**被执行**的契约：下游仓里的 Claude Code 一旦动 `api/apps/` 即自动发现并触发——列清红线（命名 `{service}.{entity}.{action}` / 声明↔注册同步 / 禁服务直调 / Entity Factory / `clock.js` / bundle·`library/` 不可改 / UI 禁 `window.*`），指回 `docs/authoring/*` + `api/sample/`，并以 **`node api/autocheck/checker.js api/apps/<svc> --static` 硬门禁**收口（`autocheck` 的 40+ 条静态规则正是这些红线的执行体，已随脚手架下发）。此前脚手架给下游下发的 `.claude/` = 0，约束只活在散文里。
  - **`init.sh`**：第 6b 步 copy + 模板化 `.claude/skills/`，并纳入初始 git commit（git-add 增 `.claude/`）。
  - **`upgrade.sh`**：第 3e 步按版本 re-template 这个 skill（Solo 自有；团队自加的其它 `.claude/skills/` 不动）。
  - **`check-doc-drift.js`**（CI 守护）：新增 §6——校验 SKILL.md 存在、frontmatter 完整（`name`+`description`），且仍指向 autocheck 门禁与 `docs/authoring`（防重构把守门 skill 掏空成散文）。
  - **`README.md` / `SETUP.template.md`**：目录图 + 指引同步。

### Fixed / Tests（门禁硬化，2026-06-30）
- **`router/tests/validator.test.js` 真 bug 修复 + 提进白名单**（BACKLOG §5.1）。诊断 = 单常量漂移：测试按 100KB OOM 盾写死阈值（string >102400 / object >204800 即拒），但 `config.js:71` 后来把默认放宽到 5MB（对象 10MB）、没回头改测试 → 两条断言恒 fail（**非运行时 bug**，盾在工作只是更松）。判定 5MB 是有意的分层设计（bodyLimit 50MB → binary 字段 10MB 豁免 → string 5MB 粗盾 → 逐字段上限走 schema `maxLength`），测试是过期那边。**修法 test-only**：require 前钉 `MAX_STRING_LENGTH=102400`、用完立即还原 `process.env`（`--runInBand` 同进程，防泄漏到后续套）。**未碰任何 router 生产逻辑**；套转绿 22/22 并入 `jest.ci.config.js`。CI 子集 100 套/1642 → **101 套/1664**（2026-06-30 实跑绿）。

### Changed / Tests（部署瘦身 + 门禁硬化，2026-06-30）
> BACKLOG §4（部署瘦身）+ §5（门禁硬化）的剩余"只加不破"项。CI 子集 1642 → **105 套 / 1690 测试**（实跑绿）。
- **构建时切片 `--services`**（BACKLOG 4.2）：`deploy/build.sh` 接受 `--services a,b,c`，把 services.json 切到子集喂 `gen-entry.js`，esbuild 只打子集；**默认无参=全量**（只加不破），未知名 fail-fast。切片逻辑独立验证(3/13、坏名报错)，默认路径与原先逐字节相同（未跑完整 esbuild）。
- **清死依赖**（BACKLOG 4.3）：`xlsx/jimp/jsqr/jszip/multer` 全仓零 require → 从 `api/package.json` 删 + `npm install --package-lock-only` 同步 lock。
- **死引用清理**（BACKLOG 4.4）：`package.json "start"` `deploy/launcher.js`(不存在)→`node monolith-entry.js`；`monolith-entry.js` 补齐 nexus/notification/ingress/approval（9→13 服务，数组 + dispatch）。
- **内核彻底移除 `@solana/web3.js`**（BACKLOG 4.1，wire 相关）：库侧 `library/auth.js`+`router-auth.js` 的 `new PublicKey(x).toBytes()` → `bs58.decode(x)`+32-byte 护栏；router 侧（用户授权）`router/handlers/keypair.js` 的 `Keypair.generate/fromSecretKey/.publicKey.toBase58()` → `nacl.sign.keyPair`+`bs58.encode`（**薄包装保留原 Keypair 接口、`getKeypair()` 调用方零改、`.keypair` 64-byte 格式不变、无需密钥轮换**）。3 个用 @solana 造测试向量的库测试同步换 tweetnacl/bs58。**已从 `package.json`+lock 删除**（全仓零 require → esbuild 不再打进 bundle，省该依赖体积）。验签等价：keypair+auth 五套 54 测试绿 + 真实使用冒烟全过（keygen→落盘→router 签→下游验→伪造拒→重载持久化）。
- **门禁提升 hermetic 套**（BACKLOG 5.2）：实跑复核后纳入 `orchestrator/run`(5/5) + `administrator/display`(9/9) + `router/keypair`(2/2)；`router/{system,capability}` 实测 fail、`administrator/identity` 单跑挂 → 保持排除。
- **ingress 行为套**（BACKLOG 5.4）：新增 `core/ingress/tests/ingest.test.js`（10 测试，纯依赖注入、零 redis/disk/net）：ingest.handle 五路径 + emit 信封 + 审计 + testFire + dedup NX。
- **判定/改写**：5.5 长链 e2e 抖动 = **by-design 固有异步延迟**（timeout bump 是正确缓解，不改生产代码）；5.3 脚本式测试改写为"被 `node` 主动调用的有意约定，盲改会破 storage `npm test`+文档，不强改"。
- 唯一 wire 相关是 `library/auth.js`/`router-auth.js`（验签等价、52 测试绿）；其余为 build/test/启动脚本，bundle 默认产物不变。

### Docs / 文档对账（2026-06-29，无 wire 影响）
> v1.1.3–1.1.5 落了一批代码，几处"经核实"文档却没跟上、开始与代码相左。一次性对账（含一次 CI 子集实跑取真实计数）。
- **CLAUDE.md 与代码对齐**：§2 approval「暂无消费者」→ **已双轨接通**（orchestrator `approval.gate.*` + collection 退款门）；§2 orchestrator「审核链未建」→ **已建**（C1 闸门 + H6 footprint 预审 + 按风险路由 approval）；§4「当前在备 v1.1.5」→ **v1.1.5 已发版（2026-06-26）、在备 v1.1.6**；§4「CRITICAL/HIGH 0 修复」歧义 → 澄清为 **0 开放待办**（残项 deferred-by-design）；§6 测试计数「67 套/848」→ **实跑 105 套/1690**（2026-06-30，`REDIS_URL=…6379`；含 validator + §5 提升，见下）。校对基准 2026-06-03 → 06-29。
- **VERSION.md §5.2 发版台账**补全 `v1.1.3/1.1.4/1.1.5` + 标注下一发布点 `v1.1.6`。
- **BACKLOG.md**：§0「封板动作」rc1→v1.1.0 过期文案 → 回写已发版 + 在备 v1.1.6；§3「approval 零消费者」→ 已双轨接通；新增 **§5 测试门禁硬化台账**（validator 真 bug〔已修，见上〕+ hermetic 套提升 + 脚本式测试归位 + 薄覆盖 + 长链 e2e 抖动根因）+ **§6 已知桩台账**（`vector.js` / planner Phase-2 / agent provider 局部）。
- **`api/library/vector.js`**：加显式 `UNIMPLEMENTED STUB` 横幅 + 清掉注释里不存在的 Commodity/CRM 业务服务引用（违反 §1「无业务层」）；`library/README.md` 标注为未实现桩。
- **`jest.ci.config.js`** 头注释「Verified green … 59 suites」→ 105 套/1690；移除指向不存在 `todo.md` 的 NEXT，改指 `BACKLOG.md §5`。
- 纯文档/注释为主 + 一处 test-only 修复（见上），零运行时改动。

---

## [v1.1.5] — 2026-06-26

> **审计驱动的修复 + Saga 可靠性收尾 + 把可靠性能力接进运维控制台。** 一轮 e2e 漂移审计(全 62 套)挖出两个活体缺陷并修复;
> 补齐本会话新代码的 e2e 空白;补上 §7.4 approve 期补偿接口存在性预审;清理一处共享 auth 死代码;
> 并把这一版攒的后端可靠性能力(崩溃重驱 / ops 告警 / Saga 补偿结果)露给 `portal/system` 操作员。
> 全部向后兼容,`v1.1.4` 可平滑升级。**注意**:suite 24 的修复让 full-profile CI e2e 从红转绿。

### Fixed
- **`user.token.refresh` 死方法**:`user/index.js` 取 `context.user?.user`,但 `context.user` 是 caller uid **字符串**
  → `callerUid` 恒 `undefined` → `bot.tokenRefresh` 恒抛 `UNAUTHORIZED`(CLAUDE.md §7 的"把 req.user 当对象"坑)。改为 `context.user`。
- **e2e 漂移 suite 24(approval)**:本会话 `127ba5e` 的"confirm 必须 ≠ 所有 prior actor"规则把老的"ADMIN 同时 verify+confirm"打挂
  → full-profile CI e2e 这条一直红。重写为真 3-distinct 链(applicant/admin-verifier/第三方 confirmer)+ 新增 distinct-confirm 禁令断言。

### Added
- **§7.4 approve 期补偿接口存在性预审**(orchestrator):`approve()` 在分流到任一审批 lane **之前**,把每个步骤方法拿去活的
  能力目录(`system:capability:list`)解析——**补偿步骤方法解析不到即拒批**(`-32602`,fail-closed:补偿失败是 fail-unsafe);
  正向/resolver 方法解析不到只 **warn**;目录不可用则跳过。与 H6 的 permit 覆盖预审正交互补。
- **`EVENT:WORKFLOW:STATUS` 增 `compensation_order`**:失败事件带逆序的"被补偿的正向步骤"列表(可观测 + 可测)。
- **运维控制台接通可靠性面**(`portal/system`,Agent Nexus → Control / Event Bus):这些后端能力此前"有后端、没 UI"。
  ① **崩溃重驱按钮**:STALLED run 一键 `orchestrator.run.retry`(Re-drive / RETRY,带确认说明从头重跑+幂等去重);
  ② **ops 告警收件箱**:读 `notification.inbox.list({targetId:'ops'})` 露出 stall scanner 发的 `ops.run_stalled`(带 hint + committedSteps + Re-drive/Dismiss),此前完全不可见;
  ③ **补偿可视化**:`run.fail` 现在把 Saga 回滚结果(`compensation`)落到 run 实体(worker 透传),FAILED 详情展示逆序回滚表(✓ undone / ✗ failed)。i18n(en+zh),遵循设计系统、无 `window.*` 弹窗。

### Changed / Hardened
- **`library/auth`(M3)**:删 write-only 死状态 `ACTIVE_SESSIONS`(握手 session 从不被 middleware 读)+ 补握手单测
  (`auth-handshake.test.js`,此前零覆盖)。AUDIT.md MEDIUM 回写真相:M1/M6 早已修(stale)、M3 本批修、M2 重定性为 v2(仅多进程 + 需 Router 协议改动)。

### Tests(覆盖硬化 — 审计后补)
- 全 62 套 e2e 漂移审计;补齐本会话新代码的真空白:**Saga 逆序补偿**(72,断 `compensation_order`)、**run.checkpoint/committedSteps**(73)、
  **stall scanner + ops 告警**(73,harness 降 `RUN_STALL_SCAN_MS`)、**gateway mock 成功发送**(63)、**Router `event_id` 去重**(新 suite 94)、
  **§7.4**(hermetic 4 + e2e 52)。`token.refresh` 的空测(suite 55)补强为硬断成功路径(回归锁)。e2e 72 加 `run.compensation` 持久化断言。

### Tooling
- **`.claude/skills/run-portal`(可视化验证 skill)**:一条命令把 `portal/system` 登录态跑起来 + 注入安全演示数据(STALLED/FAILED+补偿 run + ops 告警)+ Playwright 截图,用来眼见 portal UI 改动。auth 绕过靠注入 `session:{token}` + localStorage,演示数据全 `vis-` 前缀终态、活 worker 不碰、`--clean` 即清。仅开发工具,不进 bundle。

### 升级 / Notes
- 行为变更:`user.token.refresh` 修复 + §7.4 新增 approve 校验(opt-in:只对声明 `compensate` 的 workflow 生效,且目录不可用时跳过)+ `run.fail` 多落一个 `compensation` 字段(additive);其余是测试覆盖 + UI + 开发工具。`v1.1.4` 可直接平滑升级。

---

## [v1.1.4] — 2026-06-26

> **脚手架下游契约包。** 修复"消费者要用 `library/`(如 category)却不知道已交付、自己重写走偏"的可发现性缺口：
> 库一直随脚手架 cp 交付，但缺"怎么用"的引擎对齐契约。本版补两份蒸馏指南 + 顶层指引 + 升级同步。纯文档/脚手架增量，对 bundle / 消费者运行时**零 wire 影响**。

### Added
- **`api/AUTHORING.service.md`（service 编写契约）**：怎么写一个 wire 兼容的 SOLO 服务——文件布局、library factory 接线、"加一个实体三处同步"红线、命名 + X-Router-Token 契约、参数/返回约定。
  核心是 **§0/§4「先复用别重写」**：逐字给出把 `library/category` 挂成 `{service}.category.*` 的 4 段模板（`logic/category.js` 一行 + introspection 8 方法 + index 派发 + 两个前置）——直接回答"下游重写了 category"的走偏。
- **`api/AUTHORING.events.md`（事件/触发契约）**：`_event`（事实扇出）vs `_tasks`（副作用派发）vs `relay.call`（同步）三路；`_event` 信封"你给什么/Router 盖什么"；`EVENT:*` 命名 + registry 白名单；四种触发源（sync/event/cron/webhook）到达路径；`handlers/events.js` 声明形；三层重投幂等。
- 两份都**蒸馏自真实代码 + 引擎逐字段对齐**（不是 `docs/protocol/zh/*` 内部草案的拷贝），按 `{{PROJECT_NAME}}`/`{{SOLO_VERSION}}` 模板化，落在消费者 `api/` 根（紧挨 `api/sample`/`api/library`）。验证样板 = `api/sample`（已在 CI static 循环，`logic/category.js` 真挂了 `library/category`）。

### Changed
- **`init.sh`**：拷贝两份契约到 `$NEW_DIR/api/`（模板替换）并纳入初始 git commit。
- **`upgrade.sh`**：新增 step 3d 按版本 re-template 三份 authoring 契约（service + events + workflow）——顺带**修复既存缺口**：此前 `workflows/AUTHORING.md` 升级时根本不同步，v1.0→v1.1 升级后会留旧 workflow 语法。
- **`SETUP.template.md`**：「之后/Next」段从只指 workflow，扩为指向四份下游契约（service/events/workflow + `library/README.md` 库目录），并点明"先复用别重写"+ "以这四份 + 代码为准，非 docs/protocol/zh 草案"。

### Notes
- 对消费者**零运行时影响**：纯文档 + 脚手架交付/升级逻辑；不动 bundle、不动任何服务 wire。`v1.1.3` 可直接平滑升级。
- 升级现有项目（如 wavely）：`bash deploy/scaffold/upgrade.sh <proj>` 即同步进 `api/AUTHORING.*.md` + 刷新 `library/`（含 `category.js`）。

---

## [v1.1.3] — 2026-06-26

> **编排可靠性纵深 + 签名审批门退款 + operator 打磨。** orchestrator 拿到 at-least-once 幂等键、
> Saga 同步补偿、崩溃后幂等重驱三件套；approval 升级为 3 个真签名者的 request→verify→confirm 链
> 守住 collection 退款；operator 一轮净减 723 LOC 的去死代码 + Users 页 + 可视化清单编辑器。
> **版本边界说明**：Saga 自动补偿 + at-least-once 幂等原列 VERSION.md §4（v2），因全部是「只加不破」的
> **per-workflow opt-in 增量**（VERSION §2 早已预告"v2 若做也是 opt-in"），提前落地于 v1.1.x；§2/§4 已回写。

### Added
- **orchestrator · at-least-once 幂等键接线**（前置①）：`runner.run` 现在按 (run, step) 注入稳定
  `idempotency_key`（默认 `wf:{workflowId}:{trigger_id||per-run anchor}:{step.id}`，计算一次、跨重试复用），
  作为 param 透传（SOLO 约定：`collection.payment.record`/fulfillment `_tasks` 从 params 读，校验器忽略 extras）。
  优先级：显式 `params.idempotency_key` > step 的 `idempotency_key` 字段（支持 `$`-token 插值）> 引擎默认。
  引擎只**提供**键，去重仍是下游的事。补上了一个真实的二次提交漏洞（in-step 重试 / 事件重投）。
- **orchestrator · Saga 同步补偿**（README §7）：`ignore_error:false` 的 step 失败时，引擎按**逆序**对每个
  「已提交且声明了 `compensate`」的 step 执行补偿。`compensate` 是 **step-id 引用**——目标是普通 step，
  因而已在 H6 footprint 预审 + 签名审批 digest 内（顺带闭合授权缺口），且自动**排除出正向 pass**。
  补偿走与正向同一执行器（带稳定 `idempotency_key`，重投去重）。补偿本身失败 → `compensation_failed` +
  `EVENT:WORKFLOW:DEAD_LETTER`（绝不静默吞错）。`create()` 校验 compensate 必须是真 step-id、非自指、目标不得再声明 compensate（§7.3 无补偿链）。
- **orchestrator · 崩溃恢复（收尾）**：`run.checkpoint`（每步提交记 `committedSteps` + 刷新 `lastActivity`，
  顺带消除慢 run 被误判 STALLED）+ 新 RPC `orchestrator.run.retry`（admin、仅 STALLED、保留 `triggerId`
  的幂等重驱）。崩溃后「发现（STALLED 告警带 committedSteps）→ 一键重驱」成闭环；重驱靠稳定 `idempotency_key`
  让已提交步骤去重（**从头重驱、依赖下游去重**，非 step-cursor 中途续跑）。
- **approval · 签名 3 层审批链守 collection 退款**（治理线，governance.md §3 方向2）：`approval.record.*`
  接受并验证每阶段可选 Ed25519 签名（`user.key.*`），把证据从 server-attested 升级为 3 个不同 actor 签名的
  request→verify→confirm 链（confirm 强制签名者互不相同；无签名仍回退 server-attested，向后兼容）。
  新增 `collection.payment.refund`：fail-closed 门——仅当存在 targeting 该 payment、携完整 3 阶段链、每阶段
  由 3 个不同 actor 签名的 DONE approval 才放行，经 Router relay（`approval.record.get`）核验，无服务直调。
- **operator portal**：Passport 重建为「Users」页（标准全宽面板 + 只读详情查看器，补上 seed 用户无入口的缺口）；
  system DisplayConfigPanel 可视化清单编辑器（Views 勾选 / 字段表 / 拖拽排序 + JSON 逃生舱，无损往返）；
  Execution Trace 从孤儿页迁入 fulfillment 实例（InstanceTraceModal 按 instance 的 trace id 缝合全链）；
  实体头工具栏整合（字段配置齿轮 + 视图切换 + 搜索/筛选 + Add/归档收成紧凑组）。
- **market `order` 实体 + AML pipeline e2e（示例向）**：`market.order.*`（全 `ai:true` 带 `returns_schema`）+
  e2e suite 101 走「ingress 入账 → fulfillment 推进 → nexus AI 判 AML → 推进订单」全链（放行/拦截/升级三 lane）。
  market 是示例 app 服务（非 services.json 13 之一），对消费者无 wire 影响。

### Fixed
- **collection（payment.refund）**：bogus approvalId 触发 `approval.record.get` 抛 NOT_FOUND 被包成
  `-32603 INTERNAL_ERROR` 污染 `ERROR:QUEUE`；改为把 `-32002`/404 映射为 `FORBIDDEN`（客户端错误不入错误队列）。
- **operator（服务切换）**：`GenericEntityPage` 跨默认服务路由复用，`activeEntity` 切换时残留 → 渲染新服务没有的
  实体（如 PLANNER 显示 SHIPMENT tab）；当前选择对服务无效时重新落首个实体；分页 reset 拆进独立 effect。
- **operator（mock 监听器）**：每 30s 的合成心跳喂一个强制 `amount` 的支付 workflow → 每 30s 产一条 FAILED
  orchestrator run；移除合成心跳，`lastFiredAt` 改反映真实投递。
- **operator（渲染/key bug）**：memo 化 `UIProvider` 的 toast + context value（toast 不再重渲所有 `useUI()` 消费者）；
  process-action 编辑器按 `action.id` 加 key（修「删一行清错字段」）；RJSF Add 模态 Rules-of-Hooks 崩溃；`/config.js` 404 dev stub。

### Docs
- 回写发版状态漂移：CHANGELOG 各版「待发布」→ 实际打 tag 日期；VERSION.md §5 封板流程对齐已发的 `v1.1.0–v1.1.2`。
- VERSION.md §2/§4：把 Saga 自动补偿 + at-least-once 幂等从 v2 出版清单回写为「v1.1.x opt-in 提前落地」；
  orchestrator README §7 跨重启恢复一节按 `run.checkpoint`/`run.retry` 落地状态更新。

### 升级 / Notes
- **全部向后兼容，`v1.1.2` 可平滑升级**：`idempotency_key` 是注入 param（下游忽略 extras）；`compensate` 是
  opt-in（无声明的 workflow 行为不变）；`run.retry`/`checkpoint` 是新增 RPC（introspection 只加不删）；
  `refund` 是新方法；operator 纯前端无 wire；market 是示例 app 无 wire。
- **崩溃恢复语义**：是「STALLED → `run.retry` 从头幂等重驱」，**非 step-cursor 续跑**——非幂等下游的 workflow
  重驱仍可能重复副作用（at-least-once 固有契约，与整机一致，非本版新引入）。详见 orchestrator README §7。
- 验证：CI hermetic 84 套/1132 测试绿；orchestrator static（`run.retry` 声明↔注册同步）+ doc-drift 绿；
  全栈 e2e 新增 suite 71（签名退款 11 例）/72（Saga 补偿）/73（崩溃恢复幂等重驱），均隔离栈跑通。

---

## [v1.1.2] — 2026-06-20

> **返回契约线封闭**:全 14 服务「声明 vs 真实返回」对齐 + 机器可校验 + fulfillment 取数守卫。编排/AI/状态机现在按声明取数,不会再静默拿到 `undefined` 走错分支。

### Added
- **`library/contract.js`(返回契约引擎)**:`returns_schema`(带类型/必填/pattern 的规则项数组)与遗留 `returns`(扁平键名提示)并存;`checkReturn` 子集语义校验真实返回、`lintReturnContract` 良构校验、`checkPickPath` 核验 fulfillment 的 `pick` 点路径。**不动 `api/router/`**(`returns_schema` 是独立新字段,router/capability/manifest 仍只读 `returns`)。
- **全量补齐 `returns_schema`**:234 个方法补上类型化返回声明(条件键标 optional、provider 分歧已标注、裸数组诚实留白),修正 **67 条「声明谎言」**(声明了实际不返回的字段)。纯声明层,无 wire / 行为变更。
- **`fulfillment/logic/lint.js`(profile 链路守卫)**:把 profile `meta_fields[].source.pick` 核到真实跨服务 introspection 索引——挡住 `status`↔`state` 错字段、标量再下钻、未背靠的 condition / params var,杜绝 JsonLogic 静默走错分支。
- **CI 守卫**:14 服务各一套 `returns-contract.test.js`(hermetic)+ 全仓良构扫描 + `ai:true` 覆盖闸 + nexus 回归哨;新增无契约方法 / profile pick 错字段都会红。

### Fixed
- **planner(todo.sync)**:`logic/todo.js` 用了 `jsonrpc.INVALID_PARAMS` 却没 `require` jsonrpc → 命中即 `ReferenceError` 崩溃。补上 import。
- **collection(payment.list)**:声明的过滤参数是 `status`,逻辑层却按 `state` 过滤,导致按状态筛选恒为死过滤(永远命不中)。声明与逻辑统一为 `state`。

### 升级 / Notes
- 行为变更仅限上述两个 bug 修复 + 新增 CI 守卫;`returns_schema` 是新增字段,对现有消费者完全向后兼容,v1.1.1 可直接平滑升级。
- 剩余 ~47 条非阻塞契约债(同族信封不一致 / provider 分歧 / 裸数组 / 整洁度)已登记在 [`return-contract-debt.md`](./return-contract-debt.md),默认进 v2,不阻塞本版。

---

## [v1.1.1] — 2026-06-16

> **热修(hotfix)**:空闲时 orchestrator 事件匹配器空转,把一个 CPU 核烧满。

### Fixed
- **orchestrator(matcher)**:当项目未注册任何「订阅事件的 ACTIVE workflow」时,消费循环在到达**限速的 `xReadGroup BLOCK`** 之前就经 `consumeOnce` 提前返回,使 loop 以事件循环极限速度空转 —— 每秒约 2000 次 `SMEMBERS ORCHESTRATOR:WORKFLOW_INDEX` + `GET ORCHESTRATOR:CONTROL:PAUSED`,稳定吃满一个 CPU 核(实测某下游项目 12h 累计烧掉 ~195min CPU、主机持续发热)。根因:`xReadGroup` 的 `BLOCK` 是该循环唯一的"刹车",而无订阅流时根本走不到它。修复:无订阅流时按 `blockMs` 节流,空闲 orchestrator 每 `blockMs`(默认 5s)一拍而非死转。
- **nexus(stream consumer)**:同类形状的**纵深防御** —— 正常配置下 nexus 始终持有默认生命周期流(`EVENT:WORKFLOW:STATUS/RESULT`),不会空转;但若默认流被配空 / 订阅被全部移除,`consumeOnce` 现也按 `blockMs` 节流,杜绝同款 spin。

### 升级 / Notes
- 若你曾用运行时暂停临时止血(`redis-cli SET ORCHESTRATOR:CONTROL:PAUSED 1`):升级到本版并重启后,记得 `redis-cli DEL ORCHESTRATOR:CONTROL:PAUSED` 恢复自动化 —— 暂停标志可能已被 Redis RDB 持久化,否则 orchestrator 会以暂停态(事件触发/队列不自动跑)启动。
- 行为变更仅限"空闲节流",无 API / 数据 / 协议变化;v1.1.0 可直接平滑升级。

---

## [v1.1.0] — 2026-06-14

> **AI 自动化平台档**:在 v1.0 纯框架底座上做实 AI 自动化 + 治理线。版本边界见 [`VERSION.md`](./VERSION.md)。

### Added
- **治理线**:分层审批(C1 快速档 + approval 多签 + 风险路由 + 冷却期)· 密码加密 Ed25519 签名审批人 · 审批可视化(footprint/订阅/schema/diff,防盲签)· 外部投稿面(窄 bot + 配额 + snapshot 裁剪)。
- **nexus**:Sentinel 事件订阅式 AI 反应体 —— 动态订阅流 / autorun(agent.decide)/ emit-event 动作闭环 / per-Sentinel 身份与最小权限 / 环路·深度刹车。
- **fulfillment**:声明式状态机履约引擎(JsonLogic + `_tasks` + 幂等键 + 事件联动)。
- **生产硬化包**:`library/{cors,health,risk,walarchiver,validate,permit}` · `/health`+`/readyz` 探针 · DLQ 告警 · Redis 硬化。
- **脚手架**:`seed-registry`(服务注册)· `e2e`(API jest)+ `e2e/ui`(Playwright operator)分发 · operator 源码下发 · `SETUP.template`。
- **client/mobile**:语音输入(Qwen ASR)· 读 auto-run · STM/LTM 记忆;route-mocked e2e(view-list / memory / focus-card)。

### Fixed
- **build**:`esbuild --external:proxy-agent`(storage 入 bundle 后构建断裂)。
- **scaffold**:服务注册缺失致开箱 `-32601`;`SETUP.md` 模板缺失且被自身 `.gitignore` 误伤。

### 兼容 / Notes
- 本版假设:**单信任域 + 单机部署**(多机硬化 = v2)。
- 升级:[`../runbook/upgrade-v1.0-to-v1.1.md`](../runbook/upgrade-v1.0-to-v1.1.md)(重点:seed-registry / redis-stack / 破坏点排查)。

---

## [v1.0.0]

纯框架底座:统一网关 · 实体工厂 · 权限 · 审计 · 工作流编排 · AI 能力收敛。消费者首版基线。
