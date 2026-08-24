# 反馈：`runbook/browser-extension-ai-extraction.md` 的代码示例照抄跑不通，且失败形态是**静默的**

> 来源：steward 派生项目，2026-08-22。当时刚把「浏览器插件采电商详情页 → 落库 → 结构化」
> 这条链自己实现了一遍（1688 商品详情页，真实页面、真实数据），回头对照这份 runbook。
> **依据分类**：
> - **本机实测**（solo v1.2.1）：§一（模板插值）、§二（数组塌成对象）—— 直接 `node -e` 跑 `library/jsonlogic.js`，附命令与原始输出。
> - **读码认定**：§三（回写闭环缺失）、§四（顺序依赖）—— 引到 `文件:行号`，未起栈端到端跑。
> - **派生项目实测（1688 详情页）**：§五 —— 数字来自 steward 的真实采集，非本仓库实测。
>
> 涉及：`docs/runbook/browser-extension-ai-extraction.md`、`api/library/jsonlogic.js`、
> `api/apps/fulfillment/logic/instance.js`、`api/router/handlers/forward.js`。
> 影响面：**这份 runbook 是「不改框架代码就能跑通」的承诺**，照抄的人会得到一条
> 看起来全绿、数据全错的链路。
>
> 一句话：架构判断（端侧队列 / 状态机治理长耗时 AI / AI 收敛到 agent）**可以留**，
> 但 §2–§3 的代码示例没有跑过——其中两处会让 AI 收到字面量占位符然后编数据，
> 一处让实例永远停在 `PARSING`。

---

## 一、🔴 `{{instance.meta.dom}}` 这个模板语法不存在（runbook:76）

runbook 的 Profile 里这样传提示词：

```json
"content": "页面 URL: {{instance.meta.url}}\n\n网页内容:\n{{instance.meta.dom}}"
```

而 `api/library/jsonlogic.js:34` 的 `resolveParams` **只在值是「对象且带 `var` 或 `$` 前缀算子」时求值**，
字符串一律原样透传（`:43-45` 的 else 分支）。实测：

```bash
node -e "
const { resolveParams } = require('./api/library/jsonlogic.js');
console.log(JSON.stringify(resolveParams(
  { content: '页面:{{instance.meta.dom}}' },
  { instance: { meta: { dom: '<html>真DOM</html>' } } })));
"
```

```
{"content":"页面:{{instance.meta.dom}}"}      ← 一个字都没替换
```

正确写法是 JsonLogic：`{ "content": { "var": "instance.meta.dom" } }`。

**为什么这条最坏**：AI 收到的是字面量 `{{instance.meta.dom}}`，它不会报错，会照样吐一个
格式漂亮的 JSON。于是状态机正常流转、`instance.meta` 里有结构化数据、控制台一片绿——
**只有内容是编的**。这类失败没有任何信号，等发现时库里已经攒了一批幻觉数据。

---

## 二、🔴 `messages` 数组过 `resolveParams` 会塌成对象（runbook:69）

同一个函数的第二个问题：`resolveParams` 用 `const resolved = {}` 承接
（`jsonlogic.js:37`），对数组走 `Object.entries` 递归（`:41-42`），**数组身份丢失**。实测：

```bash
node -e "
const { resolveParams } = require('./api/library/jsonlogic.js');
const out = resolveParams({ messages: [{role:'system',content:'x'},{role:'user',content:'y'}] }, {});
console.log(JSON.stringify(out));
console.log('还是数组吗:', Array.isArray(out.messages));
"
```

```
{"messages":{"0":{"role":"system","content":"x"},"1":{"role":"user","content":"y"}}}
还是数组吗: false
```

`agent.chat` 拿到的 `messages` 不是数组。**这是框架 bug，不只是文档问题**——任何 profile
的 action 只要传数组参数都会中招，与 AI 无关。

---

## 三、🔴 架构图里那条「AI 结果回写 meta」的箭头，代码里没有对应物（runbook:31）

runbook 的架构图画着 `Agent ──metaUpdate + 事件推进──▶ Fulfillment`，正文也写
「提取字段并回写 meta」。读码认定：**没有任何机制做这件事**。

- `api/apps/fulfillment/logic/instance.js:126-145`：transition 的 `actions` 被编译成 `_tasks` 返回；
- `api/router/handlers/forward.js:103-104`：Router 把 `_tasks` **抽出来派发，并从 result 里删掉**
  （fire-and-forget，不收集返回值）；
- `api/core/agent/` 里对 `fulfillment` 零引用（只有 `providers/mock.js` 提到
  `fulfillment.profile.generate` 那个无关的 canned 响应）。

所以 `agent.chat` 的输出去了 Router，没有回到实例。**照 runbook 建的实例会永远停在 `PARSING`**，
而 runbook 的 §4「查看执行进度与提取结果」直接说 `meta` 里会有 AI 输出，对不上。

