# 反馈：事件总线没有对外推送面 —— 外部执行端（浏览器插件 / portal）只能轮询，提议 Router 加 WS「门铃」作第三消费组

> 来源：steward 派生项目（Solo v1.2.1），2026-08-23 设计「portal 中控下发工单 →
> 浏览器插件在开着的卖家后台页面上执行」的下发链路时提出。
>
> **依据分三类，请按类采信**：
> - **自查实测**：steward 插件现状（工单池 claim/settle 链路已在跑，MV3 background
>   service worker 是唯一网络出口，`client/plugin/background.js`）；solo 仓 HEAD 与
>   steward 所附 v1.2.1 bundle 全文 grep 均**零 WebSocket 实现**（唯一命中是
>   `api/autocheck/static/bind-address.js` 的一条静态检查文案）。
> - **源码/文档核对**：事件管线与两个既有消费组（见 §2 逐条 `文件:行号`）；
>   `docs/authoring/events.md`（steward 随附版，校准 v1.2.1）。
> - **平台行为引用（未自测）**：Chrome MV3 service worker 30s 空闲回收、Chrome 116+
>   活跃 WebSocket 消息可重置该计时器、`chrome.alarms` 最小间隔 30s（Chrome 120+）——
>   均为 Chrome 官方文档结论，本项目尚未实机压测。
> - **判断**：§3–§5 的设计提案整体是设计意见，不是运行结果。
>
> 涉及：`api/router/index.js:440`（挂载点）、`api/router/handlers/events.js`（事件写入）、
> `api/core/orchestrator/logic/matcher.js:87,128` 与 `api/core/nexus/logic/stream.js`
> （两个既有消费组）、`api/router/handlers/auth.js`（session 鉴权复用点）。
>
> 一句话：事件总线的消费端目前全是**信任域内**的（matcher/nexus），域外客户端
> 想「被通知」只有轮询一条路；提议加一个 **notify-only 的 WS 推送面**（第三消费组），
> 推的只是门铃、不是数据，可靠性仍留在既有 RPC 拉取路径上。

---

## 一、【场景】外部「执行端」是一类还没被覆盖的消费者

steward 的形态：插件是手、服务端是脑。portal（中控台）创建动作工单（action 实体），
浏览器插件在真实登录的卖家后台页面里领取执行（claim → 页面内执行 → settle，已在跑）。
这是一个**长在信任域外、却需要低延迟感知服务端状态变化**的客户端——和 portal 前端
想实时刷新「工单被领了/执行完了」是同一个需求的两个方向。

现状下这类客户端只有轮询：插件端 `chrome.alarms` 地板是 30s，N 个客户端 × 每 30s
一次全量 pending 查询打在 Router 上，换来的还是平均 15s 的下发延迟。轮询作为
可靠性地板没问题（steward 初期就按轮询实现，**本提案不阻塞项目**），缺的是
「事件已经在总线上了，却传不出信任域」这最后一跳。

## 二、【源码核对】总线是现成的，缺的只是第三个消费组

1. **事件写入面完备**：服务发 `_event` / `event.emit` → Router 鉴权盖章 →
   `xAdd` 写 `EVENT:*` stream（`api/router/handlers/events.js`，registry 白名单把关）。
2. **消费端目前两个，全在信任域内**：orchestrator matcher
   （`api/core/orchestrator/logic/matcher.js:87` `xGroupCreate`、`:128` `xReadGroup`，
   触发 workflow）和 nexus（`api/core/nexus/logic/stream.js`，触发 agent/sentinel）。
   `docs/authoring/events.md` §3 也明确二者是「同一批 `EVENT:*` 流上的两个独立消费组」。
3. **对外没有任何推送通道**：全仓无 WS/SSE/长轮询实现；`gateway` 是邮件/短信出站
   投递（`docs/authoring/modeling.md`），不是推送网关。
4. **挂载点现成**：Router 是 Express，`api/router/index.js:440` `app.listen(PORT)`
   的返回值（`http.Server`）当前未被捕获——捕获后挂 `server.on('upgrade')` 即可在
   **同一端口**做 WS，公网入口（Caddy 反代自动处理 upgrade）与防火墙都不用动。

## 三、【判断】提案：notify-only 的 WS 推送面，语义钉死为「门铃」

核心设计决定：**WS 只做通知，不做传输**。推下去的是「有新事件」
（stream/type + payload 摘要 + stream 条目 id 做 cursor），不是业务数据本身；
客户端收到后的唯一动作是走既有 RPC 拉取（steward 场景即 pending → claim）。由此：

- **可靠性零新增负担**：at-most-once、断线不补投、慢客户端直接丢（反正会拉）、
  多条事件可合并成一次通知。幂等、鉴权、审计全部留在既有拉取路径。
- **降级即回退**：WS 挂了 = 延迟退化成客户端自己的轮询间隔，不是功能故障。
  客户端侧轮询降频保留（如 5 分钟）当地板。
- **实现最小**：作为第三消费组 `xReadGroup` 读流、进程内按订阅扇出、读到即 ack，
  不需要投递账本、重试队列、DLQ。

配套四件事：

1. **鉴权**：连接后首帧携带 session token（不放 URL query，避免进访问日志），
   限时未认证即断；复用 `api/router/handlers/auth.js` 的既有校验。token 24h TTL
   到期时服务端带专用 close code 主动断开，客户端重登重连。
2. **可见性边界（本提案引入的唯一新安全面）**：事件 payload 此前只在信任域内流转，
   对外扇出必须**默认全部不可见、按流显式开放**。最小做法：`EVENT_REGISTRY` 三元组
   上挂可选字段（如 `external: true`）或独立 env 白名单；再按连接身份的 permit
   过滤订阅请求。宁可起步只开放极少数流。
