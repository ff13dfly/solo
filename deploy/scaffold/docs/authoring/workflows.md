# 编排工作流 · 编写指南（AI / 人都能照着写）

> 本文件让你（或一个 AI）**只凭脚手架交付的信息**就能写出一条 orchestrator 能执行的 workflow。
> 校准基准：与 `{{PROJECT_NAME}}` 随附的 Solo v{{SOLO_VERSION}} **执行引擎**（orchestrator runner）逐字段对齐——
> 不是产品愿景文档。引擎不支持的字段这里**不会出现**。
>
> ⚠️ 注意：Solo 仓 `docs/protocol/zh/workflow.md` 是更宏大的协议草案，里面的
> `$resolved` / `$consensus` / 字符串 `condition` / `agent_consensus` 步骤**当前引擎并不执行**。
> **以本文件为准。**

---

## 0. 一条 workflow 由两半拼成

| 半 | 是什么 | 从哪来 |
|----|--------|--------|
| **词汇** | 有哪些方法可调、参数/返回字段、哪些对 AI 开放 | **运行时自描述**：Router 内省所有服务后发布的 capability 目录（见 §1） |
| **语法** | 这些方法怎么拼成一份合法的 workflow JSON | **本文件**（§2 起） |

你已经有"词汇"（运行时能查到），缺的"语法"就在下面。

---

## 1. 先拿到"可调方法目录"（词汇）

每个服务在 `handlers/introspection.js` 里声明自己的方法；Router 启动时逐个内省，聚合成一份机器可读的目录，并写进 Redis。AI 应当**先读这份目录**再动笔，从中知道：方法名 `{service}.{entity}.{action}`、每个参数的 `type/required/maxLength/pattern`、返回字段 `returns`、以及 `ai`（是否对 AI 开放）。

```bash
# 全量目录（方法名 → {service,url,desc,params,returns,ai,public}）
redis-cli --raw GET system:capability:list | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d);console.log(Object.keys(m).join('\n'))})"

# 给 AI 用的语义快照（只含 ai:true 的方法，中/英两份）
redis-cli --raw GET AGENT:CAPABILITY_SNAPSHOT:ZH
```

> 单个方法的参数 schema 示例（来自 `api/sample/handlers/introspection.js`）：
> `{ name:'sample.item.get', params:[{name:'id',type:'string',required:true,maxLength:64,pattern:'id'}], returns:['id','name','status','createdAt'], ai:true }`

**只用 `ai:true` 的方法。** 而且：workflow 执行时引擎会做 **footprint 预审**——提交者的 permit 必须覆盖 workflow 里**每一个** step / resolver 的方法，否则整条直接 403（见 §6）。所以别拼你自己都没权限调的方法。

---

## 2. workflow 对象（顶层字段）

`create()` 实际接收的字段（其它字段会被忽略）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `category` | string | ✅ | 分类（意图匹配用） |
| `name` | string | ✅ | 人类可读名称 |
| `desc` | string | ✅ | 描述（语义搜索/审核展示用，写清楚"被什么触发、$input 长什么样"） |
| `steps` | Step[] | ✅ | 步骤数组，**顺序执行**（见 §3） |
| `id` | string | ❌ | 省略则自动生成 |
| `priority` | number | ❌ | 默认 50 |
| `required_inputs` | string[] | ❌ | 缺这些 input 直接报错（轻量校验） |
| `input_schema` | Schema[] | ❌ | 入参契约，**fail-closed**（见 §5）——事件触发强烈建议加 |
| `allowed_triggers` | string[] | ❌ | 允许的触发源，默认 `["sync"]`（见 §4） |
| `event_subscriptions` | object[] | ❌ | 订阅哪些事件流触发（见 §4） |
| `require_actor_permit` | boolean | ❌ | 默认 `false`。设 `true` 时，**事件触发**的 run 额外要求"引发事件的 actor 本人 permit 覆盖全部步骤方法"，actor 缺失/不可解析（如 `sentinel:{id}`）直接 403（fail-closed；见 §4） |
| `strict_result` | boolean | ❌ | step `result_schema` 违例时是否升级为失败（默认只告警） |
| `resolvers` | object | ❌ | 执行前的"名称→ID"解析（见 §7） |
| `tags`/`examples`/`negative`/`keywords`/`synonyms`/`optional_inputs` | — | ❌ | 纯发现/匹配元数据，引擎执行不读，可省 |

> ⚠️ 协议草案里的 `defaults` 当前 **`create()` 不接收**，写了也不会持久化。因此 `$config.x` 实际等价于 `$input.x`（见 §3.2）。需要默认值就在 step `params` 里写死，或交由下游服务兜底。

---

## 3. Step 对象（RPC step）

