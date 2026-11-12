# 立项：外联四层边界收敛、`core/agent` 原生 Ollama / 跨箱算力委托与 `peer-relay` 底座上收

> 来源：2026-11-12 五栈（`Solo` / `Catalog` / `Finance` / `Steward` / `Solar`）外联方式全量盘点与 `catalog-mini` 本地模型（Ollama `qwen3.5:9b`）旁路复盘。
>
> **依据分三类**：
> - **线上实查与旁路现场（2026-11-12）**：
>   1. `catalog-mini`（Apple M6 24GB）上的 `ollama` 进程实查为 `TCP *:11434 (LISTEN)` 全网口无鉴权裸奔（暴露在局域网 `192.168.1.159:11434` 与 Tailscale `100.68.103.124:11434`），未收口在 `127.0.0.1` 与 SOLO Router 网关之后；
>   2. 现网 4 条调用本地 `qwen3.5:9b` 的路径全部存在直连 `:11434` 旁路：`Finance` 履约哨兵在业务服务 `company` 内私挂协议转换桥 `adaptor/ollama-bridge.js` 再跨网连 `:11434`、`Finance` 税收编码归并在 `adaptor/ai.js` 裸 `fetch` `:11434`、`Catalog` 在 `connector/workers/{apple-native,image-harness}.js` 及 `deploy/pg/enrich-sku-*.js` 直连 `:11434`、开发机 `mcp-local-qwen.mjs` 直连 `:11434`；
>   3. 跨 SOLO 箱业务 RPC（`Finance ⇄ Steward`、`Catalog ⇄ Steward`）在各业务仓各自手写一份 `fetch('/jsonrpc')` 与 24h Token 续期逻辑（`finance/api/apps/company/adaptor/steward.js`、`catalog/api/apps/connector/workers/lib/solo-client.js`）。
> - **源码核对**：
>   - `api/core/agent/providers/index.js:32-38`（模型名前缀路由）与 `api/core/agent/providers/openai.js:113,166,192`（硬编码 `response_format: { type: 'json_object' }`）；
>   - `api/core/gateway/{index.js,README.md}` 与 `docs/planning/gateway-gaps.md`（通道职责边界及 G19 `rmbg.js` 越界记录）；
>   - `api/library/{ssrf,relay}.js` 对照 `steward/api/apps/steward/logic/outbound-client.js` 与 `catalog/api/apps/connector/index.js`。
> - **判断与规划**：厘清 SOLO 与业务箱的外联四层边界，属 `v1.3.x → v1.4`「只加不破」收敛项——下三层通用通信/算力/安全传输收归 SOLO，最上层垂直行业 API 留各业务箱 `connector`，彻底拔除 `:11434` 裸连与业务内私搭转换桥。

---

## 一、根因复盘：为什么本地模型与跨箱外联会滑向旁路？

### 1.1 `core/agent` 缺原生 `ollama` Provider，且 `qwen*` 前缀路由直接撞车
在 `Finance` 接入履约异常分诊哨兵（`nexus.sentinel` → `agent.decide`）与 `Catalog` 接入多模态底图 QC 时，连续撞上 `api/core/agent` 的三处硬限制：
1. **模型名前缀误路由**：`api/core/agent/providers/index.js:33` 硬编码了 `if (model.startsWith('qwen')) type = 'qwen'`。只要传入本地模型真名 `qwen3.5:9b`，就会被强制送进阿里云百炼 `QwenProvider`（打公网 DashScope），根本走不到本地节点；
2. **`OpenAIProvider` 与 Ollama MLX 结构化输出不兼容**：为绕开前缀拦截改传 `openai/qwen3.5:9b` 借道 `OpenAIProvider` 后，`providers/openai.js:192` 在 `decide()` 中写死了 `response_format: { type: 'json_object' }`，而 macOS Apple Silicon 上的 Ollama `0.40.x`（MLX 后端）收到该字段直接返回 **`HTTP 501 ("structured output is unavailable")`**；
3. **`think` 模式与长上下文不可控**：`qwen3.5:9b` 在 Ollama 中默认开启思考链（`think: true`），单次 `decide` 耗时高达 35～49 秒，导致哨兵超时；必须显式传 `think: false`（耗时降至 ~2.2 秒）与 `keep_alive: '30m'`，而 `OpenAIProvider` 无此通道。

