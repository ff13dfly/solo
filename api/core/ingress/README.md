# Ingress 适配器 — 实施文档

> **状态**：已实现并发布（见 §13–14；在 `deploy/services.json`，端口 8070）。本文最初是实施文档，正文部分小节仍以设计口吻写，但代码已落地。
> **定位**：core 层服务，**外部入站的中央控制面**。与 Gateway（出站）镜像对称。

---

## 0. 一句话

外部对接的差异（各家格式/签名）由**独立开发的 listener** 各自吸收、统一成 JSON；`ingress` 是中央控制面，只认这一种统一 JSON：用 **API key** 识别来源 + 启停、做**去重**和**基本结构校验**，再经 Router `event.emit` 发出 `EVENT:WEBHOOK:{源}` 事件；消费微服务订阅后**自己做领域分类与路由**。

```
外部系统 (GitHub 原生 + 签名 / Stripe / 伙伴 XML…)   ← 各家千差万别
   │
   ▼
listener-{源}   独立开发,每个外部对接一个 —— 本就该独立写
   - 懂这家格式 + 验这家签名
   - 【按 sha256(request_id) 归档原始请求】 ← 可反查的"实际收到啥"
   - 归一化成【统一 JSON 信封】(§3)
   - 带自己的 API key,经 Router 调 ingress.ingest
   │  POST {Router}/jsonrpc  { method:"ingress.ingest", params:{request_id,data} }
   │  Authorization: ApiKey <key>     ← Router 透传此头给 ingress,key 不进审计日志
   ▼
Router   唯一入口(CLAUDE.md §2);ingress.ingest 是 public 方法,免 session
   ▼
ingress   core 服务,端口 8070 —— 中央控制面,格式无关(只认统一 JSON)
   ① 从透传的 Authorization 头取 API key → 识别来源 + 查 enabled(启停)
   ② 去重:按 (source, request_id) 幂等(§5)
   ③ 基本结构校验:合法 JSON + 信封必填字段(§9,不碰领域含义)
   ④ 【按日审计】append logs/ingress/{年}/{日}.jsonl(每个出口一条:accepted/duplicate/unauthorized/disabled/invalid)
   ⑤ relay.call('event.emit', { stream:EVENT:WEBHOOK:{源}, actor:"webhook:{源}", payload:{request_id,data} })
   ▼
事件总线 → 消费微服务   订阅 EVENT:WEBHOOK:{源},自己分类/路由(smart endpoint)
```

> **入站为何过 Router 而非直连 ingress**:Router 是 SOLO 唯一入口(CLAUDE.md §2),且它**透传 `authorization` 头**给下游(`router/handlers/forward.js`),所以 API key 走头、不进 RPC params,**不落 Router 审计日志**。`ingress.ingest` 是 public 方法(免 session,由 API key 自校)。
>
> **三层留痕,request_id 贯穿反查**:listener 存**原始请求**(`sha256(request_id)` 寻址)· ingress 存**投递元数据**(按日 jsonl)· 事件流 + 下游存**实际数据**。给一个 request_id 三层都能定位。

---

## 1. 三层职责（谁干什么，别串味）

| 层 | 是什么 | 职责 | 不该做 |
|----|--------|------|--------|
| **listener** | 每个外部对接独立开发的适配器（可在 SOLO 之外 / dev mock） | 吸收外部格式差异、验外部签名、**归一化成统一 JSON**、带 API key 转发 | 不决定下游谁消费 |
| **ingress** | core 中央控制面（本服务） | API key 鉴权/识源/启停、**去重**、基本结构校验、发 `EVENT:WEBHOOK:{源}` | **不解释领域内容**、不抽领域字段、不分类 |
| **消费微服务** | 订阅事件的内部服务/workflow | **自己**解析 `data`、领域分类、后继路由 | — |

**为什么分这三层**：
- 外部格式千差万别 → 必须 per-源 适配，这天然是 **listener** 的活，独立开发不可避免。
- 但"API key 管理、启停、去重、审计"需要**一处统管** → 收口到 **ingress**，否则散到每个 listener 各搞一套。
- "这条 webhook 该触发什么" 是**领域决策** → 留给**消费微服务**，ingress 一旦替它决定就耦合死、消费者丧失灵活性。

> dumb pipe + smart endpoints：ingress 是哑的忠实管道（只管结构、来源、去重），消费者才是聪明的端点（管领域）。

