# 立项：`core/agent` 本地/外部 AI 分层计量、跨箱归因与 `fulfillment` 单据级用量账本

> 来源：2026-11-16 本策多栈（`Catalog` / `Finance` / `Steward`）履约执行数据盘点——核查「能否从履约落地数据中直接统计本地与外部 AI 的调用次数与调用量」。
>
> **依据分三类**：
> - **源码核验（`solo` `v1.3.5`）**：
>   1. `api/core/agent/lib/tokenLogger.js:15-84`：`PRICING` 仅硬编码了 `gemini-*` / `qwen-vl-*` 与 `default`（`$0.10 / $0.30`），未识别 `provider === 'ollama'`，导致本地免费模型（`ollama/qwen3.5:9b`）被按 `default` 计入虚拟美金；同时 `AGENT:TOKEN:DAILY:YYYYMMDD` 将所有 `provider` 的 `calls` / `inputTokens` / `outputTokens` / `costUsd` 混加在同一组字段，无法区分「本地零成本算力」与「外部付费 API」；
>   2. `api/core/agent/lib/tokenLogger.js:56-70`：原始明细 `AGENT:TOKEN:LOG` 仅保留最新 1000 条（`LTRIM 0 999`），且未记录调用方 `uid`、`trace` 或关联 `fulfillmentId`；批处理密集时明细迅速滚动覆盖，事后无法归因到具体业务单据；
>   3. `api/core/agent/providers/solo-peer.js:65-184`：跨箱委托（如无 GPU 的 `BC002` 经 `solo-peer/ollama/qwen3.5:9b` 调 `catalog-mini`）在调用箱本地完全不写 `tokenLogger`，调用箱的 `agent.stats.*` 看不到本箱发起的跨箱 AI 调用量，而算力箱也只看到 peer M2M 账号，不知道上游对应的 `fulfillmentId`；
>   4. `api/library/entity.js:1235-1240` 与 `api/library/relay.js:248-253`：框架已具备 `walContext` + `X-Trace-Id` 链路透传底座，但尚未承载可选的 `fulfillmentId` / `profileId` 上下文，也未透传至 `library/peer-relay.js`。
> - **下游业务真实现场**：
>   - **标准 `agent.*` 路径**（`Catalog` 本地 Qwen 抠图/出图质检与挂起诊断、`Finance` 1688 税编归并与履约异常分诊哨兵）：全部已收敛走 `Router -> core/agent`，但因缺少 `fulfillmentId` 透传与本地/云端分桶，只能看机器级粗汇总，拉不出履约单级 Token 账单；
>   - **合法网关外异构路径**（L4 `connector` 与 RPA 会话生图，如 `Catalog` 经 Steward 操控终端 Codex / Runner 会话生图，或 Python 算子调多模态媒体接口）：有调用次数、产图张数或外部估算费用，但无标准入口汇入 `agent.stats.*` 统一观测。
> - **架构裁决**：属 `v1.3.x`「只加不破」可观测性补齐——在 `solo` 底座一次性打通**「本地/云端/跨箱/RPA 分层计量 + `X-Fulfillment-Id` 零侵入链路归因 + 外部异构调用补记入口」**，避免各业务仓各自在 `instance.meta` 手搓一套不兼容的 `aiUsage` 统计字段。

---

## 一、现状断层拆解

| 断层点 | 现状表现 | 造成的统计失真 |
| :--- | :--- | :--- |
| **1. 本地与外部混桶计费** | `tokenLogger.js` 对 `provider: 'ollama'` 套用 `PRICING.default`（`$0.10/M in, $0.30/M out`），且 `DAILY` Hash 不分 `local` / `cloud` | 本地 Mac mini 免费跑的百万级多模态质检 Token 被算成美金账单，且无法单独看「本地算力扛掉了多少调用 vs 外部 API 花了多少」 |
| **2. 跨箱 `solo-peer` 调用箱失明** | `SoloPeerProvider` 直接返回远端结果，不调本箱 `tokenLogger.log` | `Finance`（`BC002`）调了多少次 `solo-peer/ollama/qwen3.5:9b` 在 `BC002` 的 `agent.stats.*` 中为 `0` |
| **3. 履约单与 AI 调用断链** | `agent.*` 14 个方法入参无单据上下文，`AGENT:TOKEN:LOG` 无 `fulfillmentId` 且仅留 1000 条 | 无法查询「某张 `FL-xxx` 履约单（或某个 `profileId`）累计调了几次本地模型、几次外部模型、耗了多少 Token」 |
| **4. 网关外 AI 动作无标准补记口** | RPA 会话类 AI（如 Codex/Runner 会话改图，只有次数/张数无 API Token）及 L4 `connector` 媒体算子无法写入统一统计 | 履约全链路统计缺口，只能在业务仓私有字段里散装拼凑 |