正是这三处卡点，逼着下游在 `finance/api/apps/company` 业务进程里临时挂了一个 `/internal/ollama-v1/chat/completions` 转换桥（剥掉 `openai/` 前缀、删掉 `response_format`、注入 `think: false`、裁剪冗余 trace），其它脚本则干脆直接裸 `fetch('http://100.68.103.124:11434/api/chat')`。

### 1.2 多箱共享一台本地 GPU 时，`core/agent` 缺「跨箱算力委托」原语
本策真实生产拓扑是：**只有 `catalog-mini` 一台 Mac mini 具备 M6 24GB 统一内存跑本地大模型**，而 `BC002`（Finance）与 `BC001`（Steward）是另外两台独立 Debian 主机上的独立 SOLO 箱。
- 由于 `BC002` 本箱的 `core/agent` 不支持将模型调用经 SOLO 标准网关委托给 `catalog-mini` 箱的 `Router -> core/agent`，`catalog-mini` 被迫将 `ollama` 绑定为 `*:11434` 对内网敞开；
- 一旦 `:11434` 敞开，所有跨机调用全部绕过了 `catalog-mini` 的 SOLO Router 鉴权、方法级 `permit`、速率限制与 `agent.stats.token` 审计台账。

### 1.3 `gateway` 命名宽泛导致职责误判，且跨箱 RPC / 安全出站底座未下沉
- **命名误导**：SOLO 里真正的 API 总网关是 `router`，AI 算力网关是 `agent`，而 `core/gateway` 实际是**出站消息与通知通道服务（SMTP / IMAP / SMS / Webhook）**。因名字叫 `gateway`，历史上曾把抠图 `logic/rmbg.js` 误塞进去（已记 `gateway-gaps.md` G19），下游新建业务连接器时也得专门避名（见 `catalog/api/apps/connector/index.js:30`）。
- **底座分散**：`library/ssrf.js` 已有静态私网段与单次 `assertPublicHostname`，但「手动拦截每一跳 30x 重定向复验 IP、Socket 连接级防 DNS Rebinding TOCTOU、受信 Tailnet 网关域名+IP 成对白名单、流式响应字节上限」仍只存在于 `steward/logic/outbound-client.js`；跨 SOLO 箱互调客户端也在各业务仓重复手写。

---

## 二、架构边界裁决：`gateway` 划分在 SOLO 合理吗？

**裁决结论：下三层（无行业语义的传输底座、通用通知通道、统一 AI 算力网关）划分在 SOLO 完全合理且必须收紧；最上层（垂直行业协议与宿主机专有硬件算子）绝不能进 SOLO `core/gateway`，统一留各业务箱自建 `apps/connector`。**

全栈外联统一收敛为以下四层架构：

| 层级 | 归属仓库 | 模块 / 服务 | 职责边界（管什么 / 不管什么） |
| :--- | :--- | :--- | :--- |
| **L1 安全传输与跨箱底座** | **`solo` (`api/library/`)** | `ssrf.js` · `outbound.js` · `peer-relay.js` | **纯传输与跨 SOLO 箱协议**：DNS 二次解析防重绑定、逐跳重定向 IP 复验、流式包体上限、受信内网网关白名单；跨 SOLO 箱 `/jsonrpc` 鉴权、24h Token 自动预刷新、`idempotencyKey` 与 `meta.hop` 透传。不碰任何业务格式。 |
| **L2 通用通信哑管道** | **`solo` (`api/core/`)** | `gateway`（出站）+ `ingress`（入站） | **标准通信通道**：SMTP / Resend 邮件、阿里云 / Twilio 短信、IMAP 收信轮询、跨箱/外部标准 Webhook 信封，配套 AES 凭据加密、幂等锁与投递台账（`gateway.delivery.*`）。**严禁塞入行业 ERP 接口或图像/业务算子**（存量 `gateway.rmbg.cutout` 冻结弃用）。 |
| **L3 统一 AI 算力网关** | **`solo` (`api/core/`)** | `agent`（经 `router` 暴露） | **云端 + 本地大模型唯一中枢**：统一纳管 DashScope Qwen、Gemini、OpenAI、**本机 Ollama（`ollama/*`）** 以及 **跨箱远端 SOLO Agent 委托（`solo-peer/*`）**；统一收敛 Prompt 安全围栏、JSON 契约校验与 `tokenLogger` 计量。业务服务零 LLM Key、零裸连 `:11434`。 |
| **L4 垂直行业连接器** | **各业务仓 (`api/apps/`)** | `connector`（参照 `catalog` 范式） | **带领域协议与计费规则的外部集成**：聚水潭/吉客云双 ERP 签名接口、电子税务局/工商核验 API、物流轨迹、macOS Vision 原生 Swift 算子等；管能力级并发闸门（`maxRunning`）、业务键去重（`keyOf`）与外部调用成本账单（`cost`），底层复用 L1 `library/outbound.js`。 |