---

## 2. listener ↔ ingress 契约：统一 JSON 信封（v0.1）

listener 归一化后 POST 给 ingress 的 body。**刻意精简——只有两个必填字段。**

```jsonc
// RPC ingress.ingest 的 params(经 Router)    头 Authorization: ApiKey <key>
{
  "request_id": "gh-delivery-7f3a9c2e",
  //  ★ 必填。本次入站的唯一 ID,【由 listener 决定取什么】:
  //     - GitHub 的 X-GitHub-Delivery / Stripe 的 evt_xxx / 自己生成的 UUID 均可
  //     - 用途①【全链路反查】:同一个 id 贯穿 listener→ingress→事件→消费者(§6)
  //     - 用途②【去重】:ingress 按 (source, request_id) 幂等(§5)

  "data": { /* 归一化后的业务数据,ingress 原样透传给消费者 */ }
  //  ★ 必填。listener 把外部 payload 收拾成统一 JSON 放这里。ingress 不解释、不裁剪。
}
```

**为什么没有别的字段**：
- **没有 `source`** —— 来源由 **API key 反查**得出（key → source 名），不让 listener 自报，避免伪造来源。
- **没有 `event`/`type`** —— 领域分类是消费者的事（dumb pipe）。ingress 一律发 `type:"webhook.received"`。
- 真要传少量 listener 上下文（如外部原始时间），可加可选 `meta:{}`，但**默认不要**，保持精简。

---

## 3. ingress 发出的事件

```jsonc
// EVENT:WEBHOOK:{SOURCE}   (ingress 经 event.emit 发出,标准信封见 Event Bus → Format)
{
  "type":       "webhook.received",         // 通用,领域分类是消费者的事
  "source":     "system.ingress",           // Router 认证,不可伪造
  "actor":      "webhook:github",            // provenance:哪个源(由 API key 推出)
  "trace_id":   "...",                       // Router 生成
  "event_id":   "...",                       // Router 生成,每条唯一
  "emitted_at": "...",
  "payload":    "{\"request_id\":\"gh-delivery-7f3a9c2e\",\"data\":{...}}"
  //            ↑ payload 带:
  //              request_id —— 上游关联 ID,继续往下传,供消费者反查 + 二次幂等
  //              data       —— listener 归一化的业务数据原样
}
```

- `actor = webhook:{源}` 复用 2026-06-02 的 actor 正本清源：provenance 在信封 `actor`，不塞 payload。
- 消费者读 `payload.data` 拿业务数据、`payload.request_id` 做关联/自身幂等。

---

## 4. API key：来源识别 + 鉴权 + 启停（三合一）

每个外部对接（listener）在 ingress 配一把 API key。它一物三用：

1. **认证** listener→ingress 这一跳（`Authorization: ApiKey <key>`）。
2. **识别来源**：key → source 实体 → `EVENT:WEBHOOK:{源}` 流 + `actor:webhook:{源}`。listener **不自报** source。
3. **启停单元**：停掉某 key（`enabled=false`）= 停掉那个源，**下游 workflow/agent 完全无感**。

source 实体（Entity Factory 存储）：

```jsonc
{
  "id":          "src_a1b2c3",
  "name":        "github",                  // 唯一,决定流名 EVENT:WEBHOOK:GITHUB
  "keyHash":     "<SHA-256(apiKey),不可逆>",  // ★ 只存哈希,明文 key 仅创建/轮换时显示一次
  "enabled":     true,                      // 启停
  "dedupTtlSec": 86400,                     // 去重窗口(覆盖外部重试,默认 24h)
  "createdAt":   1748880000000,
  "lastFiredAt": null,
  "hitCount":    0,
  "dupCount":    0                          // 被去重挡掉的次数(运维可见)
}
```

> **API key 用哈希、不用可逆加密**（实现选择，比 README 早先的"加密存"更安全且可查）：
> - 入站要按 key **反查**是哪个源 → 必须能查；可逆加密(随机 IV)查不了。故存 `keyHash = SHA-256(key)`，明文 key **只在创建/轮换时返回一次**、永不落库（DB 泄露也拿不到 key，标准 show-once 实践）。
> - 鉴权热路径 O(1):`INGRESS:KEYHASH:{hash} → sourceId` 直接映射；hash 非密、无需常量时间比较。

