# SOLO v2 — 版本规格（草案 · 范围归集）

> **状态：草案 / 范围归集。当前仍是阶段一（trunk + tags，继续推 v1.1.x），v2 尚未启动。**
> 本文是 **v2 范围的归集处**——v1.1 边界外的新发现、明确出版项、跨架构特性先落在这。
> 等真正进阶段二（从 `v1.1.x` tag 拉 `release/v1.1`、main 转 v2，见 runbook §3）时，本文转正为冻结 spec、
> [`VERSION.md`](./VERSION.md) 冻结归档。
>
> 来源：[`VERSION.md`](./VERSION.md) §4「出版清单」+ 设计讨论。**冲突时以代码 + 阶段一纪律为准。**
> 阶段/分支/兼容纪律的可执行版见 [`../runbook/release-and-branching.md`](../runbook/release-and-branching.md)。
> 校对基准：2026-06-27。

---

## 0. v2 是什么（一句话）

从「**单机 · 单信任域 · server 代签执行**」走向「**多机 · 多租户 · 密码学归因执行 · 跨网格联邦**」的分布式平台。

v1.1 把 SOLO 做成了「单信任域内的 AI 自动化平台」（§2 假设：单信任域 + 单机 + 手工发证 + server-attested 执行）。
**v2 的主线就是逐条打开这些假设**，并把若干 best-effort/实验档做成生产档。

---

## 1. 主线（六条）

| 线 | 一句话 | v1.1 现状（要打开的假设） |
|----|--------|---------------------------|
| **A. 信任模型升级** | 执行面也密码学归因（actor-claim 全量）| 单信任域 + server 代签执行——**多机/多租户已拆出**（见下） |
| **B. 投递 / 补偿完整可靠语义** | at-least-once 重投 + 全网幂等键（可选/非阻塞）| per-service 幂等 + STALLED 人工重驱——**`_task` 丢投修复/Saga durable 已拆出** |
| **C. AI 自治转生产级** | ~~autorun 置信兜底判据重设计~~（已拆出） | sentinel autorun = 实验特性，不背书生产 |
| **D. 接入面 / 运维正式档** | ~~自助注册 · SSE/MCP/SDK · Prometheus 正式档~~（已拆出） | 手工发证 · 最小告警档 |
| **E. 联邦级联（SOLO Bridge）** | SOLO_A 经 bridge 分发请求到下游 SOLO_{n}，成级联；**现也承担原 A 线"多租户"的隔离职责** | 不存在；跨网格 = 跨信任域 + 跨机器，碰 A 线两条假设 |
| **F. 部署瘦身 / 模块化加载** | 瘦内核 + 按配置拉服务工件，不再一个全量 bundle | esbuild 把 13 个服务全打进固定 `solo.js`（~7.7MB），重量 build-time 钉死 |

> **2026-07-03 拆分回写（用户拍板，规划改动，尚未实现）**：C、D 全条 + A 的多机部署硬化 + B 的 `_task` 丢投
> 修复/Saga durable 补偿，判定为可"只加不破"，已拉回 v1.1.x 排期（详见 [`VERSION.md`](./VERSION.md) §4 的对应回写）。
> A 的**多租户开放档已取消**（非拉回）——用 E 线 bridge 的联邦隔离替代，每租户一套独立网格，见 §3。B 的**完整
> at-least-once + 全网统一幂等键**降级为可选/非阻塞，仍留 v2 但不算阻塞项。**v2 主线因此收窄为：A 线仅剩
> actor-claim 全量、B 线仅剩完整 at-least-once 语义（可选）、E 线、F 线的动态插件平台部分**——详见 §2 逐项状态。
>
> E 线是本轮新增（§3 详写）。它不是独立的第五件事——而是 **A 线（mesh 密钥体系 + actor-claim + 多机 TLS）的一个汇流应用**，
> 单独拎出来是因为它是一个完整的、用户可见的产品形态；2026-07-03 起还多了一层：它是原 A 线"多租户"取消后的替代方案。
>
> F 线也是本轮新增（§4 详写）。其中**构建时切片 + 内核依赖瘦身可在 v1.1.x 先行**（"只加不破"），只有真·动态拉取插件平台才必须 v2。