引擎里每个 step 都是一次"经 Router 调一个微服务方法"。字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `id` | string | ✅ | step 标识，后续用 `$step.{id}.result.*` 取它的结果 |
| `service` | string | ✅ | 目标服务名 |
| `method` | string | ✅ | 方法名（`{service}.{entity}.{action}`；写短名引擎会自动补 `service.` 前缀） |
| `params` | object | ✅ | 参数对象，值里可用 `$` 变量（见 §3.1） |
| `condition` | object | ❌ | **JsonLogic 对象**，为假则跳过该 step（见 §3.3） |
| `retry` | number | ❌ | 失败重试次数（指数退避），默认 0 |
| `ignore_error` | boolean | ❌ | true 时该 step 失败不终止整条 workflow |
| `result_schema` | Schema[] | ❌ | 校验该 step 返回；默认只告警，`strict_result:true` 时违例即失败 |
| `compensate` | object | ❌ | 补偿声明（仅写进失败清单供人工处理，**引擎不会自动执行**它） |

> **不是原子的**：step 3 失败不会回滚 step 1/2。失败时引擎产出一份 `cleanup_manifest`（已提交的 step + 它们的 `compensate` 声明）供人工善后。非关键步骤用 `ignore_error:true`。
>
> ⚠️ 协议草案的 `type:"agent_consensus"` 多 Agent 共识 step **当前引擎不执行**——别用。每个 step 都按 RPC step 处理。

### 3.1 `$` 变量（参数注入）

`params` 里任何**以 `$` 开头的字符串**会在该 step 执行前、从执行上下文里 just-in-time 解析。根只有这四个：

| 前缀 | 来源 | 例 |
|------|------|----|
| `$input.*` | 触发时传入的 input（同步调用参数 / 事件 payload） | `$input.itemId`、`$input.data.userId` |
| `$config.*` | input 叠加在 defaults 上——当前 defaults 不可设，故**等价于 `$input.*`** | `$config.itemId` |
| `$step.{id}.result.*` | 前序 step 的返回值 | `$step.load.result.status` |
| `$context.*` | **只读**触发溯源：`actor` / `trigger_source` / `trigger_id` | `$context.actor` |

规则：
- 整个字符串必须以 `$` 起头才会被解析（`"$input.x"` ✅；`"id-$input.x"` ❌ 不做插值，原样传）。
- 解析不到 → 该 key 从参数里**删除**（不会传 `undefined`）。
- 根不在 `input/config/step/context` 内 → 返回 undefined（所以 resolver 输出要落到 `$input.*`，见 §7）。
- `$context.*` 是溯源信息，**绝不可当鉴权依据**。

### 3.2 嵌套取值 & 事件信封

事件触发时，ingress 把外部 body 包进信封 `{ request_id, data:<body> }`，所以 webhook 字段在 `$input.data.*`（见 example 03）。深层路径直接点下去：`$input.data.data.object.amount`。

### 3.3 `condition` 必须是 JsonLogic 对象

```json
"condition": { "===": [ { "var": "step.load.result.status" }, "active" ] }
```

- `{"var":"..."}` 的路径相对整个上下文 `{input, step, config, context}`——所以是 `step.load.result.status`，**不带 `$`**。
- **字符串 condition 会被引擎直接拒绝**（判为假 → 跳过）。协议草案里写的 `"$x === 'y'"` 这种**不要用**。
- 常用算子：`===` `!==` `>` `<` `>=` `<=` `and` `or` `!` `in` `var`。

---

## 4. 触发：sync vs 事件

- 默认 `allowed_triggers:["sync"]` —— 只能被 `orchestrator.workflow.run` 同步调起。
- 要被事件触发：`allowed_triggers` 含 `"event"`，并声明订阅：

```json
"allowed_triggers": ["event"],
"event_subscriptions": [
  { "stream": "EVENT:WEBHOOK:EXAMPLE", "filter": { "type": "webhook.received" } }
]
```

- 触发种类取 `triggerSource` 里 `:` 前那段（`sync` / `event` / `cron` / `webhook`）；不在 `allowed_triggers` 里就 403。
- `filter` 可选——按事件字段精确匹配，减少误触发。
- **actor 门（可选纵深）**：事件触发的 run 在服务 bot 身份下执行——footprint 预审查的是 bot 的 permit。若 workflow 做的是敏感写操作、且你想要求"**引发事件的人自己也得有这些权限**"，声明 `require_actor_permit: true`：引擎会用事件信封的 `actor` 反查其 permit 覆盖全部步骤方法，缺一个即 403；actor 缺失或是 `sentinel:{id}` 这类非 uid 形态直接拒（fail-closed）。同步触发不受影响（调用方本人就是 actor，预审已查过）。步骤里可用 `$context.trigger_actor` 读到该 actor（只读溯源，别拿它做鉴权判断）。

---

## 5. 入参与返回校验（flat schema 方言）

`input_schema` 和 step 的 `result_schema` 用同一种扁平方言（与 Router 边界校验一致）：

```json
[ { "name": "itemId", "required": true, "type": "string", "maxLength": 64, "pattern": "id" } ]
```

