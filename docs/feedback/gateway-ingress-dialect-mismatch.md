# 反馈：gateway 出站与 ingress 入站说的不是同一种方言 —— 两个 SOLO 箱子今天不能直插；bridge 应收敛进这两个器官

> 来源：solo 会话，2026-09-03。场景：steward 与 finance 两个 SOLO 箱子要**直接**互联，不经总控箱——
> finance 派 steward 跑已定稿剧本（steward `integrations/dispatch-script.js`，2026-09-02 线上跑通），
> steward 跑完把结果**投回 finance 的 ingress**、带上 finance 给的 requestId。走到「steward → finance」
> 这一跳时发现：frame 自带的出站器官（gateway webhook）与入站器官（ingress）**互相不认识对方的格式**。
>
> **依据分三类，请按类采信**：
> - **源码核对**：`api/core/gateway/logic/webhook.js:40-54`（出站 body / 头 / loopback 闸）、
>   `api/core/gateway/handlers/introspection.js:166-178`（`gateway.webhook.send` 参数与返回面）、
>   `api/core/ingress/logic/ingest.js:97-128,166`（入站 key 来源、信封校验、去重、回执）、
>   `api/core/ingress/README.md` §0/§2（信封契约、key 走头不进 params）。
> - **引用 steward 侧实测**（本篇未复测）：`steward/integrations/README.md`「七个对齐点」——
>   finance → steward 方向（JSON-RPC + integrator 窄 permit 账号）2026-09-02 线上派单到终局 24.6s，
>   同 `requestId` 重发命中幂等不重复执行。
> - **判断**：§三、§四是设计意见。steward → finance 这一跳今天不存在、无运行结果。
>
> 涉及：`api/core/gateway/logic/webhook.js`、`api/core/ingress/`、
> `docs/planning/VERSION.v2.md` §3、`docs/planning/v2-bridge-interaction.md` §2/§6。

---

## 一、【源码核对】出口与入口的六处不一致

| | `gateway.webhook.send` 发出 | `ingress.ingest` 接受 |
|---|---|---|
| **目标与外壳** | 任意 URL，POST 裸 JSON | `{Router}/jsonrpc`，JSON-RPC 2.0 信封 `{method:'ingress.ingest', params}` |
| **body** | `{type, targetId, payload, sent_at}`（`webhook.js:45`） | `params.request_id`（必填字串）+ `params.data`（对象）（`ingest.js:117-119`） |
| **鉴权** | `X-Solo-Signature: sha256=HMAC(body, secret)` + `X-Solo-Timestamp`（`webhook.js:50-54`） | `Authorization: ApiKey <key>`，Router 透传该头（`ingest.js:97`、README §0） |
| **幂等键** | `idempotencyKey` → gateway 投递账本去重（introspection `deduplicated`） | `request_id` → `(source, request_id)` SET NX（`ingest.js:123`）。**两个键互不知道** |
| **回执** | 只看 2xx（`webhook.js:72`） | `{ok, stream, request_id}` / `{ok, duplicate:true, request_id}` / 422 `dataSchema` 拦下待人审 |
| **loopback** | 拒绝（`webhook.js:40-42`，`WEBHOOK_ALLOW_LOOPBACK=1` 才放） | — |

后果：一个箱子的服务想给另一个箱子投递，今天只有两条路，都不好——
① 收方再写一个 listener 把 gateway 信封翻成 ingress 信封（每对箱子各写一份翻译器 = 论文开篇「N 个 AI 发明 N 套约定」的跨箱版）；
② 发方在 payload 里自己写出站 HTTP（绕开 gateway 的 SSRF 闸、投递账本、幂等键与审计）。

**loopback 闸单独点名**：它的注释理由是「内部调用走 Router」，说的是**箱内**。但同机多箱（N100 上 overview / runner / colony / steward 各一套 Router、不同端口）是 `VERSION.v2.md` §3.4-④ 立的 A 线**第一个里程碑形态**，目标就是另一个箱子的 Router、地址就是 `127.0.0.1:<port>`。不放行，同机跨箱第一跳就被这条闸拦死，且报错文案会把人引向「你不该直调服务」。

## 二、【判断】这一跳恰好就是 v2 bridge 的消息档