---

## 5. 去重处理

**键**：`INGRESS:DEDUP:{source}:{request_id}`。
**原子**：`SET key 1 NX EX <dedupTtlSec>`。
- 设置成功 → 新请求 → 继续发事件。
- 设置失败（key 已存在）→ **重复** → 跳过 emit，幂等返回 200（已处理过）。

```
ingress.ingest(经 Router)
  → 头取 key → 验 → 查 enabled → 基本结构校验(§9) → 审计一条
  → SET INGRESS:DEDUP:{source}:{request_id} NX EX ttl
       ├─ 成功 → emit EVENT:WEBHOOK:{源} → { ok, stream, request_id }
       └─ 失败 → dupCount++ → { ok, duplicate:true }   ← 不重复 emit
```

- **TTL = 外部重试窗口**：取 source.dedupTtlSec（默认 24h）。GitHub/Stripe 等会重投，窗口要盖住其重试周期。
- **原子 SET NX** 顺带解决并发同 id（两条同时到，只有一条 NX 成功）。
- request_id 由 listener 保证"同一次外部投递 → 同一个 id"（所以它该取 GitHub delivery id 这种外部稳定 id，而非每次随机）。

---

## 6. 全链路反查（request_id 贯穿）

`request_id` 是贯穿四层的关联键，使任意一次投递可端到端追：

```
外部投递 ──(listener 取/生成 request_id)──▶ listener 日志
   ──(统一 JSON.request_id)──▶ ingress:去重记录 INGRESS:DEDUP:{src}:{rid} + 审计
   ──(写进 emitted event payload.request_id)──▶ EVENT:WEBHOOK:{源} 流
   ──(消费者读 payload.request_id 落日志)──▶ workflow run / agent 处理
```

给一个 `request_id`，可定位：listener 端日志、ingress 去重/审计记录、流里 `payload.request_id` 匹配的那条事件、下游消费记录 —— **整条链路反向可证**。这正是要求 listener 提供稳定 id 的原因。

---

## 7. 两层验签（外部签名 vs API key，分层）

| 验什么 | 谁验 | 为什么 |
|--------|------|--------|
| **外部签名**（GitHub HMAC、Stripe Signature…） | **listener** | 只有它懂那家的方案；对**外部裸 body 字节**验 |
| **API key** | **ingress** | 统一一种；ingress 只面对 listener，不面对千奇百怪的外部系统 |

这就是 ingress 能保持简单的关键：**它永远只处理一种格式（统一 JSON）+ 一种鉴权（API key）**，N 家外部差异全挡在 listener 层。

---

## 8. dumb pipe 原则：ingress 只做结构校验，不做领域分类

ingress 的"基本格式校验"严格限定在**结构层**：
- ✅ body 是合法 JSON 吗？
- ✅ `request_id`（非空字符串）+ `data`（对象）在吗？
- ✅ request_id 长度/字符在合理范围吗（防滥用 dedup key）？

**不做**：判断 `data` 是不是一次"合法的 github push"、抽取领域字段、定领域 type、决定触发谁——**全是消费者的事**。ingress 越过这条线，就回到了"严重耦合、消费者丧失灵活性"的老问题。

---

## 9. 服务结构（标准 SOLO core 服务）

```
api/core/ingress/
├── README.md                 # 本文
├── index.js                  # express:/auth/* 握手 + /jsonrpc(管理 admin + 入站 public)
├── config.js                 # serviceName/port(8070)/redis 键/默认 dedupTtl
├── handlers/
│   ├── auth.js               # Router 握手 + /jsonrpc auth 中间件(照 sample)
│   ├── bootstrap.js          # initializeRedis
│   ├── introspection.js      # ingress.ingest(public) + ingress.source.*(admin) 声明(★ 与 index.js 注册同步)
│   ├── entities.js           # source 实体 schema(keyHash 标 sensitive)
│   └── jsonrpc.js
└── logic/
    ├── index.js              # 组装
    ├── source.js             # source CRUD(Entity Factory)+ keyHash + INGRESS:KEYHASH 映射 + 名唯一
    ├── dedup.js              # SET NX 去重
    ├── audit.js              # 按日 jsonl 投递日志(logs/ingress/{年}/{日})
    └── ingest.js             # ingest 处理:取头 key → enabled → 校验 → 去重 → 审计 → emit
```

