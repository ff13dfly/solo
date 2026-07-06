# SOLO v1.1 — 版本规格（封板线）

> **本文件是 v1.1 的验收边界。** BACKLOG 是滚动清单，本文是切面：边界内做完即封板，
> 边界外的新发现一律进 v2。冲突时以本文 + 代码为准。
> 拍板：2026-06-11（与用户对齐）。状态标记：✅ 已落地 / 🔨 待做 / ⛔ 出版（v2）。

---

## 0. 这一版（v1.1）是什么

在 v1.0 纯框架底座（网关 / 实体工厂 / 权限 / 审计）之上，**v1.1 把 SOLO 拉成一个
AI-native 自动化平台**——主要新增 / 做实了围绕"AI 自动化"的服务与治理：

- **nexus**（Sentinel 事件订阅式 AI 反应体）：动态订阅流、autorun（agent.decide 结构化决策）、
  emit-event 动作闭环、per-Sentinel 身份与最小权限、生命周期收圆、环路/深度刹车。
- **fulfillment**（声明式状态机履约引擎，JsonLogic）：状态转移发为 Router `_tasks`、幂等键、
  事件总线联动。
- **支撑 AI 自动化的其余服务/能力**：agent（LLM 中枢 + decide 结构化决策契约）、ingress（入站
  webhook 适配 + 去重）、storage OSS 子系统 + 对象级授权、事件链全链 trace + WAL 账本、
  生产硬化包（/metrics + CORS + Redis 硬化 + DLQ 告警）。
- **治理线（本轮主干，§3）**：让"AI 投稿 → 人审批 → 框架执行 → 可退回人工"成为可信闭环。

## 1. 版本定位（一句话）

**受信外部 agent 投稿档（B 档）**：外部 AI（如 OpenClaw 实例）以受限身份投稿 workflow，
人工经签名审批激活，框架（nexus/fulfillment/orchestrator 等）执行，失败随时退回人工。

## 2. 本版假设（写明即契约，不是债）

- **单信任域**：所有服务、Redis、审批人在同一信任边界内；执行归属 server-attested
  （Router Ed25519），用户级签名仅覆盖**审批面**（见 §3.2）。
- **单机部署**：loopback 信任成立（category 等）——**现状仍是单机**；多机部署硬化
  （loopback→service-bot）已判定为可"只加不破"、拉回 v1.1.x 排期（见 §4 2026-07-03 回写），
  但**尚未实现**，本行描述的仍是今天的真实状态。
- **手工发证**：bot/passport 由 admin 手工供给；**OTP 自助注册已拉回 v1.1.x 并落地**（2026-06-30，
  见 §4 回写），TOTP 第二档已判定可只加不破、拉回 v1.1.x 排期（尚未实现）。
- **AI 运行时决策 = 实验特性**：sentinel autorun（agent.decide）可用但不背书生产，
  决策上下文含不可信文本时勿驱动高风险动作。**置信阈值可配置化**（`risk_tolerance` 具名档位）
  已落地（2026-07-03，见 toFix.md）；**完整判据重设计**已判定可只加不破、拉回 v1.1.x 排期
  （见 §4 回写），但两者都不改变"实验特性、不背书生产"这条现状定性——尚未实现完的部分不改变。
- **失败语义定版**：worker 队列 at-most-once（blPop）+ STALLED 扫描兜底；
  执行失败 = FAILED + cleanup_manifest **弹人工**，无自动补偿（判断不出任务复杂性，
  自动补偿的安全前提无法静态判定——v2 若做也是 per-workflow opt-in）。
  > **v1.1.3 更新**：上述"per-workflow opt-in 自动补偿"已提前落地（仍是 opt-in，**默认契约不变**——
  > 不声明 `compensate` 的 workflow 失败行为仍是 FAILED + manifest 弹人工）。同时接线了 at-least-once
  > 幂等键（`step.idempotency_key`，引擎提供、下游去重）+ STALLED 幂等重驱（`orchestrator.run.retry`）。
  > **仍未做**：step-cursor 中途续跑、全网统一幂等键、durable 跨重启补偿。详见 §4 回写与 orchestrator README §7。

## 3. 入版清单（= 封板前要做完的）

> **✅ §3 治理线全部落地（2026-06-11）。** CI hermetic 67 套/848 测试绿（新增
> key/risk/gate/layered-approval）；全栈 e2e 新增 suite 110（治理全链路 10 用例）。
> 实现偏差：approval↔orchestrator 走**同步 relay**（不碰 router 事件注册表红线）；
> digest 不含 version（避免 approve 版本自增打断签名绑定）；sensitiveServices 默认空
> （write-verb-only 已覆盖一切副作用 workflow）；snapshot 裁剪为「外部只见 ACTIVE」
> （方法目录 ai:true 裁剪记 v1.x 纵深，窄 permit 才是真容器）。