---

## 2. 特性清单

状态标记：⛔ 仍在 VERSION.md §4 明确出版（真 v2）/ 🔵 已判定只加不破、拉回 v1.1.x 排期（2026-07-03，尚未实现）/
❌ 已取消（非拉回，需求被其他线替代）/ 🌱 v2 新提案 / 🔨 候选（待拍）。

### A. 信任模型升级
- ⛔ **actor-claim 全量**：执行面上**用户签名 / 服务凭证**。现在执行归属是 Router 用 Ed25519 代签（server-attested），
  用户级签名只覆盖审批面（VERSION.md §3.2）；v2 让"谁执行的"也密码学可归因。涉及用户私钥管理体系，
  判定为真正的破坏性架构改动，**仍留 v2**（2026-07-03 这轮拆分未拉回）。
- ❌ **多租户开放档（已取消）**：原设想是互不信任的 agent 共存于同一部署。2026-07-03 判定用 E 线 bridge 的
  联邦隔离替代——每租户一套独立网格（独立 Router/Redis/信任域），隔离强度高于同库内 tenant scoping，
  且不用改任何现有实体/permit 形状。这条需求转移到 §3（E 线），本条本身不再是待办。
- 🔵 **多机部署硬化**：`loopback → service-bot`、TLS。现在很多地方（category 等）靠"单机 loopback 可信"成立。
  2026-07-03 判定可做成配置开关（`ROUTER_URL` 非 localhost 才切路径），单机部署无感知，只加不破 → 拉回
  v1.1.x 排期。
  > **E 线的 bridge 依赖这条的 TLS 部分**——跨网格传输要 TLS；凭证那块改用 mesh 公钥签名后已大幅消解（§3.4-依赖①）。

### B. 投递 / 补偿的完整可靠语义
- ⛔ **重投队列语义（完整 at-least-once + 全网统一幂等键）**：现在只做了 `step.idempotency_key`（per-service 去重）+
  STALLED 人工重驱；投递保证语义从 at-most-once 变 at-least-once 会让未做幂等处理的下游 handler 被静默重复
  调用，判定为真正的行为破坏，**仍留 v2**，但 2026-07-03 起降级为**可选/非阻塞**——不做只是维持现状，非新增风险。
- 🔵 **`_task` fire-and-forget 丢投修复（窄义）**：`api/router/handlers/tasks.js` 的派发是非 await 的
  `axios.post(...).catch(log)`，无 ack/retry/DLQ——过载时会丢，导致实体不一致（e2e 曾观测到
  `order=PLACED instance=CLEARED`）。这是**已确认的真 bug**，不是完整 at-least-once 语义的一部分——加重试+DLQ
  可见即可，不改变投递保证语义、不影响下游。2026-07-03 从上一条拆出，按 bug 处理不分版本，已拉回 v1.1.x 排期。
  > 设计草案（taskrunner 独立服务 · 预签重放 vs Router 内 drain）见 [`BACKLOG.md`](./BACKLOG.md) + `docs/protocol/zh/event.md` 的 `_task` 章（草案·未拍板）——窄义修法可能不需要这整套设计，届时按实现复杂度取舍。
- 🔵 **Saga durable 补偿**：同步 best-effort 已落地（v1.1.3）；跨 orchestrator 重启的持久补偿（需 step-cursor
  中途续跑）2026-07-03 判定只加不破（run 实体形状不用变，照抄 sync 补偿的 opt-in 声明模式）→ 拉回 v1.1.x 排期。

