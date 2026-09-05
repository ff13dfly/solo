# 浏览器插件 + Fulfillment + AI 网页智能提取操作指南

> **适用场景**：面对全新或未适配规则的网页，通过 SOLO 现成的**浏览器插件（Extension Kit）**、
> **履约状态机（Fulfillment）**、**编排引擎（Orchestrator）** 与 **AI 中枢（Agent）**，完成
> 「页面采集 ➔ 状态机流转 ➔ AI 结构化抽取 ➔ 结果回写落库与审计」的完整闭环。
>
> **实测状态**：主链路（§2 profile + §3 workflow + 建单/推进/回写/COMPLETED）2026-08-22 在
> dev 栈（solo v1.2.1 + `resolveParams` 数组修复，`AI_PROVIDER=mock`）端到端跑通，
> 文中 JSON/代码即实跑版本。§6 的内容策略数字来自 steward 派生项目在 1688 详情页的实测（非本仓库）。
> 本文替代 2026-08-22 之前的旧版——旧版示例未经实测且有五处跑不通，
> 逐条分析见 [`docs/feedback/done/runbook-browser-extension-ai-extraction-not-runnable.md`](../feedback/done/runbook-browser-extension-ai-extraction-not-runnable.md)。

---

## 1. 架构总览

```
┌────────────────────────┐
│  目标网页 Content Script │  ① 先探内嵌 JSON（见 §6）②清洗 ③蒸馏出 ≤4000 字符文本
└───────────┬────────────┘
            │ chrome.runtime.sendMessage
            ▼
┌────────────────────────┐
│ Extension Kit (Worker) │  持久化队列，**一条自足消息**（见 §4）
└───────────┬────────────┘
            │ send: instance.list(sourceId) → create → transition(START_PARSE)
            ▼
┌────────────┐   DRAFT→PARSING 转移落库后，fulfillment 自己发
│   Router   │──▶ EVENT:FULFILLMENT:TRANSITIONED 上事件总线
└─────┬──────┘
      ▼
┌────────────────────────┐      事件订阅匹配      ┌─────────────────────────────┐
│  Fulfillment 履约引擎   │ ────────────────────▶ │  Orchestrator matcher/worker │
│  DRAFT → PARSING →     │                       │  workflow 三步：             │
│  COMPLETED / REVIEW    │ ◀──────────────────── │  ① fulfillment.instance.get  │
└────────────────────────┘  ③ transition(        │  ② agent.text.parse          │
                               PARSE_SUCCESS,    │  （②经 Router 调 Agent 服务） │
                               metaUpdate=AI输出) └─────────────────────────────┘
```

**回写闭环住在一个事件触发的 orchestrator workflow 里**，不在 fulfillment profile 的
`actions` 里。这不是风格偏好，是五个实测断点决定的——profile `actions` 直调 `agent.chat`
的写法（旧版 runbook 的做法）每一步都过不去：

| # | 断点 | 位置 |
|---|------|------|
| 1 | `resolveParams` **不做字符串插值**——`{{instance.meta.dom}}` 原样透传，AI 收到字面量后照样编出漂亮 JSON，全绿假数据 | `api/library/jsonlogic.js` |
| 2 | ~~数组参数塌成对象~~（2026-08-22 已修，数组现在保持身份逐元素求值） | 同上 |
| 3 | `_tasks` 是 fire-and-forget：Router 派发后**丢弃返回值**，AI 输出永远回不到实例，实例卡死在 PARSING | `api/router/handlers/tasks.js` |
| 4 | Router task 白名单默认**没有 agent**（只有 notification/gateway），`_tasks: agent.chat` 会被当场拒 | `api/router/config.js` `taskWhitelist` |
| 5 | `agent.chat` / `agent.text.parse` 的 `text` 参数 **maxLength 4000**（validator 强制），整页 DOM 根本进不去 | `api/core/agent/handlers/introspection.js` |

