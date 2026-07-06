# SOLO·AI 系统总览 (Overview)

> [!NOTE]
> 本文是 SOLO **框架/基础设施层**的架构理念与实现结构总览，汇总 `api/` 源码、协议文档、各微服务 README 的结构化视图。
> SOLO 是**纯框架**：统一网关、实体工厂、权限、审计、工作流编排、AI 能力收敛——**没有业务层**。
> **判断"什么已实现 / 什么是 gap"，始终以经核实的入口地图 [`CLAUDE.md`](../../CLAUDE.md) 为准**；其 §2 "真实服务清单"由 `deploy/check-doc-drift.js` (CI) 守护。

**阅读路径**

| 板块 | 章节 | 回答的问题 |
|------|------|-----------|
| Ⅰ · **由什么组成** | §3 三层架构 · §4 Router · §5 共享库 · §6 Core 服务 · §7 apps 服务 · §8 多端生态 | 系统由哪些部分拼成？各自职责？ |
| Ⅱ · **靠什么运行** | §9 协议 · §10 权限 · §11 存储与灾备 | 跨服务契约、权限、数据可靠性怎么做？ |
| Ⅲ · **怎么开发** | §12 开发范式与扩展能力 | 怎么新增服务？为什么能快？为什么能平行？ |
| Ⅳ · **决策与风险** | §13 ADR + 陷阱 · §14 安全评估 · §15 路径索引 | 历史决策、踩坑点、安全水位、文件在哪 |

> 章节号沿用源文档（从 §3 起）。AI 是横贯架构本身的设计原则——introspection 契约让 AI 读得懂每个服务、统一命名让 AI 猜得准、`core/agent` 收敛所有大模型能力——具体见 §6、§12.3。

---

# Ⅰ · 由什么组成

## 3. 三层架构

```
┌───────────────────────────────────────────────────────────┐
│ 交互层 (UI)   client/*  portal/*  （React / 多端）         │
├───────────────────────────────────────────────────────────┤
│ 编排层 (API)  router  core/agent  core/orchestrator   │
│               apps/*（应用层微服务）                        │
├───────────────────────────────────────────────────────────┤
│ 数据层        Redis（唯一数据库） + WAL 磁盘日志            │
└───────────────────────────────────────────────────────────┘
```

- **语言/框架**：Node.js + Express 5，CommonJS，单仓库
- **协议**：JSON-RPC 2.0（所有服务统一入口 Router `/api/rpc`）
- **存储**：Redis（含 RediSearch / RedisJSON）+ 本地磁盘 WAL
- **加密**：Ed25519 (TweetNaCl)、bs58、PBKDF2、SHA-256

---

## 4. Router：唯一入口

所有外部请求必须经 `router`（默认 `8600`）。

### 4.1 职责链

```
POST /api/rpc
  → 1. 解析 JSON-RPC (method, params, id)
  → 2. 系统方法 (system.*) 本地处理
  → 3. 认证：Session Token / 公开方法白名单
  → 4. 路由：按 method 前缀定位目标微服务
  → 5. 权限检查 (checkAccess：permit.services / allow_all)
  → 6. 参数校验 (Validator)
  → 7. 签发 X-Router-Token (Ed25519) 转发下游
  → 8. 处理响应中的 _tasks 异步任务（见 §4.2）
  → 9. 返回结果 + 记录交互日志
```

**原则**：
- Router 不感知业务语义（不解释 `constraints`、不消费 `meta`）
- 微服务间不直接互调，必须经 Router 或 `_tasks`
- Router Ed25519 公钥**静态注入**各微服务 `.env`，禁止运行时动态获取（防 MITM）
- **方法级权限已由 Router `checkAccess` 解决**：微服务收到请求时该关已过，无需重复做方法级校验（数据级 `constraints` 仍要下游自校）

> X-Router-Token 里打包的是**压缩**身份载荷，微服务只取 `payload.user`（UID 字符串）、`payload.permit`（`'admin'|'user'`）、`payload.constraints`，**不把整个 payload 当 `req.user`**（见 `CLAUDE.md` §7、`library/router-auth.js`）。

