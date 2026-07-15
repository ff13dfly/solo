# SOLO v2 — 版本规格（草案 · 范围归集）

> **状态：草案 / 范围归集。当前仍是阶段一（trunk + tags，继续推 v1.1.x），v2 尚未启动。**
> 本文是 **v2 范围的归集处**——v1.1 边界外的新发现、明确出版项、跨架构特性先落在这。
> 等真正进阶段二（从 `v1.1.x` tag 拉 `release/v1.1`、main 转 v2，见 runbook §3）时，本文转正为冻结 spec、
> [`VERSION.md`](./VERSION.md) 冻结归档。
>
> 来源：[`VERSION.md`](./VERSION.md) §4「出版清单」+ 设计讨论。**冲突时以代码 + 阶段一纪律为准。**
> 阶段/分支/兼容纪律的可执行版见 [`../runbook/release-and-branching.md`](../runbook/release-and-branching.md)。
> 校对基准：2026-07-15。
>
> **2026-07-12 收窄拍板（用户）**：v2 主线收敛为两条——**A. 联邦级联 SOLO Bridge（原 E 线）+
> B. 部署瘦身 / 动态插件平台（原 F 线）**。原「actor-claim 全量」（旧 A 线）与「完整 at-least-once 语义」（旧 B 线）
> **双双搁置出主线**，理由与重启条件见 §2.3。其他文档里的「E 线」「F 线」即本文的 A、B 线。
>
> **2026-07-15 增补**：新增 §3.6「安全考量（设计前必解）」——对 A 线 bridge 设计做了一轮多-agent
> 对抗式安全评审，结论（四处硬缺口 + 若干承认未解项 + 实现陷阱）归入该节。

---

## 0. v2 是什么（一句话）

从「**单网格 · 全量 bundle**」走向「**跨网格联邦（SOLO Bridge）+ 瘦内核按需装载**」的分布式平台。

v1.1 把 SOLO 做成了「单信任域内的 AI 自动化平台」（VERSION.md §2 假设：单信任域 + 单机 + 手工发证 +
server-attested 执行）。2026-07-03 拆分把能「只加不破」的项全部拉回 v1.1.x；2026-07-12 再裁掉两条搁置线后，
**v2 剩下的就是两件真正破坏性 / 全新的事：把多个 SOLO 网格联邦起来（平行处理 / 租户隔离都走这个形状），
把部署从全量 bundle 变成按需装载。**

---

## 1. 主线（两条）

| 线 | 一句话 | 现状 |
|----|--------|------|
| **A. 联邦级联（SOLO Bridge）**（原 E 线） | SOLO_A 经 `bridge` 服务分发请求到下游 SOLO_{1..n}，成级联/联邦；**平行处理与租户隔离统一走这个形状**（每租户/每平行单元一套独立网格） | 不存在；跨网格 = 跨机器（+可选跨信任域），硬前置是 v1.1.x 的多机 TLS |
| **B. 部署瘦身 / 动态插件平台**（原 F 线） | 瘦内核 + 按配置从 registry/CAS 拉服务工件，不再一个全量 bundle | esbuild 把全部服务打进固定 `solo.js`（~7.7MB）；构建时切片 + 内核依赖瘦身已判定「只加不破」、v1.1.x 可先行（§4.3-A/§4.4） |

---

## 2. 特性清单

### 2.1 A 线 · 联邦级联（SOLO Bridge）
- **跨网格 bridge 服务**：SOLO_A 经 `bridge` 把请求分发到下游 SOLO_{1..n}。每个下游是独立网格
  （独立 Router / Redis / 信任域），认证用 mesh Ed25519 公钥验签、授权用窄 permit，对 router 零改动。详见 §3。
- **环路 / 深度刹车跨网格存活**：纯拓扑问题，与信任模型无关，同运营者平行网格同样会踩，随 bridge 必做（§3.4-③）。

### 2.2 B 线 · 部署瘦身 / 动态插件平台
- **真·动态拉取插件平台（v2 主体）**：瘦内核 + 按配置从 registry/CAS 拉服务工件，告别固定全量 bundle。详见 §4.3-B。
- **多产物（中间档）**：内核 + 每服务各打一个 bundle，base 按配置 `dynamic require`。详见 §4.3-C。
- 🔨 **（v1.1.x 可先行，不占 v2）构建时切片 `--services` + 内核依赖瘦身**（换 `@solana/web3.js`、清死依赖）：
  详见 §4.3-A / §4.4 + [`BACKLOG.md`](./BACKLOG.md) §4。

