# SOLO v2 · 主箱—子箱交互模式（A 线协同运行规格 · 草案）

> **状态：草案，先于实现。** [`VERSION.v2.md`](./VERSION.v2.md) §3 定义 bridge 的**机制**
> （一次请求怎么安全过网格边界：签名 / 窄 permit / 预检 / 版本握手）；本文定义**运行模式**
> （主箱与子箱之间有哪几条通道、各自的节奏与失败语义、解耦如何保证）。bridge 代码未动工。
>
> 来源：2026-08-24 solo 会话。依据分两类：**实测/源码核对**——steward / finance / runner /
> colony / overview 五仓实现分析（文中逐条引出处）；**设计判断**——三通道划分与存档确认制
> 为本轮拍板，跨网格部分今天不存在、无运行结果。
>
> 术语：**主箱** = 主 SOLO（试验田里是 overview）；**子箱** = 下游 SOLO 网格
> （runner / colony / steward / finance / trend …）。
>
> **2026-09-03 补（用户拍板）**：主箱 / 子箱是**角色**，不是拓扑要求——任何箱都可以是发方，
> 两箱直连（第一例：steward → finance，剧本结果投回 finance 的 ingress）**不经主箱**，本文的通道划分与
> 失败语义同样适用。传输层已定为 frame 既有器官：**发方 `gateway.webhook.send`（solo 目标模式）→ 收方
> `ingress.ingest`**，不新建 bridge 服务；决定与依据见 `VERSION.v2.md` §3.0、
> [`../feedback/gateway-ingress-dialect-mismatch.md`](../feedback/gateway-ingress-dialect-mismatch.md)。
> 文中「bridge 代码未动工」仍属实——待动工的是 gateway 的那个模式。

---

## 0. 一句话

被动 RPC 是底座（主箱不发起就零沟通）；其上只有三条通道：**下行「存档确认」**（写）、
**定期拉取**（读，兼航线心跳）、**门铃**（将来，通知不带数据）。
**子箱永不依赖主箱运行，主箱撤除无痕。**

## 1. 设计原则（先于任何通道）

1. **子箱是完整生命体**：没有主箱照常运转——这是现状不是目标（五箱本来就独立成栈、各自有人有 AI 有兜底）。主箱只能给子箱**多一个输入源**，不能成为它的依赖。
2. **依赖方向单向（主→子）**：子箱永不同步回调主箱；主箱了解结果一律靠拉。
3. **失败语义显式**：拉不到 = 显式异常，当场可见；「没消息」永不解释成「没事」。
4. **撤除无痕**：主箱侧停循环删配置、子箱侧吊销 bot 账号，即撤除完成；子箱零代码回滚。

## 2. 通道一：下行指令 / 数据 —— 存档确认制（主→子，写）

主箱经 bridge 调子箱的一个**窄入口方法**，子箱同步只做三件事：
**落库为自己的实体（存档）→ 按幂等键去重 → 回执 `{id, status:'ARCHIVED'}`**。
指令和数据下发同构：都是「落成子箱的一条存档实体」。

> **传输层（2026-09-03 定）**：那个「窄入口方法」**不必每箱手写——它就是收方的 `ingress.ingest`**。
> 发方 `gateway.webhook.send`（solo 目标模式）→ 收方 Router `ingress.ingest`：ingress 按
> `(source, request_id)` SET NX 去重，回执 `{ok, request_id}` 即「已存档」、`{ok, duplicate:true}` 即幂等命中，
> 落到 `EVENT:WEBHOOK:{源}`；收方订阅者落的那条记录就是本节的「存档实体」。来源标记也不用自报：
> `actor = webhook:{源}` 由 key 反推、Router 盖章。信封 `meta.hop` 做环路刹车。
> 收方要做的只剩：建 ingress source（配置）+ 一个订阅该流的消费者（payload 小代码）。

- 🔴 **回执语义 = 「已存档」，不是「已受理」更不是「已完成」。** 执行由子箱自己的状态机
  异步推进，节奏、重试、放弃全部是子箱内政。
- **幂等键必带**：主箱生成（如 `<主箱网格id>-<条目id>`），子箱在存档层去重。由此主箱可
  无脑安全重试——`VERSION.v2.md` §3.6 #8「同步转发非 at-most-once、下游重复执行」在此
  模式下被消解：重复投递 = 去重命中，不重复执行。（colony 已实证这套去重槽有效：重发同
  `event_id` 返回 `{written:0, deduped:1}`。）
