# SOLO Backlog —— 框架级待办集中清单

> **唯一集中入口。** 把原本散落在 `docs/planning/toFix.md` / `docs/protocol/zh/context.md §11.2` /
> `api/core/orchestrator/AUDIT.md` / `docs/protocol/zh/governance.md` 的"未尽事项"汇总到此，
> 按推进顺序排。**详情仍指回各源文档**（带 file:line 证据），本表只给一句话 + 指针，不复制正文。
>
> **可执行的实施清单（优先级 + 依赖 + 待拍板问题）见 [`v1-implementation-plan.md`](./v1-implementation-plan.md)**
> （2026-07-03，汇总 toFix.md 剩余项 + v2→v1 拉回项）。
>
> 规则：SOLO 是纯框架，缺业务服务（crm/erp/…）**不算 gap**（`CLAUDE.md §1`）。
> 校对基准：2026-06-29。来源：本轮 nexus 8 维度审计 + 既有文档汇总 + v1.1.5 审计回写。

---

## v1.1 封板线（2026-06-11 拍板，权威 = [`VERSION.md`](./VERSION.md)）

> 本清单是滚动的，版本边界不滚动。v1.1 = **AI 自动化平台（nexus + fulfillment + 治理线）·
> 受信外部 agent 投稿档**（B 档）。
> **入版（封板前做完）**：分层审批（C1 快速档 + approval 多签档 + 风险路由 + 1-of-1
> 默认 + 冷却期）· 审批人体系（user approver 角色 + 密码加密 Ed25519 签名私钥，
> 签名绑定版本快照 digest）· 审批可视化（footprint/订阅/schema/diff，盲签禁令）·
> 投稿面（窄 bot + 配额 + snapshot 裁剪）· §1.1 文档清理 · sample 模板对齐。
> **出版（v2 起点，2026-06-11 拍板时的原始清单，历史记录不改）**：actor-claim 全量 · passport 自助 · SSE/MCP/SDK ·
> Saga 自动补偿（v1 终态 = 披露 + 弹人工）· metrics 正式档 · autorun 置信判据重设计 · 重投队列语义 · 多租户 · 多机硬化。
> **2026-07-03 已重新拆分**——见下方「0. 推进顺序」第 4 点与 [`VERSION.v2.md`](./VERSION.v2.md) §5，此清单大半已判定只加不破、拉回 v1.1.x。
> 下方各节条目以本线裁决归属；新发现默认进 v2，除非阻塞入版项。

## 0. 推进顺序（当前）

1. ~~**v1 封板线 = 治理线**（VERSION.md §3.1–3.5）~~ —— **✅ 全部落地（2026-06-11）**：
   分层审批（risk.js 分类器 + approval 多签 gate + orchestrator 风险路由 + 冷却期）·
   密码签名审批人（user.key.*）· 审批可视化（ApprovalReviewModal）· 投稿面（配额 + snapshot 裁剪）·
   收尾（sample 对齐 autocheck + §1.1 核实）。hermetic 65 套/828 绿 + e2e suite 110 全链路绿。
2. ~~§1 authority 收口~~ —— 读路径/生命周期已落；§1.1 文档清理已核实（残留均为正确澄清）；写侧收尾入 v2 actor-claim。
3. ~~**封板动作**（VERSION.md §5）~~ —— **✅ v1.1.0 已发版**（2026-06-14，未走 rc1，直接 tag）；滚动补丁 `v1.1.1`…`v1.1.5` 均已 tag+push（见 [`VERSION.md`](./VERSION.md) §5.2 / CHANGELOG）。**当前 = 阶段一（trunk + tags，只加不破，在备 `v1.1.6`）。**
4. **出版清单已按 2026-07-03 拍板重新拆分**（详见 [`VERSION.v2.md`](./VERSION.v2.md) §1/§2/§5、[`VERSION.md`](./VERSION.md) §4 回写）——**规划改动，尚未实现**：
   - **拉回 v1.1.x 排期（判定只加不破）**：多机部署硬化（loopback→service-bot）· `_task` fire-and-forget 丢投修复（**已确认真 bug**，e2e 实测 `order=PLACED instance=CLEARED`，独立于版本归类优先处理）· Saga durable 补偿（跨重启续跑）· autorun 置信判据重设计（续 `risk_tolerance` 具名容忍度档之后）· passport TOTP 自助 · SSE 推送 / MCP adapter / 外部 agent SDK · metrics 正式档。
   - **多租户开放档已取消**（非拉回）——改用 E 线 SOLO Bridge 的联邦隔离（每租户一套独立网格）替代。
   - **仍留 v2**：actor-claim 全量（用户/服务凭证签名，真破坏性架构）· 完整 at-least-once 重投队列 + 全网统一幂等键（降级为可选/非阻塞）· E 线（bridge 联邦）· F 线的动态插件平台部分。