### 2.3 裁决台账（出主线的项，历史记录不删）

| 项 | 裁决 | 理由 / 重启条件 |
|----|------|-----------------|
| **actor-claim 全量**（执行面用户签名/服务凭证，旧 A 线） | **搁置**（2026-07-12） | 单信任域内 server 代签 + 事件信封 actor/source 透传（v1.1.9 最小档）已满足审计；平行网格 = 同一运营者同信任域，mesh 签名的**网格级**归因已够。它实质是 bridge 跨信任域档的**子依赖**（§3.4-②），非独立需求。**重启条件：出现跨运营方联邦（下游网格属于别人）。** |
| **完整 at-least-once 重投 + 全网统一幂等键**（旧 B 线） | **搁置**（2026-07-12，此前 2026-07-03 已降级为可选/非阻塞） | 真 bug 那半（`_task` fire-and-forget 丢投）已拆出并于 v1.1.x 修复（router 有限重试退避，2026-07-05）；bridge 分发语义以**同步转发为默认**（§3.5），异步仅给明确幂等的方法——完整语义没有兑现场景，且会静默重复调用未做幂等的下游 handler（行为破坏）。**重启条件：跨网格异步 fire-and-forget 分发成为刚需。** |
| **多租户开放档**（同库 tenant scoping，旧 A 线） | **取消**（2026-07-03） | 由 A 线 bridge 的联邦隔离替代——每租户一套独立网格，物理隔离强于逻辑 scoping，不动现有实体/permit 形状。若未来租户量大、需共享基础设施摊薄成本，同库 scoping 可作为独立课题重议（§3.1 回写）。 |
| **多机部署硬化 · `_task` 丢投修复 · Saga durable 补偿 · autorun 置信判据 · passport TOTP · SSE/MCP/SDK · metrics 正式档 · 构建时切片 + 内核瘦身**（旧 A/B/C/D/F 线的「只加不破」部分） | **拉回 v1.1.x**（2026-07-03，详见 [`VERSION.md`](./VERSION.md) §4 回写） | 均判定纯增量。部分已落地：`_task` 丢投修复（2026-07-05）、Saga durable 补偿与 MCP adapter（v1.1.10）、OTP（2026-06-30）。 |

---

## 3. A 线 · 联邦级联 / SOLO Bridge（跨网格联邦）

### 3.1 概念
SOLO_A 的 `bridge` 服务把请求分发到下游 SOLO_{1..n}，形成级联。**每个下游 SOLO 是一个独立网格**
（独立 Router、独立 Redis、独立信任域）。bridge 是 SOLO_A 看向"另一个 SOLO 网格"的出口。

> **2026-07-03 回写**：这个"每个下游是独立网格"的形状，也正是原"多租户开放档"被取消后的替代方案——
> 与其在同一部署内给实体/permit 加租户维度（会动到现有形状，判定为破坏性），不如每个租户直接一套独立
> SOLO 网格，靠 bridge 联邦起来。隔离强度更高（物理隔离而非逻辑 scoping），代价是运维更重（N 租户 = N 套
> 部署）——量小、租户彼此强隔离优先时这个权衡是对的；如果未来租户量大、需要共享基础设施摊薄成本，
> 同库内 tenant scoping 仍可能作为独立课题重新拿出来议。
>
> **2026-07-12 回写**：**平行处理（水平铺开分担负载）同样走这个形状**——同一运营者铺 N 套网格，
> 各网格仍在同一信任域内，跨信任域那部分依赖（actor-claim 全量）因此不成立，见 §3.4-②。

```
       ┌─────────── SOLO_A ───────────┐         ┌──── SOLO_B ────┐
  调用方 → Router_A → … → bridge(A) ─── JSON-RPC ──→ Router_B → 下游服务
                              │                    └────────────────┘
                              └──────── JSON-RPC ──→ Router_C → …（SOLO_C）
```

### 3.2 为什么是 v2（而不是 v1.1.x 增量）
跨网格 = **跨机器**（必然）+ **跨信任域**（联邦给别人用时），直接碰 v1.1 的核心假设（VERSION.md §2：
单信任域 + 单机 loopback 可信）。同运营者平行部署主要碰"单机"假设，跨运营方联邦两条全碰。
属破坏性架构边界外，明确出版。

