# Orchestrator 工作流编排服务

服务名：`orchestrator` | 端口：`8820`

> ⚠️ 本文档描述**目标设计**。当前代码实现与本文档之间存在已知差距，详见同目录 [`AUDIT.md`](./AUDIT.md)。新功能须按本文档实现，存量代码按审计清单分批补齐。
>
> 配套阅读：[`docs/planning/VERSION.md`](../../../docs/planning/VERSION.md)（外部 AI 接入 / 受控执行总体设计，v1.1 受信外部 agent 投稿档）

---

## 1. 服务定位与信任模型

Orchestrator 把"跨多个微服务的多步骤业务流程"抽象为可编排、可审核、可回放的 workflow 对象。**外部 AI 提交工作流草案，人工审核确认后由 Orchestrator 代为执行**——orchestrator 是"AI 想做事"和"系统真去做事"之间的强审核闸门。

### 信任边界

```
                  不信任                ┃   半信任    ┃   完全信任
                                        ┃             ┃
┌─ 外部 AI / Agent ─┐    人工审核闸门  ┃ Orchestrator┃   下游业务
│ 可提交 workflow   │ ─────────────────▶┃             ┃   微服务
│ 可触发 ACTIVE     │   approver       ┃ 持服务凭证  ┃
│ 不可执行          │                  ┃ 执行 steps  ┃
└───────────────────┘                  ┃             ┃
```

### 三条不可妥协的不变式

后续每节都围绕这三条展开。任何新功能、便利特性、性能优化，**必须先检查是否破坏这三条**。

1. **AI 提交的 workflow 不经审核绝不执行**
2. **任何 ACTIVE workflow，其执行行为与审核时所见的定义完全一致**（行为、路由、触达对象都冻结）
3. **任何执行都可双向归属**：向上追溯到原始触发者，向下追溯到 workflow 修订版本与审核记录

---

## 2. 角色定义

> ⚠️ **目标设计 vs 现状**：下表是角色蓝图。**当前 in-service 强制只有一道**——每个 `run.*`/管理方法在 handler 里走 `permitIsAdmin()` 单门（AUDIT H1：方法级授权刻意交给 Router `checkAccess` 按 permit 兜底）。表中细粒度角色名（approver/steward/grant-approver）**尚未在服务内独立强制**；且 `deprecate/restore`、`method.grant.*`、版本快照等**部分方法未实现**（见 §9 / AUDIT）。已落地并 CI 绿的是：`create`(PENDING_REVIEW) + `approve/deny`(C1 单签 + 禁自审) + H6 footprint 预审 + `allowed_triggers` 闸。

permit 是**互相独立的**——一个账号可同时持有多个，但**同时持有 submitter+approver 时，submit 与 approve 不能针对同一个 workflow**（系统层强制 self-approval ban）。

| 角色 | permit 标识 | 能做什么 | 关键约束 |
|------|------------|----------|---------|
| **submitter** | `orchestrator.workflow.create` | 提交 workflow 草案（PENDING_REVIEW） | 不能审自己提交的 |
| **approver** | `orchestrator.workflow.approve` | 审核草案并 promote 为 ACTIVE | 高敏感分类需双签 |
| **operator** | `orchestrator.workflow.run` | 触发 ACTIVE workflow | 受 workflow 自身 `allowed_triggers` 约束 |
| **steward** | `orchestrator.workflow.deprecate/delete/restore` | 生命周期管理（紧急下线 / 软删 / 恢复） | 不修改行为；删除/恢复都回到 PENDING_REVIEW |
| **catalog reader** | `orchestrator.workflow.snapshot.read` | 读取 AI 能力快照 | 快照按 permit 过滤，不裸公开 |
| **grant approver** | `orchestrator.method.grant.approve` | 批准把某 method 加入 orchestrator 服务凭证 permit | 阻挡服务凭证权限单调膨胀 |

---

## 3. Workflow 生命周期与版本

### 状态机

