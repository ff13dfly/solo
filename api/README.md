# API — 后端微服务

> [!WARNING]
> **本文件曾列出大量不存在的服务**——commodity / supply / erp / authority / sale / crm / asset / production / academy / b2b / space / dingtalk / wecom **代码里都不存在**（是产品愿景，不是已部署服务）。
> **唯一权威的真实服务清单（13 个）以 [`CLAUDE.md`](../CLAUDE.md) §2 为准**，并由 `deploy/check-doc-drift.js`(CI) 守护与 `deploy/services.json` 一致。端口也以 services.json 为准。下方表格已据此修正，但若与 CLAUDE.md §2 / services.json 冲突，**以后者为准**。

架构原则与设计决策见 [CLAUDE.md](../CLAUDE.md)。本文件只覆盖"怎么跑、怎么找"。

---

## 目录结构

```
api/
├── core/          # 基础设施服务（稳定，少改动）
├── apps/          # 业务微服务（快速迭代）
├── monolith-entry.js   # 本地一键启动所有服务
└── sample/        # 新服务模板
```

---

## 启动

**本地全栈（推荐）**
```bash
cd api
node monolith-entry.js
```
通过 `child_process.fork` 将所有微服务合并在一个进程树下启动。

**单独启动某个服务**
```bash
cd api/apps/storage   # 或 api/router
node index.js
```

**新增服务**：复制 `api/sample/` 目录，修改服务名和端口，在 `monolith-entry.js` 注册即可。

---

## Core 服务

| 服务 | 端口 | 说明 |
|------|------|------|
| [router](router) | 8600 | 统一 API 网关，鉴权 + 路由转发 |
| [administrator](core/administrator) | 8680 | 系统后台 / 单管理员模型 |
| [user](core/user) | 8710 | 账号 / Session / Permit（SHA-256 挑战-响应，**非** Ed25519） |
| [agent](core/agent) | 8730 | AI 大模型中枢（Gemini / Qwen / OpenAI） |
| [nexus](core/nexus) | 8740 | agent 路由 + 事件总线发端 + 时间驱动 scheduler |
| [notification](core/notification) | 8040 | 通知投递 worker（退避重试 + 死信队列） |
| [gateway](core/gateway) | 8020 | 外部通道出站适配（邮件 / 短信等） |
| [ingress](core/ingress) | 8070 | 外部 webhook 入站适配器（API key 鉴权 + 去重） |
| [orchestrator](core/orchestrator) | 8820 | 工作流模板 CRUD + 执行 |

---

## Apps 服务

| 服务 | 端口 | 说明 | 文档 |
|------|------|------|------|
| storage | 8750 | 文件 CAS 存储（SHA-256 去重） | [README](apps/storage/README.md) |
| fulfillment | 8050 | 声明式状态机履约引擎（JsonLogic） | [IMPL](apps/fulfillment/docs/IMPLEMENTATION.md) |
| planner | 8030 | 日程 + 待办 | [README](apps/planner/README.md) |
| approval | 8060 | SAP 审批协议（MVP） | [README](apps/approval/README.md) |

> **dev-only fixtures**：`apps/collection`(8055) 与 `apps/market`(8056) 仅在 `deploy/services.dev.json` 中注册，**不是生产服务**，不在上表/生产清单内。

无独立 README 的服务，见各自 `index.js` 顶部注释或 `logic/` 目录。

---

## 端口约定

> ⚠️ 实际端口**不按整齐区段分配**（既有 80xx 也有 86xx/87xx/88xx），core/apps 端口段交错。**每个服务的权威端口以 `deploy/services.json` 为准**，下表仅作粗略参考。

| 范围 | 用途 |
|------|------|
| 8020–8820 | 后端微服务（core + apps，段内交错，见 services.json） |
| 9200–9900 | 前端 Client / Portal（开发） |