### 4.2 `_tasks` 异步任务分发

微服务响应中返回 `_tasks` 数组，Router 分离后异步调用目标：

```json
{
  "result": {
    "data": { ... },
    "_tasks": [
      { "service": "user", "method": "user.permit.update", "params": {...}, "mode": "async" }
    ]
  }
}
```

- Router 用 `SYSTEM:CONFIG:TASK_WHITELIST` 校验谁可以向谁投递
- 禁止任务生成子任务（防循环）
- 目标服务必须再次校验参数（信任不传递）

这是 SOLO 解耦跨服务副作用的核心机制。

---

## 5. 核心共享库 `api/library`

跨服务的"语言契约"。改动必须向后兼容。

| 模块 | 职责 |
|------|------|
| `constants.js` | 全局状态枚举（`STATUS.ACTIVE / DELETED / DORMANT / EXPIRED`） |
| `jsonrpc.js` | JSON-RPC 2.0 错误目录、success/error 包装器 |
| `entity.js` | CRUD & 索引工厂：标准化 Redis key、MULTI/EXEC 事务、WAL 写入、敏感字段脱敏 |
| `optimistic.js` | 原子乐观 CAS（WATCH/MULTI on duplicate 连接），并发 update 不丢更新 |
| `generator.js` | Base58 ID 生成（可配置前缀+长度） |
| `category.js` | 联邦分类（本地所有权、全局发现） |
| `search.js` | `applySearch`（小表内存过滤）+ RediSearch `escapeTag` |
| `fieldmask.js` | 字段级访问控制（`strip` / `apply` / `define`） |
| `logger.js` | 三级分片审计日志（WAL） |
| `router-auth.js` | X-Router-Token Ed25519 签名/校验、`parseRouterToken` |
| `passport.js` | 外部端设备授权 & 加盐 Proof |
| `vector.js` | RediSearch VECTOR 字段封装 |
| `filestore.js` | CAS (SHA-256) 本地文件存储 |
| `process.js` | 状态机 UI 渲染契约 |

> 完整模块清单（含 auth / bootstrap / clock / config / crypto / indexer / ports / relay 等基础工具）见 `CLAUDE.md` §3 或 `ls api/library/*.js`。

---

## 6. Core 基础设施服务（`api/core/*`）

| 服务 | 端口 | 职责 |
|------|------|------|
| **router** | 8600 | 唯一网关：鉴权、路由、签名转发、任务分发 |
| **administrator** | 8680 | 系统后台登录与管理接口（单管理员模型） |
| **user** | 8710 | 账号注册/登录（SHA-256 挑战-响应,非 Ed25519）、Session、Permit 存储 |
| **agent** | 8730 | AI 大模型中枢。Capability 路由到 Gemini / Qwen / OpenAI |
| **nexus** | 8740 | agent 路由 + 事件总线发端 + 时间驱动 scheduler |
| **notification** | 8040 | 通知投递 worker（退避重试 + 死信队列） |
| **gateway** | 8020 | 外部通道出站（邮件、短信），一般经 `_tasks` 被内部调用 |
| **ingress** | 8070 | 外部 webhook 入站适配器（API key 鉴权 + 去重） |
| **orchestrator** | 8820 | 工作流模板 CRUD 与执行，支持 `$input/$step/$config/$env` 变量注入 |

> `agent.chat`、`agent.purpose`、`agent.focus`、`agent.image.parse` 等是 AI 能力的头等公民，在 `router/logic/system.js` 静态注册表中占位，即使 agent 离线，UI 也能感知接口存在。

### 6.1 AI 模型三级优先级（ADR-006）

```
params.model  >  SYSTEM:CONFIG:AI_MODELS (Redis, TTL 60s)  >  HARDCODED_DEFAULTS
```

| Capability | 默认模型 |
|------------|---------|
| image.parse / audio.transcribe / text.parse / text.translate | `gemini-2.5-flash` |
| image.classify / label.scan | `qwen-vl-plus` |
| text.chat / agent.chat / agent.purpose / agent.focus | `qwen-turbo` |