### C. AI 自治转生产级
- 🔵 **autorun 置信判据重设计**：现在 sentinel autorun（`agent.decide`）是实验特性，含不可信文本时不驱动高风险动作。
  2026-07-03 判定只加不破（`agent.decide` RPC 契约不用变）→ 拉回 v1.1.x 排期，续 `risk_tolerance` 具名容忍度档
  （2026-07-03 已落地的部分先行缓解，仅把阈值变可配置，不改变信号本身可信度）之后的工作。

### D. 接入面 / 运维正式档
- 🔵 **passport TOTP 自助**：现在 bot/passport 全靠 admin 手工发证（OTP 已拉回 v1.1.x 并于 2026-06-30 落地）。
  TOTP 第二档 2026-07-03 判定纯增量 → 拉回 v1.1.x 排期。
- 🔵 **SSE 推送 / MCP adapter / 外部 agent SDK**：对外接入通道。2026-07-03 判定纯增量（SSE 现有 fail-closed 拒绝
  路径 + `gateway.webhook.send` 出站骨架可当模子；MCP adapter 是真正新增，但不破坏任何现有调用方）→ 拉回
  v1.1.x 排期。
- 🔵 **metrics 正式档**（Prometheus/Alertmanager）：现在的最小告警档是既有 v1 基座。2026-07-03 判定纯增量
  （在已有的最小 `/metrics` 上加详细指标）→ 拉回 v1.1.x 排期。

### E. 联邦级联（SOLO Bridge）🌱
- 🌱 **跨网格 bridge 服务**：SOLO_A 经 `bridge` 服务把请求分发到下游 SOLO_{1..n}，形成级联/联邦。详见 §3。

### F. 部署瘦身 / 模块化加载 🌱
- 🌱 **瘦内核 + 按配置拉服务工件**：部署一个 SOLO base，按配置只装需要的微服务，告别固定 ~7.7MB 全量 bundle。详见 §4。
- 🔨 **（v1.1.x 可先行）构建时切片 `--services` + 内核依赖瘦身**（换 `@solana/web3.js`、清死依赖）：详见 §4 + [`BACKLOG.md`](./BACKLOG.md) §4。

---

## 3. 联邦级联 / SOLO Bridge（跨网格联邦）🌱

### 3.1 概念
SOLO_A 的 `bridge` 服务把请求分发到下游 SOLO_{1..n}，形成级联。**每个下游 SOLO 是一个独立网格**
（独立 Router、独立 Redis、独立信任域）。bridge 是 SOLO_A 看向"另一个 SOLO 网格"的出口。

> **2026-07-03 回写**：这个"每个下游是独立网格"的形状，也正是原 A 线"多租户开放档"被取消后的替代方案——
> 与其在同一部署内给实体/permit 加租户维度（会动到现有形状，判定为破坏性），不如每个租户直接一套独立
> SOLO 网格，靠 bridge 联邦起来。隔离强度更高（物理隔离而非逻辑 scoping），代价是运维更重（N 租户 = N 套
> 部署）——量小、租户彼此强隔离优先时这个权衡是对的；如果未来租户量大、需要共享基础设施摊薄成本，
> 同库内 tenant scoping 仍可能作为独立课题重新拿出来议。

```
       ┌─────────── SOLO_A ───────────┐         ┌──── SOLO_B ────┐
  调用方 → Router_A → … → bridge(A) ─── JSON-RPC ──→ Router_B → 下游服务
                              │                    └────────────────┘
                              └──────── JSON-RPC ──→ Router_C → …（SOLO_C）
```

### 3.2 为什么是 v2（而不是 v1.1.x 增量）
跨网格 = **跨信任域 + 跨机器**，直接碰 v1.1 的两条核心假设（VERSION.md §2：单信任域 + 单机 loopback 可信）。
属破坏性架构边界外，明确出版。