### 3.1 分层审批（治理线主干）✅
- C1 保留为**快速单签档**（低风险 footprint：纯读/白名单方法），approval 服务承接
  **高风险多签档**（写方法、敏感服务），orchestrator 审批入口按风险规则路由。
- m-of-n 机制化 + **默认配置 1-of-1 + 高风险类目冷却期**（批准后 N 小时生效，
  默认 24h，留反悔窗口）；审批 expiry 72h，过期 → EXPIRED（可 restore 重投）。

### 3.2 审批人体系：user 角色 + 密码加密签名私钥 ✅
- approver 角色落 user 服务 permit 体系（administrator 单管理员模型不动——系统运维 ≠ 业务审批）。
- 每审批人一对 Ed25519 密钥：私钥 scrypt/argon2 + AES-256-GCM 密码加密存
  `USER:SIGNKEY:{uid}`，**密码不存储、每次签名输入**。
- 流程：portal 审批模态收密码 → `user.key.sign { digest, password }`（仅本人会话可签，
  限速防爆破）→ `approval.record.confirm { id, signature }` 验签落不可变记录。
  密码只在 portal↔user 之间（logger.redactSensitive 已覆盖）。
- **digest = sha256(workflowId + version + 定义快照规范序列化)** —— 绑定 §6.6 不可变
  快照，"谁批了哪一版"永久可验，不可抵赖。
- 忘记密码：admin 重发密钥对，公钥历史保留（旧签名仍可验）。

### 3.3 审批可视化（盲签禁令）✅
portal 审批视图必须呈现：footprint（全部步骤方法）、event_subscriptions（被什么触发）、
input_schema、与上一已批版本的 diff。**审批的安全性 = 审批人看到的信息量。**

### 3.4 外部投稿面 ✅
- OpenClaw 标准身份 = **窄 permit bot**（`orchestrator.workflow.create` + 能力快照只读，
  不授任何数据/执行方法——投稿身份永不执行，执行发生在审批背书后的 orchestrator 身份下）。
- 投稿配额：per-identity 10 次/小时；PENDING_REVIEW 全局上限 100（满 → 拒新投稿）。
- 能力发现暴露面：外部身份看到的 snapshot 为**裁剪版**（仅 ai:true 方法）。

### 3.5 收尾 ✅
- BACKLOG §1.1 文档清理（authority 残留表述）。
- `api/sample/` 模板对齐 autocheck（模子不能带病）+ 纳入 CI static 循环。
- portal 2.7 剩余项中仅审批视图入版（3.3）。其余出版（agent 收件箱视图/token 注入 UI）；
  **context 编辑器 autorun/emit 配置已提前落地**（commit 1d06557 + e2e ui spec）——原列 v2，封板前并入，
  属 v2 项提前，非 v1.1 硬要求。「autorun 置信判据重设计」仍出版（§4）。

### 3.6 已落地的版本基座 ✅（仅索引，不重复）
运行时安全七件套（toFix §6：失败语义/触发幂等/schema 门/storage 授权/生产硬化包/
版本快照/运维面）；防腐化三闸（per-service autocheck + hermetic 61 套 + live e2e 54 套，
全部 blocking）；auth 分叉清零（5 处 → library/auth）；事件链治理（trace 全链 + depth
刹车 + 事件去重）。

## 4. 出版清单（明确不做，v2 起点）⛔

> **v2 范围归集已独立成文：[`VERSION.v2.md`](./VERSION.v2.md)**（草案，含跨网格联邦 bridge 等新提案）。本节是清单源头，详写与依赖在那。

**仍出版（真 v2）**：actor-claim 全量（执行面用户签名/服务凭证——涉及用户私钥管理体系，判定为破坏性架构）·
重投队列语义里**完整** at-least-once + 全网统一幂等键那半（判定为破坏投递保证语义，会让未做幂等处理的
下游 handler 被静默重复调用；2026-07-03 起降级为**可选/非阻塞**——不做只是维持现状 STALLED 人工重驱，
非新增风险，量小时可无限期不做）。