---

## 1. 🔝 authority 收口（先做）

> 背景：`authority` 曾是规划中的"权限/签发"服务，**已被 ADR 1.4.1 砍掉**——bot 账号与 token 统一走
> `user.bot.*`，权限走 `permit` + Router `checkAccess`。但"authority"以三层形态残留，需要分清：
>
> 📄 **设计 + v1 实现已落** → [`docs/protocol/zh/authority.md`](../protocol/zh/authority.md)：结论是**不建 authority 微服务**，
> 外部接入做成 `user.passport.*`（铸受限 session）+ Router 方法墙（零改）+ 行隔离（v1 在 `collection` 按 `$owner`）。
> **✅ v1 已实现并过 e2e（`68-external-isolation`）**。剩：①.1 文档清理（下方）、通用版 `entity.js` 行隔离、§1.2 nexus 内部半边。

### 1.1 文档/配置清理（便宜，纯文字）
删掉/改正所有把 authority 当**现存服务**的描述（注意：明确写"authority 不存在/已砍"的引用是**对的，别动**，如 `nexus/README.md:11`、`context.js:11`、`api/README.md`）。

| 位置 | 现状（错） | 改成 |
|------|-----------|------|
| `api/core/nexus/config.js` 68/71（en）、87/90（zh） | "token issued via authority" / "委托 authority 签发 Token" | "bot 账号/token 由 `user.bot.*` 管理" |
| `docs/protocol/zh/context.md §8` 安全表 | "method ∈ `authority_role.allow_methods`" | 只读后缀静态闸 + 运行时 Router checkAccess（§5.1 已是对的，表没跟上） |
| `docs/protocol/zh/context.md §9` 示例 | fetcher 用 `authority.user.get` | 改真实方法（如 `user.*`）；`crm.*` 等保留为"示意、不存在"即可 |
| `docs/protocol/zh/context.md §10`（草案） | `authority.collab.create` 等 | §10 本就标"未实现"，落地时定归属（nexus/user），别假设 authority |

### 1.2 真实 per-agent 授权模型（实活 —— nexus 身份线，与 §2.5 同一件事）
authority 的"真问题"：**身份与最小权限没落到每个 agent**。
- **✅ 读路径已实现（2026-06-07，手动发证档）**：`authorityRole`=`system.*` 的 Sentinel，其 `data_fetchers` 经新增的 `relay.callAs` 以**自己的 bot token** 发起（`nexus/logic/identity.js` 持有 + 自动续签，`nexus.sentinel.token.set` 注入）；create/update 期**预审** fetcher ⊆ 该 bot permit；`disable` 软吊销（丢 token）。Router 零改动 —— 既有 `checkAccess` 按该 bot 窄 permit 即生效，审计归属到该 Sentinel。非 `system.*` 退回共享 `system.nexus`（legacy 非破坏）。
- **剩余（未做）**：① autorun(`agent.chat`) + `notification.send` 仍走共享 `system.nexus` token（刻意留到 emit-event 动作线一起）；② 自动发证（nexus 自建 bot，需 guard-railed 非-admin `user.bot.*`）—— 现为手动；③ 硬吊销需 admin（`user.token.revoke`），nexus bot 无此权限，由 portal admin 兜。
- 触及：`nexus/logic/{identity,context,sentinel,index}.js`、`library/relay.js`（已加 `callAs`）、`context.md §5.1②/§11.2`。
- **判断**：read-path 最小权限已落地（多租户细粒度的关键一步）；写侧最小权限随 §2.2 emit-event 动作线推进。