### 3.3 实现路径：mesh 公钥验签（认证）+ 窄 permit（授权）双层 ✅
**认证用签名、授权用 permit——两层分开，对 router 零改动**（验签发生在 bridge / 服务边界，不碰受保护目录）。
这不是新协议，而是把 SOLO 内部已有的信任模型往网格边界抬了一层：Router 现在就用 Ed25519 私钥签
`X-Router-Token`、微服务用 `config.routerPublicKey` 验签（CLAUDE.md §7）；mesh 边界照搬这套。

| 层 | 关注点 | 做法 | 出处 / 现成原语 |
|----|--------|------|------------------|
| **认证** | 这请求**真的是 SOLO_A 发的**（不可抵赖） | SOLO_A 用自己的 **mesh Ed25519 私钥**签请求 envelope；SOLO_B 用**带外登记**的 A 公钥验签 | Router §7 验签 + `api/library/router-auth.js` 的 parse；密钥托管同 §3.2 approver |
| **认证** | 防重放 / 签名只对这一次调用有效 | envelope 带 `iat`/nonce + 新鲜度窗口；签名**绑定 method + params 摘要** | gateway `logic/webhook.js` 的 `X-Solo-Timestamp` 先例 |
| **授权** | SOLO_A **能调什么**（爆炸半径） | SOLO_B 把 A 的公钥映射成一个「**外网格 principal**」，挂**窄 permit**；Router `checkAccess` 卡死，fail-closed | `api/library/permit.js`；`allow_all` 在 principal 上结构性禁止 |
| 归因 | A 里**谁**触发的（细到发起人） | actor-claim 放进**被签的 envelope**（authPayload 已有 `user` + `meta.trace`）——mesh 签名担保信封，信封载发起人 | authPayload；A 线 actor-claim |
| 服务形态 | bridge 长什么样 | **gateway 形态的出站 core 服务**（镜像 `core/gateway`），出站说原生 SOLO JSON-RPC 而非邮件/短信 | `core/gateway/index.js` 骨架；`logic/webhook.js`（出站 + 签名 + SSRF 闸）是模子 |
| 发现 + 预检 | A 怎么知道 B 有哪些方法 / 过边界前快失败 | bridge 缓存 SOLO_B 的 `system.capability.list`（public + ai:true 裁剪）做发现**和预检**；无需 token，适合联邦握手第一步 | `api/router/handlers/service.js`（非 admin 只见 `ai\|\|public`）；预检详见本节末「payload 与预检」|

**为什么是签名而不是 bearer token：**
- **边界上没有共享秘密**——A 只持自己的**私钥**（永不外发），B 只持 A 的**公钥**（本就不是秘密）。攻破 B 拿不到能冒充 A 的凭证。
- **不可抵赖 + 网格级归因**——签名证明 A 确实发了这请求，直接喂 §3.4 依赖②。
- **主权对**——每个网格掌管自己的身份（keypair），对端**自己决定信不信**（登记公钥 + 给 permit）。这才是"跨信任域联邦"的形状。
- **撤销简单**——B 把那把公钥从信任集里删掉即停；无需跨网格倒腾 token 的 issue/refresh/rotate。

> **公钥 ≠ 授权**：公钥只证明"这是 SOLO_A"，不说"A 能调 `market.order.create`"。**所以 permit 那层一定要留**——
> 这是 Router 自己被信任的同一逻辑：先验 Router 的 Ed25519 签名，再由 permit 管能不能。与 v1.1 §3.4「外部投稿面」
> 同源——投稿身份是窄 permit、bridge 身份也是窄 permit，只是认证从 bearer-token 换成了**签名验证**。

类比最贴切的现有服务：**`gateway` 是出站到 SMTP/SMS 的适配器；bridge 就是出站到"另一个 SOLO 的 Router"的适配器**，
说的是原生 SOLO JSON-RPC 而非邮件/短信。`gateway/logic/webhook.js` 的"出站 + 签名 + SSRF 防护"几乎可直接做模子。