~~passport 自助注册（OTP）~~（已拉回 v1.1.x，2026-06-30 落地）· ~~passport TOTP 自助~~（判定只加不破，已拉回 v1.1.x 排期）·
~~SSE 推送 / MCP adapter / 外部 agent SDK~~（判定纯增量，已拉回 v1.1.x 排期）·
~~Saga 自动补偿~~（同步 best-effort 已落地；durable 跨重启续跑判定只加不破，已拉回 v1.1.x 排期）·
~~metrics 正式档~~（Prometheus/Alertmanager，判定纯增量，已拉回 v1.1.x 排期；最小告警档已是既有 v1 基座）·
~~autorun 置信判据重设计~~（`agent.decide` RPC 契约不用变，判定只加不破，已拉回 v1.1.x 排期；`risk_tolerance`
具名档位已是这条的部分先行落地，2026-07-03）·
~~重投队列语义里 `_task` fire-and-forget 丢投修复那半~~（**已确认的真 bug**——`router/handlers/tasks.js`
派发不 await、无 ack/retry/DLQ，过载静默丢，e2e 已实测 `order=PLACED instance=CLEARED` 类实体不一致；
窄义修法不改变投递保证语义、不影响下游，按 bug 处理不分版本，已拉回 v1.1.x 排期）·
~~多租户开放档~~（**已取消**，非拉回——用 E 线 SOLO Bridge 的联邦隔离替代，每租户一套独立网格，隔离强度
高于同库内 tenant scoping 且不用改任何现有实体/permit 形状，见 VERSION.v2.md §3）·
~~多机部署硬化~~（loopback→service-bot、TLS——配置开关，单机部署无感知，判定只加不破，已拉回 v1.1.x 排期）。

> **v1.1.3 回写（2026-06-26）**：上列两项**部分提前落地**，因实现是「只加不破」的 per-workflow opt-in 增量，
> 符合阶段一纪律（runbook §2/§5），不触发 v2：
> - **Saga 自动补偿** → **同步 best-effort 档已落地**（`compensate` step-id 引用，逆序执行，失败入 DEAD_LETTER）。
>   **仍出版**：durable 跨 orchestrator 重启补偿（需 step-cursor）。
> - **重投队列语义** → **幂等键接线 + STALLED 幂等重驱已落地**（`step.idempotency_key` 引擎提供 + `orchestrator.run.retry`）。
>   **仍出版**：全网统一幂等键、at-least-once 重投队列的完整语义（当前去重是 per-service、重驱是 STALLED-only 人工触发）。

> **passport 自助发证回写（2026-06-30）**：「passport 自助注册（OTP）」拉回 v1.1.x——它是**公开方法收敛**（把 `agent.chat`/`storage.asset.multi` 从匿名面挪到会话后）的前置依赖，且实现默认 `closed` = 现状、纯增量（符合阶段一纪律）。落地规格见 [`spec-passport-self-issuance.md`](./spec-passport-self-issuance.md)。**仍出版**：passport TOTP 自助、报头硬化（`X-Solo-Device-Token`）。

> **2026-07-03 出版清单拆分回写（用户拍板，规划改动，尚未实现）**：把出版清单剩余项按"能否只加不破"重新过了一遍——
> - **A 线（信任模型升级）**：**多租户开放档取消**（非拉回）——用 E 线 SOLO Bridge 的联邦隔离替代（每租户
>   一套独立网格，隔离强度高于同库内 tenant scoping，且不用改动任何现有实体/permit 形状），详见
>   [`VERSION.v2.md`](./VERSION.v2.md) §3。**多机部署硬化**（loopback→service-bot）判定只加不破（配置开关，
>   单机部署无感知）→ 拉回 v1.1.x 排期。**actor-claim 全量**（用户/服务凭证签名）**仍留 v2**——涉及用户私钥
>   管理体系，判定为真正的破坏性架构改动，未被这轮拉回。
> - **B 线（投递/补偿完整可靠语义）拆分为二**：① `router/handlers/tasks.js` 的 `_task` fire-and-forget
>   丢投（无 ack/retry/DLQ，过载静默丢，e2e 已实测 `order=PLACED instance=CLEARED` 类实体不一致）——**已确认
>   的真 bug**，窄义修法（加重试+DLQ 可见）不改变投递保证语义、不影响下游 → 拉回 v1.1.x，按 bug 处理不分版本。
>   ② **完整 at-least-once 重投队列 + 全网统一幂等键**——投递保证语义从 at-most-once 变 at-least-once，会让
>   未做幂等处理的下游 handler 开始被静默重复调用，是真正的行为破坏 → **仍留 v2，且降级为非阻塞/可选**（不做
>   只是维持 v1.1 已有的 STALLED 人工重驱状态，非新增风险）。**Saga durable 补偿**（跨 orchestrator 重启续跑，
>   需 step-cursor）判定只加不破（run 实体形状不用变，照抄 sync 补偿的 opt-in 声明模式）→ 拉回 v1.1.x 排期。
> - **C 线（AI 自治转生产级）**：autorun 置信判据重设计判定只加不破（`agent.decide` RPC 契约不用变）→ 拉回
>   v1.1.x 排期，续 `risk_tolerance`（2026-07-03 已落地的具名容忍度档，部分先行缓解）之后的工作。
> - **D 线（接入面/运维正式档）**：passport TOTP、SSE 推送、MCP adapter、外部 agent SDK、metrics 正式档
>   全条判定为纯增量 → 拉回 v1.1.x 排期。
>
> 详见 [`VERSION.v2.md`](./VERSION.v2.md) §1/§2/§5 与 [`BACKLOG.md`](./BACKLOG.md)。**本轮只是拆分/重新归类
> 待办位置，未动代码**——排入 v1.1.x 排期的项目仍需逐条设计实现，不因这次归类就算完成。