### 3.3 实现路径：mesh 公钥验签（认证）+ 窄 permit（授权）双层 ✅
**认证用签名、授权用 permit——两层分开，对 router 零改动**（验签发生在 bridge / 服务边界，不碰受保护目录）。
这不是新协议，而是把 SOLO 内部已有的信任模型往网格边界抬了一层：Router 现在就用 Ed25519 私钥签
`X-Router-Token`、微服务用 `config.routerPublicKey` 验签（CLAUDE.md §7）；mesh 边界照搬这套。

| 层 | 关注点 | 做法 | 出处 / 现成原语 |
|----|--------|------|------------------|
| **认证** | 这请求**真的是 SOLO_A 发的**（不可抵赖） | SOLO_A 用自己的 **mesh Ed25519 私钥**签请求 envelope；SOLO_B 用**带外登记**的 A 公钥验签 | Router §7 验签 + `api/library/router-auth.js` 的 parse；密钥托管同 v1.1 §3.2 approver |
| **认证** | 防重放 / 签名只对这一次调用有效 | envelope 带 `iat`/nonce + 新鲜度窗口；签名**绑定 method + params 摘要** | gateway `logic/webhook.js` 的 `X-Solo-Timestamp` 先例 |
| **授权** | SOLO_A **能调什么**（爆炸半径） | SOLO_B 把 A 的公钥映射成一个「**外网格 principal**」，挂**窄 permit**；Router `checkAccess` 卡死，fail-closed | `api/library/permit.js`；`allow_all` 在 principal 上结构性禁止 |
| 归因 | A 里**谁**触发的（细到发起人） | actor/source 放进**被签的 envelope**（authPayload 已有 `user` + `meta.trace`）——mesh 签名担保信封，信封载发起人；同信任域用 v1.1.9 透传最小档即够，密码学跨 hop 档见 §3.4-② | authPayload；事件信封 actor/source 透传（v1.1.9） |
| 服务形态 | bridge 长什么样 | **gateway 形态的出站 core 服务**（镜像 `core/gateway`），出站说原生 SOLO JSON-RPC 而非邮件/短信 | `core/gateway/index.js` 骨架；`logic/webhook.js`（出站 + 签名 + SSRF 闸）是模子 |
| 发现 + 预检 | A 怎么知道 B 有哪些方法 / 过边界前快失败 | bridge 缓存 SOLO_B 的 `system.capability.list`（public + ai:true 裁剪）做发现**和预检**；无需 token，适合联邦握手第一步 | `api/router/handlers/service.js`（非 admin 只见 `ai\|\|public`）；预检详见本节末「payload 与预检」|

**为什么是签名而不是 bearer token：**
- **边界上没有共享秘密**——A 只持自己的**私钥**（永不外发），B 只持 A 的**公钥**（本就不是秘密）。攻破 B 拿不到能冒充 A 的凭证。
- **不可抵赖 + 网格级归因**——签名证明 A 确实发了这请求。
- **主权对**——每个网格掌管自己的身份（keypair），对端**自己决定信不信**（登记公钥 + 给 permit）。这才是"跨信任域联邦"的形状。
- **撤销简单**——B 把那把公钥从信任集里删掉即停；无需跨网格倒腾 token 的 issue/refresh/rotate。

> **公钥 ≠ 授权**：公钥只证明"这是 SOLO_A"，不说"A 能调 `market.order.create`"。**所以 permit 那层一定要留**——
> 这是 Router 自己被信任的同一逻辑：先验 Router 的 Ed25519 签名，再由 permit 管能不能。与 v1.1 §3.4「外部投稿面」
> 同源——投稿身份是窄 permit、bridge 身份也是窄 permit，只是认证从 bearer-token 换成了**签名验证**。

类比最贴切的现有服务：**`gateway` 是出站到 SMTP/SMS 的适配器；bridge 就是出站到"另一个 SOLO 的 Router"的适配器**，
说的是原生 SOLO JSON-RPC 而非邮件/短信。`gateway/logic/webhook.js` 的"出站 + 签名 + SSRF 防护"几乎可直接做模子。

