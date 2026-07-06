# SOLO

> **S**wift(敏捷) · **O**rchestrated(编排) · **L**earning(学习) · **O**bjects(对象)

**Version 1.1.10**

[English](README.md) | 简体中文

---

## SOLO 是什么

SOLO 是一个基于 Node.js + Express 5 + Redis 的 AI-native 微服务框架:提供统一网关、实体工厂、权限、审计、工作流编排、AI 能力路由。

它是**纯基础设施——不内置任何具体业务领域**。这里没有 CRM、ERP 或电商逻辑;SOLO 提供的是搭建这些东西的底座。(文档里有时会用 `commodity`/`crm` 这类领域名词,作为"在这个框架上你会怎么搭"的举例——哪些是"已实现"、哪些只是"举例说明",见 [`docs/README.md`](docs/README.md)。)

名字里每个字母都是一条设计原则:

| | 原则 | 含义 |
|---|---|---|
| **S** | **Swift(敏捷)** | 快速迭代、轻量级微服务、即时部署。跑得快,但不破坏数据的单一真源。 |
| **O** | **Orchestrated(编排)** | 工作流引擎、跨服务协调、状态机驱动的履约。服务之间是协作关系,不只是共存。 |
| **L** | **Learning(学习)** | AI Agent 是核心——视觉识别、语义推理、意图路由,以及事件驱动的自治 Agent(nexus Sentinel)。 |
| **O** | **Objects(对象)** | 实体优先架构。一切都是结构化、可版本化、可搜索的对象,统一走一个 Entity Factory 管理。 |

---

## 架构一览

```
┌─────────────────────────────────────────────────┐
│                   Clients                       │
│         Mobile · Desktop · Portals               │
└──────────────────┬──────────────────────────────┘
                   │ HTTPS (8600)
┌──────────────────▼──────────────────────────────┐
│              Router (API Gateway)                │
│  Auth · Ed25519-signed JSON-RPC dispatch ·        │
│  method-level permission checks · _task dispatch  │
└──────────────────┬──────────────────────────────┘
                   │
       ┌───────────┼───────────┐
       ▼           ▼           ▼
  ┌─────────┐ ┌─────────┐ ┌─────────┐
  │  Core   │ │  Apps   │ │  Agent  │
  │ Services│ │ Services│ │  (AI)   │
  └────┬────┘ └────┬────┘ └────┬────┘
       │           │           │
       └───────────┼───────────┘
                   ▼
            ┌────────────┐
            │   Redis    │
            │  (Storage) │
            └────────────┘
```

一共 14 个服务,注册在 [`deploy/services.json`](deploy/services.json) 里(这是"什么是真实存在的"的唯一真源——CI 会拿它核对其余所有文档):

**网关(Gateway)**
- **router**(8600)—— 唯一入口:鉴权、JSON-RPC 分发、Ed25519 签名转发、异步 `_task` 分发、方法级权限校验

**核心服务(Core)**
- **gateway**(8020)—— 出站外部通道适配器(邮件/短信等)
- **ingress**(8070)—— 入站外部 webhook 适配器(API key 鉴权 + 去重)
- **mcp**(8091)—— Model Context Protocol 适配器;把已审核通过的 orchestrator 工作流暴露成 MCP 工具,供外部 AI 客户端调用
- **notification**(8040)—— 带退避重试 + 死信队列的投递 worker
- **administrator**(8680)—— 系统后台 / 单管理员模型
- **user**(8710)—— 账号、Session、权限存储
- **agent**(8730)—— AI 供应商中枢(Gemini / Qwen / OpenAI),能力路由
- **nexus**(8740)—— Sentinel(事件订阅式反应型 AI Agent)注册 + 事件路由
- **orchestrator**(8820)—— 工作流模板 CRUD + 执行,置于审核/审批闸门之后

**应用层(Apps)**
- **planner**(8030)—— 日程 + 待办
- **fulfillment**(8050)—— 声明式状态机履约引擎(JsonLogic)
- **approval**(8060)—— SAP 审批协议(申请 → 核验 → 确认 → 拒绝)
- **storage**(8750)—— 内容寻址文件存储(SHA-256)

### 客户端
- **Mobile** —— 跨平台移动端
- **Desktop** —— 基于 Tauri 的桌面应用
- **Portal System** —— 系统管理后台
- **Portal Operator** —— 运营看板(团队自有源码,框架升级不会覆盖它)

---

## 快速开始

```bash
# 启动开发环境(自动装依赖,Redis 起在 6699)
bash deploy/dev.sh
```

---

## 文档

> 📖 下面链接的文档(协议规范、规划台账、操作手册)本来就是中文写的。

- **[文档地图](docs/README.md)** —— 全量索引:protocol 规范 · planning 台账 · runbook · reference
- [技术总览](docs/reference/overview.md) —— 系统架构与设计决策(⚠️ 含产品愿景,注意区分已实现/设想)
- [协议规范](docs/protocol/zh/) —— API 协议规范;先读[治理协议总览](docs/protocol/zh/governance.md)
- [规划](docs/planning/) —— [VERSION](docs/planning/VERSION.md)(封板线) · [BACKLOG](docs/planning/BACKLOG.md)(滚动待办) · [security](docs/planning/security.md) · [toFix](docs/planning/toFix.md)