```
              create
PENDING_REVIEW ──────▶ 提交者不能 approve 自己提交的
      │
      │  approver 调用 approve（如双签需第二人）
      ▼
   ACTIVE  (版本 v{n}，行为冻结)
      │
      ├──▶ update_metadata（限定字段，不影响行为/路由）
      │
      ├──▶ deprecate ──▶ DEPRECATED  (不可触发，可 reactivate)
      │
      ├──▶ delete    ──▶ DELETED     (软删，trace 保留)
      │
      └──▶ revise    ──▶ 新建 v{n+1} 草稿（v{n} 仍 ACTIVE）
                          └──▶ 走完整审核流程
                                └──▶ approve 后 v{n+1} ACTIVE，v{n} 自动 DEPRECATED
```

### 版本即不可变快照

approve 时系统**冻结整个 workflow 对象**到 `ORCHESTRATOR:WORKFLOW:{id}:v{n}` 这个不可变 key。当前版本指针存在 `ORCHESTRATOR:WORKFLOW:{id}:current`。

后果：
- 历史版本永远可调阅（监管审计 / 回溯分析）
- 触发执行时锁定到具体版本号，执行中途有人 deprecate 不影响进行中
- 调用方拿到 workflow_id 后看到的是当前版本，但 trace 永远记录"这次执行用的是 v3"

### 状态总览

| 状态 | 可执行 | 可改 | 可读 | 说明 |
|------|--------|------|------|------|
| `PENDING_REVIEW` | ❌ | ✓ (提交者) | ✓ | 草稿，等待审核 |
| `ACTIVE` | ✓ | 限定字段（见 §4） | ✓ | 已审核，可触发 |
| `DEPRECATED` | ❌ | ❌ | ✓ | 临时停用，可重新审批 |
| `DELETED` | ❌ | ❌ | ✓ (审计读) | 软删，trace 保留 |

### 周期性复审（无"一劳永逸"的 ACTIVE）

approve 时按 category 设置 `revalidation_after_days`：

| 类别 | 默认复审周期 |
|------|------------|
| 一般业务 | 365 天 |
| 含资金动作（`category.tags` 含 `monetary`） | 90 天 |
| 含个人数据 / PDPO 范围 | 180 天 |

超期 workflow 自动转 DEPRECATED 直到 re-approve；触发期前 N 天发警报给 owner 和 approver。

---

## 4. 安全规则

### 审核

- **禁止自审**：`submitted_by == approver` 时拒绝
- **双签触发条件**（任一即触发）：
  - workflow 步骤中调用了被标记 `requires_dual_approval: true` 的方法（如 `ledger.transfer`、`bank.send`）
  - workflow 所在 category 配置 `dual_approval: true`
  - workflow 步骤数 > `dual_approval_step_threshold`（默认 20）
- 双签实现：两个不同的 approver 各自调用 `workflow.approve({id, version})`，第二人提交时 promote；两次 approve 之间 workflow 不可改

### approve 时**冻结**的字段（不可改）

任何会影响**执行行为**或**路由匹配**的字段都冻结：

| 类别 | 字段 | 为什么冻结 |
|------|------|-----------|
| 行为 | `steps`, `resolvers`, `required_inputs`, `optional_inputs`, `input_schema`, `defaults`, `allowed_triggers`, `require_actor_permit` | 直接决定干什么、用什么参数、能被谁触发（`require_actor_permit` 关掉 = 静默放宽触发者门槛，运行期实际冻结） |
| 路由 | `name`, `desc`, `keywords`, `synonyms`, `examples`, `negative`, `category`, `priority` | 决定 AI 把什么意图路由到这个 workflow |

### approve 后仍可改的字段

| 字段 | 触发 snapshot rebuild | 备注 |
|------|----------------------|------|
| `tags` | 否 | 纯展示标签 |
| `owner` / `notes` | 否 | 运营备注 |
| `revalidation_after_days` | 否 | 仅影响下次复审节奏 |

**Covert 行为变更反例**——以下"看起来无害"的修改实际能扭曲路由/行为，所以被冻结：
- 改 `synonyms`：让"查询库存"工作流匹配"转账"意图 → 参数被错误工作流接收
- 改 `priority`：让恶意 workflow 在意图竞争中胜出
- 改 `desc`：直接拼到 AI prompt，影响 LLM 决策

要改这些字段唯一路径：`revise` 创建新版本草稿 → 重新审批。

### 生命周期操作