支持键：`name` `required` `type`(`string|number|boolean|object|array`) `pattern`(命名校验器，如 `id`/`email`/`slug`) `minLength` `maxLength`。

- `input_schema` 在**footprint 预审之前 fail-closed**——事件触发喂的是不可信外部 payload，强烈建议声明，挡住脏数据流进 step。
- `result_schema` 默认只告警；`strict_result:true` 时违例视作该 step 失败。

---

## 6. 生命周期（写完不会立刻能跑）

```
create  ──►  PENDING_REVIEW  ──►  approve(审批人 ≠ 提交人)  ──►  ACTIVE  ──►  可被 run
                   │
                   └─ 高风险(footprint 命中写操作/敏感面)：走 approval 多签 + 签名审批人
                      + 冷静期 effective_at（批准后要等一段才生效，留出叫停窗口）
```

- **所有**新建 workflow 一律落 `PENDING_REVIEW`（C1 审核闸），自审被禁止——AI 自动生成也逃不过这关，这就是安全兜底。
- 风险等级由**footprint**（实际要调的方法）推导，不由提交者自称。
- 运行时引擎再查一遍：状态必须 ACTIVE；过 `input_schema`；过 footprint 预审（提交者 permit 覆盖所有方法）；过冷静期。任一不过直接拒。

相关方法：`orchestrator.workflow.create` / `.approve` / `.deny` / `.run` / `.update` / `.get` / `.list`（具体参数查 §1 的 capability 目录）。

---

## 7. Resolver（执行前名称→ID 解析，可选）

把"用户友好名称"在所有 step 跑之前换成系统 ID：

```json
"resolvers": {
  "lookupItem": {
    "method": "sample.item.search",
    "params": { "name": "$input.itemName" },
    "extract": "[0].id",
    "source": "$input.itemId"
  }
}
```

- `method` + `params`：要调的方法及其参数（`params` 里同样可用 `$` 变量）。
- `extract`：从返回里取值的路径，支持下标 `[0].id`。
- `source`：把取到的值写回上下文的目标路径。**务必写成 `$input.<name>`**——因为 §3.1 里 `$` 变量的根只认 `input/config/step/context`，写到别处后续 step 读不回来。

> resolver 失败只告警、跳过，不终止 workflow。resolver 的方法也计入 footprint 预审。

---

## 8. AI 编写一条 workflow 的步骤清单

1. **读词汇**：从运行时 capability 目录（§1）筛 `ai:true` 的方法，确认每个方法的 `params`/`returns`。
2. **定触发**：同步就 `allowed_triggers:["sync"]`；事件就加 `"event"` + `event_subscriptions`。
3. **定入参**：列 `required_inputs` + `input_schema`（事件触发必写）。
4. **排 steps**：每步给唯一 `id`、填 `service`/`method`/`params`；用 `$input.*` 接入参、`$step.前一步.result.*` 接上一步产出。
5. **加条件/容错**：分支用 JsonLogic 对象 `condition`；非关键步 `ignore_error:true`；不稳的网络调用给 `retry`。
6. **自检**：JSON 能 parse；所有 `$` 变量根 ∈ {input,config,step,context}；condition 是对象不是字符串；只用了你 permit 覆盖的方法。
7. **提交**：`orchestrator.workflow.create` → 进 PENDING_REVIEW → 由另一个人 `approve` → ACTIVE → `run`。

## 9. 最常见的 5 个错（踩了直接挂）

1. `condition` 写成字符串 → 被判假，step 永远跳过。**必须 JsonLogic 对象**。
2. 用了 `$resolved.x` / `$consensus.x` → 解析不到。引擎只有 `input/config/step/context` 四个根。
3. 用了 `type:"agent_consensus"` → 当前引擎不执行，按普通 RPC step 处理后报错。
4. 拼了自己 permit 没覆盖的方法 → footprint 预审整条 403。
5. 以为 `create` 完就能 run → 必须先被**另一个人** approve 转 ACTIVE。

---

## 附：示例（`examples/`）

| 文件 | 演示 |
|------|------|
| `01-sync-minimal.json` | 最简单：同步单步（`planner.todo.create`） |
| `02-sync-multistep-condition.json` | 两步链路：`$step` 取上一步结果 + JsonLogic `condition` + `ignore_error`（`notification.send` → `planner.todo.create`） |
| `03-event-webhook.json` | 事件触发：`allowed_triggers:["event"]` + `event_subscriptions` + `$input.data.*`（`notification.send`） |

> 三个示例只用**随栈默认启动的核心服务** `planner` + `notification`，起栈即可加载试跑。换成你项目自己的方法时，照 §1 的目录改 `service`/`method`/`params`。
> 注意：`sample` 是**代码模板**（`api/sample/`），默认不随栈启动——要用 `sample.item.*` 得先在 `deploy/services.json` 注册它。