运营侧 `redis-cli SET SYSTEM:CONFIG:AI_MODELS '{"image.parse":"gemini-3.0-flash"}'`，60 秒内生效，**无需部署**。

---

## 7. 应用层微服务 (`api/apps/*`)

| 服务 | 端口 | 定位 | 关键实体 |
|------|------|------|----------|
| **storage** | 8750 | CAS 资产存储 + 多尺寸缩略图（`?s=sm/md/lg`） | Asset (SHA-256 指纹) |
| **fulfillment** | 8050 | 声明式状态机履约引擎（JsonLogic + Profile） | FulfillmentInstance, Profile |
| **planner** | 8030 | 日程 + 待办（Markdown + AI 拆解 + 本地优先同步） | Agenda, Todo |
| **approval** | 8060 | SAP 审批协议 MVP（request→verify→confirm→reject），**暂无消费者** | Record, Template, Power, Role |

> 这就是 apps 层的全部（= `deploy/services.json` 的 `apps/*`）。`deploy/services.dev.json` 另有 dev-only 夹具 `collection`(8055) / `market`(8056)，**仅供 e2e/演示，非生产服务**。SOLO 不含任何业务域服务——具体行业实体由使用者基于本框架自行新增。

---

## 8. 交互与多端生态

SOLO 前端不是单一 Web App，而是面向不同场景拆分的**客户端矩阵**，共同落在 Router 的 JSON-RPC 入口上。

### 8.1 端矩阵

| 端 | 定位 | 典型调用方 |
|------|------|--------|
| **portal/system** | 平台运维（用户、权限、配置、WAL） | 超管 |
| **portal/operator** | 运营后台：按 introspection 动态渲染各服务实体的 CRUD | 内部员工 |
| **client/qr** | 扫码落地页：按 URL 前缀字母自动路由 | 任意设备（含匿名） |
| **client/mobile** | 员工移动端 | 绑定员工的设备 |
| **client/desktop** | 桌面 AI 助手（以图识物、快捷查询） | 内部员工 |

### 8.2 Operator Portal 的"变色龙"特性

`portal/operator` **不为每个实体手写表单**：

```
页面加载
  → system.introspect（读目标服务的 entities.js / introspection.js）
  → 拿到 JSON Schema + 方法清单
  → RJSF (@rjsf/core) 渲染表单
  → 自动生成 create / update / list / delete CRUD
```

**微服务新增实体 → Portal 无需改代码即可展示**。Schema 是唯一事实源，前后端同步由 introspection 契约保证。

### 8.3 Process Protocol：状态机驱动前端

列表/详情页的"操作按钮"不是硬编码：

```
实体记录 → Category.meta.processId
       → process.state.actions[]
       → 前端遍历渲染按钮 → 点击即 RPC 调用
```

新增业务状态或按钮，只需改 Category 元数据，**UI 自动更新**。

### 8.4 多语言一等公民

文本字段天然可为对象：

```json
{ "name": { "zh": "应急球泡灯-20W", "en": "Emergency Bulb 20W" } }
```

搜索、展示、导出全链路认识 `{zh, en}`，多语言不是补丁，而是数据结构本身。

### 8.5 Local-first 同步

`planner`（日程/待办）采用**本地优先**：客户端离线编辑 → 积压变更 → 上线批量同步。该模式可向高互动场景扩展（现场盘点等）。

### 8.6 外部实体并行授权链（Passport）

内部身份（员工 / bot）走 `user` 的挑战-响应认证；外部实体走 **Passport 协议**（Anchor + 服务端 Salt + DeviceToken → `Proof = sha256(token+salt)`），各自驻守独立认证链，与 `user` 平行。

好处：外部身份不污染内部权限体系；外部端可定向关停而不影响内部侧。

---

# Ⅱ · 靠什么运行

## 9. 协议全景 (`docs/protocol/zh`)