- `restore`：DELETED → **PENDING_REVIEW**（永不直接到 ACTIVE）
- `deprecate`：ACTIVE → DEPRECATED，steward 可单方面执行（紧急下线）
- `reactivate`：DEPRECATED → 必须重新走 approve 流程（不许跳）

---

## 5. 授权与执行凭证模型

> 本节回答两个**互相独立**的问题：
> - **授权**（§5.1）：这个账号*凭什么*能跑这个 workflow？
> - **执行身份**（§5.2 起）：跑的时候用*谁的身份*去调下游？
>
> 两个问题答案不同、机制不同，不要混为一谈。

### 当前 vs 目标

| 维度 | 当前（已知不安全） | 目标 |
|------|-------------------|------|
| 谁的身份执行 step | 透传调用方 token | Orchestrator 服务凭证 |
| 下游如何识别原始 actor | 看 token sub | 看 `X-Actor-Claim` 头（orchestrator 签名） |
| 审计归属 | 单向（调用方） | 双向（actor + workflow_id + version） |
| 风险 | 混淆代理（confused deputy） | Orchestrator permit 单调膨胀（见 §5.3） |

### 5.1 执行前权限预审（Authorization Pre-flight）

> 回答"**这个账号凭什么能跑这个 workflow**"。独立于 §5.2 的"用谁的身份调下游"。

**原则**：触发 workflow 的具体账号（user 或 bot）的 permit，**必须覆盖该 workflow 会调用的全部方法**；否则在**任何 step 执行之前**直接拒绝（403），不产生任何副作用（fail-fast + all-or-nothing，不允许跑到一半卡在权限墙上留下副作用）。

**方法足迹（footprint）静态可算**：workflow 是声明式数据结构，每个 `step.service` / `step.method` 和每个 resolver 的 `method` 在 create 时强制声明（见 §6）。所以执行前可静态求出：

```
footprint = ∪ steps[].{service.method}  ∪  resolvers[].method
```

**完整 permit 按需拉取（不走转发）**：Router 出于 token 体积考虑，转发给下游的 permit 只是压缩后的 `'admin' | 'user'` 字符串 + `constraints`，**不含方法级 `services`**（方法级校验在 Router 每请求 `checkAccess` 已做完）。footprint 预审是唯一需要调用方完整 `services` 的场景，且只发生在 `workflow.run`（低频）。所以 orchestrator 在 run 时用**认证后的 caller uid**（不是 workflow 内的 `$context.actor` 字符串，后者按 §6 不可作鉴权依据）调 `user.permit.get(callerUid)` 拉取完整 permit，再校验 `footprint ⊆ permit.services`，缺任一方法即 403。**绝不为这一稀有场景让所有请求都转发大对象。**

**收益：orchestrator 不需要 god 权限**。执行授权以触发者自己的 permit 为准——一个低权限账号即使触发了调用 `ledger.transfer` 的 workflow，预审也会当场拦掉。这也是 §5.3 服务凭证"单调膨胀"风险的主要缓解：把"能不能调"的判断前移到调用方 permit，而不是堆到 orchestrator 一个超级账号上。

**三条边界（必须遵守）**：

1. **方法级能预审，数据级（constraints）不能全预审。** permit 三层（`allow_all` / `services.method` / `constraints`）中，方法级在执行前可算清；但 `constraints`（数据级，如"只能改本部门的单"）依赖运行时具体参数，仍须由下游服务在每步现场校验。**预审拦方法级，不替代下游的数据级校验。**
2. **有分支时按"可能调到的方法全集"预审。** condition 分支让某些 step 不一定执行；安全做法是预审整个 steps 全集（宁严勿漏）。前提是 `method` 必须是静态字符串——这已是 §6 硬约束，**禁止运行时算出 method 名**，否则静态预审失效。
3. **权限预审 ≠ 审核闸门（§4），两者正交、都必需。**

   | | 权限预审（本节） | 审核闸门（§4） |
   |---|---|---|
   | 判什么 | 这个账号**够不够权**跑这些方法 | 这个 workflow **逻辑本身安不安全 / 该不该存在** |
   | 何时 | 每次 `run`、自动 | 一次、人工 approve |

   反例：一个 `allow_all` 的 admin 触发了**被 AI 写坏**的 workflow（方法都在权限内，但被恶意串成有害顺序）——权限预审会放行（因为权限够），只有人工闸门能拦住。反过来，权限不够的账号触发完全合规的 workflow，预审拦掉。**缺任一道关都有漏洞。**

