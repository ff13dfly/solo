# SOLO · 项目向导（新 session 必读）

> **本文件是唯一"经核实"的入口地图。** 自动加载进每个 session，刻意保持简短、与代码一致。
> 内容详尽但带有产品愿景色彩的 `docs/reference/overview.md`、`api/README.md` 顶部已加 ⚠️ 标签——读它们时注意区分"已实现"与"设想"。
> **冲突时以本文件 + 代码为准。** 校对基准：2026-07-05，由 `deploy/check-doc-drift.js`(CI)守护服务清单一致性。

---

## 1. SOLO 是什么（一句话）

**纯框架 / 基础设施层**：Node.js + Express 5 + Redis 的 AI-native 微服务底座。提供统一网关、实体工厂、权限、审计、工作流编排、AI 能力收敛。

⚠️ **没有业务层。** `docs/` 里大量出现的 commodity / sale / crm / erp / authority / supply / b2b… 是**举例和产品愿景**，**代码里不存在**，缺失它们**不是 gap**。判断"某功能算不算缺失"时，只看下面"真实服务清单"。

---

## 2. 真实服务清单（= `deploy/services.json`，CI 守护）

| 服务 | 端口 | 层 | 职责 |
|------|------|----|------|
| **router** | 8600 | 网关 | 唯一入口：鉴权、路由、Ed25519 签名转发、`_tasks` 分发、`checkAccess` 方法级权限 |
| **gateway** | 8020 | core | 外部通道适配层（**出站**：邮件/短信等） |
| **ingress** | 8070 | core | 外部 webhook **入站**适配器（API key 鉴权 + 去重，发 `EVENT:WEBHOOK:*`；与 gateway 镜像，见 `core/ingress/README.md`） |
| **mcp** | 8091 | core | MCP (Model Context Protocol) 适配器；`POST /mcp` 把 ACTIVE 的 orchestrator workflow 映射成 MCP tools（`tools/list`/`tools/call`），外部 MCP 客户端自带 bot session token，adapter 经 `relay.callAs()` 透传、不做自有鉴权（2026-07-03，workflow-first 范围，见 `docs/planning/v1-implementation-plan.md` P4） |
| **planner** | 8030 | apps | 日程 + 待办 |
| **notification** | 8040 | core | 通知投递 worker（已带退避重试 + 死信队列） |
| **fulfillment** | 8050 | apps | 声明式状态机履约引擎（JsonLogic） |
| **approval** | 8060 | apps | SAP 审批协议（request→verify→confirm→reject）；**已有消费者**：orchestrator 高风险审批门（relay `approval.gate.*`）+ collection 退款门（`approval.record.get`，需 3 个独立签名审批人） |
| **administrator** | 8680 | core | 系统后台 / 单管理员模型 |
| **user** | 8710 | core | 账号(SHA-256 挑战-响应,非 Ed25519)、Session、Permit 存储 |
| **agent** | 8730 | core | AI 大模型中枢（Gemini/Qwen/OpenAI），能力路由 |
| **nexus** | 8740 | core | Sentinel（事件订阅式 AI 反应体）注册 + 事件路由（事件总线发端） |
| **storage** | 8750 | apps | CAS 文件存储（SHA-256） |
| **orchestrator** | 8820 | core | 工作流模板 CRUD + 执行；**审核链已建**：create→PENDING_REVIEW（C1 闸门，自审禁止）+ footprint 预审（H6）+ 按风险路由 approval（低风险快速单签 / 高风险多签门）。内部差距见 AUDIT.md |

> 端口 = `deploy/services.json`（**单一真源** / 运行权威；bundle 经 gen-entry 播 `global.__SOLO_PORTS__`）。各服务 `config.js` 的 `portFor(name, fallback)` 兜底默认现已由 `deploy/check-doc-drift.js`(CI) 强制 === services.json（monolith / 单服务 from-source 启动时兜底是载荷性的，故须一致）。解析序：`process.env.PORT` > `global.__SOLO_PORTS__` > config 兜底。

> ⚠️ `api/apps/` 下还有 `collection`/`market` 两个目录，结构齐全（index.js/logic/tests），但**仅供内部测试用**（如验证 approval 审批线的真实消费者场景）——不在 `deploy/services.json` 里，**不随脚手架 `init.sh`/升级流程下发**给消费项目。判断"真实服务"只看上表 14 个，别把这两个当框架的一部分。

---

## 3. 路径真相（文档常写错，以此为准）

| 东西 | ✅ 真实路径 | ❌ 文档里的错误写法 |
|------|------------|---------------------|
| 共享契约库 | `api/library/` | ~~`api/core/lib`~~ |
| 协议文档(中文) | `docs/protocol/zh/` | ~~`docs/zh/protocol`~~ |
| 新服务模板 | `api/sample/` | — |
| 本地全栈启动 | `api/monolith-entry.js` 或 `bash deploy/dev.sh`（Redis 起在 **6699**） | — |
| orchestrator 实现差距 | `api/core/orchestrator/AUDIT.md` | — |
| 自治 AI 雏形 | `api/autonomous/workflow-auditor/`（仿真/评估，未接真实流程） | — |

