# SOLO

> **S**wift(敏捷) · **O**rchestrated(编排) · **L**earning(学习) · **O**bjects(对象)

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

一共 所有服务声明在 [`deploy/services.json`](deploy/services.json) —— **它是唯一真源**，
「有哪些服务、各在哪个端口」以它为准，CI 拿它校验其余所有文档。别读副本，现查：

```bash
node -e "console.log(require('./deploy/services.json').map(s => s.name + ':' + s.port).join('\n'))"
```

**网关** —— `router`，系统唯一入口：鉴权、JSON-RPC 路由、Ed25519 签名转发、`_tasks` 异步分发、
方法级权限校验。

**Core** —— 每个系统都要的基础设施：出站通道（`gateway`）与入站 webhook（`ingress`）、
账号与权限（`user`）、AI 能力路由（`agent`）、事件总线及其反应体（`nexus`）、
带审核闸的工作流模板（`orchestrator`）、带重试与死信的投递（`notification`）、
MCP 互操作（`mcp`）、系统后台（`administrator`）。

**Apps** —— 与业务域无关的通用积木：`planner`、`fulfillment`（声明式状态机）、
`approval`、`storage`（内容寻址）。

### 客户端

- **Portal System** / **Portal Operator** —— 系统后台与运营台。operator 以源码交付：
  下发一次，**框架升级永不覆盖**，随你改。
- **Mobile** —— 跨平台移动端。**Desktop** —— Tauri 桌面端。
- **浏览器插件** —— [`client/extension-kit/`](client/extension-kit/) 是框架侧半边
  （带退避的传输、**熬得过 MV3 service worker 回收的持久发送队列**、图片规格化、会话处理），
  外加一个可直接加载的 sample。你自己的扩展住 `client/extension/`，永不被覆盖
  ——与 `api/library` 和 `api/apps` 是同一条边界。

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
├── api/         Router · 共享库 · core + apps 服务 · 新服务脚手架 · 质量门禁
├── portal/      系统后台与运营台
├── client/      移动端 · 桌面端 · 浏览器插件 kit
├── deploy/      开发脚本、构建、项目脚手架、services.json（端口/服务的真源）
├── e2e/         黑盒集成测试
└── docs/        协议规格、规划台账、runbook
```

**服务目录刻意不在这里逐个列**——它们会变，而 `deploy/services.json` 已经写着。
要写第 15 个服务，拷 [`api/sample/`](api/sample/)。

---

## 发布

每个 tag 在 [`CHANGELOG`](docs/planning/CHANGELOG.md) 里都有一条，写明这一版带来什么、
下游要不要做什么。**历史不在这里重复一遍**——手工维护的副本必然变旧：

```bash
git tag | sort -V | tail -5          # 最近几个发布点
git describe --tags --abbrev=0       # 当前
```

开发走 trunk + tags：`main` 保持向后兼容（不删方法、不缩公开面、library API 只加签名），
破坏性改动一律攒去 v2。见 [`docs/runbook/release-and-branching.md`](docs/runbook/release-and-branching.md)。

---

## License(许可证)

[Apache License 2.0](LICENSE)。
