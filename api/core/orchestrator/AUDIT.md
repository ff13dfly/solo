# Orchestrator 实现差距与对齐清单

> **与 `README.md` 配套使用**。README 描述目标设计，本文追踪当前代码相对目标的差距。
>
> **使用约定**：
> - 每条差距完成后改勾选框为 `[x]`，"Done in" 填 commit hash
> - 任何 PR 描述需回答："本次改动消除了清单里哪条？引入了哪些新差距？"
> - 新发现的差距追加到对应严重度，不删除已修复条目（保留历史）
>
> **首次建立**：2026-05-17（基于审计报告）

---

## 状态总览

| 严重度 | 已修 / 总 | 暂缓 |
|--------|----------|------|
| ⛔ CRITICAL | 3 / 4 | C4（actor-claim，见下） |
| ⚠️ HIGH | 4 / 6 | H1（Router 已覆盖）、H5（优化功能） |
| ⚪ MEDIUM | 4 / 6 | M1·M3·M4·M6 ✅；M5 主体覆盖；M2 出版（v2 多机，见下） |
| ⚙️ 配套机制待补 | 1 / 6 | — |

**关键判断**：CRITICAL + HIGH 全部修完之前，**orchestrator 不应当用于支付 / 合规 / 任何高敏感场景**。当前实现只适合内部受控环境（开发、demo）。

---

## ⛔ CRITICAL

每条都是"单步即可利用"的链路，必须最优先处理。

### C1. 工作流创建即 ACTIVE，无审核门

- **修复要求**：
  - [x] `create()` 改为 `status: 'PENDING_REVIEW'`，记录 `submittedBy`、`approvals:[]`
  - [x] 新增 `workflow.approve(id)` — 禁止自审、去重、→ ACTIVE
  - [x] 新增 `workflow.deny(id, reason)` — → REJECTED
  - [ ] 双签机制（需 AUDIT A5 `requires_dual_approval` 声明落地后再加，当前单签）
- **验收测试**：
  - [x] create → PENDING_REVIEW（含 submittedBy、approvals=[]）
  - [x] self-approval ban — 同 uid 提交后无法批准 → -32005
  - [x] approve → ACTIVE，deny → REJECTED
  - [x] 不可重复 approve；不可 approve 非 PENDING_REVIEW 状态
  - [x] 测试：`core/orchestrator/tests/approval-gate.test.js`（16 例）
- **状态**：✅ DONE（双签待 A5）
- **Done in**: 2026-05-30

---

### C2. runner 不校验 workflow 状态

- **修复要求**：
  - [x] `if (workflow.status !== 'ACTIVE') throw FORBIDDEN` — 拦 PENDING_REVIEW / REJECTED / DELETED
  - [ ] version 锁定（快照 key），trace 记录 `workflow_version`（待后续）
- **验收测试**：
  - [x] PENDING_REVIEW / REJECTED / DELETED → run → -32005，下游零调用
  - [x] ACTIVE → run → 正常执行
  - [x] 测试：`approval-gate.test.js` C2 部分
- **状态**：✅ DONE（version 锁定待后续）
- **Done in**: 2026-05-30

---

### C3. resolver 黑名单旁路 + create 完全不校验

> **2026-05-31 决策：白名单体系暂缓，黑名单 regex 已删除。**
> 原设计（`safe_for_resolver: true` 声明 + 全服务注册）在 SOLO 单信任域下是过度设计：
> - **H6 footprint 预审**已确保 caller permit 覆盖所有 resolver 方法，orchestrator 调 resolver 不产生超权。
> - **C1 审批闸门**保证 workflow（含 resolver 定义）经过不同人审核。
> 旧的黑名单 regex 是假安全感（关键词匹配可绕过、漏洞多），已从 `update()` 中删除，
> `create()` 和 `update()` 均加注释说明 C1 + H6 是真正的安全边界。

- **已做**：
  - [x] 删除 `update()` 中的 keyword blacklist regex（`logic/workflow.js`）
  - [x] `create()` 和 `update()` 加注释，明确 C1 审批 + H6 预审是安全边界
- **暂缓**：
  - [ ] `safe_for_resolver: true` 白名单声明体系（跨信任域或更严格合规时再启动）
  - [ ] `on_failure: fail|skip|default` 字段（独立功能，与安全无关，可单独做）