`api/library/` 实有（30 个，以目录为准）：auth, bootstrap, category, clock, config, constants, contract, cors, crypto, entity, fieldmask, filestore, generator, health, indexer, jsonlogic, jsonrpc, logger, optimistic, passport, permit, ports, process, relay, risk, router-auth, search, validate, vector, walarchiver。

---

## 4. 当前开发重点（推进顺序，已与用户对齐 2026-06-11）

> **版本边界见 [`VERSION.md`](./docs/planning/VERSION.md)（v1.1 = AI 自动化平台：nexus + fulfillment + 治理线，受信外部 agent 投稿档）**；滚动待办仍在 [`BACKLOG.md`](./docs/planning/BACKLOG.md)（详情台账见 `docs/planning/`）。治理线（分层审批 + 密码签名审批人 + 审批可视化 + 投稿面，VERSION.md §3）**已全部落地**。**v1.1 已封板发版**：`v1.1.0`（2026-06-14，未走 rc1）→ `v1.1.1` → `v1.1.2` → `v1.1.3`（编排可靠性纵深：at-least-once 幂等 + Saga 同步补偿 + 崩溃幂等重驱 + 签名退款审批门）→ `v1.1.4`（脚手架下游契约包）→ `v1.1.5`（2026-06-26，审计驱动修复 + Saga 收尾：token.refresh 死方法修复、e2e 漂移修复、§7.4 approve 期补偿接口运行期预审、auth 死代码清理、e2e 覆盖硬化）→ `v1.1.6`（2026-06-30，passport 自助发证 + 公开面收敛 + UI e2e 转阻塞门 + 错误码守门 + 脚手架契约文档收进 `docs/` + 下游守门 skill `solo-service`）→ `v1.1.7`（2026-07-01，passport 身份线 device/upgrade + 公开面二次收窄至 19 公开法）→ `v1.1.8`（2026-07-01，测试基础设施硬化：全量 e2e 三 flaky 机制清零 + passport 限流 / storage 读门控 / agent.model RPC）→ `v1.1.9`（2026-07-02，架构协调性债清理：#1 缓存写即 bust · #2 bot 权限图单一真源 · #5 端口 CI 守门 · #4 误诊澄清 + actor-claim 最小可行档）→ `v1.1.10`（2026-07-03，MCP adapter + AI 注入检测第二轮 + Saga durable 补偿跨重启续跑）——**均已 tag 发版**。`v1-implementation-plan.md` 主线清单（P0-P2 + P4-MCP）至此**全部实现**：`_task` fire-and-forget 丢投修复（router 有限重试退避，2026-07-05）+ orchestrator `deprecate`/`restore` 生命周期（新增 `DEPRECATED` 状态，2026-07-05）已提交（本地领先 `v1.1.10`，未切新 tag）。剩余项（P3 全部、P4 多机部署硬化）已确认暂缓存档；P4 剩余四项（passport TOTP/SSE/外部 agent SDK/metrics 正式档）+ P5 六项 minor 为低优先级可选项，见缝插针，不占排期。**当前 = 阶段一（trunk + tags，只加不破，继续推 v1.1.x）**；发版/分支纪律见 [`docs/runbook/release-and-branching.md`](./docs/runbook/release-and-branching.md)。新发现默认进 v2，除非「只加不破」可平滑进 v1.1.x。

1. **P0 CI**（✅ 已落地并 commit）：`.github/workflows/ci.yml`（static + jest 绿色子集）+ `api/jest.ci.config.js`。
2. **治理线**：`api/library/permit.js`(footprint 预审 H6) → orchestrator C1 审核闸门，消费 approval。
3. **approval 深挖**（轮到时）：m-of-n 多签 + expiry + 规则引擎。
4. ~~**actor-claim**：走**最小可行档**（预审 + 透传 + 审计），暂不上服务凭证签名~~ —— **✅ 已落地（2026-07-02）**：事件信封 actor/source 透传进 run 实体（审计）+ workflow opt-in `require_actor_permit`（runner actor 足迹预审，fail-closed）+ `$context.trigger_actor`；默认关 = 零破坏。服务凭证签名档仍暂缓（AUDIT C4）。

> orchestrator 内部差距见 `AUDIT.md`（CRITICAL/HIGH **0 个开放待办**——已修 C1/C2/C5 + H2/H3/H4/H6 + C4 最小档，残项 C4 签名档/H1/H5 均 deferred-by-design；MEDIUM 仅 M2 留 v2）。