### 1.3 actor-claim / 信任根（治理线，更深）
"以谁的名义执行、下游如何验证归属" + "信任根是 server-attested 还是用户级签名"。
- ✅ **最小可行档已落地（2026-07-02，预审 + 透传 + 审计，无签名）**：事件信封 `actor`/`source` 经 matcher→run-command→run 实体（审计）→`$context.trigger_actor`；workflow opt-in `require_actor_permit:true` → runner §2.6 校验 **actor 本人 permit 覆盖全足迹**（fail-closed，不可解析形态直接拒，不走 NeedsGrant）；默认关=现状零破坏。confused deputy 最小面闭合（toFix §二.事件链 ✅）。hermetic `actor-precheck` 11 用例入 CI。
- **剩（跨信任域档，仍暂缓）**：X-Actor-Claim 签名头 + orchestrator 服务凭证 + `library/actor-claim.js` + `actor-claim.md` 协议——指回 `governance.md §2/§4` + `orchestrator/AUDIT.md` C4。
- **判断**：单信任域下 H6+C1+最小档够用；真要做用户级不可抵赖，得先给用户身份模型加私钥（governance.md §2 的"目的-能力缺口"）。

### 1.4 passport 注册/登录补全（外部用户自助接入）
> 设计已细化：[`docs/protocol/zh/passport.md`](../protocol/zh/passport.md) v1.2.0（§3.4–3.7 注册/登录 + OTP + 实现约束清单 + 安全审查）。passport v1（admin 供给 + `verify`→受限会话）已实现并过 e2e；缺"自助"这一档。
> **🆕 落地规格已出（2026-06-30）→ [`spec-passport-self-issuance.md`](./spec-passport-self-issuance.md)**：把自助 OTP 发证 + per-app 发证策略 + gateway relay 接线 + **公开面收敛**（翻 `public:false`）收敛成可实现契约。**因其是公开方法收敛的前置依赖、且默认 `closed` 纯增量，已拉回 v1.1.x**（原倾向 v2）。
> **✅ 第一阶段已实现（2026-06-30）**：OTP 自助发证 + 公开面收敛（`storage.asset.multi`）落地并过 hermetic（`passport-otp.test.js` 10 测试）+ e2e（`suites/111` 7 测试 full profile 绿）。见 CHANGELOG [Unreleased]。

- 🟢 **安全：凭证泄进日志（系统性）** — `status: done`（日志脱敏，2026-06-06）。`library/logger.js` 新增 `redactSensitive`（denylist：deviceToken/password/challenge/response/token/secret/otp/… + 嵌套递归），`ERROR:QUEUE` 入队前对 `params` 打码，**一次覆盖 passport + 登录凭证**（+6 hermetic 测试入 CI）。剩 ⚪ **报头传输硬化**（协议 §4.5 目标，deviceToken 改走 `X-Solo-Device-Token` 免入 params）——跨切面（Router 透传 + user 分发取 header（现 `index.js:224` handler 只收 params）+ 改客户端/e2e），**优先级低**（泄漏已止血）。证据：`logger.js redactSensitive`、`forward.js:50-58`。
- ✅ **自助注册/登录（推送式 OTP）已实现（2026-06-30）**：`user.passport.otp.request/verify`（public）+ `config.passport.{issuance,defaultRole}`（per-app、fail-closed、defaultRole 必行隔离）+ 一次性消费 + 防枚举 + 错码 anchor 锁定 + MULTI 原子。**剩**：① ~~`otp.request` 请求级限流~~ ✅ **已补（2026-07-01）**：per-anchor 定窗限流（默认 3/60s，`PASSPORT_OTP_REQUEST_{MAX,WINDOW_SEC}`）+ 卡死计数器自修 + `RATE_LIMIT_EXCEEDED (-32029)` 带 retry_after；不破防枚举；+3 hermetic。（per-IP 仍在 Router 层，未下沉服务）② TOTP 第二档（passport.md §3.5b）③ 报头硬化（见上条）。
- ✅ **接线缺口已补**：passport 工厂签名加 `relay`（`createPassportLogic(redis, config, {role, relay})`），user/index.js 仿 notification 构造 relay；OTP 经 `gateway.email.send` 投递（best-effort）。~~**剩**：生产需 admin 供给 user 的 relay token + user permit 放行 gateway send~~ ✅ **已接线（2026-07-01）**：`deploy/seed-bots.js` + `e2e/harness/setup.js` 双镜像新增 `system.user` relay bot（permit `gateway.email.send`/`gateway.sms.send`）→ 建 bot + 播 `RELAY:TOKEN:user`。默认关（issuance=closed）故 dormant，只加不破。
- ⚪ **未实现的运维档**：Salt 轮转（§4.1）、单设备撤销（§4.2 现仅整主体 `disable`）。