**payload 与预检（body 透传 + 缓存能力表预检，已定）：**
- **业务 body 原样透传**——bridge 不改写业务参数。但 bridge 是**出网格 egress 点**：跨信任域时这里做 fieldmask/redact
  （数据主权，§3.4-依赖④）。透传的只是内层 body；外层 envelope（mesh 签名 + actor-claim）是 bridge 现造的。
- **缓存下游能力表做预检**——bridge 缓存 SOLO_B 的 `system.capability.list`（复用 Router `updateCapabilityMap` 的 60s 刷新），
  过边界前先查：方法存在 + ai/public 暴露 + 命中 A 的窄 permit（有 schema 顺手校 params）。这正是 SOLO 内网 `_task` 已有的纵深
  （`api/router/handlers/tasks.js:103-122` 拿 `CAPABILITY_MAP` 预检，注释："prevent propagation of malformed data"）。
- **预检是优化、不是边界**：缓存会过期（B 删方法 / 改 schema / 撤 permit），B 的 `checkAccess` + 校验**永远权威**（fail-closed）。
  预检 miss 或下游 `METHOD_NOT_FOUND` → **优雅降级回"裸转发让 B 拒"** + 顺手刷新缓存。最坏退化成裸转发，本就安全。
- **为什么内网都预检了、跨网格更要**：跨网格被拒不免费——真网络往返 + 一次签名 + 污染 B 的限流/日志 + 错误归因差；
  **异步分发**时被静默拒 = 丢投黑洞（接 §3.5 分发语义 + B 线 `_task` 可靠投递）。所以同步转发"反正会被 B 丢弃"是安全的，
  异步转发的"丢弃"则正是要堵的洞。

### 3.4 认证只是一块——级联是几条 v2 线的汇流
下面四件单靠认证（签名 + permit）解决不了，正是 E 线对其他 v2 线的**依赖**（也解释了为什么它天然是 v2）：

1. **密钥托管 + 信任登记（签名模型已大幅消解此项）**：换签名后 bridge **不再存对端的 bearer token**——边界上没有共享秘密。
   剩下的是：① SOLO_A 的 **mesh 私钥静态托管**（scrypt/AES，镜像 §3.2 approver 密钥）；② SOLO_B **带外、显式登记** A 的公钥
   （**不是 TOFU**——从公开端点抓来就信是跨信任域脚枪）；③ key-id 轮换 + 公钥历史保留（§3.2 已有先例）。跨机分发的是公钥（非秘密），比 bearer token 安全得多。
2. **跨网格 actor 归因（依赖 A 线 actor-claim）**：A 以 bot 调 B，B 只看到"来自 A 的 bot"，丢了 A 里真正的发起人（user/sentinel）。
   要"A 里谁触发的"在 B 可审计 / 可追责，需 **actor-claim 跨 hop 存活**（当前 authPayload 只带 server-attested 的 trace/depth）。
3. **环路 / 深度刹车跨网格**：A→B→A 联邦回环。depth 计数器要跨 bridge hop 存活
   （relay 转发 `X-Trace-Id`/`X-Trace-Depth`，但跨网格下游 Router 默认会 mint 新链）——否则无限联邦回环。
4. **信任边界 / TLS / 数据主权（依赖 A 线多租户 + 多机 TLS）**：跨网格本质是多信任域。
   哪些数据能过 bridge？跨域要在边界做 fieldmask/redact；传输要 TLS。

> **一句话：认证用 mesh 公钥签名（消掉了共享秘密托管那块）、授权用窄 permit；bridge 这个特性 = mesh 密钥体系 + actor-claim + 多租户 + 多机 TLS 的汇流点。**
> 先把 A 线那几块做实，bridge 才是"把它们组装成一个产品形态"，而不是从零造跨网格信任协议。

