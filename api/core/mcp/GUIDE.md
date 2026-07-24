# mcp 服务任务配方

> 由 fleet-standard `guide` 方法下发（经 Router：`system.guide { service: "mcp" }`）。
> 与服务代码同目录、同 commit 更新。方法签名与参数约束以 `methods` 自省为准，
> 本文只讲自省说不出的**任务流程与语义**。

## 这是什么

MCP (Model Context Protocol) 适配器：把 orchestrator 里 `status:'ACTIVE'` 的
workflow 映射成 MCP tool，供外部 MCP 客户端发现和调用。它是一条**纯协议翻译**通路——
不做鉴权、不持有自己的服务身份，调用方自带的 bot session token 原样透传给 Router，
`checkAccess` 是唯一执行点。

**关键：真正的接口不在自省里。** `methods` 自省列出的 `ping`/`methods`/`entities`
只是 Router 面（`POST /jsonrpc`）的服务发现握手，对使用本服务毫无意义。实际工作全在
**另一条外部路由 `POST /mcp`** 上（标准 MCP JSON-RPC），它不经 Router 转发、由调用方
自带的 token 鉴权，所以刻意不在自省里声明——下面讲的就是它。

## 配方一：MCP 客户端接入（initialize → 发现 → 调用）

前置：拿到一个 bot session token（管理员经 `user.bot.create` + `user.bot.issue.token`
手工发证，一个窄 bot 对应一个外部消费方）。该 bot 的 permit 里**至少要有**
`orchestrator.workflow.list` + `orchestrator.workflow.run`，否则下面两步分别会被卡。
token 通过 HTTP 头 `Authorization: Bearer <token>` 携带。

所有请求都是标准 JSON-RPC 2.0，POST 到 `/mcp`：

1. **握手** `{"method":"initialize"}` → 返回 `{ protocolVersion:"2025-06-18",
   capabilities:{tools:{}}, serverInfo:{name:"solo-mcp-adapter", version} }`。
   握手**不需要 token**。随后可发一条 `{"method":"notifications/initialized"}`
   通知（无 id，服务端回 202 空体）。
2. **发现** `{"method":"tools/list"}`（需 Bearer token）→ `{ tools: [...] }`。
   每个 tool：`name` = workflow 的 id（调用时就传这个）、`description` = workflow 描述、
   `inputSchema` = 标准 JSON Schema（由 workflow 的 `input_schema` 转换而来）。
3. **调用** `{"method":"tools/call","params":{"name":"<workflowId>","arguments":{...}}}`
   （需 Bearer token）。`name` 即上一步的 tool 名（= workflowId），`arguments` 即 workflow
   的输入，会原样转发到 `orchestrator.workflow.run`。

## 配方二：读 tools/call 的返回

返回恒为 MCP tool result 形状：`{ content:[{type:"text", text:"<JSON 字符串>"}], isError }`。

- `isError:false` → `content[0].text` 是 workflow run 结果的 JSON 字符串，自行 `JSON.parse`。
- `isError:true` → 调用**语义失败但请求合法**：可能是 workflow run 返回
  `status:'failed'`（此时 text 是 `{error, failedStep}` 的 JSON），也可能是未知
  workflowId、checkAccess 拒绝、或 run 过程抛错（text 是错误消息）。
  **这些都不是 JSON-RPC 协议错误**——请求本身是好的，只是被点名的 tool 没跑成。
- 只有**请求本身畸形**（如 `tools/call` 漏了 `name`）才回 JSON-RPC 错误（-32602）。

## 坑与约定

- **只映射 ACTIVE workflow**：`PENDING_REVIEW`/`REJECTED`/`DEPRECATED`/`DELETED` 的
  不是可调用的 tool，不会出现在 `tools/list`。刚创建的 workflow 要先过 orchestrator
  的审核链变 ACTIVE 才可见。
- **无自有鉴权，全靠透传**：本 adapter 不校验 token、不做任何授权判断。你能 list/call
  什么，完全由你那个 bot 的 permit（Router `checkAccess`，方法级）决定。
- **无法按消费方过滤具体 workflow**：checkAccess 是方法级、非 workflow 实例级——
  任何 permit 含 `orchestrator.workflow.list` 的 bot 看到的都是**同一份**全量 ACTIVE 列表。
- `tools/list` 缺 token → 401；token 失效或无 `orchestrator.workflow.list` 权限 →
  502（上游 RelayError）。二者要分清：401 是没带，502 是带了但不通。
- **无分页游标**：`tools/list` 一次最多取 200 个 workflow（MVP），超出不翻页。
- **单请求/响应 HTTP**，不是 MCP 完整 spec 的 session/SSE streamable-HTTP 变体。
- 本服务满足不了你的任务时，把缺口提到 `system.report`（用法见 Router guide §6），
  不要静默放弃或绕野路子。