对照 `v2-bridge-interaction.md` §2「存档确认制」：发方投递 → 收方**落库为自己的实体、按幂等键去重、回执「已存档」** → 执行由收方自己的状态机异步推进。

ingress 已经逐字是这个东西：`(source, request_id)` 去重、回执 `{ok, request_id}` 或 `duplicate:true`、
落到 `EVENT:WEBHOOK:{源}` 让收方订阅者自己决定做什么（dumb pipe）。§2 原文写的「子箱一个窄入口方法 + 存档实体 + 幂等去重」
**不必每箱手写**——入口就是 ingress，存档就是订阅者落的那条记录。

再对照 `VERSION.v2.md` §3.3：「bridge 是 gateway 形态的出站 core 服务，镜像 `core/gateway`」。
gateway 本来就是它指定的出站身体，ingress 是入站镜像。差的只是两者不说同一种话。

## 三、【判断】收敛方案：bridge = gateway 出站 → ingress 入站；frame 只加一个目标模式

**定义**：箱子之间互为对方 Router 的客户端。凭证只有 frame 里已有的两种——
调对方**方法**用 bot token（窄 permit，今天就在跑）；给对方**投递**用对方 ingress 发的 API key。
不需要总控箱，不新增服务、实体、方法名。箱子 owner 为了联邦要学的新名词：**零**（ingress source 与 gateway webhook 本来就该认识）。

**frame 唯一要加的：`gateway.webhook.send` 一个 solo 目标模式**（参数形状留实现定，如 `target:'solo'`）：

1. 外壳改 JSON-RPC 信封：`{jsonrpc:'2.0', id, method:'ingress.ingest', params:{request_id, data, meta}}`；
   `request_id` 取调用方给的 `idempotencyKey`（两个幂等键合一，一个键贯穿发方账本与收方去重），`data` = `payload`。
2. 鉴权改头：`Authorization: ApiKey <secret>`，不再算 HMAC。
3. **解析 JSON-RPC 回执**，把 ingress 的 `duplicate:true` / 422 held 如实透出（现在只看 2xx，`duplicate` 会被当成功且无区分）。
4. **放行 loopback**——仅 solo 模式、且目标路径是 `/jsonrpc`；其余模式维持现状。
5. **信封 `meta.hop`**：发方置 `hop+1`，ingress 原样透传进事件 payload，gateway 见 `hop ≥ 上限`（建议 3）拒发。
   这是环路刹车（§3.6 #5）唯一需要的机制——消息语义下 A→B→A 只可能由 B 的订阅者**显式**再投回 A 造成，
   没有 RPC 那种自动转发扇出，一个计数就够。ingress README §15 D2「可选 `meta` 需要再加」的第一个需要就是它。

投递账本、SSRF 闸（非 loopback 部分）、`idempotencyKey`、timeout、64KB 响应上限全部沿用。

**发方存对端 key 的地方不进 frame**：`gateway.webhook.send` 的 `secret` 本就由调用方传入，存哪是调用方的事
（steward 有 `steward.variable` secret 型 + apiprovider 式「approve = 放行一个出站目标」，正好复用）。
⚠️ **需核实**：`secret` 走 RPC params 经过发方 Router，Router 审计若记 params，对端 key 就落进发方审计日志——
这是 `gateway.webhook.send` HMAC `secret` 的既有形态，不是本模式新引入，但 ingress 当初刻意让 key 走头不走 params
（README §0）就是为了避开这一点。若 Router 确实记 params，gateway 侧应接受 secret **引用**而非明文（同 notification config 的做法）。

## 四、【判断】为什么不需要签名档、RPC 档、新服务

按 `VERSION.v2.md` §3.6 A 组四缺口逐条对到消息档：