- **状态**：⏸️ 部分处理（伪安全代码已清理；白名单体系暂缓）
- **Done in**: 2026-05-31（黑名单删除）

---

### C4. 调用方头部全量透传 → 混淆代理 (confused deputy)

> **⏸️ 暂缓（2026-05-30）**：在 SOLO 当前的单信任域 + user/bot 身份模型下，此项是过度设计。
> 原本的攻击面（orchestrator 借 caller token 调超权方法）已被 **H6（footprint 预审）** 封堵——caller permit 若不覆盖 workflow 方法足迹，根本跑不起来。**C1 审批闸门**再保证 workflow 本身经过审核。两重门都在位后，confused deputy 路径在内部环境下不成立。
> X-Actor-Claim / 服务凭证是**跨信任域 + 强不可抵赖**场景的增强项（README §5.2 原文如此定性），SOLO 目前不需要。有跨域合规需求时重新评估。
>
> **✅ 最小可行档已落地（2026-07-02，预审 + 透传 + 审计；签名/服务凭证仍暂缓）**：
> H6 在**事件路径**只查到共享 bot 的宽 permit（trivially pass），从不问"引发事件的 principal 自己有没有这个权限"——这是残留的 confused deputy 面（谁能往被订阅的流 emit，谁就借到 bot 权限）。现补齐三件：
> ① **透传**：matcher 把信封 `actor`（引发者，emit 路径可信声明）+ `source`（Router 认证的发射者，不可伪造）带进 run-command → run 实体（`actor`/`actorSource` 字段）→ runner `$context.trigger_actor`（只读溯源，禁作授权输入）；grant/requeue 恢复路径全程保留。
> ② **预审（opt-in）**：workflow 新字段 **`require_actor_permit: true`** → runner §2.6 在 H6 之后加查 **actor 本人 permit 是否覆盖全足迹**（`user.permit.get` 同时解析 user/bot uid）；actor 缺失或不可解析形态（`sentinel:{id}`/`cron:{id}`/`anonymous`）**fail-closed** FORBIDDEN；刻意不走 NeedsGrant——运营 grant 补的是 bot 的权限缺口，不能洗白 actor 的。默认（字段缺省）= 纯审计档，现状零破坏。该字段 ACTIVE 期冻结（同 steps/resolvers）、审中改动作废在途签名闸。
> ③ **审计**：run 实体 + ops 通知（needs_grant/run_failed）带 actor；永久拒绝/重试耗尽时 run 实体同步收尾为 DEADLETTER（修"被拒 run 滞留 RUNNING→假 STALLED 告警"）。
> 覆盖：hermetic `actor-precheck.test.js`（11 用例）+ matcher/worker/run/static-workflow-hardening 扩展用例。**仍暂缓**：X-Actor-Claim 签名头 / orchestrator 自有 keypair / `library/actor-claim.js`（跨信任域档，见下清单）。

- **不变式破坏**：§1 不变式 #3（执行可双向归属）
- **README 参考**：§5 执行凭证模型（Actor Claim）
- **当前代码**：`logic/runner.js:355-361` —— `authorization` 和 `x-admin-token` 透传给所有 step
- **如将来重启，需做**：
  - [ ] orchestrator 持有自有 Ed25519 keypair（启动时生成或从环境加载）
  - [ ] 实现 `X-Actor-Claim` 协议：actor / actor_realm / workflow_id / workflow_version / approved_by / trigger_source / trigger_id / issued_at + 签名
  - [ ] step dispatch 时不再透传 caller 头部，改用 orchestrator 服务凭证 + actor claim
  - [ ] 写 `docs/protocol/zh/actor-claim.md`，规范下游验签 + 双向 audit
  - [ ] `library/actor-claim.js` SDK
- **状态**：⏸️ 暂缓（内部环境下 H6 + C1 已覆盖攻击面；跨域需求出现时重新启动）→ **最小可行档 ✅（2026-07-02，见上）**；签名/服务凭证档仍暂缓
- **Done in**: 2026-07-02（最小档：actor 透传 + `require_actor_permit` opt-in 预审 + run 实体审计）

---

### C5. restore 直接复活为 ACTIVE，绕过审核