---

## 三、目标规格（只加不破，四项具体演进）

### 3.1 `core/agent` 新增原生 `OllamaProvider`（`providers/ollama.js`）
1. **显式前缀优先路由（修复 `providers/index.js`）**：
   - 优先匹配显式命名空间前缀：`ollama/<model>` 或 `ollama:<model>` → `OllamaProvider`（剥离前缀后将真实模型名如 `qwen3.5:9b` 传给 Ollama），`openai/<model>` → `OpenAIProvider`，`qwen/<model>` → `QwenProvider`；
   - 仅当未带显式 provider 前缀时，才按 `AI_PROVIDER`（当 `AI_PROVIDER=ollama` 时默认走 `OllamaProvider`）或历史模型名前缀自动推断——确保 `ollama/qwen3.5:9b` 永不误入阿里云 `QwenProvider`，同时 100% 兼容既有裸 `qwen-plus` / `gemini-*` 配置。
2. **安全默认配置（`core/agent/config.js`）**：
   - `OLLAMA_BASE_URL`：默认 **`http://127.0.0.1:11434`**（框架默认引导本机环回绑定）；
   - `OLLAMA_KEEP_ALIVE`：默认 `'30m'`；
   - `OLLAMA_THINK`：默认 `false`（极速响应，避免推理模型 CoT 拖死同步 RPC / 哨兵；允许调用参数显式传 `think: true` 开启深度推理）。
3. **能力与契约对齐**：
   - 实现 `chat`、`parseText`、`parseImage`（原生支持 base64 / data URL 转 Ollama `messages[].images` 多模态视觉输入）、`decide`；
   - 请求走 Ollama 原生 `POST /api/chat`（`stream: false`），**不传 `response_format`**（避开 MLX HTTP 501），内置 Markdown 围栏剥离与首尾 JSON 对象提取，严格遵守 `decide` 失败返回 `{ success: false, error }` 软降级契约；
   - 将 `prompt_eval_count` / `eval_count` 写入 `tokenLogger`（`provider: 'ollama'`），使 Portal `agent.stats.*` 能完整观测本地算力负载与吞吐。
   - `agent.providers` 自省方法在 `OLLAMA_BASE_URL` 配置启用时如实返回 `{ id: 'ollama', name: 'Ollama (Local)', vision: true }`。

### 3.2 `core/agent` 支持跨箱算力委托（`SoloPeerProvider` / `solo-peer/<model>`）
1. **场景**：当 `Finance`（BC002）自身无 GPU、需调用 `catalog-mini` 上的本地 `qwen3.5:9b` 时，不再跨网直连 `:11434`。
2. **机制**：
   - 在 `Finance` 箱配置 `SOLO_AGENT_PEER_URL=https://catalog-api.w3os.net/jsonrpc`（或受信内网 Router 地址）及窄权限 M2M 凭据（仅含 `agent.decide` / `agent.chat` / `agent.image.parse` / `agent.text.*`）；
   - `Finance` 的 `agent.model.set({ capability: 'agent.decide', model: 'solo-peer/ollama/qwen3.5:9b' })` 将请求经 `library/peer-relay` 转发至算力箱的 SOLO Router；
   - 算力箱 Router 完成身份鉴权、权限校验、速率限制与审计后，交由算力箱本机 `core/agent` → `127.0.0.1:11434` 执行。