### 5.2 最小可行执行模型 vs 增强

授权（§5.1）确定后，"用谁的身份调下游"有两档实现，**预审是两档共同的前提**：

| 档 | 执行身份 | 下游识别 actor | 适用场景 |
|----|---------|---------------|---------|
| **最小可行** | 透传触发者 token | 下游看 token sub，自行再校验方法 + constraints | 内部受控环境；`ACTIVE 闸门 + §5.1 预审 + 透传 + 审计(actor+workflowId+version)` 即闭环 |
| **增强** | orchestrator 服务凭证 + Actor Claim（下文） | 下游验 orchestrator 签名，读 claim 里的 actor | 跨信任域、需强溯源 / 不可抵赖；引入 §5.3 method-grant 治理 |

**关键判断**：Actor Claim / 服务凭证是**增强项，不是阻塞项**。先有 §4 闸门 + §5.1 预审，最小模型即可安全运行于内部环境；出现跨域强溯源需求时再上 Actor Claim，不必一开始就全套。

**✅ 最小可行档已落地（2026-07-02，AUDIT C4 最小档）**——事件路径专属的三件套：
- **透传**：matcher 把事件信封 `actor`（引发者，emit 路径可信声明）与 `source`（Router 认证的发射者）带进 run-command → run 实体（`actor`/`actorSource` 字段，永久归属）→ `$context.trigger_actor`；`run.grant`/`run.retry` 恢复路径全程保留。
- **opt-in 预审**：workflow 声明 **`require_actor_permit: true`** 后，事件触发的 run 在 H6（bot permit）之后**再查 actor 本人 permit 是否覆盖全足迹**——封 confused deputy（共享 bot 宽 permit 让 H6 对事件路径 trivially pass）。fail-closed：actor 缺失或不可解析形态（`sentinel:{id}`、`cron:{id}`、`anonymous`）直接 FORBIDDEN；**刻意不走 NeedsGrant**——运营 grant 补的是 bot 的权限缺口，不能洗白 actor 的。字段默认 `false` = 现状；ACTIVE 期冻结（同 steps/resolvers），审中改动作废在途签名闸。
- **审计**：ops 通知（needs_grant / run_failed）payload 带 actor；永久拒绝 / 重试耗尽时 run 实体同步收尾 `DEADLETTER`（不再滞留 RUNNING 等 stall 扫描误报）。

### 目标设计（增强档）：Actor Claim 透传

```
任意 caller ──▶ orchestrator.workflow.run（caller 的 token）
                      │
                      │ orchestrator 自验证：
                      │   1) caller 有 workflow.run 权限
                      │   2) caller permit 覆盖 workflow 方法足迹（§5.1 预审）
                      │   3) workflow 是 ACTIVE，version 锁定到 v{n}
                      │   4) workflow 的 allowed_triggers 含当前来源
                      ▼
              ledger.transfer
              ╔══════════════════════════════╗
              ║ Authorization: <orchestrator ║
              ║                 service token>║
              ║ X-Actor-Claim: signed JSON {  ║
              ║   actor: <caller.sub>,        ║
              ║   actor_realm: <caller.aud>,  ║
              ║   workflow_id: wf-abc,        ║
              ║   workflow_version: v3,       ║
              ║   approved_by: [user_Y, user_Z],║
              ║   trigger_source: sync,        ║
              ║   trigger_id: trace-xxx,       ║
              ║   issued_at: 1234567890        ║
              ║ }                              ║
              ║ X-Actor-Claim-Sig: <ed25519>   ║
              ╚══════════════════════════════╝
                      │
                      ▼
              下游服务 验证 orchestrator 签名 → 业务执行
              下游 audit 必须双记录 {actor, workflow_id+version}
```

### 5.3 Orchestrator 服务凭证的边界（防止单调膨胀）

**问题**：每批准一个新工作流如果它需要 `X.Y.Z` 方法而服务凭证没这权限，权限就要扩——长此以往趋近 `allow_all`，最小化原则名存实亡。