缺的是一个组件，二选一：① agent 侧在完成后主动调
`fulfillment.instance.transition({ id, event, metaUpdate })`（但那样 agent 就认识 fulfillment 了，
与「AI 隔离」的设计初衷冲突）；② 让 `nexus` 订阅 agent 的完成事件再推进状态机。
**runbook 应该明说这一步要自己接，或者补上现成实现**——现在它读起来像已经通了。

---

## 四、🔴 建单与推进的顺序依赖被塞进了无序队列（runbook:176-196）

```js
await queue.enqueue({ method: 'fulfillment.instance.create', ... });
await queue.enqueue({ method: 'fulfillment.instance.transition',
  params: { id: idemKey, // 或实例 ID
            event: 'START_PARSE' } });
```

两个问题：

1. **`id` 必须是实例 ID**。`fulfillment/handlers/introspection.js:111` 明写
   `description: 'Instance ID'`；`sourceId` 只在 `instance.create`（`:78`）上。
   注释里那句「或实例 ID」等于承认自己也不确定——按 introspection，`idemKey` 传进去就是找不到实例。
2. **实例 ID 要等 create 返回才有**，而持久化队列的两个条目是**独立重试**的
   （`client/extension-kit/lib/queue.js` 的投递语义就是逐条 at-least-once，没有 `dependsOn`）。
   create 还没成功时 transition 就可能先发，或者 create 重试期间 transition 已经死信。

这是把「有依赖的两步」当成「无依赖的两条投递」。**正确形态**是：只入队 `create` 一条，
把「建完就推进」做成服务端的事（profile 里 `DRAFT` 的自动首跳，或 create 时带
`autoStart`），端侧永远只投一条自足的消息。

---

## 五、内容层面：剥掉 `<script>` 等于把最好的数据源扔了（runbook:121）

> **依据：steward 派生项目 2026-08-22 在 1688 商品详情页实测，非本仓库实测。**

runbook 的清洗把 `script` 一并删掉，理由是「高耗 Token 但对 AI 语义无价值」。实测数字：

| | 整页大小 | 内含 |
|---|---|---|
| 剥掉 script（runbook 的做法） | 34 KB | `window.__` 出现 **0 次** |
| 保留内联 JSON script | 338 KB | 完整 `skuMap` / `skuInfoMap` / `skuRangePrices`：50 个 SKU 的价格、库存、规格 |

电商详情页把一份**完整的结构化模型**序列化在 `<script>` 里。留下它之后，我这边
**根本没用 AI**——括号配平取出 JSON 直接解析，拿到 50 个 SKU 的价格/库存/规格/卖家/阶梯价，
零 Token、零幻觉、不随改版漂移。

所以 §5 那张演进表的顺序值得调整：不是「冷启动全量 AI → 成熟期沉淀选择器」，而是

1. **先探有没有内嵌 JSON**（零成本、精确）——没有才谈 AI；
2. AI 用在「确实只有 DOM 可读」的页面上；
3. 沉淀选择器是第三步。

配套的三条，runbook 里都没提、而它们都会让人撞墙：

- **content script 读不到 `window.context` 这个对象**（ISOLATED world 看不见页面 JS 对象），
  只能读 `<script>` 的**文本**再自己 parse，或另起 MAIN world probe。
- **数值最怕交给 AI**：1688 把 `¥5.01` 拆成三个 span（`¥` / `5` / `.01`），DOM 文本里就是断的。
  AI 很可能读成 `5`——**差 100 倍且看不出来**。runbook 全程没有读回确认或数值校验，
  `AWAITING_REVIEW` 那一格也没定义什么条件才进（置信度门槛是空的）。
- **登录态**：同一页登录前后数据不同（实测那页写着「登录查看全部规格」）。runbook 没提。

另外三处小的：`slice(0, 100000)`（runbook:133）会把 HTML **截在标签中间**且不告知截了多少；
`captureVisibleTab`（runbook:237）**只拍可视区**，长详情页拍不全；`link`/`canvas` 删了没问题，
但 `svg` 里有时带着图标语义——影响很小，一并提一句。

---

## 六、建议（按价值排序）

1. **修 `resolveParams` 的数组塌陷**（§二）——这是框架 bug，波及所有 profile action，
   不改的话任何数组参数都传不进去。`Array.isArray(template)` 时用 `template.map(...)` 返回数组即可。
2. **把 runbook 的 Profile 示例改成 JsonLogic 写法**（§一），并在 `resolveParams` 的文档/注释里
   明写「字符串不做插值」——现在这条语义只能从代码读出来，而猜错的代价是静默的幻觉数据。
3. **补上或明说 §三 那个缺失的回写环节**。要么给一份 nexus 订阅的现成配置，要么在 runbook 里
   用红字标出「这一步需要你自己接，本文不含实现」。现在它读起来像已经通了。
4. **§四 改成只入队一条自足消息**，把「建完就推进」放到服务端。顺带在 runbook 里点明
   `instance.transition` 的 `id` 是实例 ID，不是 sourceId/idemKey。
