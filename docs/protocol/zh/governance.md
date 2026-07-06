# 治理协议总览 (Governance Overview)

> [!WARNING]
> **本文是"缝合图",不是新协议。** 它的存在是因为 SOLO 的治理层目前**协议先行、实现严重滞后,且各协议之间没有顶层分工**——`approval`、orchestrator 内建审批、`actor-claim`、`permit` 四者各自描述,互不引用,导致逻辑上有重叠和悬空。本文显式回答"谁负责什么、谁调谁、信任根是什么",作为推进治理线(`todo.md`)时的地图。
>
> 校对基准:2026-05-29,对照真实代码。判断"已实现 vs 设计"以本文的状态标记 + `CLAUDE.md` §2 + `api/core/orchestrator/AUDIT.md` 为准。

---

## 0. 一句话分工

治理 = **四道关卡**,作用域从粗到细、从静态到动态:

| 关卡 | 协议/位置 | 管什么 | 粒度 | 状态 |
|------|-----------|--------|------|------|
| **① permit** | `core/user` 存储 + Router `handlers/access.js` 的 `checkAccess` | "这个调用方**能不能调**这个方法" | 方法级 | ✅ 已实现(Router 每请求校验) |
| **② footprint 预审** | orchestrator `runner.js` + `library/permit.js`(`coversAll`) | "工作流要调的**所有**方法,调用方权限是否**全覆盖**" | 方法集合 | ✅ 已实现(H6 预检,CI 绿;权限不足→NeedsGrant 暂停) |
| **③ 审批闸门** | orchestrator 内建(C1,LOW 风险)+ `approval` 服务(HIGH 风险 workflow 的 `approval.gate.*` 多签、collection 退款等非工作流场景的 `approval.record.*`) | "这个**变更/工作流**要不要人**核准**才能生效" | 变更/工作流 | ✅ 已实现(C1 单签 approve/deny + 禁自审 + 按 `risk_level` 路由 HIGH→approval 多签,CI 绿;`approval` 服务**已有消费者**,见 §3) |
| **④ actor-claim** | 最小档在 orchestrator（matcher→run 实体→runner §2.6）；签名档 `library/actor-claim.js`(待) | "执行时**以谁的名义**、下游如何验证与归属" | 执行凭证 | ⚠️ **最小可行档 ✅（2026-07-02）**：事件 actor 透传 + run 实体审计 + opt-in `require_actor_permit` 足迹预审（fail-closed）；签名/服务凭证档仍 ❌（AUDIT C4） |

**关键认知**:① 已经牢固,框架今天就能跑;②③④ 全是洞,而且**洞与洞之间还没说清边界**——这正是本文要缝合的。

---

## 1. 四道关卡的边界(避免互相重叠)

四者**正交**,不可互相替代。常见误解是"有了 permit 就不用审批",或"有了审批就不用预审"。澄清:

```
调用方发起 workflow.run
   │
   ├─ ① permit:Router 先验"你能不能调 workflow.run"        ← 拦"门外汉"
   │
   ├─ ② footprint 预审:orchestrator 验"workflow 内部要调的
   │     ledger.transfer / email.send … 你的 permit 是否全覆盖"  ← 拦"借工作流越权"
   │     (Router 只验了入口那一下,管不到 workflow 内部的足迹)
   │
   ├─ ③ 审批闸门:此 workflow 是否已被**第二个人**核准为 ACTIVE  ← 拦"自己说了算"
   │     (与 permit 正交:你有权调,不代表这个高敏感动作不需要复核)
   │
   └─ ④ actor-claim:执行每个 step 时带签名凭证,下游记录
         "actor=谁 / workflow=哪个 / approved_by=谁"            ← 解决"事后谁担责"
```

边界铁律(来自 orchestrator AUDIT §5.1):
- **②预审 ≠ ③审批**:预审是"权限够不够"(自动),审批是"该不该做"(人工)。两者都必需。
- **②方法级 ≠ 数据级**:footprint 只拦方法;数据级 `constraints`(如"只能改自己部门")仍须**下游每步现场校验**,预审管不了。
- **③审批 ≠ ①permit**:审批不发权限,只对"已授权但高敏感"的操作加一道人工闸。

---

## 2. 信任根:这是体系最脆的地方

治理的所有"不可否认 / 防抵赖"承诺,最终都要落到**某个密码学身份**上。当前现实:

| 主体 | 是否有密钥对 | 能签名吗 |
|------|------------|---------|
| **Router** | ✅ Ed25519(`ROUTER_PUBLIC_KEY` 静态注入各服务) | ✅ 签 X-Router-Token,服务间信任根 |
| **微服务(含 orchestrator)** | ⚠️ 设计上应各持服务凭证,**目前 orchestrator 无自有 keypair**(AUDIT C4) | ❌ 还做不到 actor-claim 签名 |
| **终端用户** | ❌ **无**。`core/user` 是密码登录(Z-Handshake/PBKDF2),用户不持私钥 | ❌ 做不到"用户级"客户端签名 |

> [!WARNING]
> **这是一个目的与能力的缺口,不只是"还没写"。** `approval` §6.4、`security` 都承诺"用户级 Ed25519 不可抵赖签名",但**用户身份模型里根本没有用户私钥**。因此 `approval` 的证据当前只能是 **server-attested**(服务器盖章,`publicKey/signature=null`)——它能证明"系统记录了谁在何时操作了哪个 payload 哈希",**但防不住管理员抵赖**,而后者恰恰是审批协议存在的理由。
>
> **结论**:在引入"用户密钥"或"把信任根明确下沉到服务凭证 + Router 签名链"之前,治理协议里所有"密码学不可抵赖(用户级)"的措辞都应理解为**目标,而非当前保证**。推进治理线时,第一个要拍板的就是:不可否认的信任根放在**用户**(需要给用户发密钥)还是**服务凭证 + actor-claim**(orchestrator 代签,溯源到 approved_by)。本框架的内部受控定位下,后者更现实。

---

## 3. `approval` 服务 vs orchestrator 内建审批(✅ 已拍板,2026-07-03)

> **决策:方向 2**——orchestrator 继续自建 C1(workflow 专用),`approval` 服务专注**非工作流类**敏感变更。
> 不是"二选一废掉一个",是分工按"是不是 workflow"切,两套自审/多签逻辑长期并存(§3 原文承认的代价,接受)。
>
> **现状核实**(2026-07-03,与决策前的假设有出入,记录在案):真跑起来的代码其实是**方向1+方向2的混合**,不是纯方向2——
> - orchestrator `workflow.approve` 按 `risk_level` 路由(`workflow.js:568-632`):LOW 走 C1 自包含单签快速道;**HIGH 走 `approval.gate.open`/`approval.gate.sign`**(approval 服务的多签状态机)——这部分结构上就是方向1(orchestrator 内部落到 approval)。
> - collection `payment.refund` 用 `approval.record.get` 校验一个面向本次退款、需 3 个独立签名审批人的 approval.record——这是方向2设想的典型非工作流场景,已有实现。
>
> **决策的实际含义**:HIGH 风险 workflow 走 `approval.gate` 是既有实现,**不因这次决策回退**(拆掉它是倒退,不是收敛);决策管的是**以后**——不再把 LOW 风险 C1 单签道也并进 approval 服务,`approval` 的"主战场"定位为非工作流敏感变更(collection 退款是范例,以后同类场景照此接,如直接改 permit/价格)。

这是体系里**最明显的逻辑重叠**,目前两套并存(以下是拍板前的原始分析,保留供参考):

| | `apps/approval` (SAP 协议) | orchestrator 内建审批(README §4) |
|---|---|---|
| 模型 | request → verify → confirm(三段式) | submitter → approver(→第二 approver)(双签) |
| 自审禁止 | ✅ 有 | ✅ 又实现一遍 |
| 多签 | §7.2(草案) | 双签(草案) |
| 不可否认 | Ed25519 证据链(草案) | 服务凭证 + actor-claim(草案) |
| 内容中立 | ✅ 任意 `service:entity:id` 都能纳入 | ❌ 仅针对 workflow 对象 |
| 实现 | MVP(单签 + server-attested),**无消费者** | **✅ approve/deny 已实现**(C1 单签 + 禁自审,CI 绿;双签未做) |

**问题**:两者都在解决"敏感操作需多人核准",却各造轮子。`orchestrator README` 0 次提 approval 服务;`approval 协议` 0 次提 orchestrator。

**三个可能的收敛方向(需你定)**:

1. **approval 作为通用审批后端,orchestrator 调它**(推荐)
   - orchestrator 的 `workflow.approve` 内部落到 `approval.record.*`;approval 提供"内容中立的审批状态机 + 证据链",orchestrator 只提供"workflow 特有的 PENDING_REVIEW→ACTIVE 状态流转 + footprint 预审"。
   - 好处:一套审批引擎、一套证据链;符合 SOLO"协议复用、松耦合"原则。
   - 代价:approval 要先补齐多签/到期/(可选)真实签名,orchestrator 审批 UI 要对接 approval。

2. **orchestrator 内建,approval 退化为"非工作流类变更"的审批**(如直接改 permit/价格)
   - 两者分工按"是不是 workflow"切。代价:两套自审/多签逻辑长期并存,违反 DRY。