- **修复要求**：
  - [x] `restore()` 设 `status: 'PENDING_REVIEW'`，`approvals:[]`，清除 `deletedAt`
  - [ ] portal UI 提示"需重新审核才可触发"（前端待做）
- **验收测试**：
  - [x] DELETED / REJECTED → restore → PENDING_REVIEW，approvals=[]
  - [x] restored 后 run → -32005
  - [x] 测试：`approval-gate.test.js` C5 部分
- **状态**：✅ DONE（portal UI 待后续）
- **Done in**: 2026-05-30

---

## ⚠️ HIGH

### H1. 服务层无 permit 校验（仅依赖 Router）

- **README 参考**：§2 角色定义
- **当前代码**：`index.js:124-149` —— 只 `orchestrator.token.*` 检查 isAdmin，其他全裸过
- **修复要求**：
  - [ ] 每个 handler 显式校验 `req.user.permit` 含本方法所需 permit
  - [ ] 集中到一个 middleware-style 装饰器，避免每个方法手写
  - [ ] permit 检查失败抛 `UNAUTHORIZED`（不是 internal error）
- **验收测试**：
  - [ ] 用无 `workflow.approve` permit 的 token 调 approve → 403
- **状态**：⏸️ 暂缓（2026-06-01）—— Router 每请求 `checkAccess` 已在转发前完成方法级校验；微服务收到请求时这关已过，重复校验无增量收益。有多服务共享同一 port / bypass Router 场景时重新评估。
- **Done in**: —

---

### H2. isAdmin 表达式逻辑错误

- **README 参考**：§2 角色定义
- **当前代码**：`index.js:121` —— `req.permit === 'admin' || req.user?.permit === 'admin'`
- **问题**：`req.user` 是 uid 字符串，非对象；第二个判断永远 false（`token.*` 三个方法实际只靠第一个判断通过）
- **修复要求**：
  - [x] 用 `library/permit.js` 的 `isAdmin(req)`（同时处理字符串 + 对象两种形态）
  - [x] 抽到 `library/permit.js` SDK（Solo 全局复用，不只 orchestrator）
- **验收测试**：
  - [x] CI 全量通过（13 套/164 测试）；`library/tests/permit.test.js` 覆盖 isAdmin 两种形态
- **状态**：✅ DONE
- **Done in**: 与 permit.js(A2) + H6 同批提交（2026-05-29）

---

### H3. evaluateCondition 用 `new Function()` eval

- **README 参考**：§6 Condition 安全限制（"必须用 json-logic-js"）
- **修复要求**：
  - [x] 整段重写为 `json-logic-js`（与 fulfillment 统一）
  - [x] 严格等号：JsonLogic `===` 不做类型强转（`"0" !== 0`）
  - [x] 删除 `new Function` 代码路径
  - [x] 字符串 / 数组 condition 拒绝（fail closed → 步骤 skipped，workflow 继续）
- **迁移路径**：condition 格式从字符串改为 JsonLogic 对象。`branching-flow.json` 已更新为样板。存量 ACTIVE workflow 如有旧格式字符串 condition，运行时 step 会 skipped（fail closed），需重新提交。
- **验收测试**：
  - [x] `===` 匹配 → 步骤运行；不匹配 → skipped
  - [x] 严格等号：`"0" !== 0` → skipped（无类型强转）
  - [x] 字符串 condition 拒绝 → skipped，workflow completed（fail closed）
  - [x] 数组 condition 拒绝 → skipped
  - [x] and / or / > 等 JsonLogic 算子正常工作
  - [x] 无 condition → 步骤始终运行
  - [x] 测试：`core/orchestrator/tests/condition.test.js`（8 例）
- **状态**：✅ DONE
- **Done in**: 2026-05-31

---

### H4. Portal 没有审核 UI

- **README 参考**：§4 审批 + §9 RPC 方法表
- **修复要求**：
  - [x] STATUS 列显示 PENDING / ACTIVE / REJECTED / DELETED 彩色徽章
  - [x] approve / deny 按钮（仅 PENDING_REVIEW 行显示）
  - [x] deny 必须填写 reason（内联 modal，非系统弹窗）
  - [x] 自审禁止 → toast 明确提示"Cannot approve your own workflow"
  - [x] REJECTED 行 hover 显示 denialReason tooltip
  - [x] restore 成功提示"pending re-approval"，引导用户知道需要重审
  - [x] PENDING_REVIEW 行左边框黄色，REJECTED 行红色（视觉区分）
  - [ ] 按 owner / category / 提交时间筛选（后续优化）
  - [ ] 审核详情 diff 视图（后续）
  - [ ] 双签第二审批人等待状态（待 A5 双签落地后）
  - [ ] version 切换器（后续）