| 协议 | 要点 | 实现度 |
|------|------|--------|
| **security** | 挑战-响应认证（PBKDF2 200k + SHA256）、三层权限（`allow_all / services / constraints`）、字段级 Field Mask、WAL 灾备 | 已实现 |
| **workflow** | Workflow JSON Schema、Focus 状态机（无状态，客户端传 context）、变量解析（`$input / $config / $step / $resolved`）、`_tasks` 异步分发 | 已实现 |
| **category** | 联邦分类："本地所有权 + 全局发现"，Key 大写，Router 为元数据中心 | 已实现 |
| **fulfillment** | 声明式状态机：`transitions[].condition` 用 JsonLogic，`actions` 触发 workflow，`history` 审计 | 已实现 |
| **process** | 实体状态驱动 UI：Category 声明 `processId/processService`，前端统一渲染 actions | 已实现 |
| **passport** | 外部实体设备授权：Anchor + 服务端私 Salt + deviceToken → `Proof = sha256(token+salt)` | 已实现 |
| **config** | 三层：Router 全局（`SYSTEM:CONFIG:*` JSON String）/ 微服务运行时 / 服务结构元信息 | 已实现 |
| **event** | 两类事件源（`_event` 搭载 + matcher 驱动）+ 一执行器；nexus 时钟、orchestrator matcher、router `event.emit`/`_event` | 已实现 |
| **memory** | 客户端短期记忆：Operational / Conversation / Correction | 协议 |
| **approval (YAP)** | 三段式闭环：审核 → 分发 → 核实；强签名为 Phase-2 设计 | MVP（暂无消费者） |
| **extraction** | AI 信息提取：前端预压缩 Base64 → `agent.image.parse`（`mode='product'`）解析 | 已实现 |
| **qr** | 各服务自治 QR：URL 前缀字母即归属，统一 `*.qr.resolve` 返回 `{id, targetType, targetId, meta}` | 协议 |
| **ai-test / report / vision / context** | AI 测试闭环 / Report-as-Code DSL / 以图识图向量检索 / 上下文装配 | **草案/愿景，无实现** |

---

## 10. 权限模型（三层）

```
用户 permit (user Redis key)
  ├── allow_all: boolean              # 是否管理员（等价全权限）
  ├── services: { [svc]: [methods] }  # 方法级控制（"*" = 全量）
  └── constraints: { [method]: {...} }# 数据级约束（Router 透传，微服务自解释）
```

- **方法级**：由 Router `checkAccess` 在入口统一拦截（微服务不再重复校验）
- **数据级**：Router 经 `X-Router-Token` 下发 `constraints`；微服务在 logic 层按需 `require('library/fieldmask')` 应用
- **下发压缩**：token 里 `permit` 只有 `'admin' / 'user'` 两字符串，完整方法列表留在 user service 按需拉取
- **`*` 全局规则**：`constraints['*']` 与方法级规则取**并集**；`show` 优先级高于 `hide`

---

## 11. 存储与灾备

### 11.1 Redis 查询分界线

Redis 没有二级索引，字段过滤必须在取出后由 Node.js 在内存完成。按数据量选方案：

| 数据量 | 方案 | 位置 |
|--------|------|------|
| < 几千 | `SMEMBERS → mGet → applySearch` | `library/search.js` |
| 几万+ | RediSearch `FT.SEARCH` | 服务本地 `logic/search.js` |

**迁移信号**：单次 list 延迟可感知时，迁 RediSearch。不要提前优化。

### 11.2 WAL 灾备 (ADR-002)

- `entity.js` 写操作：`MULTI/EXEC`（string 类型原子；RedisJSON 类型顺序执行）
- 写入成功后调用 `logger.insert({ op, key, before, after, user, stamp })`
- `sensitiveFields` 自动脱敏（passwordHash / login_hash / secret / token）
- 恢复路径：最近 RDB 快照 + 按 stamp 重放日志 → `deploy/wal-recover.js`

### 11.3 部署版本追踪 (ADR-005)

每次部署成功后写入：