| 缺口 | 消息档下 | 依据 |
|---|---|---|
| #2 actor 被当授权输入 | **按构造不存在**：actor = `webhook:{源}` 由 key 反推、Router 盖章，对端无法自报 | `ingest.js:92`、ingress README §3 |
| #4 federation-public ≠ public | **按构造不存在**：一把 key 只能往自己命名的那条流投递，够不到收方任何方法；比「窄 permit」更窄 | README §4 |
| #8 重复执行 | **已有**：ingress SET NX + gateway 投递账本 | `ingest.js:123`、introspection `deduplicated` |
| #1 `aud` 绑定 | per-pair 秘密下**隐式成立**（发给 B 的信封 C 验不过）；一箱一把公钥时才需显式 → 跨运营方档 | — |
| #5 环路刹车 | **要做**，即 §三第 5 条 `meta.hop` | — |
| #3 callee 钉定 | TLS 证书；跨机公网 https 两侧已有 | — |
| 版本握手 | 靠 BACKLOG §3「bundle 运行时自报版本」，落地后 ping 自然带出；不是 bridge 自己的机制 | `BACKLOG.md` §3 |

Ed25519 mesh 签名 / `aud` / nonce / 外网格 principal / capability 预检 / 独立 bridge 服务——这些解决的是**下游属于别人**时的问题
（不可抵赖、边界无共享秘密、一箱一钥而非 N² 对）。`VERSION.v2.md` §2.3 / §3.4 已把 actor-claim、fieldmask 定成
「出现跨运营方联邦才重启」的条件依赖；**签名档归到同一个条件下**，判据一致。同运营者 mesh 里 API key + TLS 足够。

跨箱**调方法**（读对方状态、`v2-bridge-interaction.md` §3 的定期拉取）= 当对方 Router 的普通客户端，bot token 即可，
今天就在跑，不另立「RPC 档」。§3.5「同步转发为默认」应改为「**投递为默认**」——与交互规格 §7「不做同步跨箱调用链、
每次交互终点是落到某一箱的存档」本就一致，这次把 §3 拉齐。

治理面顺带简化：没有中心协调层，就没有「协调层配置变更谁有权改」这个问题
（[`org-container-per-person-mesh.md`](./org-container-per-person-mesh.md) §二）——每个 owner 只治理自己的
入站（`ingress.source.*`，admin）与出站（发方存 key 的地方）。主权形状不变：对端自己决定信不信。

## 建议排序

1. **`gateway.webhook.send` solo 目标模式**（§三 1–5，只加不破，v1.x）——steward → finance 当场可用；同机多箱靠第 4 条。
2. **`VERSION.v2.md` §3 回写收敛决定**、§3.3–§3.6 标为跨运营方档；`v2-bridge-interaction.md` §2/§6 传输层落名。
3. **核实 Router 审计是否记 params**（§三 ⚠️）；记则 gateway 接受 secret 引用。
4. ingress README §15 D2 结论更新为「`meta` 已加，首个字段 `hop`」——随实现一起写，不提前写。

## 本次没有产生本地补丁

steward / finance 两侧都未在只读区打补丁；steward → finance 这一跳尚未动工。finance 侧目前 `api/apps` 内无任何
`EVENT:WEBHOOK:*` 订阅者，接通时要建 source、发 key、加订阅（配置 + 小代码，全在 payload）。

---

## 处理结论

2026-09-03 triage（solo 会话，用户拍板）。**方向采纳**：bridge 收敛为 gateway 出站 → ingress 入站，frame 只加
`gateway.webhook.send` 的 solo 目标模式；签名档 / principal / 预检 / 独立服务全部收窄为跨运营方档条件依赖。
判据由用户定：**SOLO 作为支持层的必要条件是简洁**，方案以「owner 要学的新名词数」计，目标为零。

当日落地（均为文档，不涉代码）：
- `docs/planning/VERSION.v2.md`：新增 §3.0 收敛决定；§1 / §2.1 / §2.3 / §5 同步；§3.3–§3.6 标注为跨运营方档基线。
- `docs/planning/v2-bridge-interaction.md`：主箱/子箱改为角色而非拓扑要求；§2 通道一传输层落名；§6 清单改写；§8 指针更新。
- `docs/planning/BACKLOG.md` §3：登记「bridge 消息档 v1：gateway solo 目标模式 + `meta.hop`」。

**未做、留后续**：代码（建议 1）；Router 审计 params 核实（建议 3）；ingress README D2 回填（建议 4，随实现）。
本篇因此留在 `docs/feedback/` 顶层，代码落地后再移 `done/`。论文 `docs/paper/draft-pattern-first.md` §4.5「deployment has not begun」
仍属实，未改；接通后再进该节括注。