- **验收测试**：
  - [x] TypeScript 编译零报错
  - [ ] E2E：提交 → 不同账号审批 → 触发 → trace 显示角色（待 E2E harness 建立后）
- **状态**：⚠️ 基础审批 UI 已完成，筛选 / diff / 双签 UI 后续
- **Done in**: 2026-05-31（基础 approve/deny UI）

---

### H5. 批量导入直接 create，无审核

- **README 参考**：§3 状态机
- **当前代码**：`portal/system/src/pages/WorkflowManagement.tsx:238` —— `handleImport` 直接调 `workflow.create`
- **修复要求**：
  - [ ] 批量导入的所有 workflow 都进 PENDING_REVIEW
  - [ ] UI 增加"批量审批工具"：勾选多个 PENDING_REVIEW 一次性审（仍按 §4 规则禁止自审 / 触发双签）
- **状态**：⏸️ 暂缓（2026-06-01）—— 批量导入是内部运维操作（非对外接口），C1 审批闸门已覆盖后续触发的安全门；批量审批 UI 属优化功能，暂无实际消费场景。有多人协作 / 大量 workflow 上线场景时再做。
- **Done in**: —

---

### H6. workflow.run 无权限预审（footprint 未校验）

- **README 参考**：§5.1 执行前权限预审
- **修复要求**：
  - [x] `workflow.run` 入口静态求 footprint = ∪ `steps[].method` ∪ `resolvers[].method`
  - [x] 用 caller uid 调 `user.permit.get(callerUid)` 拉取完整 permit
  - [x] `coversAll(permit, footprint)` 失败即 FORBIDDEN(-32005)，列出 missingMethods；在任何 step 执行前拦截
  - [x] 有分支时按 steps 全集预审（宁严勿漏）
  - [x] callerUid=null 时跳过（Router 已拦匿名）
- **验收测试**：
  - [x] 部分 permit → 403 且下游零调用（`h.mock.count() === 0`）
  - [x] 空 permit → 403
  - [x] 403 错误信息列出缺少方法
  - [x] 分支内方法也纳入 footprint → 403
  - [x] 完整 permit → 执行成功
  - [x] admin(allow_all:true) → 通过
  - [x] 服务级通配符 `*` → 通过
  - [x] callerUid=null → 跳过预审，user.permit.get 不调用
  - [x] user.permit.get 失败 → -32603（非 -32005）
  - [x] 测试文件：`core/orchestrator/tests/footprint-precheck.test.js`（10 例全过）
- **注意**：预审只拦方法级；数据级 `constraints` 仍须下游每步现场校验。预审 ≠ 审核闸门，两者正交、都必需。
- **状态**：✅ DONE
- **Done in**: 与 permit.js(A2) + H2 同批提交（2026-05-29）

---

## ⚪ MEDIUM

### M1. DELETED workflow 被 create 覆盖时 trace 丢失

- **README 参考**：§10 存储（version 不可变 + trace 独立 key）
- **修复要求**：
  - [x] 一旦实现 §3 的 `v{n}` 不可变版本机制，本问题自然消失（历史快照永远在）
- **状态**：✅ 已被 §6.6 不可变版本快照化解 —— `create()` 覆盖 DELETED 时**续版本线**
  （`workflow.version = (existing.version||0)+1`）并把每版写进 append-only `versionKey(id, v)`
  不可变快照（`logic/workflow.js` create 路径，注释"old versions' snapshots are never
  overwritten — audit history survives"）。主 key 虽仍整替，但历史已在 v{n} 快照里永存。
- **Done in**: 与 §6.6 版本快照同批（toFix §6.6）

---

### M2. 握手种子 PENDING_SEEDS 用进程内 Map