5. **§五 的顺序调整**：先探内嵌 JSON，再考虑 AI。并补上 ISOLATED world、数值校验、登录态三条。
6. 长期：这份 runbook 通篇没有「怎么验证 AI 提取对不对」的环节。建议加一节
   **交叉校验**——同一页用两种路径（AI 抽取 vs 内嵌 JSON/选择器）各取一次，
   不一致就进 `AWAITING_REVIEW`。AI 提取的价值在覆盖未知页型，但它的正确性必须由别的东西背书。

---

## 处理结论

**2026-08-22 triage（solo 会话）：五条全部成立，当日落地。** 逐条核实方式与结论：

- §一 / §二：本机复跑 feedback 附的复现命令，**全部复现**。§二比报告的还糟一层——
  `cat` 等非 `var` 算子也不被 `resolveParams` 识别（启发式只认顶层 `var`/`$` 前缀键），
  所以 params 模板里**根本没法做字符串拼接**，只能整字段 `{var}`。
- §三：读码证实。`handlers/tasks.js` 的 `postWithRetry` 只 `axios.post` 不收返回值；
  实例上的 `pending_callbacks` 全仓库无人读写，是死字段。
- §四：`introspection.js` 明写 id = Instance ID；`lib/queue.js` 注释自证「队头失败退避后，
  下次唤醒时后面的照常发」。
- §五：内容判断采纳，写进新 runbook 时按纪律标注「派生项目实测」。

**triage 中另发现四点（feedback 未提）**：

1. **Router task 白名单默认没有 agent**（`router/config.js` 只有 notification/gateway）——
   旧 runbook 的 `_tasks: agent.chat` 还有第五个断点，前四条全修好也会被白名单拒。
2. **`agent.chat`/`agent.text.parse` 的 `text` 参数 maxLength 4000**（validator 强制）——
   「整页 DOM 灌给 agent」在方法契约层就不成立；`meta` 这类 object 参数整体上限 ~10MB，
   DOM 留档没问题，但送 AI 的必须蒸馏。
3. **`fulfillment.instance.create` 不按 sourceId 去重**（每次生成随机 FL- id）——
   at-least-once 队列重投会建重复实例；旧 runbook 的 idemKey 只挡队列层。
4. **回写闭环的现成拼法其实存在**：orchestrator matcher 支持事件订阅触发 workflow
   （`trigger_source='event:{stream}'`，按 entry ID 幂等），fulfillment 转移已发
   `EVENT:FULFILLMENT:TRANSITIONED`。§三的二选一（agent 认识 fulfillment / nexus 订阅）
   都不必：workflow 三步 `instance.get → agent.text.parse → instance.transition(metaUpdate)`
   即闭环，2026-08-22 在 dev 栈（AI_PROVIDER=mock）**端到端实测跑通**
   （`CREATE→DRAFT | START_PARSE→PARSING | PARSE_SUCCESS→COMPLETED`，meta 里拿到回写）。

**落地动作**（对应建议 1–6）：

- ✅ 建议 1：`api/library/jsonlogic.js` 修数组塌陷（`Array.isArray → map`，保持数组身份
  逐元素求值）+ `library/tests/jsonlogic.test.js` 更新（33 例绿，CI 白名单 129 套无回归）。
- ✅ 建议 2：`resolveParams` 注释明写「字符串不插值、只认顶层 var/$」；`cat` 识别**不扩**
  （启发式误伤普通对象的风险大于收益，拼接需求由端侧或 workflow 消化）。
- ✅ 建议 3：不是「补文档说要自己接」，而是整个换架构——runbook 重写为事件触发 workflow
  闭环（见上第 4 点），profile 回归纯状态图。
- ✅ 建议 4：runbook §4 改为一条自足消息 + 自定义 `send`（`instance.list(sourceId)` 幂等探测
  → create → transition 串行）；`instance.list` 的 `sourceId` 过滤逻辑层本就支持但 introspection
  未声明，已补声明（`apps/fulfillment/handlers/introspection.js`，静态门禁绿）。
- ✅ 建议 5：runbook §6 顺序调整为「内嵌 JSON → AI 蒸馏文本 → 选择器沉淀」，补
  ISOLATED world / 数值拆 span / 登录态 / captureVisibleTab 四条。
- ✅ 建议 6：runbook §7 新增交叉校验（双路径比对 + 数值规则，不过则 `PARSE_NEED_REVIEW`
  进 `AWAITING_REVIEW`，顺带给该状态定义了进入条件）。
- 旧 runbook 里 Router 端口写的 8440 也是错的（真实 8600），重写稿一并修正。
- ⏳ 留 BACKLOG（框架级、本次不动）：`instance.create` 的 sourceId 幂等去重；
  agent 长文本上限的正式方案；`pending_callbacks` 死字段清理。见 `docs/planning/BACKLOG.md §3`。