**对策**：approval 流程**两步**：

1. **方法授权审批** (`orchestrator.method.grant`)：每当工作流首次引用某 method（如 `ledger.transfer`），先单独走"加入 orchestrator permit"审批。这个审批走 grant approver 角色（独立 permit），单独留痕（`ORCHESTRATOR:METHOD_GRANT:{method}`）。
2. **工作流审批**：第一步通过后才能 approve 这个具体工作流。

效果：orchestrator 的 permit 增长可见、可审、可回滚。运维能在仪表盘看到"权限扩张事件"。

### Actor Claim 协议要求

- Orchestrator 用自有 Ed25519 密钥签 Claim
- 下游服务自验证签名（公钥从 administrator 取）
- claim 必填字段：`actor`、`actor_realm`、`workflow_id`、`workflow_version`、`approved_by`、`trigger_source`、`trigger_id`、`issued_at`
- claim TTL：`issued_at + 60s`，过期下游拒绝（防重放）
- 下游服务**必须**把 `actor` 和 `workflow_id+version` 双向写入审计日志

---

## 6. 工作流模板结构

### 变量

| 变量 | 来源 | 解析时机 |
|------|------|---------|
| `$input.*` | 调用方传入的运行时参数 | step 执行前 |
| `$step.{id}.result.*` | 前序步骤的返回值 | step 执行前 |
| `$step.{id}.status` | 前序步骤的执行状态（`success` / `failed` / `skipped` / `compensated`） | step 执行前 |
| `$config.*` | workflow 级默认配置（`defaults` 字段，与 `$input` 同名时 `$input` 覆盖） | step 执行前 |
| `$context.actor` | 当前触发者标识（只读，供日志拼接，**不可作鉴权决策依据**） | step 执行前 |
| `$context.trigger_actor` | 引发触发事件的 principal（事件信封 `actor`，同步触发为 null；只读溯源，**不可作鉴权决策依据**——鉴权走 `require_actor_permit` 预审，§5.2） | step 执行前 |
| `$context.trigger_id` | 本次触发的全局 ID（trace 关联键） | step 执行前 |

**移除/禁止访问**：`$env.*`（服务器环境变量），防止泄露。

### 解析规则（硬约束，不可放宽）

1. **只解一层**：变量值如果本身是含 `$xxx` 的字符串，**不再递归解析**。任何后续改动不得违反这条。
2. **未定义即剥除**：变量解析为 `undefined` 时，注入目标 params 时**该 key 被剥除**（不传 null，避免下游误判）。
3. **类型保留**：number / boolean / object 原样传递，不做字符串化。
4. **下标限定**：`$step.x.result.items[0].id` 中的下标只能是非负整数字面量，不能是变量。

### Step 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✓ | workflow 内唯一 |
| `service` | string | ✓ | 目标服务名 |
| `method` | string | ✓ | 完整方法名 |
| `params` | object | ✓ | 参数，支持 `$` 变量 |
| `condition` | string | | 执行条件（见下） |
| `ignore_error` | boolean | | true 时失败不阻断后续 |
| `retry` | number | | 失败重试次数（默认 0，最大 5） |
| `compensate` | string | | 失败时触发的补偿 step id（见 §7） |
| `idempotency_key` | string | | 透传给下游做去重，支持 `$` 变量 |
| `result_schema` | object | | 可选：JSON Schema 校验返回值，不符视为失败 |

### Input Schema（强制）

每个 workflow 必须声明 input schema（JSON Schema 子集），`workflow.run` 入口校验：

```yaml
input_schema:
  amount:    { type: number, minimum: 0, maximum: 1000000 }
  currency:  { type: string, enum: [HKD, USD, CNY] }
  recipient: { type: string, format: customer-id }
```

**默认不允许任意字符串穿透**——所有 input 必须显式声明类型。无 schema 的 workflow approve 阶段被拒。

### Condition 安全限制

只允许以下 token：