| Key | 内容 |
|-----|------|
| `SYSTEM:BUILD` | 服务器自增步数 |
| `SYSTEM:COMMIT` | 本地 `git rev-parse --short HEAD` |

比对本地 commit 即可判断是否有未部署变更。

---

# Ⅲ · 怎么开发

## 12. 开发范式与扩展能力

SOLO 把"快速上新服务"和"多人/多 Agent 并行推进"作为一等公民目标。这一章把**怎么组织代码**（§12.1-12.3）与**架构提供了哪些扩展能力**（§12.4-12.7）两条线并排讲清。

### 12.1 微服务目录（参照 `api/sample`）

```
api/<service>/
├── config.js            # 端口 / Redis key / pageSize / seeds
├── index.js             # 入口：启动 Server、连 Redis、注册 handlers
├── handlers/
│   ├── introspection.js # RPC 方法声明（供 Router/AI/Portal 发现）
│   ├── entities.js      # 数据 Schema（含 sensitiveFields）
│   └── *.js             # 协议适配层（校验、权限、格式化）
├── logic/               # 纯净业务逻辑（Redis 操作、跨服务调用）
└── tests/
```

**红线**：`introspection.js` 声明 + `index.js` 的 `handlers` 注册**必须同步修改**。只有声明 → AI 能看到却调不通；只有注册 → 能调用但 AI 不可见。

**命名规范**：
- 方法：`{service}.{entity}.{action}`（如 `planner.todo.create`）
- 外键：`{targetService}Id`（✅ `userId`；❌ `uid`）
- 实体嵌套：最大 3 层

**必需 API**：`methods`（Agent 能力自省）、`entities`（Agent Schema 自省）、`ping`（Router 心跳）。

### 12.2 单进程开发模式 (`monolith-entry.js`)

生产部署是 N 个独立 Node 进程；本地开发则用 `monolith-entry.js`：主进程 `child_process.fork` 拉起所有微服务，共享终端、一套日志、一次 Ctrl-C 全部回收。**协议与生产一致**——调 Router 走网络。（或 `bash deploy/dev.sh`，Redis 起在 6699。）

新增微服务只需在 `deploy/services.json` 登记端口与模块路径，`monolith-entry` 自动挂载，Router 自动发现。

### 12.3 AI-Native 方法论（"Architecture as a Prompt"）

架构本身被设计成 **"AI 可读、AI 可写、AI 可扩"**，落到开发过程：

- **Schema + 命名规范** → AI 生成代码不偏航
- **introspection** → AI 无需人工讲解接口，直接消费服务元数据
- **ADR 作为共享上下文** → AI 引用历史决策，避免反复推演
- **`api/sample` 完整模板** → "复制 + 改字段名"即可得到新服务骨架

这确保**未来的维护、重构、扩展也能持续由 AI 主导**，而不是依赖写出代码的那个人。

### 12.4 快速开发：从"写代码"到"填模板"

| 能力 | 加速点 |
|------|--------|
| **Entity Factory** (`library/entity.js`) | 写一个 Schema 得完整 CRUD + 索引 + MULTI/EXEC + WAL。微服务不碰 Redis API |
| **Introspection 契约** | `entities.js` / `introspection.js` 声明一次，Portal / Agent / Router 自动消费 |
| **Portal 零代码表单** | RJSF + introspection → 新实体 0 前端改动（§8.2） |
| **shared libs** | `jsonrpc / search / fieldmask` 固化样板，handler 层常 < 20 行 |
| **Seed 机制** (`config.js seeds.*`) | 服务启动自动向 Router 注册分类、配置、示例数据，**部署即可用** |
| **`deploy/services.json`** | 登记端口+模块路径 → `monolith-entry` 和部署脚本自动接入 |
| **Hot-swap 运营配置** | `SYSTEM:CONFIG:*` 改 Redis 值 60s 内生效，**无需部署** |
| **AI-Native 方法论**（§12.3） | Schema + 命名 + ADR → AI 生成代码大幅提速 |

### 12.5 平行扩展：系统性解耦

架构每一层都在刻意避免"改 A 必须改 B"：