workflow 路径天然绕开 1/2/4（orchestrator 有自己的 `$` 变量求值、workflow 步骤走正常 RPC
不走 task 白名单），3 由 workflow 的回写步骤补上，5 靠端侧蒸馏（§6）消化。

**分层职责**：Extension Kit 管防丢与幂等投递；Fulfillment 管状态、历史、审计与人工介入；
workflow 管「事件 → AI → 回写」的编排（且受治理线审批约束）；Agent 收敛所有大模型调用，
业务侧不碰三方 Key。AI 输出只进 `instance.meta`、经状态机把关流转，不直写核心数据。

---

## 2. 第一步：创建履约状态机模板（纯状态图）

Profile 只声明状态与转移，**不带 `actions`**（AI 调用在 §3 的 workflow 里）：

```json
{
  "method": "fulfillment.profile.create",
  "params": {
    "id": "dom-ai-extractor",
    "name": "网页 DOM 智能提取（状态图）",
    "transitions": [
      { "event": "START_PARSE",       "from": "DRAFT",           "to": "PARSING",         "condition": null, "actions": [] },
      { "event": "PARSE_SUCCESS",     "from": "PARSING",         "to": "COMPLETED",       "condition": null, "actions": [] },
      { "event": "PARSE_NEED_REVIEW", "from": "PARSING",         "to": "AWAITING_REVIEW", "condition": null, "actions": [] },
      { "event": "MANUAL_APPROVE",    "from": "AWAITING_REVIEW", "to": "COMPLETED",       "condition": null, "actions": [] },
      { "event": "FAIL",              "from": "PARSING",         "to": "FAILED",          "condition": null, "actions": [] }
    ]
  }
}
```

`AWAITING_REVIEW` 的进入条件由 §3 workflow 的校验步骤决定（§7 交叉校验不一致、或数值
校验不过时发 `PARSE_NEED_REVIEW` 而非 `PARSE_SUCCESS`）——不要留一个永远没人走的状态。

---

## 3. 第二步：注册事件触发的提取 workflow（回写闭环）

### 3.1 一次性准备：给 `system.orchestrator` bot 补 agent 权限

workflow 由 orchestrator worker 以 `system.orchestrator` bot 身份执行，其默认 permit
（`deploy/bot-permits.js`）**不含 agent**——不补这一步，run 会停在 `PAUSED_AWAITING_HUMAN`
等人工 `orchestrator.run.grant`。管理员执行一次（`services` 是整体替换，要带上原有各项）：

```json
{
  "method": "user.bot.update",
  "params": {
    "uid": "system.orchestrator",
    "permit": { "allow_all": false, "services": {
      "collection": ["*"], "market": ["*"], "notification": ["*"], "fulfillment": ["*"],
      "user": ["user.permit.get"],
      "approval": ["approval.gate.open", "approval.gate.sign", "approval.gate.get"],
      "agent": ["agent.text.parse"]
    } }
  }
}
```

### 3.2 workflow 定义（实测版本）

```json
{
  "name": "DOM AI 提取闭环",
  "category": "extraction",
  "desc": "EVENT:FULFILLMENT:TRANSITIONED(PARSING) → agent.text.parse → 回写 transition",
  "allowed_triggers": ["event"],
  "event_subscriptions": [
    { "stream": "EVENT:FULFILLMENT:TRANSITIONED", "filter": { "type": "instance.transitioned" } }
  ],
  "steps": [
    { "id": "fetch", "service": "fulfillment", "method": "fulfillment.instance.get",
      "params": { "id": "$input.instanceId" },
      "condition": { "and": [
        { "===": [{ "var": "input.profileId" }, "dom-ai-extractor"] },
        { "===": [{ "var": "input.toState" }, "PARSING"] } ] } },
    { "id": "extract", "service": "agent", "method": "agent.text.parse",
      "params": { "text": "$step.fetch.result.meta.text" },
      "condition": { "and": [
        { "===": [{ "var": "input.profileId" }, "dom-ai-extractor"] },
        { "===": [{ "var": "input.toState" }, "PARSING"] } ] } },
    { "id": "writeback", "service": "fulfillment", "method": "fulfillment.instance.transition",
      "params": { "id": "$input.instanceId", "event": "PARSE_SUCCESS",
                  "metaUpdate": { "ai": "$step.extract.result.data" } },
      "condition": { "and": [
        { "===": [{ "var": "input.profileId" }, "dom-ai-extractor"] },
        { "===": [{ "var": "input.toState" }, "PARSING"] } ] } }
  ]
}
```