---

## 二、目标规格（只加不破）

### 2.1 `tokenLogger` 分层计量与本地零成本修正（`api/core/agent/lib/tokenLogger.js`）

1. **修正计费单价与分层标识（`tier`）**：
   - 新增 `resolveTier(provider)`：
     - `provider === 'ollama'` $\rightarrow$ `tier = 'local'`，**固定 `costUsd = 0`**；
     - `provider === 'solo-peer'` $\rightarrow$ `tier = 'peer'`，本箱记调用次数与返回 `metadata.usage` 中的委托 Token 量，**本箱 `costUsd = 0`**（实际成本或本地零成本在算力提供箱记账，防跨箱双计费，同时保留调用箱的业务归因视图）；
     - `provider === 'rpa'`（经 `agent.stats.record` 上报的会话型 AI）$\rightarrow$ `tier = 'rpa'`；
     - 其余（`qwen` / `gemini` / `openai` / `bitexing` / `removebg` 等）$\rightarrow$ `tier = 'cloud'`。
   - 补齐常用文本模型参考单价（如 `qwen-plus`、`qwen-max`、`gpt-4o*` 等），并允许传入显式 `costUsd` 覆盖估算值（供外部已知账单成本的媒体算子直接写入）。

2. **日汇总与小时汇总按 `tier` 及 `provider` 拆分子计数器（100% 保留原顶层字段兼容旧面板）**：
   - 在 `AGENT:TOKEN:DAILY:YYYYMMDD` Hash 中保留原 `calls` / `inputTokens` / `outputTokens` / `costUsd`（其中 `costUsd` 不再混入 `ollama` 虚拟费用），并同步维护分层字段：
     - `tier:local:calls`、`tier:local:inputTokens`、`tier:local:outputTokens`
     - `tier:cloud:calls`、`tier:cloud:inputTokens`、`tier:cloud:outputTokens`、`tier:cloud:costUsd`
     - `tier:peer:calls`、`tier:peer:inputTokens`、`tier:peer:outputTokens`
     - `tier:rpa:calls`、`tier:rpa:images`
     - `provider:<provider>:calls`、`provider:<provider>:inputTokens`、`provider:<provider>:outputTokens`、`provider:<provider>:costUsd`
   - `agent.stats.token` 返回结构在保留 `{ daily, recent }` 原字段基础上，每条 `daily[i]` 附带结构化 `byTier: { local, cloud, peer, rpa }` 与 `byProvider` 字典。

3. **`SoloPeerProvider` 补齐调用箱本地记账（`api/core/agent/providers/solo-peer.js`）**：
   - 当远端 `peerRelay.call('agent.*', ...)` 返回后，从 `res.metadata?.usage` 提取 `{ inputTokens, outputTokens }`，在本箱调用 `tokenLogger.log({ method, model: downstreamModel, provider: 'solo-peer', inputTokens, outputTokens, costUsd: 0 })`，使调用箱自身即可统计跨箱 AI 依赖度与关联履约单消耗。

---

### 2.2 基于 `walContext` + HTTP Header 的零侵入 `fulfillmentId` 归因链路

为避免修改 14 个 `agent.*` 业务方法的 JSON-RPC `params` Schema（不破坏 `additionalProperties: false` 门禁），复用现有 `X-Trace-Id` 同构通道：

1. **请求头与上下文扩展（`api/router/`、`api/library/entity.js`、`api/library/relay.js`、`api/library/peer-relay.js`）**：
   - 定义标准内部透传头：`X-Fulfillment-Id`（匹配 `/^[A-Za-z0-9_:-]{1,64}$/`）与可选 `X-Fulfillment-Profile`（匹配 `/^[A-Za-z0-9_.-]{1,64}$/`），仅对已鉴权请求采信并清洗控制字符；
   - `requestContext(req)` 自动提取 `fulfillmentId`、`profileId` 与 `callerUid: req?.user || null` 存入 `walContext`；
   - `relay.call(method, params, opts)` 与 `peerRelay.call(method, params, opts)`：
     - 支持第 3 参数可选传入 `{ fulfillmentId, profileId }`；
     - 若未显式传，自动从当前 `walContext.getStore()` 继承并附加 `X-Fulfillment-Id` / `X-Fulfillment-Profile` 请求头（跨服务、跨 SOLO 箱一跳透传）。