---

## 5. 核心约定（动代码前必知）

### ⛔ Router 修改保护

**`api/router/` 下的任何文件，未经明确授权禁止修改。**

Router 是系统唯一入口，承载 auth / routing / permission / event 等核心逻辑，改错影响全局。

**操作规则（适用于所有 AI 工具 / 开发者）：**
1. 遇到需要联动 router 的需求，**优先在服务侧、`api/library/`、`deploy/` 脚本寻找非 router 解法**。
2. 如果确实必须改 router，必须先说明：改哪个文件、改什么、为什么——**等用户明确回复同意后**再动手。
3. 用户主动指示"改 router 的 XX"才算授权；自行推断"router 也需要改"不算授权。

- **声明 + 注册必须同步**：`handlers/introspection.js` 声明的方法 ↔ `index.js` 的 handlers 注册，少一边就是红线。
- **命名**：方法 `{service}.{entity}.{action}`；外键 `{targetService}Id`；实体嵌套 ≤ 3 层。
- **服务间禁止直接互调**：必须经 Router，或返回 `_tasks` 由 Router 异步分发。
- **方法级权限已由 Router `checkAccess` 解决**：微服务收到请求时这关已过，无需重复做方法级校验（数据级 `constraints` 仍要下游自校）。
- **实体走 Entity Factory**(`api/library/entity.js`)：自带 CRUD + 索引 + MULTI/EXEC + WAL；`sensitiveFields` 要在 `entities.js` 显式声明。
- **不要 `Date.now()` 散落**：用 `api/library/clock.js`（可注入、测试可冻结）。

---

## 6. 跑测试

```bash
cd api
# ⚠️ 必须用 redis-stack-server（带 RedisJSON）——普通 redis-server 会让 walarchiver/
#    orchestrator/storage/nexus 等依赖 RedisJSON 的套在 JSON.SET/stream 上挂死（非报错，是无限等）。
redis-stack-server --port 6379 --daemonize yes --save ""   # 测试需要 Redis（CI 用 redis/redis-stack-server）
npx jest -c jest.ci.config.js --ci --runInBand             # CI 绿色子集（105 套/1690 测试，2026-06-30 实跑绿，--runInBand 防 MockRouter 并发 flaky）
```

⚠️ 仓库里很多 `*.test.js` 不是 hermetic 的：`core/agent/**` 要外部 LLM API；e2e/rbac/integration 要全栈；部分是 `process.exit` 脚本。CI 用 `jest.ci.config.js` 的**白名单**只跑已验证通过的子集（剩余硬化项见 `BACKLOG.md §5`）。

---

## 7. Router → 微服务通信约定（踩坑防坑）

Router 转发请求时，在 `X-Router-Token` 里打包一个**压缩后的**身份载荷，用 Ed25519 私钥签名。微服务 auth middleware 解码后**只取以下三个字段**，绝不把整个 payload 当 `req.user`：

```js
// ✅ 正确 — 微服务 auth middleware 应该这样写
req.user        = payload.user;        // UID 字符串（如 'uid-abc123'）
req.permit      = payload.permit;      // 压缩权限：'admin' | 'user'（字符串）
req.constraints = payload.constraints; // 数据权限约束对象

// ❌ 错误 — 曾经的写法，已全部修复（2026-06-01）
// req.user = payload;   // 把完整 payload 对象赋给 req.user
```

**为什么压缩**：Router 用私钥对每个 token 签名，token 放在 HTTP header 里，体积要小。
`payload.permit` 只有 `'admin'` / `'user'` 两个字符串，**不下发完整的 permit 对象**（方法列表留在 user service，按需拉取）。

**直接影响**：
- `isAdmin(req)` 用 `req.permit === 'admin'`（library/permit.js 已实现）
- `submittedBy` / `callerUid` 等字段存 `req.user`（UID 字符串），不存整个对象
- 自审禁止比较 `submittedBy === callerUid` 是**字符串比较**，不是对象引用比较
- 共用库 `api/library/router-auth.js` 的 `parseRouterToken` 已封装正确的解析逻辑，新服务直接用

## 8. UI 开发规范

### 禁止：系统弹窗

前端任何地方都**不要**用 `window.alert()` / `window.confirm()` / `window.prompt()`。

**为什么**：系统弹窗阻塞主线程、绕过设计系统、在自定义暗色 UI 中突兀、无法被样式化/动画化/标准工具测试。

**改用**：
- 危险/不可逆操作 → 在当前视图或模态内渲染内联警告块（state 控制显隐）
- 轻量反馈 → `useUI().toast`
- 硬确认门 → 专门的确认模态：`<Modal>` + `<Button variant="danger">`

如果一个操作危险到需要确认，用户应在 UI 内部确认——而不是在一个他无法与钓鱼弹窗区分的浏览器原生对话框里。