- **字面量**：数字、字符串（单/双引号）、`true` / `false` / `null`
- **比较运算符**：`===`、`!==`、`<`、`<=`、`>`、`>=`（**禁用 `==` 和 `!=`**，杜绝隐式类型转换）
- **逻辑运算符**：`&&`、`||`、`!`
- **括号**：`(`、`)`
- **变量访问**：`$input.x`、`$step.x.result.y`、`$step.x.status`、`$config.x`、`$context.actor`、`$context.trigger_id`，含 `.` 和 `[整数下标]`

**不允许**：算术运算（`+ - * /`）、字符串拼接、函数调用、对象字面量、属性赋值、任何 identifier 类 token。

**实现要求**：必须用 `json-logic-js`（library 已依赖），**禁止 `new Function()` eval**。这是硬性技术选型，保护整个 workflow 安全模型。

### Resolver 语义

Resolver 在 steps 之前执行，把"人类语言"映射成"系统 ID"（如 `room: "卧室"` → `room_id: "room-abc"`）。

| 字段 | 说明 |
|------|------|
| `method` | 调用的服务方法，**必须是被标注 `safe_for_resolver: true` 的方法**（白名单，由各服务自行声明） |
| `params` | 调用参数，支持 `$` 变量 |
| `extract` | 从结果取值的 path（如 `[0].id`） |
| `source` | 把取到的值写到 context 哪个路径（如 `$config.room_id`） |
| `on_failure` | `fail`（默认，整 workflow 中止）/ `skip`（参数留空）/ `default(val)`（用兜底值） |

**Resolver 不能 silent failure**——默认 fail-fast。如果业务确实接受"找不到就跳过"，必须显式声明 `on_failure: skip` 并在审核时被看到、评估。

---

## 7. 事务补偿（Saga 模式）

> **实现状态（2026-06）**：**同步 best-effort 补偿已落地**（`runner.js` `runCompensations` + `executeCall`）。
> `ignore_error:false` 的 step 失败时，引擎按**逆序**对每个**已提交且声明了 `compensate`** 的 step 执行其补偿 step；
> 补偿走与正向**同一个执行器**（retry + 稳定 `idempotency_key`，故重投/重试去重）。`compensate` 是 **step-id 引用**——
> 目标是一个普通 step，因而引擎自动把"被某 step `compensate` 引用的 step"**排除出正向 pass**（它只作补偿、不在正向流程跑）。
> §7.3（补偿不能再补偿）+ 目标必须存在，已在 `create()` 强制校验。补偿失败 → `compensation_failed:true` +
> 发 `EVENT:WORKFLOW:DEAD_LETTER`（§7.2 的 stream 部分）。
> **部分落地（v1.1.3）**：① 跨 orchestrator 重启的恢复——已加 `run.checkpoint`（每步提交记 `committedSteps` + 刷新 `lastActivity`，顺带消除慢 run 被误判 STALLED）+ `orchestrator.run.retry`（仅 STALLED、保留 `triggerId` 的幂等重驱）：崩溃后可「发现（STALLED 告警带 committedSteps）→ 一键重驱」，重驱靠稳定 `idempotency_key` 让已提交步骤去重。
> **注意**这是**从头重驱、依赖下游去重**，不是 step-cursor 中途断点续跑（已提交的非幂等下游若不去重仍会重复——见 §7 补偿要求 #1）。仍未做：真正的 step-cursor 续跑（中途 step 不重放）。
> **§7.4 approve 期"下游补偿接口存在"校验已落地**：`approve()` 在分流到任一审批 lane **之前**，把每个步骤的方法拿去
> 活的能力目录（`system:capability:list`）解析——**补偿步骤的方法解析不到即拒批**（fail-closed：补偿失败是 fail-unsafe，
> 正向已提交才发现安全网是破的），正向/resolver 方法解析不到只 **warn**（fail-fast、无已提交副作用）。目录不可用时**跳过**
> （一次目录抖动不该卡死所有审批）。校验仅"方法存在"，与 H6 的 permit **覆盖**预审正交、互补。

### 失败语义

step 失败的定义（任一即算）：
- 抛错（业务 / 网络 / 超时）
- HTTP 非 2xx
- JSON-RPC 响应含 `error` 字段
- 返回值不符 step 的可选 `result_schema`

失败行为：
- `ignore_error: true` → step 标记 `status: failed`，**不阻断**后续；后续 step 可读 `$step.x.status === 'failed'`
- `ignore_error: false`（默认）→ 触发 `compensate` 链（如配置），然后整个 workflow 终止