| 维度 | 机制 | 效果 |
|------|------|------|
| **服务间** | 禁直接互调，经 Router 或 `_tasks` | 新服务上线不触碰老服务 |
| **数据** | Redis key 按服务前缀隔离 | 各服务掌控自己的数据域 |
| **分类体系** | 联邦分类：本地所有权 + Router 元数据中心 | 新业务自带分类，不排队改"全局字典" |
| **权限** | `permit.services` 方法粒度，`constraints` 自解释 | 新方法声明即接入权限体系 |
| **前端操作** | Process Protocol：按钮由 Category meta 驱动 | 新状态/按钮改元数据即可 |
| **AI 能力** | `SYSTEM:CONFIG:AI_MODELS` 三级优先级 | 单 capability 升级不影响其他 |
| **外部身份** | Passport 与内部认证平行 | 新增外部端不污染 `user` |
| **部署** | 每服务独立进程 + 端口 + 连接池 | 单服务升/降/停，其他不受影响 |

### 12.6 并行推进（多人 / 多 Agent）

- **文件隔离**：每个微服务自己的 `handlers/logic/tests`，合并冲突面极小
- **契约先行**：`entities.js + introspection.js` 先定稿，前端、Agent、其他服务并行开发
- **红线清晰**：`声明+注册必须同步`（§12.1）是唯一硬约束，被 lint/AI 反复提醒
- **ADR 作为共享上下文**：多人/多 Agent 看同一份决策史，避免原地推演

### 12.7 水平伸缩与能力边界

**能伸缩的地方**（无状态 Node 进程 + 共享 Redis 的自然结果）：
- handler/logic 纯函数，session 全在 Redis
- Router 按 `method` 前缀分发，同服务多实例放 nginx 后即可
- `entity.js` 的 MULTI/EXEC + `optimistic.js` 让并发写入天然安全
- WAL 每节点各自写本地磁盘，恢复时按 stamp 归并

**硬天花板**（现阶段有意不解决）：
- Redis 单实例上限、单 Router 实例 QPS 仍是硬天花板；超过时需分片/集群
- 无 K8s/自动扩缩容，手动起进程
- 契约一次性学习成本：`_tasks / introspection / Entity Factory` 掌握前有坡

---

# Ⅳ · 决策与风险

## 13. 架构决策记录 & 常见陷阱

### 13.1 ADR 摘要

| ADR | 标题 | 状态 |
|-----|------|------|
| 001 | 字段拦截（Field Mask）— 配置在 Role.constraints，工具库 `library/fieldmask.js`，微服务按需接入 | 部分实现 |
| 002 | WAL 写前日志 — Entity MULTI/EXEC + 磁盘日志 + 敏感字段脱敏 + 重放恢复 | 已实现 |
| 005 | 部署版本追踪 — `SYSTEM:BUILD` + `SYSTEM:COMMIT` | 已实现 |
| 006 | AI 模型三级优先级选取 | 已实现 |

详细背景见 `CLAUDE.md` 对应 ADR 节。

### 13.2 常见陷阱

- `updatePermit` 校验严格：目前只接受 `allow_all + services` 结构，扩展 `constraints` 需同步改校验器
- `entity.list` 走 Redis `SMEMBERS`，大数据量注意性能；迁 RediSearch 的信号是"单次 list 延迟可感知"
- role/permit 修改不是实时：需等 Router 下次请求从 Redis 刷新 session
- `entity.update` 是顶层字段合并（`{ ...existing, ...updates }`）；传 `meta: {...}` 会整体替换，务必用 `updateMeta` 或展开后再传
- 微服务**禁止**直接互调，必须经 Router 或 `_tasks`
- 不要 `Date.now()` 散落：用 `api/library/clock.js`（可注入、测试可冻结）

---

## 14. 软件安全评估

基于 `docs/protocol/zh/security.md`、`library/*`、`router/*` 以及各服务实现的综合评估。

### 14.1 已有安全能力（Strengths）