## 5. 封板流程

1. ✅ §3 全部转 ✅，阻塞闸 CI 全绿（static 15 目录 / hermetic 67 套·848 测试 / portal-tsc system+operator / live e2e 55 套·281 测试；ui-e2e 非阻塞）。
   **2026-06-13 全闸本地复跑确认绿**（redis-stack-server，非普通 redis-server——见 CLAUDE.md §6）。
2. ✅ **已封板并发版**：未走 rc1，直接从已验证 commit 打 `git tag v1.1.0`（2026-06-14）；其后滚动补丁均已打 tag 并推 origin——`v1.1.1`（2026-06-16，idle 空转热修）、`v1.1.2`（2026-06-20，返回契约线封闭）、`v1.1.3`（2026-06-26，编排可靠性纵深：at-least-once 幂等 + Saga 同步补偿 + 崩溃幂等重驱 + 签名退款审批门）、`v1.1.4`（2026-06-26，脚手架下游契约包）、`v1.1.5`（2026-06-26，审计驱动修复 + Saga 收尾）、`v1.1.6`（2026-06-30，passport 自助发证 + 公开面收敛 + UI e2e 框架转阻塞 + 错误处理统一/错误码守门 + 脚手架文档收进 `docs/` + 部署瘦身/@solana 移除；全量 e2e 64/64 + CI 子集 106 套/1702 绿）、`v1.1.7`（2026-07-01，公开面收敛收官：passport 身份线 device/bot/upgrade + 二次收窄 6 法 + `user.profile` 转 permit 门控/tier 随 login.verify 下发；公开方法 ~20→19；收敛专项 e2e 111/112/113 + router 契约 40/40 + CI 子集 106 套/1697 绿；全量 e2e 既有共享-mesh flaky 立项 BACKLOG §5）、`v1.1.8`（2026-07-01，测试基础设施硬化：全量 e2e 三个共享-mesh flaky 机制 §5.6 ①poll 超时/②ERROR:QUEUE 跨套污染/③taskWhitelist 缓存竞态 结构性清零 —— 连跑两轮 66 套/349 稳定绿；收尾 passport otp 请求限流 + `storage.asset.get/resolve` 转门控（公开方法 19→17）+ OTP 生产接线 + `agent.model.*` RPC/门户面板；CI 子集 109 套/1727 绿；不碰 router）、`v1.1.9`（2026-07-02，架构协调性债清理：#1 缓存写即 bust（触及 router，用户明确授权）/ #2 bot 权限图单一真源 / #4 服务内 admin 校验误诊澄清·保留不动 / #5 端口单一真源 CI 守门 + actor-claim 最小可行档（预审 + 透传 + 审计，AUDIT C4 / confused deputy 最小面闭合）；CI 子集 110 套/1751 绿；全量 e2e 66 套绿）、`v1.1.10`（2026-07-03，MCP adapter 新服务（第 14 个，workflow-first）+ v2 出版清单拆分拉回两项落地：AI prompt injection 防御第二轮（启发式检测）+ Saga durable 补偿（持久化游标 + 重试上限）+ `agent.decide` risk_tolerance 具名容忍度档 + orchestrator 执行轨迹持久化 + public 面白名单守门 + administrator setting.config.* 硬门；CI 子集 114 套/1794 绿；相关 e2e 对真实全栈跑通；不碰 router）。各 `package.json.version` = bundle 名 = 消费者 `.solo-version` = tag 一致。**下一发布点 = 从 main 打 `v1.1.11`**（见 CHANGELOG [Unreleased]）。发版/分支可执行版见 [`../runbook/release-and-branching.md`](../runbook/release-and-branching.md) §6。
3. **当前 = 阶段一（trunk + tags）**：main 保持向后兼容（只加不破），继续推 v1.1.x，下一发布点从 main 打新 tag。**真要动破坏性架构**时才进阶段二：从 `v1.1.x` tag 拉 `release/v1.1`、main 转 v2（bugfix 在 release 分支修 → cherry-pick 回 main）；届时本文件冻结，v2 另起 VERSION.md。

> **发版/分支/兼容纪律的可执行版见 [`../runbook/release-and-branching.md`](../runbook/release-and-branching.md)；每个 tag 配 [`CHANGELOG.md`](./CHANGELOG.md) 一条。**