- **来源标记**：存档实体带 origin（runner 的 `origin` 字段就是为此预焊的钩子——
  `coder/logic/task.js:34-37` 注释明言「the field is wired now so every task records its
  origin from day one」；当前枚举 `issue|request|internal` 需扩联邦来源值）。
- **子箱兜底（解耦成立的关键，全部在子箱内）**：
  - 处理不了 → 标 `NEEDS_HUMAN` / `REJECTED`，进子箱自己的人工队列（steward 工单模式）；
  - **不允许存在「等主箱」状态**——主箱从此不再出现，存档条目照常被处理或按子箱规则老化；
  - 重启 → 存档即队列，未完成条目重新入队（runner「task 实体本身就是队列」模式，
    `coder/logic/task.js:67-95` 的重启清算）。
- **先例**：这不是新发明——runner 的 task 队列、steward 的工单 claim/report/escalate、
  ingress 的收即落库，都是同一模式；本文只是把它立成跨网格契约。

## 3. 通道二：定期拉取 —— 统计采集 + 航线心跳（主→子，读）

主箱按固定节奏（默认 30 分钟，对齐 overview collector 现有节奏）逐箱拉：
`ping` + 每箱一个**只读自述方法**。

**双重身份**：它既是子箱状态的采集器，也是**航线本身的心跳**——低频使用的航线会静默腐烂
（密钥轮换 / permit / 版本漂移，坏在最需要的那一刻），colony 已把「稀疏调用方 = 必然故障」
验证成定律；定期拉让签名、permit、版本握手、环路刹车每天被真实走 48 遍。

**指标三层**（全部是零成本可判定事实，不打分、不排名）：

| 层 | 指标 | 现成度 |
|---|---|---|
| **L0 活着吗** | ping 的 status / version / uptime；**三处版本对齐**（`.solo-version` = git tag = 线上 bundle 版本） | ping 全箱现成；⚠️ **但线上 bundle 版本目前 wire 上拿不到**——core 服务 ping 报的是内联冻结的 0.1.0，`system.service.list` 的版本也是注册默认值（colony 实测为假）。前置 = `BACKLOG.md` §3「bundle 运行时自报版本」（build 注入 + `/health` 透出） |
| **L1 机器回路** | 事件流**窗口斜率**、DLQ 深度、relay token `lastRefreshAt` 是否前进 | colony 判据成文；nexus/notification 的 `/metrics` 已挂 gauge |
| **L2 人工闸门积压** | **等人的事几件、最老的等了几天**（各箱语义自定，形状统一） | finance `pipeline.overview`、runner `coder.task.stats` 已是此形状；steward / colony 各补一个小只读方法 |

**采集纪律**（照搬 overview collector 已跑通的）：逐箱隔离失败；连续 3 轮失败才告警、
恢复再报一次；每箱带 `collectedAt` 新鲜度戳，**戳过期本身是一级信号**；一律窗口口径、
不用绝对计数（防将来 MAXLEN 修剪截断）；**区分「被拒」和「空」**（-32005 是权限故障不是
零数据——portal 已把两者渲染成一样，采集器不得重蹈）。

**展示红线**（overview 宪章，`mind/strategy/solo-v2-testbed.md`）：结果只喂 `/week` 判断
与异常告警；健康探针、重试、熔断、日志等运维细节不进主箱 UI。

## 4. 通道三（将来）：门铃 —— 子→主，通知不带数据

- 唯一允许的子→主方向流量；推的只是「有新东西」+ cursor，主箱收到后仍走拉取。
- 挂了 = 延迟退化为通道二节奏，**是降级不是故障**。
- 依赖 solo 侧「对外推送面（WS 门铃）」落地（`BACKLOG.md` §3 已登记，
  语义已 triage 拍板：notify-only + 可见性默认全关，见
  [`../feedback/event-bus-no-external-push-plane.md`](../feedback/event-bus-no-external-push-plane.md)）。
  在那之前**不做任何私有推送替代**。
- **紧急告警不经主箱**：子箱用自己的 gateway 出站通道（邮件/短信）直接通知人，链路更短。

## 5. 失败语义总表