| 层面 | 机制 | 对抗场景 |
|------|------|----------|
| **认证** | 挑战-响应：PBKDF2-HMAC-SHA256 × 200k + SHA256 | 数据库泄漏后密码不可逆、零知识通信 |
| **挑战** | Challenge 60s TTL + 一次性 | 重放攻击 |
| **服务间信任** | Router Ed25519 签名 X-Router-Token，公钥静态注入微服务 `.env` | 中间人、伪造 Router |
| **密钥存储** | `.keypair` AES-256 加密 | 磁盘泄漏部分防护 |
| **权限** | 三层：`allow_all` + `services` 方法级 + `constraints` 数据级 | 越权调用、越权读取 |
| **字段级防护** | `library/fieldmask.js` `show/hide` + `*` 全局规则 | 敏感字段泄漏 |
| **限流** | `SYSTEM:CONFIG:RATE_LIMITS` 按前缀、按 ip/user 计数 | 刷接口、DoS |
| **任务白名单** | `SYSTEM:CONFIG:TASK_WHITELIST` 控制 `_tasks` 源-目标关系 | 任务注入、横向滥用 |
| **公开方法白名单** | `PUBLIC_METHODS` 显式枚举 | 误暴露敏感接口 |
| **WAL 审计** | `entity.js` MULTI/EXEC + 磁盘日志 + `sensitiveFields` 自动脱敏 | Redis 损坏恢复、变更可追溯 |
| **外部端授权** | Passport：Anchor + 服务端私 Salt + `Proof=sha256(token+salt)` | 某个业务域 Salt 泄漏不波及其他 |
| **文件完整性** | Storage CAS（SHA-256 内容寻址） | 文件篡改、重复上传 |
| **日志安全** | `chmod 600`、禁放 web 可访问目录、不经 API 暴露 | 日志外泄 |
| **Session** | Token 7 天过期、按需轮换 | Token 长期有效风险 |

### 14.2 主要风险与缺口（Gaps）

#### A. 结构性风险

| # | 风险 | 说明 | 严重度 |
|---|------|------|--------|
| A1 | **Redis 单点即攻破面** | 用户 permit、session、业务数据、Passport Proof 全在 Redis | ⚠️ 高 |
| A2 | **Router 私钥即系统信任根** | 一旦泄漏，攻击者可伪造任意用户身份调用所有下游 | ⚠️ 高 |
| A3 | **LoginHash 是离线爆破目标** | 即使 200k 迭代，拖库后仍可针对弱密码离线爆破 | 🟡 中 |
| A4 | **跨服务信任仅靠 Ed25519** | 无网络层纵深防御（mTLS、服务网格），Router 绕过即沦陷 | 🟡 中 |

#### B. 实现层缺口（需工程跟进）

| # | 缺口 | 当前状态 | 建议 |
|---|------|----------|------|
| B1 | **Field Mask 未全量接入各业务 logic** | 工具库完成；已在 `collection` 接入并有单测 + e2e（suite 35：按用户 constraints 遮蔽 `amount`）验证，模式跑通；其余服务尚未接入 | 逐服务审计 `apply` 是否在返回前调用 |
| B2 | **Approval (YAP) 无消费者** | 敏感变更暂无强审批闭环（MVP 已建，未接入治理链） | 优先级提到 P0，否则合规与责任追溯断链 |
| B3 | **Storage 静态目录公网可达** | `/assets/{path}` 裸 URL 无鉴权 | 敏感资产引入签名 URL 或 permit 授权访问 |
| B4 | **WAL 日志含 before/after 完整快照** | 靠 entity `sensitiveFields` 才脱敏 | 启动时静态检查每个 entity 必须显式声明 |
| B5 | **_tasks 下游再校验依赖自觉** | Router 白名单只过滤来源 | `library` 提供 `taskGuard` 强制二次校验 |
| B6 | **CSRF / 浏览器端风险** | JSON-RPC 走 POST，未见 Origin/Referer 校验 | Router 层补 CSRF，有状态操作校验 Origin |
| B7 | **管理员种子账号轮换** | `administrator` 有种子 admin，未强制首次修改 | 首次启动强制改密 + 失败锁定 |
| B9 | **客户端 memory 脱敏靠前端自律** | 协议要求过滤手机号/身份证/密码，实现分散 | 统一脱敏工具函数 + CI 检查 |
| B10 | **速率限制默认配置缺失** | `RATE_LIMITS` 是可配项 | Router 启动时写入保底策略，配置可加不可减 |
| B11 | **Redis 本身访问控制** | 文档未见 AUTH、bind、TLS 规范 | 运维手册补齐：`requirepass` + 内网绑定 + ACL + TLS |
| B12 | **日志审计人员权限** | WAL 不受 field_mask 管控；SSH 即见全量快照 | OS 层审计（auditd）+ 集中日志传输 |