**语义要点**（都是实测/读码确认的，不是猜的）：

- **事件 `payload` 就是 `$input`**：fulfillment 每次转移发的 payload 含
  `instanceId / profileId / sourceId / fromState / toState / event`（`apps/fulfillment/logic/instance.js`）。
- **`filter` 只能匹配信封顶层字段**（`type`/`source`/`actor`——精确相等，不进 payload）。
  按 profileId/toState 细筛要靠**每个 step 的 `condition`**（JsonLogic，数据根是
  `input/step/config/context`）。三个 step 都要挂同一个 guard——条件不满足的 step 被跳过，
  不会报错。
- **空转 run 是预期行为**：该 profile 的**每次**转移（包括回写触发的 PARSING→COMPLETED）都会
  触发一次 workflow，不匹配的那些 run 三步全 skip、状态 DONE、零副作用。不构成死循环，
  但 run 实体会累积，排查时别被它们迷惑。
- **`$` 变量只支持整段替换**：`"$step.fetch.result.meta.text"` 可以，`"前缀 $input.url"` 这种
  串内拼接不支持（只有 `idempotency_key` 例外）。要给 AI 组合多段上下文，就在端侧拼好放进
  `meta.text`。step id 用 `\w`（字母数字下划线），别带连字符。
- **治理线**：生产按 orchestrator GUIDE 配方一走——`orchestrator.workflow.create`（落库即
  `PENDING_REVIEW`）→ **换一个人** `workflow.approve`（自审禁止；高风险走多签 + 冷静期）→
  `workflow.build` 刷新能力快照。dev 栈可参考 `deploy/mock/inject-workflows.js` 直接注入 ACTIVE。
- **时序**：matcher 每 ≤5s 重扫 ACTIVE workflow 的订阅流、对新流**从 `$`（只读新消息）建消费组**。
  workflow 激活后等一个发现周期（约 8s）再发首个事件，否则事件早于消费组、静默丢失。

---

## 4. 第三步：插件端采集与投递（一条自足消息）

### ① Content Script（先探结构化数据，再蒸馏文本）

```javascript
// content.js — 运行在目标网页上下文（ISOLATED world）
function capture() {
  // 1. 先探内嵌 JSON（§6：命中就根本不需要 AI）。注意 content script 读不到页面的
  //    window.* JS 对象（ISOLATED world），只能读 <script> 的文本再自己 parse。
  const embedded = probeEmbeddedJson(document);   // 站点无关的启发式，未命中返回 null

  // 2. 未命中才走 AI 路径：清洗后蒸馏出给 AI 的文本。
  //    agent 的 text 参数上限 4000 字符（Router validator 强制）——这不是本文自设的约束，
  //    是框架在逼你把「喂给 AI 的东西」做小：取正文/标题/关键区块，不是整页 DOM。
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, iframe, canvas').forEach((el) => el.remove());
  const text = clone.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 4000);

  return {
    url: location.href,
    title: document.title,
    embedded,                      // 命中时是结构化对象，交叉校验（§7）也用它
    text,                          // AI 路径的输入，≤4000 字符
    capturedAt: new Date().toISOString(),
  };
}

chrome.runtime.sendMessage({ type: 'CAPTURE_TASK', payload: capture() });
```

原始 DOM 若确需留档，放 `meta` 里没问题（Router 对 object 参数整体上限约 10MB，不逐字段卡），
但**别指望把它直接塞给 agent**——送 AI 的只有蒸馏后的 `text`。

### ② Background Worker（一条消息、自带幂等，send 里串行三步）