### 3.3 新增 `api/library/peer-relay.js`（跨 SOLO 箱官方 RPC 客户端）
与箱内进程间 `api/library/relay.js` 对称，提供跨箱标准调用器 `createPeerRelay(opts)`：
- 支持两种凭据模式：① M2M API Key（对接 `m2m-principal-scope-and-sealed-envelope.md` §1.1）；② Bot 账号挑战-响应登录 + 24h JWT 自动续期（内置单实例 inflight 锁合并并发换票 + `<15%` TTL 后台 `unref()` 预刷新）；
- 自动注入 `idempotencyKey`、`Connection: close` / 超时重试（仅对网络断连，不对业务错误重试）以及跨箱 `meta.hop` 环路计数检查；
- 供 `SoloPeerProvider`、`Steward ⇄ Finance`、`Catalog ⇄ Steward` 统一复用，消灭各业务仓散装 `solo-client.js`。

### 3.4 新增 `api/library/outbound.js` 安全出站传输器并固化 `autocheck` 门禁
1. 在 `api/library/ssrf.js` 基础上封装 `outboundRequest(url, opts)`（吸收 `steward/logic/outbound-client.js` 已实战验证的全部防线）：
   - `redirect: 'manual'` 逐跳拦截 301/302/307/308，对每一跳 `Location` 重新执行 `assertPublicHostname`（防公网域名 302 跳 `http://127.0.0.1:11434` 或云元数据 `169.254.169.254`）；
   - 自定义 `http.Agent` / `https.Agent` `lookup` 钩子，将 DNS 校验与实际建连 IP 原子绑定，彻底堵住 DNS Rebinding TOCTOU；
   - 流式读取响应体并强制执行 `maxBodyBytes`（默认 2MB）与硬超时 `maxTimeoutMs`；
   - 支持显式配置受信跨机网关对（`trustedPeers: [{ host, ip }]`），默认全拒 RFC1918 / Loopback / CGNAT（`100.64.0.0/10`）。
2. **`autocheck` 与文档对齐**：
   - 将 `gateway.rmbg.cutout` 标为 `@deprecated`（新项目走 `agent.image.*` 或业务 `connector`）；
   - `autocheck` 增加静态检查提示：业务 `apps/*`（除显式声明的 `connector` 服务外）禁止直接裸连 `:11434` 或私持 `DASHSCOPE_API_KEY` / `OPENAI_API_KEY`，引导统一经 `relay.call('agent.*')` 收口。

---

## 四、分阶段实施与旁路清零路线

1. **Phase 1（`solo` 仓先红后绿，零破坏发版）**：
   - 落地 `api/core/agent/providers/ollama.js` + 修复 `providers/index.js` 显式前缀优先级 + 补齐 hermetic 单测（覆盖 `ollama/qwen3.5:9b` 路由、`think: false`、免 `response_format` JSON 解析、多模态图片输入、`tokenLogger` 记账）；
   - 落地 `api/library/outbound.js` 与 `api/library/peer-relay.js` + `SoloPeerProvider`（`solo-peer/*`）及单测。
2. **Phase 2（`catalog-mini` 源头关门）**：
   - `catalog` 升级 SOLO bundle，配置 `core/agent` 绑定本机 `http://127.0.0.1:11434`；
   - 将 `catalog-mini` 系统级 `OLLAMA_HOST` 改回 `127.0.0.1:11434` 并重启 Ollama，`lsof -nP -iTCP:11434` 实证不再监听 `*`（局域网/Tailscale 裸端口关闭）；
   - 为 `Finance`、开发机 `local-qwen` 签发窄权限 M2M 账号（仅开放 `agent.*` 推理方法），同时更新 `bence-probe` 改为经网关健康端点探活。
3. **Phase 3（下游旁路一次性拆除）**：
   - **`Finance`**：删除 `api/apps/company/adaptor/ollama-bridge.js`、`deploy/run.sh` 中的 `/internal/ollama-v1` 注入与 `adaptor/ai.js` 直连代码，`fulfillment_triage` 与 `taxmap.classify` 全量切回 `agent.*`（`solo-peer/ollama/qwen3.5:9b`）；
   - **`Catalog`**：`connector/workers/{apple-native,image-harness}.js` 与 `deploy/pg/enrich-sku-*.js` 切回本箱 `Router -> agent.*`；
   - **开发机 MCP**：`~/.gemini/config/mcp-local-qwen.mjs` 改为持 Token 调 `catalog-mini` SOLO Router Gateway `agent.chat` / `agent.image.parse`。

---

## 处理结论（solo 侧）