### 14.3 威胁建模（STRIDE 视角）

| 威胁 | 当前应对 | 残留风险 |
|------|---------|---------|
| **Spoofing**（伪造身份） | 挑战-响应 + X-Router-Token | Router 私钥泄漏即全系统沦陷（A2） |
| **Tampering**（数据篡改） | WAL + Storage CAS | YAP 无消费者，敏感变更无强证据（B2） |
| **Repudiation**（抵赖） | WAL 记录 `user/stamp` | YAP 未接入前靠 WAL，抵赖成本不高 |
| **Information Disclosure** | Field Mask + sensitiveFields | Field Mask 未全量接入（B1）；Storage 公开 URL（B3） |
| **Denial of Service** | RATE_LIMITS | 默认配置可能弱（B10）；单 Redis 故障即全停（A1） |
| **Elevation of Privilege** | permit + 公开方法白名单 | 种子账号（B7）；`_tasks` 再校验缺失（B5） |

### 14.4 合规与审计成熟度

| 维度 | 成熟度 |
|------|:------:|
| 密码不落地、零知识认证 | ✅ 高 |
| 操作审计（who/when/what） | 🟡 中（WAL 已有，需全员检查 `sensitiveFields`） |
| 敏感变更不可抵赖 | 🔴 低（YAP 无消费者） |
| 数据导出/脱敏 | 🟡 中（Field Mask 未全量接入） |
| 密钥生命周期 | 🟡 中（Router 轮换流程明确，Administrator 种子缺手册） |
| 灾难恢复演练 | 🟡 中（有 `wal-recover.js`，未见演练记录） |

### 14.5 高优先级整改（按 ROI）

1. **B2 Approval 接入治理链**：对 permit/role 类敏感变更强制走 YAP
2. **B1 Field Mask 全量接入**：逐个 `apps/*/logic/` 加 `fieldmask.apply`
3. **B4 Entity `sensitiveFields` lint**：启动时对注册实体做静态检查
4. **B3 Storage 授权化**：敏感资产改签名 URL
5. **B5 `taskGuard` 公共校验器**：下沉到 `library`
6. **B11 Redis 硬化**：运维手册补齐 AUTH/TLS/ACL
7. **A2/A3 密钥与密码**：Router 私钥备份 + 最低密码强度
8. **B10 限流保底**：Router 启动强制保底策略

---

## 15. 关键路径索引

| 需求 | 位置 |
|------|------|
| 跨服务"语言契约" | `api/library/` |
| Router 入口 | `api/router/index.js` |
| 认证/权限/字段拦截规范 | `docs/protocol/zh/security.md` |
| 工作流/Focus/Tasks | `docs/protocol/zh/workflow.md` |
| 履约引擎 Profile 规范 | `docs/protocol/zh/fulfillment.md` |
| 事件总线设计 | `docs/protocol/zh/event.md` |
| QR 前缀注册表 | `docs/protocol/zh/qr.md` §3 |
| 架构决策 / 入口地图 | `CLAUDE.md` |
| orchestrator 实现差距 | `api/core/orchestrator/AUDIT.md` |
| 服务级实现细节 | `api/apps/<service>/docs/IMPLEMENTATION.md` 或 `README.md` |
| 新服务模板 | `api/sample/` |