- **README 参考**：N/A（运维问题）
- **真实位置**：**不是** orchestrator 局部——auth 已统一到 `library/auth.js`（orchestrator
  `handlers/auth.js` 只是 `createAuthHandlers(config)` 薄包）。Map 在 `library/auth.js`，
  **13 个服务共享同一缺陷**（原条目把位置写在 orchestrator 是 stale）。
- **影响**：pm2 cluster / k8s replicas 下，A 进程 `/auth/seed` 发的 seed 到 B 进程
  `/auth/verify` 验不到 → 握手随机失败。**单机单进程（VERSION.md §2 的 v1.1 部署假设）无影响。**
- **修复要求**：
  - [x] ACTIVE_SESSIONS 删除（write-only 死状态 → 见 M3，已删）
  - [ ] PENDING_SEEDS 跨进程化 —— **⏸️ 出版（v2 多机硬化）**。**阻塞点**：`/auth/verify` 只发
    `{signature, publicKey}` **不回传 seed**（`router/handlers/service.js:42`），服务靠遍历已发
    种子用签名反查。要做 O(1) 的 Redis 查（而非对所有 seed SCAN，丑且 racy），需 Router 在 verify
    回传 seed —— 那是 **Router 协议改动**（受保护文件）。且仅多进程触发 → 归 v2 多机硬化一并做。
- **状态**：⏸️ 出版（v2）—— 仅多机部署触发，干净修复需 Router 协议改动；单机 v1.1 不受影响
- **Done in**: ACTIVE_SESSIONS 删除部分见 M3

---

### M3. ACTIVE_SESSIONS 写了但从不读

- **真实位置**：`library/auth.js`（统一后）—— handleVerify 成功时写 session，但 middleware
  每请求只验 Router token、**从不读 session** → 纯 write-only 死状态（含 sweeper 那一支）。
- **修复要求**：
  - [x] 删除 ACTIVE_SESSIONS 声明 + handleVerify 里的 `.set` + sweeper 里的清理分支
  - [x] 补握手单测（此前 handleSeed/handleVerify 零覆盖）：`library/tests/auth-handshake.test.js`
    （5 例：发种子/合法签名成功/拒未发种子/单次性/缺参 400）
- **状态**：✅ DONE —— 死状态已删，握手行为不变（11 测绿）
- **Done in**: 本批（library/auth.js）

---

### M4. CORS 通配 + 无 Origin 校验

- **当前代码**：`index.js:29` —— `app.use(cors(corsOptionsFromEnv()))`（共享 `library/cors.js`，从 env 读白名单）
- **修复要求**：
  - [x] 限定 Origin 到允许的 portal 域名列表（`library/cors.js` 从 env `CORS_ORIGINS` 读，缺省回退）
  - [x] 浏览器请求按 origin 白名单放行（生产硬化包统一处理，非仅本服务）
- **状态**：✅ 已修（随生产硬化包 §3.6 落地，全服务共用 `library/cors.js`）
- **Done in**: ac1ff09

---

### M5. 无速率限制 / 无工作流数量上限

- **README 参考**：§11 防御性约束
- **当前代码**：投稿配额 + Router 层限流 + 索引化（不再裸 KEYS）
- **修复要求**：
  - [~] `library/ratelimit.js` SDK —— **未库化**；改走 §3.4 内联配额 + Router `handlers/ratelimit.js`（方法级限流，每请求 checkAccess 时生效，覆盖所有下游含本服务）。库化 SDK 仍记 A3，出版。
  - [x] `workflow.create`：单 submitter 配额 —— `enforceSubmissionQuota`（`logic/workflow.js:107`，create 第 158 行调用），**10/小时**（VERSION §3.4 定值，非原拟 100）。
  - [ ] `workflow.run`：按 workflow `rate_limit` 配置（未配默认 60/分钟）—— 细粒度档出版（通用限流已由 Router 覆盖）。
  - [x] 系统全局上限：**PENDING_REVIEW backlog ≤ 100**（`pendingCap`，§3.4 —— 防审批队列 DoS；原拟 1000 总数上限收敛为"待审上限"这一真实风险面）。
  - [x] `list` / matcher 改索引：用 `workflowIndex`(SMEMBERS) / run-id 索引，KEYS 仅留一次性 legacy backfill（已注明 acceptable）。