### 补偿链

```yaml
steps:
  - id: create_purchase
    method: supply.purchase.create
    compensate: rollback_purchase   # 失败时跳到这一步
    params: { ... }

  - id: notify_supplier
    method: gateway.email.send
    ignore_error: true              # 通知失败不阻断主流程

  - id: rollback_purchase           # 补偿步骤
    method: supply.purchase.cancel
    params:
      id: $step.create_purchase.result.id
      reason: "saga compensation"
    idempotency_key: "comp-$context.trigger_id-rollback"
```

### 补偿要求（不可妥协）

1. **补偿步骤必须 idempotent**：补偿可能因 orchestrator 重启被重试，下游服务按 `idempotency_key` 去重。
2. **补偿失败必须可见**：补偿本身失败 → 整个 trace 标记 `compensation_failed: true` + 推送 `EVENT:WORKFLOW:DEAD_LETTER` Stream + 写入 `ORCHESTRATOR:DEAD_LETTER` 等待人工介入。绝不静默吞错。
3. **补偿不能再补偿**：补偿步骤本身不能再带 `compensate` 字段，避免无限链。审核时强制校验。
4. **下游服务必须提供补偿接口**：调用 `supply.purchase.create` 的 workflow 必须声明对应的 `supply.purchase.cancel` 存在；找不到则 approval 阶段被拒。

---

## 8. 触发器

workflow 可被以下来源触发，每种各自的鉴权契约（实现状态以 introspection / 下列消费者文件为准）：

| 触发器 | 鉴权 | actor claim 的 trigger_source | 消费者 |
|--------|------|-------------------------------|--------|
| **同步 JSON-RPC** | 调用方 token（带 `workflow.run` permit） | `sync` | `workflow.run` 入口 |
| **事件流** | 订阅 Redis Stream，无 caller | `event:{stream_key}` | `logic/matcher.js` 事件匹配消费者 |
| **定时任务** | cron 配置，无 caller | `cron:{schedule_id}` | `core/nexus/logic/scheduler.js` 时钟驱动 |
| **Webhook** | 来源签名验证（HMAC / 域签名） | `webhook:{source_id}` | 经 `ingress` 服务 8070 入站，发 `EVENT:WEBHOOK:*` |

**关键设计**：approve workflow 时必须显式声明 `allowed_triggers: [sync, event, cron, webhook]`，**未声明的 trigger 即使有调用也被拒**。这避免"为同步用途审批，被事件偷偷触发"。

事件/定时/webhook 触发时无 caller token，actor 字段填触发器的标识（如 `cron:daily-balance-sweep`），下游审计能看到"是定时任务触发的，不是某个具体人"。

---

## 9. 核心 RPC 方法

> **方法清单与参数以 introspection 为准** —— 调 `system.introspect` 或读本服务 `handlers/introspection.js`（声明↔注册由 `deploy/check-doc-drift.js` CI 守护）。

各方法的 permit 角色、冻结字段约束、状态机迁移已分散在 §2（角色）、§3（生命周期）、§4（安全规则）。下面只记**实现进度与方向**，不复述方法签名。

**已落地**：审核闸门（`approve` / `deny`）与事件 / 定时 / webhook 触发（见 §8）。create→PENDING_REVIEW→自审被拒（-32005）→他人 approve→ACTIVE 闭环已由 e2e suite 52 验证。

**仍缺（方向）**：
- 生命周期：`revise`（基于 ACTIVE 创建新草稿 v{n+1}）、`deprecate`（紧急下线）、`reactivate`、`versions`（历史版本列举）
- 审计追溯：`trace.list` / `trace.get`（执行历史查询）
- 服务凭证治理：`method.grant.submit` / `method.grant.approve`（§5.3 单调膨胀防护）

缺了这些，版本演进、紧急下线、执行历史查询、服务凭证单调膨胀防护都跑不通，所以**当前实现仍不能视为完全生产就绪**。差距明细见 [`AUDIT.md`](./AUDIT.md)。

---

## 10. 存储