3. **二选一,废掉另一个**
   - 若工作流是唯一需要审批的场景 → approval 冗余;若审批要覆盖一切敏感变更 → orchestrator 不该自己造审批。

> 本文推荐 **方向 1**:它让"②footprint 预审"留在 orchestrator(因为只有它知道 workflow 的方法足迹),把"③审批状态机 + ④证据"交给 approval 这个内容中立的专职服务。这样四道关卡各归其位、不重叠。

---

## 4. 目标闭环(方向 1 落地后的调用链)

```
AI/人 提交 workflow 草案
   │  orchestrator.workflow.create  →  status=PENDING_REVIEW(不可直接 ACTIVE,AUDIT C1)
   ▼
approval.record.request(target=该 workflow, payload=步骤足迹摘要)
   │  approval 状态机 INIT
   ▼
第二人 approval.record.verify   →  DISPATCHED   (禁止自审;高敏感触发多签)
   │  ← 证据链记录 approved_by(信任根见 §2)
   ▼
orchestrator 收到核准  →  workflow 冻结为不可变 v{n},status=ACTIVE
   ▼
调用方 orchestrator.workflow.run
   │  ② footprint 预审:user.permit.get(caller) → coversAll(足迹)   失败即 403,下游零调用
   ▼
每个 step 派发:orchestrator 用**服务凭证**签 ④ X-Actor-Claim
   │  {actor, workflow_id, workflow_version, approved_by, issued_at, 签名}
   ▼
下游服务:验签(library/actor-claim.js)→ 执行 → 双向写 audit
   │  ③数据级 constraints 在此现场校验(预审管不到)
   ▼
(可选)approval.record.confirm:物理执行确认 → DONE
```

这条链同时消解了 §1-§3 的三个问题:审批单一来源(approval)、信任根明确(服务凭证 + approved_by 溯源)、actor-claim 有了归属。

---

## 5. 现状 → 目标 的差距索引

| 要做的 | 对应 AUDIT/todo 条目 | 当前 |
|--------|---------------------|------|
| `library/permit.js`(`coversAll` 等) | AUDIT A2 / todo permit.js | ✅ 已实现(`runner.js` 引用) |
| footprint 预审 | AUDIT H6 | ✅ 已实现(CI 绿;不足→NeedsGrant 暂停) |
| workflow.create 改 PENDING_REVIEW + approve/deny | AUDIT C1 | ✅ 已实现 |
| 禁止自审 + 双签 | AUDIT C1/§4 | ⚠️ 禁自审 ✅;双签 ❌ |
| actor-claim **最小可行档**(透传+预审+审计,无签名) | AUDIT C4 最小档 | ✅ 已实现(2026-07-02)：matcher 透传信封 actor/source → run 实体审计;workflow `require_actor_permit` opt-in → runner §2.6 actor 足迹预审(fail-closed);hermetic `actor-precheck` 11 用例 |
| `docs/protocol/zh/actor-claim.md`(签名档协议) | AUDIT A6 | ❌ 文档不存在(最小档语义记录在 orchestrator AUDIT C4 + README) |
| `library/actor-claim.js`(签/验/审计) | AUDIT A1 / C4 | ❌ |
| orchestrator 自有 keypair | AUDIT C4 | ❌ |
| approval ↔ orchestrator 打通 | 本文 §3 | ✅ 已拍板(方向2,2026-07-03)+ 核实为混合实现:HIGH 风险 workflow 已走 `approval.gate.*`,非工作流场景(collection 退款)走 `approval.record.*`;LOW 风险 workflow 保持 C1 自包含 |
| approval 多签/到期/规则引擎 | approval §7.2/§8/§9 | ❌ MVP |

**推进顺序建议**(拓扑序,与 AUDIT §二一致):
`permit.js(A2)` → `footprint 预审(H6)` → `审批闸门(C1) + 定方向1` → `actor-claim(A1/A6/C4)` → `approval 多签等增强`。
前三步打通,治理线就从"协议碎片"变成"可运行的闭环"。

---

## 附:为什么单独写这份文档

`security.md` 讲认证与权限原语,`approval.md` 讲审批协议,`workflow.md` 讲编排,orchestrator `AUDIT.md` 追实现差距——**没有一份回答"这几样合起来怎么构成一个自洽的治理体系"**。缺这张图,AI 或新人推进治理时只能在四份互不引用的文档间反复横跳,且会撞上 §2(信任根空)、§3(双轨审批)这两个文档里都不会主动告诉你的体系级矛盾。本文就是那张缺失的缝合图。