---

## 2. nexus（2026-06-05 审计；与 `context.md §11.2` 对齐）

> 已扎实、**不在待办**：context 装配（guard/data_fetchers/system_prompt）、autorun 闭环、投递可靠性
> （成功才 ack + 退避重试 + DLQ + 幂等）。下面是剩余。

### 🔴 Tier 1 —— 挡住"通用使用"
| # | 缺口 | 一句话 | 证据 |
|---|------|--------|------|
| ~~2.1~~ | **✅ 动态订阅流（已实现）** | `stream.js` 每 tick `discoverStreams()`（默认流 ∪ 每个 ACTIVE Sentinel 的 `eventSubscriptions`），新流免重启自动建组消费 + NOGROUP 自愈。任意业务事件可接。 | `stream.js` discoverStreams/ensureGroups；e2e `66-nexus-dynamic-streams` |
| ~~2.2~~ | **✅ emit-event 动作闭环（已实现 2026-06-07）** | 声明式 `context.emit:{stream,type,emit_when?,payload_template?}`（inverted gate）；autorun 后经真实 Router `event.emit` 发决策事件上总线（`actor=sentinel:{id}`，at-most-once SETNX 守卫），下游 Sentinel/orchestrator matcher 消费。**剩**：结构化产出契约（现 autorun 仍裸 `agent.chat`，emit 用 event/fetch/sentinel 字段）。 | e2e `69-nexus-emit-loop`（full）；`context.js` buildEmit、`stream.js` emit 分支 |
| ~~2.3~~ | **✅ 外部投递闭合（webhook 已建 / sse fail-closed，2026-06-10）** | `gateway.webhook.send`（`gateway/logic/webhook.js`：POST JSON + HMAC-SHA256 `X-Solo-Signature` 签名 + SSRF 守卫 + 有界超时）已注册；sse 改为 `notification.config.set` / `sentinel.broadcast` 直接 fail-closed（"配上即死信"→"诚实拒绝"），broadcast 的 webhook 路径随之转真。剩：SSE 主动推送本身仍 v2。 | `gateway/handlers/introspection.js:127` + `index.js:130`；hermetic `gateway/tests/webhook.test.js`；e2e `100-delivery` |

### 🟠 Tier 2 —— 重毛刺 / 脚枪
| # | 缺口 | 一句话 |
|---|------|--------|
| ~~2.4~~ | **✅ Sentinel 生命周期收圆（2026-06-07）** | `update`（保 id/历史）+ `enable`（重激活+重订阅+重建组）+ `delete`（注册表硬删）+ `disable`（软吊销 token + **清 `NEXUS:SUB` 订阅集**）全齐。剩：硬吊销活 session 仍需 admin（`user.token.revoke`，nexus bot 无权——由 portal admin 兜）。 |
| 2.5 | **身份/最小权限**（读路径已实现） | = §1.2。✅ read-path：per-Sentinel token（`relay.callAs` + `identity.js`）、`authorityRole`→bot 绑定、create 期 fetcher⊆permit 预审。剩：写侧（autorun/动作）token、自动发证。 |
| ~~2.6~~ | **✅ fetcher 有界（2026-06）** | 原述"relay 无 socket 超时"**不确**——`relay.js:247/280` 早有 socket 超时（~90s），但对 context fetch 太宽：单消费者会被慢上游拖最长 ~90s/事件。已加**每-fetcher 紧超时**（`context.js` `withTimeout`，`NEXUS_FETCHER_TIMEOUT_MS` 默认 8s），超时按该 fetcher 的 `on_error`（skip/fallback/abort）处置。hermetic 2 用例（`context.test.js`）。 |
| 2.7 | **Portal 运维面缺口** | `nexus.dlq.*` 有 RPC 但无 DLQ 查看/重投 UI；无 agent 收件箱视图；无 agent 编辑（依赖 2.4 的 update）；context 编辑器**没有 autorun 开关**；无 nexus token 注入 UI。 |