**payload 与预检（body 透传 + 缓存能力表预检，已定）：**
- **业务 body 原样透传**——bridge 不改写业务参数。但 bridge 是**出网格 egress 点**：跨信任域时这里做 fieldmask/redact
  （数据主权，§3.4-④）。透传的只是内层 body；外层 envelope（mesh 签名 + actor/source）是 bridge 现造的。
- **缓存下游能力表做预检**——bridge 缓存 SOLO_B 的 `system.capability.list`（复用 Router `updateCapabilityMap` 的 60s 刷新），
  过边界前先查：方法存在 + ai/public 暴露 + 命中 A 的窄 permit（有 schema 顺手校 params）。这正是 SOLO 内网 `_task` 已有的纵深
  （`api/router/handlers/tasks.js:103-122` 拿 `CAPABILITY_MAP` 预检，注释："prevent propagation of malformed data"）。
- **预检是优化、不是边界**：缓存会过期（B 删方法 / 改 schema / 撤 permit），B 的 `checkAccess` + 校验**永远权威**（fail-closed）。
  预检 miss 或下游 `METHOD_NOT_FOUND` → **优雅降级回"裸转发让 B 拒"** + 顺手刷新缓存。最坏退化成裸转发，本就安全。
- **为什么内网都预检了、跨网格更要**：跨网格被拒不免费——真网络往返 + 一次签名 + 污染 B 的限流/日志 + 错误归因差。
  同步转发下被拒即上抛；若未来给幂等方法开异步分发，被静默拒 = 丢投黑洞，预检就是第一道堵洞（§3.5 分发语义）。

### 3.4 前置与条件依赖
下面四件单靠认证（签名 + permit）解决不了，是 bridge 落地前要逐一核对的清单
（②④ 的跨信任域部分为**条件依赖**——同运营者平行网格不触发）：

1. **密钥托管 + 信任登记（签名模型已大幅消解此项）**：换签名后 bridge **不再存对端的 bearer token**——边界上没有共享秘密。
   剩下的是：① SOLO_A 的 **mesh 私钥静态托管**（scrypt/AES，镜像 v1.1 §3.2 approver 密钥）；② SOLO_B **带外、显式登记** A 的公钥
   （**不是 TOFU**——从公开端点抓来就信是跨信任域脚枪）；③ key-id 轮换 + 公钥历史保留（v1.1 §3.2 已有先例）。跨机分发的是公钥（非秘密），比 bearer token 安全得多。
2. **跨网格 actor 归因（条件依赖，2026-07-12 拍板）**：**同运营者平行网格不需要**——各网格同信任域，
   envelope 透传 actor/source（v1.1.9 最小档）+ mesh 签名的网格级归因已满足审计。仅当下游网格属于**不同运营方**
   （真跨信任域，B 要独立验证"A 里谁触发的"且不信 A 的透传）时，才需要 actor-claim 全量（密码学跨 hop 存活），
   届时按 §2.3 重启条件重新立项。
3. **环路 / 深度刹车跨网格（必做）**：A→B→A 联邦回环。depth 计数器要跨 bridge hop 存活
   （relay 转发 `X-Trace-Id`/`X-Trace-Depth`，但跨网格下游 Router 默认会 mint 新链）——否则无限联邦回环。
   纯拓扑问题，与信任模型无关，平行网格同样会踩。
4. **TLS / 数据主权**：跨机传输要 TLS——**多机部署硬化已拉回 v1.1.x**（VERSION.md §4），是 bridge 的硬前置，
   不占 v2 排期。跨信任域时哪些数据能过 bridge：在 bridge egress 做 fieldmask/redact（同运营者平行网格可全通，条件依赖）。

> **一句话：认证用 mesh 公钥签名（消掉了共享秘密托管那块）、授权用窄 permit；同运营者平行网格只欠
> "多机 TLS（v1.1.x）+ 环路刹车"两块地基，跨运营方联邦才追加 actor-claim + fieldmask 两块条件件。**

### 3.5 开放设计问题（拍板前要定）
- **分发语义**：**同步转发为默认**（签好 envelope、等下游返回，失败上抛由调用方决定重试）——2026-07-12 随
  「完整 at-least-once 搁置」进一步坐实；异步 fire-and-forget 仅考虑给明确幂等的方法，且属可选强化、非首发面。