- **状态**：⏸️ 主体覆盖（投稿配额 + 全局待审上限 + Router 限流 + 索引化已落地；库化 ratelimit SDK = A3、workflow.run 细粒度限流 → 出版）
- **Done in**: 8776484（§3.4 配额/待审上限）· ac1ff09（索引化/硬化包）

---

### M6. workflow.update 缺乏 ETag/version 并发控制

- **影响**：两个 admin 同时编辑同一 workflow 时，后存者覆盖前者，无冲突提示
- **修复要求**：
  - [x] update 接受 `expected_version`，不匹配则抛冲突 —— `logic/workflow.js` update：
    `if (expected_version !== undefined && (existing.version||0) !== expected_version) throw FORBIDDEN('Version conflict...')`，
    且整个改动走 `optimisticJsonUpdate`（乐观并发，非裸 last-writer-wins）。
  - [ ] portal UI 检测到冲突提示"工作流已被他人修改，请刷新"（前端待做，非引擎缺陷）
- **状态**：✅ 引擎侧已修（expected_version + 乐观并发）；portal 提示 UI 后续
- **Done in**: 与 §6.6 版本快照/乐观并发同批

---

## ⚙️ 配套机制待补（设计已定，需新建模块）

这些不是"修 bug"，是 README 引入但代码完全缺失的新机制。

### A1. `library/actor-claim.js` SDK
- **用途**：orchestrator 签发 Actor Claim + 下游服务验证
- **接口**：`sign({...})` / `verify(headers)` / `extractActor(req)` / `auditPair(req, audit)`
- **依赖**：administrator 暴露 orchestrator 公钥
- **Done in**: —

### A2. `library/permit.js` SDK
- **用途**：统一 permit 检查（替代各服务手写 `=== 'admin'`，并统一 `req.permit` / `req.user.permit` 路径）
- **不改 Router 转发**：permit 仍压缩成 `'admin'|'user'` 转发（token 体积考虑），方法级校验留在 Router 每请求 `checkAccess`
- **双路径接口**：
  - 常规（读转发字符串）：`isAdmin(req)`、`getConstraints(req)`
  - 完整对象（H6 按需取后用）：`hasPermit(permitObj, method)`、`coversAll(permitObj, methods[])`
- **复用**：Solo 全局，不止 orchestrator
- **Done in**: —

### A3. `library/ratelimit.js` SDK
- **用途**：限流（M5 依赖）
- **Done in**: —

### A4. `entities.js` 的 `safe_for_resolver` 声明
- **用途**：各服务在自己的 `handlers/entities.js` 声明哪些 method 是 resolver 白名单
- **示例**：`{ method: 'customer.find_by_name', safe_for_resolver: true, ... }`
- **校验**：orchestrator 在 create/update workflow 时拉所有服务的 entities 校验
- **Done in**: —

### A5. `requires_dual_approval` 声明
- **用途**：method 级别标注是否触发双签
- **位置**：各服务 `handlers/entities.js` 中声明
- **示例**：`ledger.transfer`、`bank.send`、`administrator.account.destroy` 等
- **Done in**: —

### A6. `docs/protocol/zh/actor-claim.md` 协议规范
- **用途**：下游服务接收/验证 Actor Claim 的统一规范
- **必含**：签名算法、claim 字段、TTL、verify 流程伪代码、audit 写入要求
- **Done in**: —

---

## 二、修复推进策略

不是按严重度顺序，是按**依赖关系拓扑**：

```
Phase A：基础设施（A1-A6 配套机制）
   │
   ▼
Phase B：审核闸门（C1 + C2 + C5）✅ 已完成 —— 关上前门
   │
   ▼
Phase C：行为冻结严格化（C3 + H3）—— 杜绝 covert 行为变更（含 RCE）
   │
   ▼
Phase D：UI 与运营（H4 + H5）—— 审核流程能在 portal 跑通
   │
   ▼
Phase E：守护（H1 + M1-M6）—— 防御性 + 运维
   │
   ▼
Phase F（按需）：跨域执行凭证（C4 actor-claim）—— 暂缓，有跨信任域需求时启动
```

> **C4 已移出主线**：原 Phase C（执行凭证）在单信任域内部环境下不成立，H6 + C1 已覆盖其攻击面。
> B-D 全部完成前，orchestrator **不能用于支付 / 合规 / 客户面**。

---

## 三、新 PR 检查清单

