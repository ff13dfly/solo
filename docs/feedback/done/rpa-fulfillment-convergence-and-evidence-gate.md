# 立项与底座补齐：RPA × Fulfillment 全域履约收口 —— 补齐 SOLO 五项履约原语，淘汰下游三套平行自造状态机

> 来源：2026-11-07 四栈线上履约与 RPA 真实生产数据盘点（`Catalog`、`Steward`、`Finance`、`Solar`），由用户拍板立项并要求**「全部收回到 SOLO」**。
>
> **依据严格分三类采信**：
> - **线上实测数据（2026-11-07 生产库直查）**：`catalog-mini` (`100.68.103.124` PostgreSQL + Redis)、`BC001` (`100.69.34.70` Steward Redis `:6385`)、`BC002` (`100.71.109.85` Finance Redis `:6379`)、本机 `Solar` 代码仓。
> - **源码核对**：`api/apps/fulfillment/logic/{instance,profile,rules,lint}.js`、`api/library/logger.js`，以及下游消费者实现参照（不设跨仓链接）：`finance/api/apps/company/logic/fulfillment.js`（801 行）、`catalog/api/apps/content/logic/fulfillment.js`（1,067 行）、`steward/integrations/finance-fulfillment.js`（339 KB）。
> - **架构拍板**：SOLO `apps/fulfillment` 是唯一合法履约状态机真源；底座缺失的五项 RPA 协同原语已在 SOLO 本仓一次性补齐（✅ 2026-11-07），本篇留 `docs/feedback/` 顶层作为下游三套平行状态机退场收口的追踪总单。

---

## 一、【线上实测】四套业务系统履约 × RPA 真实运行基线（2026-11-07）

### 1.1 四栈盘点总览

| 栈 | 原生 `FULFILLMENT:INSTANCE:*` | 下游平行自造状态机 / 工单表 | 真实数据暴露的核心问题 |
|---|---:|---|---|
| **Finance** (`BC002:6379`) | **0 条**（仅 1 个种子 profile `standard_trade`） | 自造 `COMPANY:FULFILLMENT:*` **12 条**（`DRAFT: 4` / `COMPLETED: 5` / `CANCELLED: 3`） | 绕开 SOLO 原生 `fulfillment` 另起炉灶写 801 行 `company.fulfillment.*`；且完成态证据里混入 `••••••` 网页掩码占位符与 `http://127.0.0.1:8124/assets/...` 死链 |
| **Catalog** (`catalog-mini`) | **29 条**（`1688_order_procurement` 21、`temu_listing_publish` 6、`standard_trade` 2） | 自造 `CONTENT:FULFILLMENT:*` **7 条** + PG `flow.batch` **366 批** | 双账本状态分裂：同一批次在 `CONTENT:FULFILLMENT` 已 `READY/COMPLETED`，镜像 `FULFILLMENT:INSTANCE` 仍停在 `DRAFT` 或 `GENERATING`；3 条 `IN_PROGRESS` 实例卡死 **12 天**无人收割；`completed` vs `COMPLETED` 大小写漂移 |
| **Steward** (`BC001:6385`) | **0 条**（未挂载 `apps/fulfillment`） | `HIVE:JOB:*` **2,005 条**（`DONE: 1,701` / `EXPIRED: 221` / `ERROR: 52` / `ESCALATED: 28` / `CLAIMED: 1`）+ `steward/integrations/finance-fulfillment.js`（339 KB 仓外胶水） | `EXPIRED` 占总工单 **11.0%**（常驻插件掉线窗口内无死期收割联动）；验证码/扫码人工接管态（`ESCALATED` 28 单）与业务履约主单完全脱节；高频工单全量常驻 Redis 无归档 |
| **Solar** | 代码就绪（`solar_quote_fulfillment`） | `SOLAR:QUOTE` 镜像驱动原生 `fulfillment` | 唯一遵守原生 `fulfillment` 的新栈，但受限于无 `create(idempotent:true)`，只能手写客户端 `sourceId` 查重兜底 |

### 1.2 迫使下游各自重写状态机的五个底座缺口（根因归因）

为什么 `Finance`（801 行）和 `Catalog`（1,067 行）宁可重写一套 `*.fulfillment.*`，外加 `Steward` 写 339 KB 仓外桥接脚本，也不用 SOLO 自带的 `apps/fulfillment`？核对源码后确认根因不在业务特殊，而在原生 `apps/fulfillment` 缺少 **RPA 异步与半自动履约必撞的五项原语**：