- **信任登记 / 密钥轮换的运维面**：B 怎么带外登记 A 的公钥（admin 方法？`deploy/` 配置？），轮换时怎么平滑过渡（key-id + 多活公钥）。
- **拓扑来源**：下游 SOLO_{n} 清单是静态配置（`deploy/`）还是动态注册 / 发现？
- **下游故障语义**：某个 SOLO_{n} 挂了，bridge 降级 / 重试 / 熔断？是否要 per-downstream 健康探针。
- **级联深度上限**：除了环路刹车，是否要硬上限（如 ≤3 跳）防止联邦链路过深。
- **能力对齐**：预检缓存过期 / B 升级 schema 的**基线已定**（advisory + 降级回裸转发让 B 权威裁决，见 §3.3「payload 与预检」）；
  **仍开放**：是否值得再加 bridge 侧 schema 兼容层，还是契约不符就直接失败。

### 3.6 安全考量（设计前必解）

> **2026-07-15**：对 §3.3–§3.5 的 bridge 设计做了一轮**多-agent 对抗式安全评审**（8 个威胁镜头 → 去重成 31 条 →
> 逐条对抗验证，基于 `webhook.js`/`router-auth.js`/`tasks.js`/`service.js` 的代码 ground truth）。
> 结论：**信任模型骨架站得住**——签名认证 + 窄 permit 授权双层、边界无共享秘密、非 TOFU 带外登记、复用已验证的
> Ed25519 信封，都是对的。缺口集中在四处设计**没算清**的地方（A 组，开工前必补），外加若干「点了名却没解决」（B 组）
> 与「取决于未定选项」（C 组）；另有一类不是设计漏洞、但会被实现者踩坑的**实现陷阱**（D 组）。
>
> 烈度 🔴 高 / 🟠 中 / ⚪ 低。状态 **缺**=设计未提及 / **半**=提及但未解 / **选**=仅在某未定选项下成立。

#### A. 设计真正漏掉的硬缺口（v2 开工前必补）

1. 🔴 **缺 · 签名信封无 audience（目标网格）绑定 → A→B 的合法调用可重放到兄弟网格 C。**
   §3.3 密码学表签的是 `iat/nonce + method+params 摘要`，**唯独没有 `aud`**。A 同时联邦到 B、C（都登记 A 的**同一把**
   mesh 公钥、都给 principal-A 授了含方法 M 的窄 permit——A 把同一 workflow 方法扇出到平行网格时很自然）时，恶意下游 B
   拿 A 发它的合法信封，在新鲜度窗口内原样转投 C；C 验签通过（确是 A 签的）+ permit 命中 → C 以 A 身份执行。直接推翻
   §3.3「攻破 B 拿不到能冒充 A 的凭证」。**修法**：目标 grid-id 进被签摘要，下游拒 `aud ≠ 自己`。注意 `router-auth.js:94-101`
   的 `parseRouterToken` 只返回 `{iss,iat,user,permit,constraints,meta}`、丢弃未知字段——`aud` 无法靠"照搬"落地，必须 bridge 侧新写验签器。

2. 🔴 **半（被当审计、实为授权）· 自声明的 actor/source 是 B 的 authz 输入，不只是审计标签。**
   §3.4-② 把 actor-claim 当"归因粒度"推迟到跨运营方档，但 B 侧**已有安全闸**在拿 actor/source 当授权判据：
   `require_actor_permit` 足迹预审、自审禁止（`submittedBy === callerUid`）、独立签名审批人门、nexus 事件 `source` 门。
   同信任域"透传就够"对**审计**安全，但 A 侧任何组件被攻破/有 bug 即可伪造 actor / source **绕过这些 B 侧授权门**。
   设计只把它当审计，漏了它是 authz 输入。**修法**：跨 hop 签 actor，或让 B 对 bridge 来源的调用**拒绝**把未签名的
   actor/source 当授权判据（fail-closed）。

3. 🔴 **缺 · 只认证 A→B，没钉定 callee（B）身份 → 单向认证。**
   设计通篇是"B 验 A 的签名"，对"A 怎么确认对面真是 B"只字未提。URL 上的冒充者（DNS/BGP/MITM）可毒化 A 缓存的
   capability.list、把伪造 RPC 结果喂进 A 的自动化。现成 `addService`（`service.js`）认证的是 Router→service 方向，
   反向没有，无可复用的 callee 钉定。**修法**：TLS 证书钉定 + B 用自己的 mesh key 签响应/能力种子。§3.4-④ 的 TLS 只解决
   传输加密，不解决"对面是不是 B"。