旧版把 `create` 和 `transition` 当两条独立队列消息投递，是错的：持久化队列的条目**逐条
独立重试、失败退避后后面的照常发**（`lib/queue.js` 的明文语义），create 失败时 transition
会先出门；且 `transition` 的 `id` 是**实例 ID**（create 返回才有），不是 sourceId/idemKey。
正确形态是**一条自足消息**，依赖顺序收进自定义 `send` 里：

```javascript
// background.js（基于 client/extension-kit）
import { createRpc, createQueue, createSession, createEndpoints, chromeArea } from './kit.js';

const local = chromeArea('local');
const session = createSession({ local, session: chromeArea('session') });
const eps = createEndpoints({ backend: local, presets: [{ url: 'http://localhost:8600/jsonrpc', name: '本地全栈' }] });
const rpc = createRpc({ getEndpoint: eps.get, getToken: session.getToken, setToken: session.setToken, reauth: () => {/* ... */} });

async function deliverCapture(payload) {
  const sourceId = (await rpc.sha256(`dom:${payload.url}:${payload.capturedAt.slice(0, 10)}`)).slice(0, 32);

  // 幂等探测：create **不按 sourceId 去重**（每次都会生成新实例）。at-least-once 队列
  // 必然重投，所以先查再建。sourceId 过滤是 instance.list 的声明参数。
  const existing = await rpc.attempt('fulfillment.instance.list', { sourceId });
  let inst = existing.items[0];

  if (!inst) {
    inst = await rpc.attempt('fulfillment.instance.create', {
      profileId: 'dom-ai-extractor',
      sourceId,
      meta: { url: payload.url, title: payload.title, text: payload.text,
              embedded: payload.embedded, capturedAt: payload.capturedAt },
    });
  }
  // 只在还没推进过时才推进（重投时实例可能已在 PARSING/COMPLETED）
  if (inst.state === 'DRAFT') {
    await rpc.attempt('fulfillment.instance.transition', { id: inst.id, event: 'START_PARSE' });
  }
}

const queue = createQueue({
  backend: local,
  // 必须用 attempt（单层重试归队列管），send 整体失败则整条退避重投——
  // 三步里任何一步挂掉，下轮从 list 探测重入，不会重复建单。
  send: (item) => deliverCapture(item.params),
  scheduleWake: (ms) => chrome.alarms.create('solo-queue', { when: Date.now() + ms }),
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'solo-queue') queue.drain(); });
chrome.runtime.onStartup.addListener(() => queue.drain());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'CAPTURE_TASK') return;
  queue.enqueue({ method: 'capture.dom', params: msg.payload,
                  idemKey: `cap-${msg.payload.url}-${msg.payload.capturedAt.slice(0, 10)}` })
       .then(() => queue.drain());
});
```

---

## 5. 查看执行进度与提取结果

```json
{ "method": "fulfillment.instance.get", "params": { "id": "FL-20260822-5818" } }
```

- **`state`**：`PARSING` ➔ `COMPLETED`（或 `AWAITING_REVIEW`/`FAILED`）；
- **`meta.ai`**：workflow 回写的 AI 结构化输出（`agent.text.parse` 的 `data`）；
- **`history`**：实测跑通的完整链是
  `CREATE→DRAFT | START_PARSE→PARSING | PARSE_SUCCESS→COMPLETED`，
  每条含时间戳、触发事件、关联用户；
- workflow 侧留痕看 `orchestrator.run.list / run.get`（管理员）。

---

## 6. 冷启动内容策略（顺序很重要）

> 数字来源：steward 派生项目 2026-08-22 在 1688 商品详情页实测（非本仓库实测）。