---

## 项目结构

```
solo/
├── api/
│   ├── router/          # API 网关(主入口)
│   ├── library/         # 共享工具库(auth、entity、permit、jsonrpc、clock 等)
│   ├── core/             # 基础设施服务
│   │   ├── administrator/
│   │   ├── agent/
│   │   ├── gateway/
│   │   ├── ingress/
│   │   ├── mcp/
│   │   ├── notification/
│   │   ├── nexus/
│   │   ├── orchestrator/
│   │   └── user/
│   ├── apps/             # 通用的、与具体业务领域无关的应用
│   │   ├── approval/
│   │   ├── fulfillment/
│   │   ├── planner/
│   │   └── storage/
│   ├── sample/           # 新服务脚手架模板 —— 复制它来搭建第 15 个服务
│   └── autocheck/        # 静态 + 仿真质量门禁
├── portal/
│   ├── system/           # 管理后台
│   └── operator/         # 业务后台
├── client/
│   ├── mobile/           # 移动端
│   └── desktop/          # 桌面端(Tauri)
├── deploy/               # 开发脚本、构建、services.json(端口/服务的单一真源)
├── e2e/                  # 黑盒集成测试框架
└── docs/                 # 文档与协议规范
```

---

## 演进历程

比起罗列功能清单,这里更想讲清楚**每个阶段为什么发生**——驱动它的设计问题是什么。每个 tag 版本精确的改动 diff,见 [`CHANGELOG.md`](docs/planning/CHANGELOG.md)。

### v1.0 —— 框架雏形
最初的版本:Router API 网关、Entity Factory、工作流编排引擎、AI Agent 能力路由。定下了一条之后所有东西都要遵守的铁律:服务之间禁止直接互调——所有跨服务交互都经过 Router、走 JSON-RPC。

### v1.1.0 —— 从网关到 AI 自动化平台
设计问题:怎么让 AI Agent 能对事件做出反应、半自主地行动,同时又不丢掉人工监督?这一版加了 **nexus** 事件总线 + **Sentinel**(事件订阅式反应型 AI Agent),配一套声明式上下文装配 + autorun 闭环;新增 **ingress** 处理入站 webhook;storage 迁移到了可插拔的 OSS 供应商之后;**orchestrator** 有了第一道审批闸门(工作流必须先审核才能跑);**passport** 给外部用户一个隔离的身份(方法墙 + 行级隔离);还有一套质量门禁三件套——`autocheck` 静态审计、CI、e2e 测试框架——保证以上这些不会悄悄退化。

### v1.1.1 – v1.1.5 —— 让编排在故障下依然可信
一旦工作流可以无人值守地跑起来,真正的问题就来了:某一步跑到一半失败了,或者进程崩溃在执行中途,会怎样?这个阶段加了幂等键(避免重试或重投的步骤被二次执行)、同步的 Saga 式补偿(某一步失败时撤销已经成功的步骤)、崩溃安全的 checkpoint + 重试(卡住的 run 能续跑,而不是悄悄烂掉),以及一套脚手架契约包,让基于 SOLO 搭建的服务默认就继承这些保证。

### v1.1.6 – v1.1.8 —— 安全地向外部用户开放入口
设计问题:怎么让真实的外部用户能自助注册,又不会把每个内部 RPC 方法都变成意外对外暴露的公开 API?这个阶段上线了 passport OTP 自助发证、把公开方法面收窄了两轮(收敛到一个很小的、显式的白名单)、加了设备绑定的 session 升级——而且,因为一道安全边界的可信度取决于盯着它的测试有多可靠,这个阶段还清理掉了全量 e2e 套件里最后的 flaky 机制,让 CI 真正能当一道可信的门禁用。

### v1.1.9 – v1.1.10 —— 收敛架构缺口,扩展 AI 互操作性
一次结构性复盘一口气揪出了好几个"各自独立生长、现在互相不一致"的问题——没有失效机制的缓存、手工同步的两份 bot 权限图、两个不同的服务端口真源——都在同一个版本里修掉了。同时:一套最小可行的 **actor-claim** 机制补上了事件触发工作流里的"混淆代理"缺口(工作流可以要求:不只是执行的 bot,连**触发**这次执行的那个人也必须真的拥有对应权限);**MCP adapter** 把已审核通过的 orchestrator 工作流暴露成任何支持 MCP 协议的 AI 客户端都能调用的工具;ingress 边界新增了第二轮 prompt 注入检测;Saga 补偿变成了**持久化**的——能在 orchestrator 重启后正确续跑,而不只是在单次进程生命周期内有效。

### v1.1.10 之后(`main` 分支持续开发中)
后台 `_task` 分发现在会带退避重试,而不是一次性的、失败就静默丢弃的 fire-and-forget POST。orchestrator 工作流新增了独立于 delete 的 `deprecate`/`restore` 生命周期,让"退休一个已经在生产环境跑了很久的工作流"这件事,不再和"撤销一个从没被批准过的草稿"混为一谈,有了自己独立的审计轨迹。

---

## License(许可证)

[Apache License 2.0](LICENSE)。