每个改 orchestrator 的 PR，描述必须包含：

- [ ] 本 PR 消除了 AUDIT.md 哪些条目？（列编号）
- [ ] 本 PR 是否引入新差距？如有，是否已追加到 AUDIT.md？
- [ ] 本 PR 是否违反 README §1 的三条不变式？如违反，理由 + 补偿设计是什么？
- [ ] 本 PR 是否需要更新下游服务（如新增 actor-claim 字段、新增 `safe_for_resolver` 声明）？
- [ ] 本 PR 是否引入新的 RPC 方法？是否在 README §9 表里？permit 是哪个？

未回答完不予 merge。

---

## 四、历史快照

| 日期 | 状态变更 | 备注 |
|------|---------|------|
| 2026-05-17 | 首次建立，CRITICAL 5 / HIGH 5 / MEDIUM 6 / 配套 6 | 基于会话审计报告 |
| 2026-05-24 | 新增 H6（workflow.run footprint 权限预审），HIGH 5→6 | README §5.1/§5.2 补充"权限预审 + 最小可行执行模型" |
| 2026-05-29 | H2 ✅ + H6 ✅ + A2(permit.js) ✅，HIGH 0→2，配套 0→1 | library/permit.js 落地，orchestrator isAdmin 修正，footprint 预审实现（10 测试） |
| 2026-05-30 | C1 ✅ + C2 ✅ + C5 ✅，CRITICAL 0→3 | 审批闸门：PENDING_REVIEW、approve/deny、自审禁止、runner 状态校验、restore→PENDING_REVIEW（16 测试） |
| 2026-05-30 | C4 ⏸️ 暂缓，CRITICAL 实际 3/4 | 单信任域下 H6+C1 已覆盖 confused deputy 攻击面；X-Actor-Claim 为过度设计，跨域需求出现时重启 |
| 2026-05-31 | H3 ✅，HIGH 2→3 | evaluateCondition 改 json-logic-js，删 new Function RCE 路径；condition 格式改 JsonLogic 对象（8 测试） |
| 2026-05-31 | C3 ⏸️ 部分处理 | 删除 update() keyword blacklist（伪安全）；白名单体系暂缓，C1+H6 是真正安全边界 |
| 2026-05-31 | H4 ⚠️ 基础完成，HIGH 3→4 | Portal approve/deny UI：STATUS 徽章、APPROVE/DENY 按钮、deny reason modal（内联）、自审禁止提示、行颜色区分 |
| 2026-06-26 | at-least-once 幂等键接线（v1.1.3） | `runner.run` 按 (run,step) 注入稳定 `idempotency_key`，补 in-step 重试/事件重投的二次提交漏洞；引擎提供、下游去重。Saga 前置① |
| 2026-06-26 | Saga 同步补偿落地（v1.1.3）—— README §7 最大「设计 vs 代码」缺口闭合 | `compensate` step-id 引用、逆序执行、排除出正向 pass、与正向同执行器（带幂等键）；补偿失败→`compensation_failed`+`EVENT:WORKFLOW:DEAD_LETTER`；`create()` 校验非自指/目标存在/§7.3 无补偿链。**新差距**：durable 跨重启补偿（step-cursor）仍缺 |
| 2026-06-26 | 崩溃恢复：checkpoint + run.retry（v1.1.3） | `run.checkpoint`（committedSteps + lastActivity，消除慢 run 误判 STALLED）+ `orchestrator.run.retry`（仅 STALLED、保留 triggerId 的幂等重驱）。从头重驱、依赖下游去重，**非** step-cursor 续跑（仍缺）|
| 2026-06-26 | MEDIUM 真相回写 + M3 修复，MEDIUM 1→4 | 复核发现 AUDIT 多条 stale：**M6 已修**（update 有 `expected_version` + 乐观并发）、**M1 已被 §6.6 版本快照化解**（续版本线 + 不可变 v{n}）。**M3 本批修**：删 `library/auth.js` write-only 死状态 `ACTIVE_SESSIONS` + 补握手单测（原零覆盖，11 测绿）。**M2 重新定性**：位置在共享 `library/auth.js`（13 服务共享，非 orchestrator 局部）、仅多进程触发、干净修复需 Router 回传 seed（受保护）→ 归 v2 多机硬化 |
