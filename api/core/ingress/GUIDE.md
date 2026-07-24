# ingress 服务任务配方

> 由 fleet-standard `guide` 方法下发（经 Router：`system.guide { service: "ingress" }`）。
> 与服务代码同目录、同 commit 更新。方法签名与参数约束以 `methods` 自省为准，
> 本文只讲自省说不出的**任务流程与语义**。

## 这是什么

外部 webhook 的**入站**中央控制面（与 gateway 出站镜像）。哑管道：只做 API key 识源 +
去重 + 基本结构校验，然后经 Router `event.emit` 发出 `EVENT:WEBHOOK:{源}` 事件。**不解释
领域内容**——「这条 webhook 该触发什么」是下游消费者的事。

**两类调用者，别混：**
- **管理端（admin）**：注册/启停源、发 API key、看审计、处理复核队列。全部 admin-only RPC。
- **外部 listener（public）**：带源的 API key 把归一化 JSON 投进来。只有 `ingress.ingest` 一个方法，免 session。

## 配方一：配置一个入站源（管理端，拿一次性 API key + stream 名）

1. `ingress.source.create { name, dedupTtlSec?, dataSchema? }`
   - `name`：唯一，`^[a-zA-Z0-9_-]{1,64}$`。它决定下游 stream 名 = `EVENT:WEBHOOK:{NAME 大写}`。
   - `dedupTtlSec`：去重窗口秒数，不传默认 **86400（24h）**——要能覆盖外部系统的最大重试窗口。
   - 返回里带 `apiKey`（明文）和 `stream`。**`apiKey` 只在这一次（和 rotate 时）回显，之后永不返回**（只存 SHA-256）。
2. 把 `apiKey` 带外交给对应 listener；把 `stream` 记下来给下游订阅方。
3. key 丢了 → `ingress.source.key.rotate { id }` 拿新 key（旧 key 立即失效），不是重建源。

## 配方二：外部 listener 投递一条 webhook（去重 → 发事件）

listener（每个外部对接独立开发，吸收各家格式/验签、归一化）经 **Router** 调：
```
POST {Router}/jsonrpc   { "method":"ingress.ingest", "params":{ "request_id", "data" } }
Authorization: ApiKey <该源的 key>     ← 走头，不进 RPC params，也不落 Router 审计日志
```
- **`request_id` = 幂等键，必须在同一外部事件的多次重投间保持稳定**（如 GitHub `X-GitHub-Delivery`、
  Stripe `evt_xxx`，或 listener 自生成的 UUID）。去重键 = `(源, request_id)`，窗口内重复直接短路。
- **来源不由 listener 自报**——由 API key 反查（防伪造来源）；`data` 原样透传，ingress 不裁剪不解释。
- 接受路径发出 `EVENT:WEBHOOK:{源}`，`type: "webhook.received"`，`actor: "webhook:{源}"`，
  `payload: { request_id, data }`。
- 返回是 6 条路径的联合，**只有 `ok` 恒有**：接受 `{ok:true, stream, request_id}`；
  重复 `{ok:true, duplicate:true, request_id}`（不再发事件）；拒绝 `{ok:false, error}`
  （无效 key / 源停用 / 结构非法 / dataSchema 违规——违规额外带 `violations`）。

## 配方三：下游消费（这条链的终点）

下游服务/workflow（如 nexus sentinel、orchestrator）订阅 `EVENT:WEBHOOK:{源}`，**自己**解析
`data`、做领域分类与后继路由。ingress 一律发通用 `webhook.received`，不替下游决策。订阅用的
stream 名从配方一的 `create`/`get` 返回里取，别自己拼错大小写。

## 配方四（可选）：dataSchema 白名单 + 人工复核

源可 opt-in `dataSchema`（checkParams 扁平方言，`create`/`update` 传；传 `[]`/`null` 清除、回到不透明透传）。
一旦配置，凡**未声明的字段 / 声明字段类型或 pattern 不符 / string 字段命中注入启发式扫描**，
**整条投递**被扣进有界复核队列（返回 422），并给 ops 发通知——不是只丢坏字段，也不静默丢弃。
管理端用 `ingress.review.list` / `ingress.review.approve`（原样发出，绕过 schema，人即是检查）/
`ingress.review.discard`（永不发出）处理。

## 坑与约定

- **API key 只存 SHA-256，创建/轮换各回显一次**。丢了只能 rotate，无法找回。
- **`request_id` 不稳定 = 去重失效**（同一事件被当新投递重复发到下游）；窗口太短同理，重试跨窗会漏去重。
- **改源 `name` 会改 stream 名**（`EVENT:WEBHOOK:{NAME 大写}`），下游订阅会断——改名等于换 stream。
- `disable` 只挡入站（该源 `ingest` 返 403），**下游/已发事件无感**；源是真删（无软删回收站）。
- 入站**必须过 Router**（`ingress.ingest` 是 public 方法），别直连 ingress:8070；key 走 `Authorization` 头。
- `ingress.source.test { id, data }` 发合成事件用于连线自检，**跳过去重 + dataSchema + 审计**，别拿它验去重。
- 源上的 `hitCount`/`dupCount`/`rejectCount` 计数可观测；`rejectCount` 持续上涨 = 发送方配错或有敌意。