### ⚪ Tier 3 —— 小 / 打磨
- ~~模型选择只能 `redis-cli`~~ ✅ **已补（2026-07-01）**：`agent.model.list/set/reset`（admin RPC，写后 bust 缓存立即生效，声明↔注册同步 + autocheck 过，+8 hermetic）+ 门户 `Settings/ModelPanel.tsx`（per-capability effective/default/override 表 + 就地编辑，内联反馈无系统弹窗）。`SYSTEM:CONFIG:AI_MODELS` 现有完整 RPC/portal 写路径。
- autorun LLM 失败静默降级（`output=null`，不重试、不告警）。
- 无外部 agent SDK/范例（每个集成方手搓 `notification.inbox.list/ack` 轮询循环）；无自定义事件流的接入 runbook。

### 📄 Tier 4 —— 文档
并入 §1.1（authority 清理）；其余随手修。

---

## 3. 其它服务 / 跨切面（指回详情，不复制）

| 主题 | 一句话 | 权威详情 |
|------|--------|----------|
| **联邦分类坏** | ~~`category.create/delete` 经 Router 登记 key 时不带凭证 → 永远 `Admin required`~~ ✅ **已修（2026-06-07）**：Router `system.category.reserve/delete` 从 `isAdmin` 放宽为 `isAdmin \|\| isLoopbackRequest`（单机 localhost 信任，`delete` 仍 owner-scope）；多 HOST 部署才需改 service-bot token（已注释标注）。 | `docs/planning/toFix.md §1 #2`（✅ 已修，此前 BACKLOG 表 stale） |
| **生产硬化** | relay/category 无超时、permanent-error 当临时重试、Router token 可重放、storage 无签名 URL、CORS 全开、Redis 默认无密。 | `docs/planning/toFix.md §2` |
| **orchestrator** | 版本快照/revise、deprecate、trace 持久化、Saga compensate（**同步档已落**，durable 跨重启留 v2）、`method.grant` 服务凭证治理。 | `orchestrator/AUDIT.md` |
| **治理线** | footprint 预审 H6 ✅、C1 审批闸 ✅、approval **已双轨接通**（orchestrator 高风险门 + collection 退款门）、**actor-claim 最小档 ✅**（2026-07-02，事件 actor 透传 + `require_actor_permit` opt-in 预审 + run 审计，见 §1.3）；剩 C1 单签↔A5 双签收敛、信任根签名档（见 §1.3）。 | `governance.md`、`orchestrator/AUDIT.md` |
| **fulfillment profile 投稿面** | lint 契约（6 规则）+ `profile.generate` + **投稿面 + 完整性闸已落地**（`submit`/`approve`/`reject` + `reviewState` + 实例激活闸（create + advance）+ 职责分离 + **改可执行字段回审/冻结** + `approvedDigest` 绑定版本；e2e 104 十用例）。**剩（深档）**：投稿配额、高风险 Ed25519 签名多签（经 approval）、外部投稿身份窄 bot、(可选)完整版本归档 + 实例 pin digest。 | `docs/protocol/zh/fulfillment.md §7` |
| **AI 准确率 eval** | NL→意图/参数准确率**无系统评估**（mobile route-mocked e2e 故意 mock 掉 AI）。真实载体 = `api/autonomous/workflow-auditor/` + `agent.case.generate`。做成 eval/基准线，非 tester 微服务。（注：portal/system 旧 `AISupport` 页已于 2026-06 移除，不复活。） | `docs/protocol/zh/ai-test.md`（stub） |
| **返回契约债** | 全 14 服务"声明 vs 真实返回"审计后剩 ~47 条**非阻塞**缺陷（同族/跨路径形状不一致 · 裸数组 list · agent provider 分歧 · 条件键）。`returns_schema` 已如实标注、e2e 全过 → 属一致性/约定债 + 几个未完成功能。🔴 影响 fulfillment 取数的仅 B/D/H 类。守卫已建（`library/contract.js` + ai:true 覆盖闸 + `fulfillment/logic/lint.js`）。 | `docs/planning/return-contract-debt.md`（2026-06-18 审计，带 file:line） |
| **架构协调性债** | "长歪了"清单（非 bug，是不一致）：① 四份各自为政的 60s 进程内缓存多数无 bust（router events/tasks/ratelimit + agent model_config；§5.6③ 根因）—— **✅ 功能面已修（2026-07-01：tasks/ratelimit 写即 bust + model_config 已带 bust + events 无运行时写者不需要）**，DRY 合并留 v2 ② 两份手工同步的 bot 权限图（seed-bots ↔ e2e harness）③ `public` 声明散 3 层无单一真源（"public 太多"的结构根因）④ 服务内 admin 校验深浅不一（8 服务 vs 纯 Router，约定 vs 实践）⑤ 端口两份真源（services.json ↔ config.js portFor）⑥ 返回契约债（见上条）⑦ 桩/真方法混排 introspection。②④⑤⑦ 可 v1.1.x 顺手做；①DRY 合并 + ③ 留 v2 破坏窗口。 | `docs/planning/coherence-debt.md`（2026-07-01 走查，带 file:line + 归属标注） |