2. **框架原生触发点自动染色（零业务代码改动即可覆盖事件/动作驱动路径）**：
   - `apps/fulfillment` 在发射 `_tasks` 与 `peer_rpc_with_callback` 时，自动在上下文/请求头携带当前 `instance.id` 与 `instance.profileId`；
   - `core/nexus` Sentinel 在消费 `EVENT:FULFILLMENT:TRANSITIONED`（或 payload 含 `instanceId` / `id` 且 `profileId` 存在）调 `agent.decide` 时，自动在 `relay.call` 注入对应的 `fulfillmentId` 与 `profileId`。

3. **履约单级与模板级聚合存储**：
   - 当 `tokenLogger.log` 检测到上下文中存在合法 `fulfillmentId` 时（同时存入 `AGENT:TOKEN:LOG` 明细项）：
     - 原子累加 `AGENT:TOKEN:FULFILLMENT:<fulfillmentId>`（Hash，TTL `90d`）：维护 `totalCalls`、`localCalls`、`localInputTokens`、`localOutputTokens`、`cloudCalls`、`cloudInputTokens`、`cloudOutputTokens`、`peerCalls`、`peerInputTokens`、`peerOutputTokens`、`rpaCalls`、`images`、`costUsd`、`profileId`、`updatedAt` 及按 `model:<cleanModel>:calls` / `tokens` 细分；
     - 若存在 `profileId`，同步累加日维度模板桶 `AGENT:TOKEN:PROFILE:YYYYMMDD:<profileId>`（TTL `90d`），便于直接看「视觉履约 vs 税票履约 vs 双 ERP 同步」各自的 AI 消耗占比。

---

### 2.3 新增标准查询与异构补记 RPC（严格遵守全小写点分命名与 `autocheck` 门禁）

在 `api/core/agent/index.js` 与 `handlers/introspection.js` 新增 2 个管理/内部方法（均设 `ai: false`）：

1. **`agent.stats.fulfillment`**（查询单张或批量履约单的 AI 调用汇总，以及按 `profileId` 的日汇总）：
   - 入参：`{ id?: string, ids?: string[], profile?: string, days?: number }`（`ids` 上限 100）；
   - 返回：对应履约单的分层统计对象 `{ id, profileId, totalCalls, costUsd, tiers: { local, cloud, peer, rpa }, models: {...}, updatedAt }`（无记录时返回全 0 结构而非报错，方便前端列表批量左连接展示）。

2. **`agent.stats.record`**（供本栈受信内部服务如 `connector` 补记未经过 `core/agent` LLM 网关的异构 AI / RPA 会话调用）：
   - 权限：仅限 admin 或显式授权的内部服务 bot（`permit` 门禁，`ai: false`）；
   - 入参：
     ```json
     {
       "provider": "codex-rpa | gemini | dashscope | apple-vision",
       "model": "codex-image-gen",
       "tier": "rpa | cloud | local",
       "method": "connector.image.auto",
       "calls": 1,
       "inputTokens": 0,
       "outputTokens": 0,
       "images": 1,
       "costUsd": 0,
       "fulfillmentId": "FL-20261116-0001",
       "profileId": "catalog_visual_automation",
       "idempotencyKey": "connjob-xxx-route-0"
     }
     ```
   - 行为：按 `idempotencyKey`（`SET NX EX 86400`）防重入后，统一写入 `tokenLogger` 的日表、小时表与 `AGENT:TOKEN:FULFILLMENT:<fulfillmentId>`，使 API 大模型、本地 Ollama、云端生图脚本与 RPA 会话型 AI 在同一套 `agent.stats.*` 账本中闭环。

---

## 三、边界说明：哪些在 `solo` 一次搞定，哪些需下游升级后顺手接一行？

1. **`solo` 升级后零业务改代码即生效的部分**：
   - 全局 `agent.stats.token` 自动拆出本地（`local`，`$0`）与外部云端（`cloud`）及跨箱委托（`peer`）的调用次数和 Token 量；
   - `SoloPeerProvider` 调用箱（如 `Finance` `BC002`）自动拥有本箱发起的跨箱 AI 调用账本；
   - 经 `fulfillment` `_tasks` 或 `nexus` Sentinel 自动触发的 `agent.decide` / `agent.*` 自动挂上 `fulfillmentId`。
2. **下游业务仓升级 `solo` bundle 后的极简配合项**：
   - 若业务代码是在异步 Worker 子进程（脱离了原 HTTP 请求 `walContext`，如 `catalog` 的 `connector` worker）里调 `agent.*`，只需在 `peerRelay.call('agent.image.parse', params, { fulfillmentId })` 第 3 参数把单号传进去；
   - 对于完全不走 `core/agent` 的外部生图脚本或 RPA 会话（如 `catalog` 的 `gen-hero-image.py` 与 `codex-image-gen`），在 `connector` 任务收口处调一次 `agent.stats.record` 即可并入总账。