| 场景 | 结果 |
|---|---|
| 主箱宕机 | 子箱零影响。唯一损失：新指令不再下发、统计中断——且中断在主箱恢复后自见（新鲜度戳） |
| 子箱宕机 | 下行投递失败上抛，主箱重试（幂等安全）；拉取记入失败台账，连续 3 轮才告警 |
| 网络断 | 同上；恢复即自愈，无需人工对账（存档去重兜底重复投递） |
| 撤除整套机制 | 主箱删循环 + 航线配置；子箱吊销 bot 账号；inbox 存量条目按子箱自己的生命周期走完 |

🔴 **守住解耦的唯一前提**：不允许任何子箱的业务逻辑反过来消费主箱聚合的数据做决策。
目前所有用途（`/week` 判断、异常告警）终点都在人；哪天某箱开始依赖主箱数据跑流程，
「撤掉不影响」即告失效，须按正式航线重新评估。

## 6. 每箱接入的最小改动清单

| 项 | 落点 | 性质 | 何时必须 |
|---|---|---|---|
| bot 账号 + 窄只读 permit | 子箱（配置） | 配置动作，非代码 | 通道二 |
| 只读自述方法 | 子箱 `api/apps/<svc>/` | 小代码 | L2 时（finance / runner 已有现成） |
| ~~inbox 入口 + 存档实体 + 幂等去重~~ → **ingress source（建源、发 key）+ 订阅 `EVENT:WEBHOOK:{源}` 的消费者** | 收方：配置 + `api/apps/<svc>/` 小代码 | 入口与去重由 ingress 承担，只写消费者 | 仅开通通道一的箱子 |
| 拉取循环 + 失败台账 + 新鲜度戳 | 主箱 | 代码 | 通道二 |
| ~~bridge 出站服务（签名信封）~~ → **`gateway.webhook.send` solo 目标模式** | solo frame（v1.x 只加不破，`BACKLOG.md` §3） | 框架小改，一个开关 | 通道一 |
| 发方存对端 key 的地方 | 发方 payload（如 steward `steward.variable` secret + approve 放行出站目标） | 配置 | 通道一 |

**过渡路径（2026-09-03 改写）**：通道二今天就能跑——bot 账号 + `permit.services` 白名单，**这不是过渡，就是终态**
（跨箱调方法 = 当对方 Router 的普通客户端）。通道一等的只是 gateway 那个模式；签名信封只在跨运营方档才回来，
届时也只换传输层，指标契约、自述方法、存档确认语义一个字不改。

## 7. 明确不做的

- **不做同步跨箱业务调用链**（一个请求穿多箱等结果）——每次交互的终点都是「落到某一箱的
  存档 / 台账」，没有跨网格分布式事务（`VERSION.v2.md` §3.6 #8 明言无跨网格 Saga）。
- **不做子箱同步回调主箱**。
- **不推数据**（门铃也只推通知）。
- **不给箱子打分排名**；判断留散文（overview 红线：提交数 ≠ 价值）。
- **指标 schema 不预设**——从「反复问过的问题」长出来（当前三问及其事故背书：
  「还在跑吗」trend 前端静默死 4 天 / 「线上哪版」mso 一个月证实不了 /
  「多少事等人」捕获条目躺 13 天）。

## 8. 与既有文档的关系

- **机制**：`VERSION.v2.md` §3.0（2026-09-03 收敛：gateway solo 模式 → ingress，同运营者档）；
  §3.3–§3.6（签名 / principal / aud / 预检，**跨运营方档基线**）。本文不重复。
- **安全缺口（2026-09-03 更新）**：消息档下 §3.6 A 组 #2 / #4 **按构造不存在**（actor 由 key 反推、
  peer 只能往自己那条流投递），#8 由 ingress 去重 + gateway 账本消解，#1 在 per-pair 秘密下隐式成立；
  **唯一要做的是 #5 环路刹车 = 信封 `meta.hop`**，随 solo 模式一起落。逐条对照见
  [`../feedback/gateway-ingress-dialect-mismatch.md`](../feedback/gateway-ingress-dialect-mismatch.md) §四。
- **角色与 UI 红线**：overview 仓 `mind/strategy/solo-v2-testbed.md`（跨仓库不设链接）。
- **治理**（协调层归属人、bridge 配置变更接 approval）：
  [`../feedback/org-container-per-person-mesh.md`](../feedback/org-container-per-person-mesh.md) §2，公司侧生效；个人 mesh 里归属人即本人。