---

## 4. 部署瘦身 / bundle 减肥（v1.1.x 可先行）

> 设计与三层路线（切片 / 多产物 / 动态拉取插件平台）见 [`VERSION.v2.md`](./VERSION.v2.md) §4。下面是**"只加不破"、现在就能落**的子集
> （动态拉取插件平台本身是 v2）。痛点实体：`deploy/build.sh` 产的 `api/publish/solo.js` ≈ **7.7MB** 单 bundle，
> esbuild 把全部 13 个服务无差别打进去（重量 build-time 钉死，运行时 `SOLO_SERVICES_JSON` 只选启动子集、不减体积）。

| # | 项 | 一句话 | 收益 / 风险 | 证据 |
|---|----|--------|------------|------|
| 4.1 | ✅ **内核移除 `@solana/web3.js`**(2026-06-30，已删依赖) | 用户授权后完成 router 收尾：`router/handlers/keypair.js` 的 `Keypair.generate/fromSecretKey/.publicKey.toBase58()` → `nacl.sign.keyPair`+`bs58.encode`，用**薄包装保留原 Keypair 接口**（`getKeypair().secretKey` / `.publicKey.toBase58()` 调用方零改），`.keypair` 64-byte 格式不变、无需轮换。库侧 `auth.js`/`router-auth.js` 早先已换 `bs58.decode`+护栏。**@solana 已从 package.json+lock 彻底删除**（全仓零 require → esbuild 不再打进 bundle）。验证：keypair+auth 五套 54 测试绿 + 真实使用冒烟（keygen→落盘→签→验→伪造拒→重载持久化）全过。 | `router/handlers/keypair.js`、`library/auth.js:73`、`library/router-auth.js:70` |
| 4.2 | ✅ **构建时切片 `--services`**(2026-06-30) | `deploy/build.sh` 加 `--services a,b,c`：把 services.json 切到子集喂 `gen-entry.js`，esbuild 只打子集；**默认无参=全量**(只加不破)，未知服务名 fail-fast。切片逻辑已独立验证(3/13、坏名报错)、`bash -n` 过；未跑完整 esbuild(重、会改 publish/solo.js)，默认路径与原先逐字节相同。 | `deploy/build.sh`（slice 段 + `EFFECTIVE_SERVICES_JSON`） |
| 4.3 | ✅ **清死依赖**(2026-06-30) | `xlsx/jimp/jsqr/jszip/multer` 全仓零 `require`（已 grep 核）→ 从 `api/package.json` 删，`npm install --package-lock-only` 同步 lock（root.deps 已清空）。 | `api/package.json`、`package-lock.json` |
| 4.4 | ✅ **死引用 / stale 清理**(2026-06-30) | `package.json "start"` `deploy/launcher.js`(不存在) → `node monolith-entry.js`；`monolith-entry.js` 补齐 nexus/notification/ingress/approval（数组 + dispatch 两处），13 服务齐，`node --check` 过。 | `api/package.json`、`api/monolith-entry.js` |