### 3.5 开放设计问题（拍板前要定）
- **分发语义**：bridge 同步转发（签好 envelope、等下游返回）还是异步 fire-and-forget 分发？
  后者勾连 B 线 `_task` 可靠投递——跨网格丢投比同机更难补偿。倾向：**同步转发为默认**，异步仅给明确幂等的方法。
- **信任登记 / 密钥轮换的运维面**：B 怎么带外登记 A 的公钥（admin 方法？`deploy/` 配置？），轮换时怎么平滑过渡（key-id + 多活公钥）。
- **拓扑来源**：下游 SOLO_{n} 清单是静态配置（`deploy/`）还是动态注册 / 发现？
- **下游故障语义**：某个 SOLO_{n} 挂了，bridge 降级 / 重试 / 熔断？是否要 per-downstream 健康探针。
- **级联深度上限**：除了环路刹车，是否要硬上限（如 ≤3 跳）防止联邦链路过深。
- **能力对齐**：预检缓存过期 / B 升级 schema 的**基线已定**（advisory + 降级回裸转发让 B 权威裁决，见 §3.3「payload 与预检」）；
  **仍开放**：是否值得再加 bridge 侧 schema 兼容层，还是契约不符就直接失败。

---

## 4. 部署瘦身 / 模块化加载（加载优化）🌱

### 4.1 现状与痛点
部署/启动的成品是 `deploy/build.sh` 产的**单文件 esbuild bundle `api/publish/solo.js` ≈ 7.7 MB**
（`release/solo.v1.1.x.js` 每个 ~7.6MB）。痛点：esbuild 把 `services.json` 里**全部 13 个服务**无差别打进去，
**重量是 build-time 钉死的**——哪怕你只跑 router+user+agent，也扛着全部 13 个服务的代码 + 依赖。

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
  **工件完整性签名（正好接 E 线 mesh-key）** + 版本。SOLO 有 CAS（SHA-256）能当工件仓、bundle 已字节可复现 + `SHA256SUMS`。

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
  - 例：Saga 补偿、幂等键的 best-effort 部分已在 v1.1.3「只加不破」提前落地；完整 durable / at-least-once 档才留 v2。
  - 例（2026-07-03）：C 全条 + A 的多机硬化 + B 的 `_task` 丢投修复/Saga durable 补偿，判定只加不破 → 拉回
    v1.1.x；A 的多租户被 E 线的物理隔离方案取代（不是"能不能只加不破"的问题，是需求本身转移了）；B 的完整
    at-least-once 语义、A 的 actor-claim 全量，判定为真破坏 → 仍留 v2。
- E 线（bridge）天然破坏性（跨信任域 + 跨机），整条进 v2；2026-07-03 起还兼任 A 线原"多租户"需求的落地方式（§3.1 回写）。
- F 线（部署瘦身）：**构建时切片 + 内核依赖瘦身可"只加不破" → v1.1.x 先行**（[`BACKLOG.md`](./BACKLOG.md) §4）；动态拉取插件平台进 v2（§4）。
- `_task` 可靠投递：**窄义丢投修复**（重试+DLQ 可见）2026-07-03 判定只加不破，拉回 v1.1.x；**taskrunner 独立
  服务 / 预签重放**这类更完整的重投架构设计草案仍属 B 线的"完整语义"那半，记录在 [`BACKLOG.md`](./BACKLOG.md)
  指针 + `docs/protocol/zh/event.md` 的 `_task` 章（草案·未拍板）。

---

## 6. 索引来源

- v1.1 边界与出版清单原文：[`VERSION.md`](./VERSION.md) §2（假设）、§4（出版清单）。
- 滚动待办：[`BACKLOG.md`](./BACKLOG.md)。
- orchestrator 内部差距：[`../../api/core/orchestrator/AUDIT.md`](../../api/core/orchestrator/AUDIT.md)。
- 阶段 / 分支 / 发版纪律：[`../runbook/release-and-branching.md`](../runbook/release-and-branching.md)。