### HTTP 面（全部经 Router，无独立外部入站口）

```
app.get('/auth/seed')                  // Router 发现握手(标准)
app.post('/auth/verify')               // 标准
app.post('/jsonrpc', authMiddleware)   // 两类方法:
   ├─ ingress.ingest        public —— 入站投递(listener 经 Router 调;key 在透传头里)
   └─ ingress.source.*      admin  —— 源管理
```

> **入站不再是独立裸端点**:走 Router 的 public `ingress.ingest`。API key 在 `Authorization` 头(Router 透传),不在 params,不落审计日志。middleware 验的是 Router 签名;ingress.ingest 内部再验 API key。

---

## 10. 管理面方法（`ingress.source.*`，admin）

> **方法清单与参数以 introspection 为准** —— 调 `system.introspect` 或读本服务 `handlers/introspection.js`（声明↔注册由 `deploy/check-doc-drift.js` CI 守护）。

两类入口：**public** `ingress.ingest`（listener 经 Router 入站投递，key 在透传头里）+ **admin** `ingress.source.*` / `ingress.log.recent`（源 CRUD、启停、apiKey 轮换、合成 `{request_id, data}` 触发自测、读投递审计日志）。命名遵守 `{service}.{entity}.{action}`（CLAUDE.md §5）。

---

## 11. Portal/system 管理界面

把 ingress 管理放进 `portal/system`，与现有页同构（参照 `EventManagement.tsx` / `NexusManagement.tsx`）。

### 11.1 导航与位置

`Dashboard.tsx` 的 `menuItems` 新增一项，**放在 Event Bus 之前**——数据流"外部 → ingress → 事件总线 → agent"，导航顺读即链路顺序：

```
⇄ Workflows
⇲ Ingress        ← 新增(入站源管理)
⬡ Event Bus      ← ingress 喂给这里
⚄ Agent Nexus
```

- i18n key `nav.ingress`（en `Ingress` / zh `入站网关`）。
- 路由 `<Route path="ingress" element={<IngressManagement />} />`。

### 11.2 页面（`pages/IngressManagement.tsx`）—— 两个 tab

沿用范式：`h-[60px]` header + tab bar（同 EventManagement）、表格、`<Modal>`、`useUI().toast`、footer。**严禁** `window.alert/confirm/prompt`（CLAUDE.md §8）。

**Tab ① SOURCES（设置）** —— 源管理：
- 列：NAME / STREAM(`EVENT:WEBHOOK:{NAME}`) / ENABLED(开关) / DEDUP / LAST FIRED / HITS / DUPS / ACTIONS。
- 行内：启停开关、TEST（`ingress.source.test`）、ROTATE KEY（确认→一次性显示新 key）、RAW、DEL（内联危险确认）。
- 新建模态：name + dedupTtl → 创建后**一次性显示 apiKey**（复制，关闭不再可见）。

**Tab ② DELIVERIES（查看 log）** —— 投递审计：
- 数据源：`ingress.log.recent`（limit 200，最近 7 天，可按 outcome 过滤 + REFRESH）。
- 列：TIME / SOURCE / REQUEST ID / OUTCOME(色标) / STATUS / BYTES。
- outcome 色：accepted=绿、duplicate=黄、unauthorized/invalid=红、disabled=灰。只读（日志在 `logs/ingress/{年}/{日}.jsonl`）。

### 11.3 与 Event Bus 页分工

- **Ingress 页**：管"谁能进来"（源、API key、启停、去重窗口）。
- **Event Bus 页**：管"进来之后"（事件格式、Schedule、Runs）。
- 相邻，构成"入口 → 总线"完整运维视图。

---

## 12. 衔接点（file:line，复用既有机制）