> 进度(2026-06-30)：**§4 全部落地** —— 4.1（含 router `keypair.js` 收尾 + 从 package.json/lock 删 @solana）、4.2、4.3、4.4 均已完成。esbuild 不再打 @solana（全仓零 require）；exact bundle MB 待一次 `bash deploy/build.sh` 实测。

---

## 5. 测试门禁硬化（v1.1.x 可先行，"只加不破"）

> CI 白名单（`api/jest.ci.config.js`）2026-06-30 实跑 **105 套 / 1690 测试**绿（1685 passed + 5 skipped）。
> 仓内 `*.test.js` 约 140 个，余被排除（非 hermetic / 脚本式约定 / 实测 fail）。下面是把门禁做厚的子集，均"只加不破"。

| # | 项 | 一句话 | 归属 / 证据 |
|---|----|--------|------------|
| 5.1 | ~~🔴 **`validator.test.js` 真 bug**~~ ✅ **已修(2026-06-30)** | 诊断：单常量漂移——测试按 100KB 写，`config.js:71` 后来把默认放宽到 5MB、没回头改测试 → 两条断言恒 fail（**非运行时 bug**，盾在工作只是更松）。5MB 是有意的分层设计（bodyLimit 50MB 外环 → binary 字段 10MB 豁免 → string 5MB 粗盾 → 逐字段上限走 schema `maxLength`），故测试是过期那边。修法 (a) test-only：require 前钉 `MAX_STRING_LENGTH=102400`、用完还原 env（防 `--runInBand` 泄漏），套已转绿(22/22)并提进白名单。**未碰任何 router 生产逻辑。** | `router/tests/validator.test.js:1-13`、`jest.ci.config.js` |
| 5.2 | ✅ **提升 hermetic 套**(2026-06-30) | 逐个实跑复核后提进白名单：`orchestrator/run`(5/5)、`administrator/display`(9/9)、`router/keypair`(2/2)。**排除**（子代理"看着可入"被实跑推翻）：`router/system`(6 failed)、`router/capability`(1 failed)、`administrator/identity`(单跑挂>2min，非 hermetic)。 | `jest.ci.config.js` |
| 5.3 | 🟡 **脚本式"测试"——改写：非垃圾，是有意约定** | 复核发现这些是被 `node` 主动调用的约定：`apps/storage/package.json:8` 的 `npm test` = `node tests/scripts/unit.test.js .`（YAML 驱动 runner），`sample`/`planner` 的 `cases.md` 都文档化了 `scripts/unit.test.js`；`wal-recovery.test.js` 是 `walarchiver.js`/`library/README` 指向的 WAL 灾备集成脚本。**盲目改名/移走会打断 storage `npm test` + 多处文档**。它们已不在 CI 白名单、只在 ad-hoc 全跑（`jest` 无 `-c`）时碍事，而仓库本就要求用 `-c jest.ci.config.js`。真要净化 ad-hoc 全跑，应加默认 `jest.config.js` 的 `testPathIgnorePatterns`（低价值、可选）。**不强行改、不破约定。** | `apps/storage/package.json:8`、`sample/tests/cases.md` |
| 5.4 | ✅ **补薄覆盖：ingress**(2026-06-30) | 新增 `core/ingress/tests/ingest.test.js`（10 测试，纯依赖注入、零 redis/disk/net）：ingest.handle 五条路径(accept/duplicate/unauthorized/disabled/invalid) + emit 信封 + 审计行 + testFire + dedup.claim NX 幂等。已进白名单。**（2026-07-01 续）** `apps/collection/tests/logic.test.js` + `apps/market/tests/logic.test.js` 已本是纯 mock-redis DI、实跑绿 → **入白名单**；**剩** `apps/planner`：无 `logic.test.js`，其 logic 走 entity factory（需 RedisJSON fat-mock，非 collection 那种手搓 set/get 可照抄），且已有 returns-contract（CI）+ e2e 22/59 冗余覆盖 → **暂缓**（性价比低）。 | `core/ingress/tests/ingest.test.js`、`apps/{collection,market}/tests/logic.test.js` |
| 5.5 | ✅ **长链 e2e 抖动根因**(2026-06-30，判定 by-design) | 根因 = **固有异步延迟、非缺陷**：多跳 fire-and-forget（`tasks.js:155` 不 await）+ orchestrator/nexus `blPop`/`block` 各 5s + 测试 500ms 轮询，满载盒子累积 30–90s。收紧 blpop→CPU 空转、await `_task`→拖慢响应——**timeout bump 是唯一正确缓解**，无需改生产代码。按 by-design 收口。 | `router/handlers/tasks.js:155`、`orchestrator/config.js:94`、`nexus/config.js:65` |
| 5.6 | ✅ **全量 e2e 共享-mesh 隔离硬化**(2026-07-01 立项 + 同日修完) | 全量（66 套一套 mesh 串行）此前非稳定绿，**三类既有债、与产品改动无关、不在 CI 阻塞门**（CI 走 hermetic 白名单，不含全量）——**全部结构性修复，修后 66 套/349 测试连跑稳定绿（耗时 ~303s→~117s，不再空耗超时）**：**① 最终一致性轮询超时** → `jest.config.js` `testTimeout` 60s **小于**套内 90s poll 预算，抬到 **150s** 对齐（套注释早已假定此值）；**② 全局 `ERROR:QUEUE` 跨套污染**（真隔离 bug）→ `assertNoErrors` 改 **每套 beforeAll 抓基线、只断本套新增 delta**（`lib/verify.js` `captureErrorBaseline` + `harness/reset-errors.js` setupFilesAfterEnv；非破坏、不改 ~20 调用点）；**③ Router taskWhitelist 60s 缓存竞态**（新发现）→ Router `handlers/tasks.js` 缓存白名单 60s 无写时 bust，5 个 pipeline 套各改各的窄子集致值翻转、市场 `_task` 偶发误判 BLOCKED（`market.order.pay is not allowed`）→ 固定为**单一联合超集**（`lib/whitelist.js`，harness 开机播种 + 54/101/102/103/104 统一引用，值全程不变）。均不碰 router。 | `lib/verify.js`、`lib/whitelist.js`、`harness/{setup,reset-errors}.js`、`jest.config.js`、`suites/54/101/102/103/104` |