| 顺位 | 策略 | 依据 |
|---|---|---|
| **①** | **先探内嵌 JSON** | 电商详情页普遍把完整数据模型序列化在 `<script>` 里。实测同一页：剥掉 script 后 34KB、结构化线索为零；保留后 338KB 里有完整 `skuMap`——50 个 SKU 的价格/库存/规格，括号配平取出直接 parse，**零 Token、零幻觉、不随改版漂移**。 |
| **②** | **AI 只吃蒸馏文本** | ①未命中的页型才走 AI；4000 字符上限（§1 断点 5）本身就排除了「整页 DOM 灌给大模型」。 |
| **③** | **沉淀选择器降本** | 成熟期让 AI 顺带推断 CSS/XPath 选择器下发插件端，后续本地抽取。 |

旧版的顺序（冷启动全量 AI → 成熟期才沉淀规则）是反的：把最好的数据源（内嵌 JSON）当噪声
剥掉了，还把最贵最不可靠的路径放在第一步。

**三个必踩的坑**（不提前知道每个都要撞一次）：

- **ISOLATED world**：content script 看不见页面的 `window.*` 对象，内嵌数据只能从
  `<script>` 的**文本**里 parse，或另起 MAIN world probe。
- **数值最怕交给 AI**：1688 把 `¥5.01` 拆成三个 span（`¥`/`5`/`.01`），DOM 文本是断的，
  AI 读成 `5` 差 100 倍且看不出来。数值字段必须有校验（§7）。
- **登录态**：同一页登录前后数据不同（「登录查看全部规格」）。采集时把登录态记进 meta，
  别把两种状态的数据混进同一个 sourceId。

另外：`slice()` 截断会切在标签/词中间且不告知截了多少，蒸馏时按语义块取舍；
`chrome.tabs.captureVisibleTab` **只拍可视区**，长详情页拍不全，多模态路径要滚动拼接。

---

## 7. 交叉校验：AI 输出必须由别的东西背书

AI 提取的价值在覆盖未知页型，但它的正确性自己保证不了。给 §3 的 workflow（或端侧）加一道
校验，决定发 `PARSE_SUCCESS` 还是 `PARSE_NEED_REVIEW`：

1. **双路径比对**：`meta.embedded`（内嵌 JSON 路径）存在时，与 AI 输出逐字段比对，
   关键字段（价格/库存/SKU 数）不一致 → `PARSE_NEED_REVIEW` 进 `AWAITING_REVIEW`；
2. **数值规则**：价格 > 0、在品类合理区间、AI 输出的数字必须能在 `meta.text` 原文里找到
   （防拆 span 断读）；
3. 校验全过才 `PARSE_SUCCESS`。这样 `AWAITING_REVIEW` 有了明确定义的进入条件，
   人工只看机器拿不准的。

---

## 8. 常见问题排查（Troubleshooting）

| 症状 | 原因与处置 |
|---|---|
| 实例永远停在 `PARSING`，run 显示 `PAUSED_AWAITING_HUMAN` | bot permit 缺方法（多半是 §3.1 没做）。`orchestrator.run.grant { id, methods }` 一次性放行并重入队，然后把 permit 补上。 |
| workflow 激活后首个实例没被处理 | matcher 建消费组从 `$` 起读——事件发早了。等 ~8s 再发，或对该实例手工重发 `START_PARSE` 前先 `override` 回 DRAFT。 |
| `INVALID_PARAMS: parameter 'text' length exceeds maximum limit of 4000` | 端侧蒸馏没做（§4①），把整页塞进去了。 |
| RPC `-32007 (RETRY_LATER)` | 上游 LLM 限流/超时。orchestrator 对瞬时错误自动退避重试（上限 5 次后进死信），无需手动干预。 |
| 同一页面出现多个实例 | send 里没做 `instance.list(sourceId)` 幂等探测（§4②）——`instance.create` 不按 sourceId 去重。 |
| run 列表里一堆「全 skip 的 DONE」 | 预期行为（§3.2 空转 run），不是故障。 |
| Service Worker 休眠后不发 | `manifest.json` 要有 `"alarms"` 权限；`onStartup` 里挂 `queue.drain()`。 |
| 长驻采集循环隔天开始安静失败 | bot session token 24h TTL——token 刷新必须放在循环体内每轮做，不能只在循环外做一次。 |