- **2026-11-12 Phase 1（SOLO 仓先红后绿）已全部落地并验证通过**：
  1. **`core/agent` 原生 `OllamaProvider` 与显式命名空间前缀路由**：
     - 新增 `api/core/agent/providers/ollama.js`：直调 Ollama 原生 `POST /api/chat`（`stream: false`、`think: false` 默认防 CoT 阻塞、`keep_alive: '30m'` 常驻显存），**永不发送 `response_format`**（彻底规避 Apple Silicon MLX `HTTP 501 ("structured output is unavailable")`），内置 Markdown 代码围栏与 `<think>` 标签剥离及首尾 `{...}` JSON 提取；完整实现 `chat`、`parseText`、`translateText`、`parseImage`（支持 base64 / data URL 转 `messages[].images`）、`extractProductInfo`、`scanLabel`、`classifyImage`、`decide`（软降级契约 `{ success: false }`）、`focus` 与 `suggestCategoryAttrs`，并将 `prompt_eval_count` / `eval_count` 接入 `tokenLogger`（`provider: 'ollama'`）。
     - 修复 `api/core/agent/providers/index.js`（`ProviderFactory.resolveProviderType`）：优先识别显式命名空间前缀（`ollama/<model>`、`solo-peer/<model>`、`openai/<model>`、`qwen/<model>`、`gemini/<model>`、`bitexing/<model>`、`mock/<model>`）及 Ollama 冒号 tag（如 `qwen3.5:9b`），修复此前 `model.startsWith('qwen')` 将本地 `qwen3.5:9b` 误派给阿里云 DashScope `QwenProvider` 的缺陷。
     - 修复 `api/core/agent/providers/openai.js`：自动剥离 `openai/` 前缀，并支持 `OPENAI_JSON_MODE=false` 关闭 `response_format`。
     - 更新 `api/core/agent/config.js` 与 `api/core/agent/index.js`（`agent.providers` 自省动态暴露 `ollama` 与 `solo-peer`）。
  2. **`core/agent` 跨箱算力委托（`SoloPeerProvider`）与 `api/library/peer-relay.js`**：
     - 新增 `api/library/peer-relay.js`（`createPeerRelay`）：支持 M2M `ApiKey`、Bot `Bearer` Token 与 `user.login.request` + SHA-256 `user.login.verify` 挑战-响应登录（内置 single-flight `inflightAuth` 并发合并锁、`-32001`/401 自动重登、`<15%` TTL 预刷新与 `meta.hop` 跨箱防环熔断）。
     - 新增 `api/core/agent/providers/solo-peer.js`：识别 `solo-peer/<downstreamModel>`（如 `solo-peer/ollama/qwen3.5:9b`），剥离 `solo-peer/` 前缀后经 `peer-relay` 转发至远端算力箱 SOLO Router `/jsonrpc` 的 `agent.*` 能力。
  3. **`api/library/outbound.js` 安全出站客户端与 `autocheck` 门禁**：
     - 新增 `api/library/outbound.js`（`outboundRequest` / `assertPublicHost` / `pinnedHttpRequest`）：基于 `library/ssrf.js` 拦截私网/Loopback/CGNAT/云元数据与 DNS Rebinding 泛解析域名（`*.nip.io`、`*.sslip.io`、`*.xip.io`、`localtest.me`、`lvh.me`），支持显式 `trustedPeers`（`SOLO_OUTBOUND_TRUSTED_PEERS` / `STEWARD_OUTBOUND_ALLOW_TAILNET_IPS`）、Socket 级 `lookup` IP 锁定（消除 DNS Rebinding TOCTOU）、逐跳重定向 SSRF 复检（`followRedirects`）及流式响应体上限（`maxBodyBytes = 2 MiB`）。
     - 在 `api/core/gateway/handlers/introspection.js` 与 `api/core/gateway/logic/rmbg.js` 将 `gateway.rmbg.cutout` 标记为 `@deprecated`。
     - 在 `api/autocheck/static/security.js` 新增静态检查：当业务服务（非 `agent` / `connector`）直连 `:11434` 或直接读取 `DASHSCOPE_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` 时输出架构告警。
  4. **Hermetic 回归单测**：新增 `api/library/tests/outbound-peer-ollama.test.js` 并纳入 `api/jest.ci.config.js` 门禁。