---

## 6. 已知桩 / 未实现能力（诚实标注，非 gap；默认 v2 / 待真实消费者）

> "框架预留但未接"的占位，**不是 bug、也不算 v1.1 gap**——列此防止把它们当已实现能力误用。

- **`library/vector.js`** —— 纯占位：四个方法只 `console.log` 返回假数据、**零生产引用**，其测试自标 100% 覆盖为 vacuous（`vector.test.js` STUB NOTICE）。文件已加显式 STUB 横幅。真要做语义记忆时再实现（需 embedding provider + 向量库）。→ v2 / 待真实消费者。
- **`apps/planner` `todo.analyze` / `todo.schedule`** —— Phase-2 桩，返回写死 `PENDING`（`introspection.js` 已标 `STUB_RETURN`）。→ Phase 2。
- **agent provider 局部覆盖** —— `openai` / `bitexing` 的 `focus`/`identifyPurpose*` 选中即 throw "not implemented"；`gemini.focus` 是未完成桩。诚实抛错（非静默），按需补齐。→ v2 / 按需。

---

## 附：本清单合并了哪些来源
- `docs/planning/toFix.md` —— API 待修详情（保留为 drill-down；其条目在 §2/§3 已索引）。
- `docs/protocol/zh/context.md §11.2` —— nexus 上下文协议的未尽（已在 §2 汇总）。
- `api/core/orchestrator/AUDIT.md` —— 编排实现差距（仍是权威详情）。
- `docs/protocol/zh/governance.md` —— 治理缝合图（信任根/双轨审批/actor-claim）。
