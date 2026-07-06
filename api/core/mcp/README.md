# MCP Adapter

> **状态**：已实现（workflow-first MVP，2026-07-03）。见 `deploy/services.json`，端口 8091；决策与范围记录在 `docs/planning/v1-implementation-plan.md` P4"MCP adapter"小节。
> **定位**：core 层服务，外部 MCP (Model Context Protocol) 客户端的协议适配层。与 `gateway`/`ingress` 一样是"外挂客户端"——对 Router 而言只是又一个 JSON-RPC 调用方，不参与 Router 内部逻辑。

## 一句话

`POST /mcp` 把 orchestrator 里 `status:'ACTIVE'` 的 workflow 映射成 MCP tool（`tools/list`），`tools/call` 转发到 `orchestrator.workflow.run`。这是一条纯粹的**协议翻译**通路：不做鉴权、不持有自己的服务身份，外部调用方自带的 bot session token 原样透传给 Router，`checkAccess` 是唯一执行点。

```
外部 MCP 客户端                 (自带 bot session token，出自 user.bot.issue.token)
   │  POST /mcp
   │  Authorization: Bearer <bot-token>
   │  {"jsonrpc":"2.0","id":1,"method":"tools/list"}
   ▼
mcp adapter (本服务，端口 8091)
   ① 从 Authorization 头取 token，原样透传，不做本地校验
   ② relay.callAs(token, 'orchestrator.workflow.list' | 'orchestrator.workflow.run', params)
   ▼
Router (checkAccess 用该 bot 的 permit 卡关) → orchestrator
```

## 鉴权模型

每个外部 MCP 消费方对应**一个窄 bot 账号**（`user.bot.create` + `user.bot.issue.token`，管理员手工发证），`permit` 显式枚举允许调用的方法（至少要有 `orchestrator.workflow.list` + `orchestrator.workflow.run` 才能用起来）。本服务自身**从不**调用 `relay.call()`/`relay.setToken()`——它没有、也不需要自己的服务身份，`relay.callAs()` 是唯一用到的原语（与 nexus 给每个 Sentinel 发独立 bot 身份是同一套机制，见 `library/relay.js` 的 `callAs` 注释）。

## 已知边界（MVP 范围，非缺陷）

- **只接了 workflow 这一条数据源**。其余服务的 RPC 方法（"能力表"）没有汇入 `tools/list`——规划中提到"能力表也走同一个 MCP 出口"，但这轮没做，后续可加。
- **`tools/list` 无法按消费方过滤具体能看到哪些 workflow**：Router `checkAccess` 是方法级而非 workflow 实例级，一个 bot 只要 permit 里有 `orchestrator.workflow.list`，看到的就是全部 ACTIVE workflow（是否被允许*调用*某个具体 workflow，仍由该 bot 有没有 `orchestrator.workflow.run` 权限决定，但那也是方法级的，不是按 workflowId 细分的）。
- **传输层是最简单的单请求/响应 HTTP POST**，不是 MCP 完整 spec 里的 session/SSE streamable-HTTP 变体。
- **消费方发证是手工的**（`user.bot.create` 由管理员操作）；如果以后消费方要动态自助接入，会撞上 `nexus bot 自动发证` 那个已知的手工瓶颈（见 `v1-implementation-plan.md` P5）。

## 方法面

- 外部面（`POST /mcp`，不经 Router 转发，调用方自带 token）：`initialize` / `tools/list` / `tools/call` / `notifications/initialized`。
- Router 面（`POST /jsonrpc`，标准 SOLO 服务发现握手）：`ping` / `methods` / `entities` / `events`——本服务无持久化实体、不产生/订阅事件，这几个方法只是保持与其余 13 个服务一致的可发现性。

## 测试

`tests/tools.test.js`——`logic/tools.js` 的 hermetic 单测（schema 转换、`isError` 分支），已加入 `api/jest.ci.config.js`。跑法同其余服务：`cd api && npx jest -c jest.ci.config.js --testPathPatterns core/mcp`。