4. 🟠 **缺 · 「窄 permit」不是真正的爆炸半径地板。**
   (a) B 上 `public:true` 方法**绕过 permit**（`service.js:274-278` 的过滤即证公开面对任何 peer 敞开），principal-A 无视窄
   permit 就够到 B 整个公开面（含 passport 自助发证）——v1.1.6/7 已把公开面收窄到 19 法，但仍对能触达 B Router 的 peer 敞开；
   (b) 服务级通配 `market.*` 不是 `allow_all`，躲过 §3.3「结构性禁止 allow_all」却给服务级全量可达。**修法**：定义"窄"
   （禁服务通配）+ 外网格 principal 不吃 public 旁路（federation-public ≠ public）。

#### B. 文档承认、但没解决（承认 ≠ 补上）

5. 🟠 **半 · 环路/深度刹车「必做」却无法用现有原语强制。**
   §3.4-③ 要 depth 计数跨 hop 存活，但 `tasks.js` 的 `_task` 分发沿用同一 trace/depth（RPC hop 不自增）、且每个下游 Router
   默认 mint 新 trace 链——纯 RPC 的 A→B→A 回环永远触不到 `EVENT_MAX_DEPTH`。要求写了、机制不存在。**修法**：bridge 在被签
   信封里自带 federation-hop 计数，别依赖事件 depth。

6. 🟠 **半 · 密钥生命周期（单点 + 轮换≠撤销 + 无人值守托管悖论 + 与审批人密钥同库）。**
   §3.4-①/§3.5 承认托管/轮换/登记 open，但欠考虑：一把 key 认证 A 到整个联邦（泄露 = 到处冒充 A，收敛是 N 方手动）；
   "公钥历史保留"与"删除即撤销"互相矛盾；服务 key 必须开机自解密（口令不能只在人脑）→ 静态"加密"近乎混淆；
   "镜像 §3.2 审批人密钥"把**联邦身份**与**审批伪造材料**塞进同库，一次泄露两头通吃。**修法**：per-peer 密钥或短期证书、
   独立撤销名单（区别于历史保留）、服务密钥专用托管（KMS/HSM，别和审批人密钥同库）。

7. 🟠 **半（跨运营方） · 出口数据最小化是 opt-in、且只管请求腿。**
   默认是 body 原样透传（§3.3），fieldmask 只提了请求腿——**B 的响应回流进 A 从不脱敏**，actor/source/trace 元数据默认随
   信封过境，最小档默认发、升级到跨运营方也无强制关闭闸。只在跨运营方档要紧（§2.3 重启条件），但响应腿遗漏是实打实的。
   **修法**：跨信任域默认拒式脱敏、两条腿都脱、升级时强制元数据最小化。

8. 🟠 **半 · 「同步转发」其实不是 at-most-once + 无跨网格一致性。**
   §2.3 推迟 at-least-once、§3.5 留白分发语义，但即便同步默认也非 at-most-once（A 丢了 B 的响应 → 调用方重试 → B 重复执行，
   而 B 不被要求幂等，见 `tasks.js` "no durable queue / at-most-once" 注）；"异步只给幂等方法"无可机器校验的幂等契约；
   且无跨网格 Saga（补偿是网格内的）——部分联邦失败留下无法补偿的状态。对财务方法尤其尖锐（退款/审批门都在下游）。
   **修法**：跨网格幂等键契约、明确"无跨网格原子性"、异步以声明式 idempotent 标志为门。

9. 🟠 **半 · 韧性/DoS：无熔断、无超时纪律、无隔板、无扇出预算。**
   同步转发遇恶意/慢下游会耗尽 bridge 连接并级联回 A；一次廉价触发按 N^depth 扇出而无宽度/总调用预算。§3.5 把下游故障、
   深度上限列 open 但未定。**修法**：per-downstream 熔断 + 健康探针、每触发硬扇出/总调用预算、激进超时 + socket 拆除
   （`webhook.js` 现有实现读满 64KB 后不 destroy socket，带宽不设界）。

#### C. 取决于未定选项 / 低烈度