| Key | 内容 | 不可变性 |
|-----|------|---------|
| `ORCHESTRATOR:WORKFLOW:{id}:v{n}` | 第 n 个 approved 版本的完整快照 | append-only |
| `ORCHESTRATOR:WORKFLOW:{id}:current` | 指向当前 active 版本号 | 只在 approve 时移动 |
| `ORCHESTRATOR:WORKFLOW:{id}:draft` | 当前待审草稿 | 提交者可改 |
| `ORCHESTRATOR:WORKFLOW:{id}:meta` | 状态、时间戳、owner、approver 历史 | append-only |
| `ORCHESTRATOR:APPROVAL:{id}:v{n}` | 审批记录（approver / 时间 / diff / 理由） | 不可改 |
| `ORCHESTRATOR:TRACE:{trigger_id}` | 单次执行的完整 trace（含 actor claim、所有 step 结果） | 写一次，TTL ≥ 业务合规留存期 |
| `ORCHESTRATOR:TRACE:INDEX:{workflow_id}:{date}` | 按 workflow + 日期的 trace 索引 | append-only |
| `ORCHESTRATOR:DEAD_LETTER` | 补偿失败的实例，等待人工处理 | append-only + resolution 字段 |
| `ORCHESTRATOR:METHOD_GRANT:{method}` | orchestrator 服务凭证授权过的 method 列表 | append-only + 关联 approval |
| `AGENT:WORKFLOW_SNAPSHOT:{permit_hash}` | AI 能力快照，按 caller permit 哈希分版本 | 每次 approve 自动 rebuild |

**Trace 持久化是硬要求**——监管审计需要"3 年前某次执行做了什么"。TTL 至少覆盖业务合规留存期（金融业务 ≥ 6 年）。

**Snapshot 按 permit 分版本**——避免"低权 caller 通过 snapshot 枚举高权工作流"，每个 permit 哈希一份过滤后的快照。

---

## 11. 防御性约束

| 项目 | 限制 |
|------|------|
| 单 workflow steps 数量 | ≤ 50（超出审核时被拒） |
| 单 workflow 总大小 | ≤ 64 KB |
| `workflow.create` 频率 | 单 submitter ≤ 100/小时 |
| `workflow.run` 频率 | 按 workflow 配置 `rate_limit`，未配置默认 60/分钟/caller |
| condition 嵌套深度 | ≤ 8 层 |
| trace 单次大小 | ≤ 1 MB（超出截断并标记） |
| input_schema 字段数 | ≤ 30 |
| **workflow 内嵌套触发 `orchestrator.workflow.run`** | **禁止**（避免链式调用 / 死循环 / 权限蹦极） |
| Snapshot 写入并发 | 用 Redis SET NX 串行化，否则拒绝并提示重试 |
| Workflow ID 命名 | `^[a-z0-9-]{4,32}$`，禁止特殊字符 |
| Resolver 调用层数 | resolver 不能触发链式 resolver |

---

## 12. 不变式追溯表

回到 §1 的三条不变式，逐条对应到本文档的保护机制：

| 不变式 | 保护机制 |
|--------|---------|
| **AI 提交的 workflow 不经审核绝不执行** | §3 状态机 + §9 `run` 校验 ACTIVE + version 锁定 + §4 自审禁止 + §4 双签 |
| **ACTIVE 行为与审核时见到的完全一致** | §4 冻结字段（含 metadata） + §3 版本不可变快照 + §6 condition/resolver 严格规则 + §6 input_schema 强制 |
| **任何执行可双向归属** | §5 Actor Claim 协议 + §10 trace 持久化 + §10 approval 记录不可变 + §8 trigger_source 显式声明 |

任何后续变更必须先回答："这条改动会不会破坏上面三条中的任何一条？"如果会，必须有明确的补偿设计，否则不得 merge。

---

## 13. 相关文档

- 外部 AI 接入与受控执行总体设计：[`docs/planning/VERSION.md`](../../../docs/planning/VERSION.md)（v1.1 受信外部 agent 投稿档）
- 下游服务如何接收 / 验证 Actor Claim：`docs/protocol/zh/actor-claim.md`（待补）
- 审批流程操作手册：`docs/runbooks/workflow-approval.md`（待补）
- 当前实现 vs 本文档的差距清单：[`AUDIT.md`](./AUDIT.md)