1. **无 `(profileId, sourceId)` 服务端创建幂等**：`fulfillment.instance.create` 每次必新建 `FL-*`（`logic/instance.js:275` 原实现）。RPA 队列、Webhook 重投或 `_tasks` 重试一旦触发二次调用，同一采购单/报税单直接裂出双实例（此前已登记于 `BACKLOG.md` §3 DOM 提取遗留 ①）。
2. **无正交 `ASSIST_REQUIRED` 断点保护栈（`suspend` / `resume`）**：原 `hold` 要求每个业务状态显式在 `transitions` 写一条 `hold_requested` 规则（N 个状态 × 人工接管 = N 条样板规则），且不能保存 RPA 现场 `checkpoint`（停在哪一步、截图 assetId、AI 诊断建议）与人工 `resolution` 回填。RPA 遇到滑块/短信 OTP/扫码重登只能把主单打成 `ERROR` 重跑，或另建平行表。
3. **无声明式状态驻留 TTL 与收割器（`stateTtls` + `reap`）**：`fulfillment-condition-fail-open.md` §三曾指出缺少时间驱动设施。Catalog 线上 3 条 `IN_PROGRESS` 实例已静默躺平 12 天（`2026-10-26` 起未动），既不转 `TIMED_OUT` 也不发告警。
4. **无转移证据质量闸门（`transition.evidence`）与状态大小写静态检查**：
   - `Finance` 线上已 `COMPLETED` 的企业实名/税务履约单中，RPA 抓回页面脱敏态 `"••••••"` / `"9132****MA1X"` 仍被当成合法税号放行归档；同时 `storage` 未配外发域名时产出的 `http://127.0.0.1:8124/assets/...` 回环死链直接写进跨机凭证。
   - `Catalog` 真实出现 `completed`（小写）与 `COMPLETED`（大写）并存，导致按状态聚合漏单。
5. **无单实例单次能力回调令牌（Capability Callback Token）**：外部 RPA 执行手（Steward 插件 / Hand 桌面手）跑完剧本回调业务箱子时，此前要么给一个能扫全表的高权全局 Bot Token，要么走仓外 339 KB 脚本轮询中转；而 `instance.pending_callbacks` 字段自建表起一直是未接线的死字段（`BACKLOG.md` §3 DOM 提取遗留 ③）。

---

## 二、【底座补齐】SOLO `apps/fulfillment` 五项原语一次性落地（✅ 2026-11-07）

遵循「只加不破、不碰 `api/router/`、全部走 SOLO 标准 RPC 命名与 `autocheck` 门禁」，五项能力已在 `api/apps/fulfillment/` 全部实现并通过单测与契约门禁：

| # | 原语 | RPC / Schema 契约 | 关键实现与安全护栏 |
|---|---|---|---|
| 1 | **`sourceId` 幂等建单** | `fulfillment.instance.create({ sourceId, profileId, meta, idempotent: true })` | 按 `($owner, profileId, sourceId)` 维护 `FULFILLMENT:SOURCE:*` 索引 + 存量实例自动回填；命中返回 `{ ...existing, deduplicated: true }`，跨租户隔离不串单（`logic/instance.js:275-315`）。 |
| 2 | **正交人工协办断点栈** | `fulfillment.instance.suspend` + 增强版 `fulfillment.instance.resume` | 任意非 `CANCELLED` 状态无需在 profile 写 N×M 条规则即可挂入 `ASSIST_REQUIRED`（可自定大写状态名），将 `{ blockedState, suspendState, reasonCode, reason, checkpoint, aiSuggestion, suspendedAt, transitionId }` 压入 `instance.suspension`；人工处理完调 `resume({ id, resolution, metaUpdate, expectedTransitionId })` 精确恢复回原 `blockedState` 并合并上下文，100% 兼容旧 `hold` 路径（`logic/instance.js:441-640`）。 |
| 3 | **状态驻留 TTL 与收割** | `profile.stateTtls` + `fulfillment.instance.reap` + `instance.list(stateChangedBefore)` | Profile 支持声明 `stateTtls: { PROCESSING: { ttlMs, event, reason? } }`（纳入 `lint.js` 规则 8 校验目标 `event` 存在且 `ttlMs > 0`，并计入 `approvedDigest` 防审批后篡改）；`instance.reap` 支持 `dryRun` 预览与 `expectedTransitionId` ABA 护栏，自动触发超时事件并返回 `_tasks`；`index.js` 支持 `FULFILLMENT_REAP_INTERVAL_MS` 可选后台轮询（`logic/instance.js:645-732`）。 |
| 4 | **证据质量闸门 & 大小写 Lint** | `transition.evidence` + `lint.js` 规则 9a / 9b | `rules.evaluateEvidenceGate` 在 `advance()` 内强制校验 `requiredFields`（支持点分路径）、`rejectMasked`（拦截 `••••••` / `****` / `***` / `9132****MA1X`，不误伤 Markdown `**bold**`）、`rejectLoopbackUrls`（拦截 `127.0.0.1` / `localhost` / `[::1]` 死链）、`minRows`、`minBytes`；`lint.js` 规则 9b 将同 profile 内 `completed` vs `COMPLETED` 大小写分裂判为 **hard error**、纯小写状态名报 warning（`logic/rules.js:63-162`、`logic/lint.js:210-285`）。 |
| 5 | **单次能力回调令牌** | `fulfillment.instance.token.issue` + `public: true` `fulfillment.instance.callback` | 签发 `flcb_<48hex>`，Redis 仅存 `FULFILLMENT:CBTOKEN:<sha256>`（`EX = ttl`），同步登记 `instance.pending_callbacks`（激活历史死字段）；`callback` 先验过期与 `allowedEvents` 白名单，再以 `GETDEL` 原子单次消费，并绑定签发时刻的 `expectedTransitionId`（ABA 防串改）；`library/logger.js` `SENSITIVE_KEY_RE` 与 `instance.js` `stripSensitiveMeta` 双重兜底防止明文 token 入日志或 `instance.meta`（`logic/instance.js:738-880`、`autocheck/static/public-surface-check.js`）。 |