| 用到的 | 位置 | 说明 |
|--------|------|------|
| `event.emit` + `trustEventActor` | `router/index.js:184-190` | ingress 经 relay 调它，声明 `actor=webhook:{源}` |
| 事件注册表 + 前缀通配 | `router/config.js`（`system.ingress`）+ `router/handlers/events.js`（`checkRegistry` 末尾 `*` glob） | 已实现：`'system.ingress': { 'EVENT:WEBHOOK:*': ['webhook.received'] }`，一条通配覆盖所有动态源流 |
| relay bot | `api/library/relay.js` | ingress 用 `system.ingress` bot token 经 Router 调 event.emit（同 nexus scheduler） |
| Entity Factory | `api/library/entity.js` | source 实体 CRUD；`keyHash` 标 sensitive |
| 哈希/随机 | `node:crypto` | `randomBytes` 生成 key、`sha256` 算 keyHash（show-once，不可逆） |
| 时钟 | `api/library/clock.js` | `lastFiredAt` 等用它，不散 `Date.now()`（CLAUDE.md §5） |
| 下游订阅 | workflow `event_subscriptions` / agent `eventSubscriptions` | 路由下沉到这里，ingress 不感知 |

---

## 13. 打包 / 发布决策

**已定 + 已落地（2026-06-02）：发布档** —— ingress 进 SOLO 发行包，与 Gateway 平级。三件套已原子落地：

```
✅ ① core/ingress 服务代码(index.js + handlers/ + logic/)
✅ ② deploy/services.json  { "name":"ingress", "path":"core/ingress/index.js", "port":8070 }
✅ ③ CLAUDE.md §2 真实服务清单表  已增 ingress 行(13 服务)
```

- `deploy/check-doc-drift.js`（CI）：已通过（13 服务，双向一致）。
- `deploy/build.sh` / `gen-entry.js`：已验证 esbuild bundle 成功（ingress 进 solo.js）。

---

## 14. 实施进度

服务代码、Portal 页、Router 事件注册（`system.ingress` + `checkRegistry` 前缀通配）、bundle 均已落地；逻辑层 smoke（create/auth/emit/dedup/disable/rotate）已过。**剩下的是部署期运维 + 全栈端到端，尚未跑**：

- ⬜ **注册到 Router**：Portal → Service Management 加 `http://localhost:8070`（首次）。
- ⬜ **起 `system.ingress` bot**：Portal → Bot Accounts 建 `system.ingress` → 注入 token（自动调 `ingress.token.set`），relay 才能经 Router 调 `event.emit`。
- ⬜ **全栈端到端**：`dev.sh` → 建源 → `mock.sh` → 看事件落流（步骤见下）。

**端到端验证（待全栈跑）**：
```
bash deploy/dev.sh                          # 起全栈(含 ingress)
# Portal → Ingress 创建源,拿一次性 API key(或 RPC ingress.source.create)
INGRESS_API_KEY=ingk_xxx bash deploy/mock.sh # 起 mock listener
curl -X POST localhost:8091/hook -d '{"hello":"world"}'   # 模拟外部 webhook
redis-cli -p 6699 XREVRANGE EVENT:WEBHOOK:MOCK + - COUNT 1 # 看事件落流
```

---

## 15. 开放决策点

| # | 决策 | 选项 | 结论 |
|---|------|------|------|
| ~~D1~~ | 发布档 | 现在进 services.json / 孵化档 | **已定：发布档**（进发行包，三件套一起加，§13） |
| D2 | 信封是否要可选 `meta` | 只 request_id+data / 加可选 meta | 先只两字段，需要再加 |
| D3 | 去重 TTL 默认 | 24h / 7d / per-source 配 | per-source 配，默认 24h |
| D4 | listener 是否纳入本仓 | 各自独立仓/外部 / 仓内放 dev mock listener | 仓内放一个 dev mock listener 打链路，真 listener 各自独立 |
| D5 | 端口 | 8070 / 其他 | 8070（未占用） |

---

## 16. 与协议的关系

| 文档 | 关系 |
|------|------|
| `event.md §1` | "webhook = 入站 + 事件，外部鉴权是入站方自己的事" —— listener 验外部签名正是此意 |
| `event.md §4.7` | `event.emit` 主动发事件通道 —— ingress 收到 listener 投递后的唯一对外动作 |
| `event.md §6.3` | 事件落流后扇出 matcher(路①)/agent(路②) —— ingress 是这条链的外部入口 |
| `event.md §4.3` | actor 正本清源 —— ingress 用 `actor=webhook:{源}` 携带 provenance |
| `CLAUDE.md §2` | ingress 若发布，需进真实服务清单（与 Gateway 平级，core 层） |
| `CLAUDE.md §5/§7/§8` | 声明=注册同步、Entity Factory + sensitiveFields、req.permit 鉴权、前端禁系统弹窗 —— 实施遵守 |