10. 🟠 **选（动态拓扑）· 出口 SSRF。** 设计**默认**（静态运营方配置 URL + 可信下游）下安全；若 §3.5 拓扑来源选"动态注册/发现"、
    且非 admin 或被提示注入的 A 侧 bot 能influence 目标，可指向 `169.254.169.254`/RFC1918——照搬的 `webhook.js:23,39` 护栏
    **只挡 loopback**（不挡 metadata/私网/链路本地，不解析 IP、跟随重定向）。**选动态则必须**：解析后校验 IP、禁跟随重定向、注册 admin 门控。
11. ⚪ **缺 · 时钟同步是新鲜度防重放的未列依赖。** 跨网格时钟无共享权威（`router-auth.js:35-39` 的 300s 窗口 + 60s skew 是为同机
    设的），偏移拉宽重放窗口；有真正的 nonce 缓存后可缓解。补进 §3.4 依赖表。
12. ⚪ **半（基本已规避）· 共享下游的行隔离塌陷。** §3.1「每租户一套网格」避开了经典情形（`constraints/$owner` 会把 A 的多 actor
    看成一个 owner）；残留仅在 A 把多个终端用户复用到同一个 B 时。
13. ⚪ **缺 · 错误透传 = 侦察 oracle**（B 内部错误码/消息泄露给 A 的调用方）；**缺 · actor uid 跨网格命名空间冲突**（若 B 拿 A 的裸 uid
    去解析自己的用户空间 → 冲突/冒充）。均属标准加固。

#### D. 实现陷阱（不是设计漏洞，但落地会踩 → 文档须点名）

评审反复冒出的"复用原语与设计自相矛盾"（**方法/参数绑定缺失、无 nonce、HMAC 共享秘密**）经对抗验证**均被驳回**：
§3.3 表明确写了 Ed25519 + nonce + method/params 绑定 + 无共享秘密，`webhook.js`/`router-auth.js` 是作为**方案先例与出站
形态的模子**引用、非字面拿来用。所以它们不是**设计**漏洞——但是**实现陷阱**：谁真的直接 `parseRouterToken`（无 nonce、只认
身份，`router-auth.js:87-101`）或抄 `webhook.js:52` 的 HMAC，就把这些洞原样带回来。**落地要求**：bridge 验签器必须自实现
nonce 缓存 + method/params/aud 摘要绑定 + 非对称验签，不得字面复用上述两个原语。

> **一句话**：骨架对，但**签名信封字段不完整（缺 aud + 真 nonce 存储 + hop 计数）、actor/source 的推迟有被当审计实为授权的
> 后果、互认单向（未钉 callee）、"窄 permit"被 public 方法与通配漏掉**——A 组四处是 v2 开工前必解；其余要么承认未做（B 组），
> 要么被"同运营者 + 静态拓扑"的默认前提圈掉（C 组）。

---

## 4. B 线 · 部署瘦身 / 模块化加载（加载优化）

### 4.1 现状与痛点
部署/启动的成品是 `deploy/build.sh` 产的**单文件 esbuild bundle `api/publish/solo.js` ≈ 7.7 MB**
（`release/solo.v1.1.x.js` 每个 ~7.6MB）。痛点：esbuild 把 `services.json` 里**全部服务**无差别打进去，
**重量是 build-time 钉死的**——哪怕你只跑 router+user+agent，也扛着全部服务的代码 + 依赖。

> **运行时按配置只启子集"已经能用了"**：`SOLO_SERVICES_JSON` → `deploy/gen-entry.js` 生成一组懒工厂，
> 启动时只实例化配置里列的服务。**缺的只是构建时切片**——把"只装哪几个"从 deploy-time 提到 build-time/artifact 层。

### 4.2 为什么好实现：解耦红利已到账
插件系统最难的"把服务从彼此身上拆下来"，SOLO 早已是既成事实：**零跨服务 `require()`**（纯 Router 通信，CLAUDE.md §5），
服务只共享 `api/library/`（内核），已是 npm workspaces。所以这事是**参数化构建**，不是重构。

### 4.3 三个层次（难度递增）
- **A. 构建时切片（容易）**：`gen-entry.js`/`build.sh` 接受服务子集，`build.sh --services router,user,agent` → 只含这仨的瘦 bundle。
  内核（router + library + bootstrap）是地板；因服务解耦，esbuild 不会牵连兄弟服务。**"只加不破"（默认仍打全量）→ v1.1.x 可先行。**