**验证证据**：
- `api/apps/fulfillment/tests/{profile-lint,logic,returns-contract}.test.js` + `api/library/tests/logger-redact.test.js` 全部通过；
- `node api/autocheck/checker.js apps/fulfillment --static` → `Errors: 0`。

---

## 三、【强制收敛清单】下游平行状态机退场路线（全部收回到 SOLO）

> **架构红线（2026-11-07 用户拍板）**：任何 SOLO 派生项目严禁再在 `api/apps/<biz>/logic/fulfillment.js` 自造平行履约状态机或双写镜像账本；存量三处分叉按以下清单逐栈收回 SOLO 原生 `apps/fulfillment` + `gateway.webhook.send(target:'solo')`：

- [ ] **1. Finance 收口（退场 `company.fulfillment.*` 801 行）**：
  - 将企业开户/税务申报/月度结账模版迁为 SOLO 原生 `fulfillment.profile`（开启 `transition.evidence: { rejectMasked: true, rejectLoopbackUrls: true, requiredFields: [...] }` 与 `stateTtls`）；
  - 存量 12 条 `COMPANY:FULFILLMENT:*` 一次性迁移至 `FULFILLMENT:INSTANCE:*`（保留 `sourceId` 与审计历史），删除或薄代理化 `company/logic/fulfillment.js`；
  - 派单给 Steward 时调用 `fulfillment.instance.token.issue` 签发窄单次 `callbackToken`（或经 `ingress` 接收 `gateway.webhook.send(target:'solo')` 投递），不再暴露宽权限账号。
- [ ] **2. Catalog 收口（退场 `content.fulfillment.*` 1,067 行，消除双账本分裂）**：
  - 废除 `CONTENT:FULFILLMENT:*` 与 `FULFILLMENT:INSTANCE:*` 的双写镜像，统一以 `FULFILLMENT:INSTANCE:*`（`idempotent: true` 绑定 `batchId` / `orderId`）为唯一状态真源；
  - 用 `profile.stateTtls` + `fulfillment.instance.reap` 清理存量卡死 12 天的 `IN_PROGRESS` 僵尸单，修复 `completed` 小写状态漂移。
- [ ] **3. Steward 跨箱桥接收口（退场 `steward/integrations/finance-fulfillment.js` 339 KB 仓外胶水）**：
  - 剧本遇到滑块/短信验证码进入 `ESCALATED` 时，凭单次令牌或跨箱投递驱动上游 `fulfillment.instance.suspend({ reasonCode: 'OTP_REQUIRED', checkpoint })`；人工在千手侧处理恢复后驱动 `resume`；
  - 剧本完工统一走 `gateway.webhook.send({ target: 'solo', url: '<peer>/jsonrpc', secret, idempotencyKey, payload })` 投回上游 `ingress.ingest`（或直调 `fulfillment.instance.callback`），删除 339 KB 仓外轮询胶水脚本。

> **2026-11-12 收口归档**：SOLO 侧五项原语 + 跨箱声明式 `peer_rpc_with_callback` + `fulfillment.barrier.*` 扇入屏障均已在 SOLO 仓 100% 落地；下游业务仓迁移任务归口于各业务仓自身 backlog，本篇在 SOLO 仓移入 `docs/feedback/done/`。