---

## 四、验收门禁（Hermetic 测试与 Autocheck）

1. 先写回归单测跑红再实现：
   - 验证 `OllamaProvider` 记账 `tier === 'local'` 且 `costUsd === 0`，不污染 `tier:cloud:costUsd`；
   - 验证 `SoloPeerProvider` 在调用箱写入 `tier === 'peer'` 用量且通过 `X-Fulfillment-Id` 将单号传至远端算力箱；
   - 验证 `relay.call` 在 `walContext` 含 `fulfillmentId` 时自动透传请求头，且 `agent.stats.fulfillment({ ids })` 精确返回各单 `local` / `cloud` / `rpa` 次数与 Token；
   - 验证 `agent.stats.record` 的 `idempotencyKey` 幂等防重与非授权账号 `-32003` 拒绝。
2. 通过 `node api/autocheck/checker.js api/core/agent --static`（确保新增 RPC 命名全小写点分、`introspection.js` 与 `index.js` 100% 对齐、`Failed: 0`）。

---

## 五、处理结论（2026-11-24）

已按方案 A 完成全链路落地（只加不破，100% 向后兼容）：

1. **`tokenLogger` 分层计量与本地零成本修正**（[`api/core/agent/lib/tokenLogger.js`](../../api/core/agent/lib/tokenLogger.js)）：
   - 实现 `resolveTier(provider, explicitTier)`：`ollama`/`local`/`apple-vision` → `local`（`costUsd = 0`），`solo-peer` → `peer`（调用箱 `costUsd = 0`，防跨箱双计费），`rpa`/`*-rpa` → `rpa`，其余云端模型 → `cloud`；支持显式 `costUsd` 覆盖并补齐常用模型参考单价。
   - `AGENT:TOKEN:DAILY:YYYYMMDD` 保留原顶层字段并在 `daily()` 返回中新增 `byTier` 与 `byProvider`；`AGENT:TOKEN:LOG` 明细记录 `tier`、`uid`、`trace`、`fulfillmentId`、`profileId`。
   - [`SoloPeerProvider`](../../api/core/agent/providers/solo-peer.js) 补齐调用箱本地 `tier = 'peer'` 记账。
2. **`X-Fulfillment-Id` / `X-Fulfillment-Profile` 零侵入防伪透传与自动染色**：
   - [`api/router/handlers/trace.js`](../../api/router/handlers/trace.js)、[`index.js`](../../api/router/index.js)、[`forward.js`](../../api/router/handlers/forward.js)、[`tasks.js`](../../api/router/handlers/tasks.js)：仅对已鉴权调用方按严格正则采信 `X-Fulfillment-Id` / `X-Fulfillment-Profile`，签入 `X-Router-Token.meta` 并在 `_tasks` 派发中延续。
   - [`api/library/entity.js`](../../api/library/entity.js)（`requestContext`）、[`relay.js`](../../api/library/relay.js)、[`peer-relay.js`](../../api/library/peer-relay.js)：支持从 `walContext` 自动继承及第 3 参数 `{ fulfillmentId, profileId }` 显式传入，本箱与跨箱一跳透传。
   - [`api/apps/fulfillment/logic/instance.js`](../../api/apps/fulfillment/logic/instance.js)（`_tasks` 与 `peer_rpc_with_callback`）及 [`api/core/nexus/logic/stream.js`](../../api/core/nexus/logic/stream.js)（Sentinel 消费 `EVENT:FULFILLMENT:*`）自动注入 `fulfillmentId` 与 `profileId`。
3. **新增标准查询与异构补记 RPC**（[`api/core/agent/index.js`](../../api/core/agent/index.js)、[`introspection.js`](../../api/core/agent/handlers/introspection.js)）：
   - 新增 `agent.stats.fulfillment`（单查 `id` / 批查 `ids` ≤ 100 / 按 `profile` 日聚合，90d TTL，缺失单据返回全 0 结构）；
   - 新增 `agent.stats.record`（`SET NX EX 86400` 幂等防重，服务层校验 admin / `system.*` / `bot.*` 身份，非授权调用方返回 `-32003`）。
4. **测试与门禁**：新增 [`api/tests/unit/agent-fulfillment-metering.test.js`](../../api/tests/unit/agent-fulfillment-metering.test.js)，并通过 `autocheck`、`precheck.sh`、`check-doc-drift.js`、`check-error-codes.js` 与 `check-upgrade-path.sh`。