3. **订阅模型**：直接复用 workflow `event_subscriptions` 的形状
   （`{stream, filter:{type}}`），不发明新语法。
4. **心跳**：服务端 ping ~20s。顺带满足 MV3 SW「30s 内有 WS 活动才不被回收」的
   保活约束（平台行为引用，见头部依据分类）——这意味着心跳间隔是**对外契约**的
   一部分，不只是探活参数，改动要进 CHANGELOG。

## 四、【判断】形态两个变体，倾向 A，请 triage 定

- **A. 内建于 Router 进程**：挂 §2.4 的 upgrade 点。优点是鉴权/入口/配置零新增，
  缺点是给 Router 加了长连接状态（内存中的连接表 + 订阅表）。
- **B. 独立系统服务（类 gateway 的定位：「WS 推送」作为又一种出站投递通道）**：
  进程隔离更干净，但入口要么仍经 Router 的口转发 upgrade、要么开新端口
  （新端口意味着每个派生项目的反代与防火墙都要多一条配置，部署面变大）。

派生项目侧明确**不该做**的是业务服务自己开 WS 端口——绕开 Router 鉴权与审计、
破坏 ingress 拓扑，这也是本提案上收而不是在 steward 本地实现的原因。

## 五、【判断】派生项目的过渡路径（说明提案不着急、但方向值得早定）

steward 计划：① 服务侧现在就按 events.md 发 `action.created` 事件并登记 registry
（今天就对 workflow/nexus 有用，将来 WS 消费的就是同一条流，服务侧零改动切换）；
② 插件侧把「查并领取」收敛成单一 `checkNow()` 入口，alarm tick 与未来的 WS onmessage
都调它。也就是说：**上游什么时候做都不破坏下游**，但「门铃语义」这个方向若能早定，
派生项目就不会各自长出私有推送方案（那才是难收拾的分叉）。

## 建议排序

1. **先定语义再定实现**：接受/驳回「notify-only 门铃 + 可见性白名单」这两条设计
   决定——它们决定派生项目现在怎么铺路，实现本身可以慢慢来。
2. **形态 A（Router 内建 upgrade）**：实现最小路径见 §2.4/§3，依赖上只需 `ws`
   （零依赖包）或裸 upgrade 握手。
3. **`EVENT_REGISTRY` 挂 `external` 可见性字段**：registry 本来就是 per-stream
   粒度的配置面（与 event-bus-xadd-unbounded-dead-config.md 建议 2 的 per-stream
   覆盖口同一个思路，可一并设计）。
4. **（文档）events.md 增补**：消费端从「两个消费组」改为「N 个消费组」的表述，
   并写明对外推送的门铃契约与心跳约束。

## 本次没有产生本地补丁

steward 按轮询先行，不在本地实现任何 WS；无 `[Project]` 分叉。

---

## 处理结论（solo 侧）

2026-08-23 triage（solo 会话）。事实主张经源码核实**全部属实**：`router/index.js:440` 的 `app.listen`
返回值确未捕获；全仓零 WebSocket 实现；两个消费组即 orchestrator matcher（`matcher.js:87,128`）与
nexus（`stream.js:278`），均在信任域内。另核对规划台账：**「SSE 推送」本就是 D 线已拉回 v1.1.x 的排期项**
（VERSION.md 2026-07-03 拆分回写）——本篇不是新立项，而是给该项送来第一个真实消费者，并把形态从 SSE
论证为 WS（MV3 SW 保活需双向活动，平台行为引用）。逐条结论：

- ✅ **语义拍板（建议 1，接受）**：「**notify-only 门铃** + **可见性默认全关、按流显式开放**」两条设计决定
  成立，即日起是既定方向。推送面永远只是延迟优化——可靠性/幂等/鉴权/审计全部留在既有 RPC 拉取路径，
  WS 挂了 = 退化为轮询、非功能故障。派生项目可据此铺路（§5 的两步：服务侧发事件进 registry、客户端收敛
  单一 `checkNow()` 入口），不必等实现。
- ⏸ **形态（建议 2，倾向 A 但缓拍）**：A（Router 内建 `server.on('upgrade')`）实现面最小、鉴权/入口/配置
  零新增，但落在 `api/router/` 修改保护区——**须用户审阅后明确授权**，与 xadd 反馈（2026-08-18 triage）的
  建议 1/2（EVENT:* TRIM 接线）同属 router 待授权批次，届时可一并动。B（独立服务）不预先排除，授权讨论时
  一起摆上桌。
- 📌 **可见性白名单机制（建议 3，取向修正）**：**不挂 registry 字段**——沿 2026-08-18 xadd triage 的先例
  （per-stream 配置口选**单个 env 列表**、不动 registry 数据结构），取 `EVENT_EXTERNAL_STREAMS='…'` 类
  env 白名单，与 `EVENT_MAXLEN_OVERRIDES` 同族，实现时一并设计。
- ⏸ **events.md 增补（建议 4，实现时再写）**：runbook 反馈（2026-08-22）刚证明「文档承诺了代码没有的
  东西」是最坏的失败形态——门铃契约、「心跳间隔是对外契约」等表述**随实现一起进文档**，不提前写。
- 排期登记：`BACKLOG.md §3` 新增「对外推送面（WS 门铃）」一行挂本篇指针；§2.3 里「SSE 主动推送本身仍 v2」
  的过期表述一并修正（它 2026-07-03 已拉回 v1.1.x）。