- **C. 多产物（中）**：内核 + 每服务各打一个 bundle 文件，base 启动按配置 `dynamic require` 已落盘的那几个。不靠 registry 就拿到磁盘瘦身。
- **B. 真·动态拉取插件平台（大 = v2 主体）**：瘦内核 + 按配置从 registry/CAS 拉服务工件。要：每服务独立打包 + 分发机制 +
  **工件完整性签名（正好接 A 线 mesh-key）** + 版本。SOLO 有 CAS（SHA-256）能当工件仓、bundle 已字节可复现 + `SHA256SUMS`。

### 4.4 内核依赖瘦身（与切片正交，v1.1.x 可先行）
- 🔴 **`@solana/web3.js`（14 MB!）只为在 `library/auth.js` + `library/router-auth.js` 里解析 Ed25519 `PublicKey`** →
  换成已在依赖里的 `tweetnacl`/`bs58`（`bs58.decode` 出 bytes 直接喂 nacl verify）。这是**内核**依赖，胖了**每一个**部署 = 最大单点收益。
  复杂度低，但 crypto 敏感 → 靠现有 `auth-handshake.test.js` 兜。**注意 `router-auth.js` 在 `api/library/`、不在受保护的 `router/`，不需授权。**
- 🟠 agent 的 `openai`（9.8MB）+ `@google/generative-ai` 在 bundle 里且只 agent 用 → 切片不含 agent 时自然省掉。
- ⚪ 死依赖 `xlsx/jimp/jsqr/jszip/multer`（全仓无 `require`）可清——但它们只瘦 `node_modules`、**不在 bundle 里**，不解决 `solo.js` 大小。

### 4.5 顺手翻出的破绽（清理项）
- `api/monolith-entry.js` 已 **stale**：只列 9 个服务，缺 nexus/notification/ingress/approval（CLAUDE.md 还指它当本地全栈入口）。
- `api/package.json` 的 `"start": "node deploy/launcher.js"` 指向**不存在的文件**（死引用）。

> **版本归属**：A（切片）+ §4.4 内核依赖瘦身 + §4.5 清理 = **"只加不破"，v1.1.x 可先行**（已登记 [`BACKLOG.md`](./BACKLOG.md) §4）；
> C/B（多产物 / 动态拉取插件平台）= **v2 主体**。

---

## 5. 与 v1.1 的边界 / 出版判据

- 入 v2 的判据：**非破坏性改不动了**（"只加不破"无法平滑落地）。能"只加不破"的，仍走 v1.1.x（runbook §2/§5）。
  - 例：Saga 补偿、幂等键的 best-effort 部分已在 v1.1.3「只加不破」提前落地；durable 补偿也已随 v1.1.10 落地。
  - 例（2026-07-03 拆分）：多机硬化、`_task` 丢投修复、TOTP、SSE/MCP/SDK、metrics、构建时切片等判定只加不破 → 全部拉回 v1.1.x（台账见 §2.3）。
- **A 线（bridge）**：天然破坏性（跨机器 + 可选跨信任域），整条 v2；兼任原"多租户"需求的落地方式（§3.1 回写）。
  硬前置多机 TLS 在 v1.1.x 先行，不占 v2。
- **B 线（部署瘦身）**：构建时切片 + 内核依赖瘦身 v1.1.x 先行（[`BACKLOG.md`](./BACKLOG.md) §4）；多产物 / 动态拉取插件平台进 v2（§4）。
- **actor-claim 全量 / 完整 at-least-once**：2026-07-12 搁置出主线（§2.3），**不再是 v2 待办**；
  重启条件分别为「出现跨运营方联邦」/「跨网格异步分发成为刚需」，触发时重新立项再议版本归属。

---

## 6. 索引来源

- v1.1 边界与出版清单原文：[`VERSION.md`](./VERSION.md) §2（假设）、§4（出版清单）。
- 滚动待办：[`BACKLOG.md`](./BACKLOG.md)。
- orchestrator 内部差距：[`../../api/core/orchestrator/AUDIT.md`](../../api/core/orchestrator/AUDIT.md)。
- 阶段 / 分支 / 发版纪律：[`../runbook/release-and-branching.md`](../runbook/release-and-branching.md)。
