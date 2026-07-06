# SOLO v1.1.x 实施清单

> **本文是"接下来要做什么"的执行依据。** 汇总 2026-07-03 这轮工作产出的两类来源：
> ① `toFix.md` 里核实后仍真实开放的项（已剔除本轮扫描发现的陈旧/已修条目）；
> ② `VERSION.v2.md` / `VERSION.md` §4 拆分后判定"只加不破"、从 v2 拉回 v1.1.x 排期的项。
> 2026-07-05 更新：P0-P1-P2-P4（MCP adapter）已全部实现，见各小节 ✅ 标记。P3 全部、P4 多机部署硬化已明确暂缓存档；P4 剩余（passport TOTP/SSE/外部 agent SDK/metrics 正式档）+ P5（6 项 minor）是低优先级可选项，非阻塞。
> 校对基准：2026-07-05。索引入口仍是 [`BACKLOG.md`](./BACKLOG.md)；v2 边界见 [`VERSION.v2.md`](./VERSION.v2.md)。

---

## 怎么用这份清单

- 每条给：**是什么 / 在哪 / 为什么排这个优先级 / 依赖或需要先拍板的问题**。
- 优先级是建议顺序，不是硬编号——P0 是"不分版本都该做"的 bug，P1-P4 按"对下游影响 × 独立性"粗排，P5 是低优先级磨光。
- 标"**需先拍板**"的项，实现前要先由你定一个策略/设计问题，不建议直接开工。

---

## P0 · Bug（不分版本，优先级最高）

### `_task` fire-and-forget 丢投 —— **✅ 已实现(2026-07-05，router 改动经用户当轮明确授权)**
- **在哪**：`api/router/handlers/tasks.js`（原 `axios.post(...).catch(log)`，非 await，无重试）+ `api/router/config.js`（新增 `tasks.maxAttempts`/`tasks.retryBaseMs`，默认 3 次、200ms 起指数退避，`TASK_MAX_ATTEMPTS`/`TASK_RETRY_BASE_MS` 可覆盖）。
- **落地**：每个 task 的分发从"不 await 的单发 POST"改成 `postWithRetry()`——await + 有限重试（默认 3 次、指数退避），重试耗尽才写入 `ERROR:QUEUE:router`（**复用既有机制**：`core/administrator/logic/error.js` 的 `error.list`/`error.listAll`/`error.clear` 早已对这条队列提供跨服务可查/可清能力，不是新起的 DLQ 结构）。多个 task 之间仍并发派发（`Promise.all`），互不阻塞；`processTasks()` 本身依旧被 `router/index.js` 非 await 调用——不改变主请求的响应延迟，也不改变整体 at-most-once 投递语义（完整 at-least-once 是 B 线，见上方"明确降级/不做"）。
- **验证**：`router/tests/tasks.test.js`（+2 例：瞬时失败重试后成功不进错误队列；重试耗尽才记 `TASK_ERROR`+`attempts` 字段，原有 8 例同步调整为 await 语义后全绿）；`router/tests`(11 套/180 测试)、CI 全量(114 套/1795 测试)、`autocheck --static router`(改动前后错误数不变，均为 router 非标准模板既有误报，已用 `git stash` 对照确认)均绿。未新增 e2e——这是路由层内部重试时序问题，hermetic mock 已能完整覆盖执行路径，不需要真实多服务栈验证。
- **依赖**：无。

---

## P1 · 安全/治理（优先，涉及已知攻击面或架构一致性）

### AI prompt injection 防御 · 第二轮 —— **✅ 已实现(2026-07-03)**
- **在哪**：`api/library/injection-detect.js`（新文件，共享检测函数，非 ingress-only，供未来其他服务复用）+ `api/core/ingress/logic/ingest.js`（接入现有 dataSchema 校验管线，一处调用）。
- **落地**：`type:'string'` 的 declared 字段过完 dataSchema 白名单后，再过一层轻量启发式扫描（4 类已知注入话术模式：ignore-instructions / role-override / role-tag-injection / guardrail-override，见 `injection-detect.js` 的 `PATTERNS`），命中即走现有 dataSchema 违规同一条路径——`review.push()` 进人工审核队列，未另起新通道、未新增状态机。零增量接线成本，只加了一个检测函数 + 一处调用（`ingest.js` 的 `violations` 数组多拼一段 `scanDeclaredStrings(...)`）。
- **明确不做（这轮）**：语义级检测（规则穷举不了自然语言）、`data_fetchers` 等非 ingress 注入面、结构化信任标记——等有真实误报/漏报数据后再评估要不要往下做。
- **验证**：`library/tests/injection-detect.test.js`（10 例，纯函数单测）+ `core/ingress/tests/ingest.test.js`（新增 2 例：命中注入模式→422+进审核队列；普通自由文本→正常放行，不误报），均已加入 `jest.ci.config.js`。未新增 e2e 覆盖——沿用既有先例：dataSchema 白名单本身（上一轮功能）也只有 hermetic 覆盖，无 e2e，此次保持一致，不额外扩面。
- **依赖**：无。

### orchestrator deprecate/reactivate 生命周期 —— **✅ 已实现(2026-07-05)**
- **在哪**：`api/core/orchestrator/logic/workflow.js`（新增 `deprecate()`）+ `handlers/introspection.js`/`index.js`（新方法 `orchestrator.workflow.deprecate`）+ `handlers/entities.js`（状态枚举文案）。
- **拍板结果**：重新激活一个被 deprecate 的 workflow **强制走完整审批**（跟 `restore()` 今天的行为一致），不做时间窗内轻量恢复的捷径。
- **落地**：新增 `DEPRECATED` 状态，与 `PENDING_REVIEW`/`ACTIVE`/`REJECTED`/`DELETED` 并列。`deprecate()` 只能从 `ACTIVE` 触发，记录 `deprecatedAt`/`deprecatedBy`——把"退休一个用了半年的生产 workflow"从"撤销一个从没批准过的草稿"（`delete()`，行为不变，仍可从任意状态直接到 `DELETED`）里分离出独立审计轨迹。`restore()` **零代码改动**就自然接住 `DEPRECATED`（它原本的判断就是"非 ACTIVE/PENDING_REVIEW 一律回 PENDING_REVIEW 走全新审批"），重新走 C1/多签审批才能回 `ACTIVE`。`runner.js`/`matcher.js` 原有的 `status !== 'ACTIVE'` 强校验对 `DEPRECATED` 天然生效（不可执行、不可被 AI 匹配），同样零改动。`update()` 新增一条：`DEPRECATED` 和 `DELETED` 一样冻结编辑，防止跳过 restore+审批直接改动已退休定义。`list()` 默认展示 `DEPRECATED`（不同于需要 `includeDeleted` 才可见的 `DELETED`）。
- **验证**：`core/orchestrator/tests/approval-gate.test.js` 新增 "P1 — deprecate/reactivate lifecycle" 一节（9 例：deprecate 成功 + 记录 who/when；四种非 ACTIVE 状态下 deprecate 均 FORBIDDEN；DEPRECATED 无法 run；restore 从 DEPRECATED 回 PENDING_REVIEW 且清空 deprecation 字段、重新 approve 前无法 run；update 拒绝编辑 DEPRECATED；list 默认展示 DEPRECATED 但不展示 DELETED），CI 全量(114 套/1804 测试)、`check-doc-drift`、`autocheck --static core/orchestrator` 均绿。
- **依赖**：无。

---

## P2 · 可靠性（原 v2 B 线，本轮判定只加不破）

### Saga durable 补偿（跨 orchestrator 重启续跑） —— **✅ 已实现(2026-07-03)**
- **在哪**：`api/core/orchestrator/logic/run.js`（新增 `compensationCheckpoint()`，持久化 `run.compensationProgress`）、`logic/runner.js`（`runCompensations` 改造为读/写游标）、`logic/worker.js`（把 `run.create()` 返回的 `compensationProgress` 传给 `runner.run()`，并挂 `onCompensationCommit` 回调）、`config.js`（新增 `worker.compensationMaxAttempts`，默认 3，`RUN_COMPENSATION_MAX_ATTEMPTS` 可覆盖）。
- **落地**：`run.compensationProgress`（按 forStep 键控：`{compensate, status, attempts, lastError, lastAttemptAt}`）在**每次尝试前后**都持久化（`attempting` → `success`/`failed`），所以就算进程在补偿中途真的崩溃，下一次 `orchestrator.run.retry`（STALLED→RESUMING→`worker.processOne` 重跑）都能读到这份游标：已成功的补偿直接跳过（`skipped:true`，不重新调用下游），未成功的从持久化的 `attempts` 继续数，不会归零重来。
- **重试上限 + 转人工**：`attempts` 达到 `compensationMaxAttempts`（默认 3，跨重启不清零）后该 forStep 标记 `status:'exhausted'`，本轮及以后都**不再真的调用**下游补偿方法，`compensation.failed` 仍为 `true`（沿用既有 DEAD_LETTER 语义），避免"重启→失败→再重启→再失败"的无声循环。
- **零破坏边界**：`compensationProgress`/`onCompensationCommit` 均为新增可选参数，缺省（同步 RPC 路径、或异步首轮）时 `runCompensations` 行为与改造前逐字节一致——已用专门测试验证（见下）。
- **验证**：`core/orchestrator/tests/run.test.js`（+2 例：checkpoint 持久化/RUNNING-only；游标随 `create()` 恢复存活）+ `core/orchestrator/tests/compensation-durable.test.js`（新文件，5 例：runner 层 resume-from-cursor + 到点 exhausted + 无游标时行为不变；worker+run 全链路层用 `processOne` × N 轮模拟"崩溃→STALLED→requeue"，断言 attempts 跨轮持久化、到 cap 后不再真调用下游、成功的条目不被重复调用），均已加入 `jest.ci.config.js`。**e2e**：`e2e/suites/73-saga-recovery.e2e.test.js` 新增一例（对真实 Router+orchestrator+collection 服务，重复"伪造 STALLED→`orchestrator.run.retry`"直到 `exhausted`，断言真实 run 实体上的 `compensationProgress`/`attempts` 语义与上面一致）。
- **依赖**：无强依赖。

### 完整 at-least-once 重投队列 + 全网统一幂等键 —— **明确降级为可选，非阻塞项**
- **在哪**：`worker.js`（`blPop` 破坏性读，at-most-once）。
- **决策**：2026-07-03 已拍板——**不做不算欠账**。现状（STALLED 扫描 + 人工 `orchestrator.run.retry`）是 v1.1 立项时的既定选择，不是意外缺口。真要做，会把投递保证语义从 at-most-once 变成 at-least-once，未做幂等处理的下游 handler 会开始被静默重复调用——这是真正的行为破坏，仍留 v2，量小时可无限期不做。**列在这里只是存档，不是待办。**

---

## P3 · AI 自治转生产级（原 v2 C 线，本轮判定只加不破）

> **2026-07-03 回写**：本节两项均**暂缓**——判定"不是结构性问题"，不占近期排期，仅存档。

### autorun 置信判据重设计（完整版）
- **在哪**：`api/core/agent/logic/decide.js`、`api/core/agent/providers/*.js`。
- **现状**：`risk_tolerance` 具名档位（本轮已落地）只是把阈值变可配置，没有改变置信度信号本身的可信度——模型自评置信度在真实测试中始终聚在 1.0/0.9，不管对错。
- **怎么做（方向，未细化）**：`agent.decide` 的 RPC 契约不需要变，可以在这个契约内换/增强置信度信号——比如多模型交叉验证、基于历史准确率的校准、或者干脆放弃"让模型自评"这个思路换成别的置信度代理指标。这条设计空间比较大，值得先讨论方向再动手。
- **依赖**：无强依赖，但产品定位上"autorun 从实验特性转生产背书"这句话的含金量取决于这条做得扎不扎实，值得认真对待。

### nexus autorun 结构化产出契约（tool-call）
- **在哪**：`api/core/nexus/logic/stream.js`。
- **现状**：autorun 只支持裸文本 `agent.chat`，没有结构化/tool-call 产出契约，即使有 emit-loop 也难可靠解析成动作。
- **依赖**：与 `agent.decide` 契约相关，建议跟"置信判据重设计"放一起规划（同属"AI 自治转生产级"这条主线）。

---

## P4 · 接入面 / 运维正式档（原 v2 D 线 + A 线多机硬化，本轮判定纯增量）

### 多机部署硬化 —— **暂缓(2026-07-03)**
- **在哪**：`router/handlers/auth.js`（category loopback 信任）、`urlFor`。
- **决策**：只要部署仍是单机（服务间通信不跨越不受信网络），loopback 信任缺口不会被触发，不算欠账，不排期。
- **运维约束（"谨慎处理"的具体含义）**：`ROUTER_URL`/各服务间调用的 URL **不能**指向跨机器的公网或不受信网络地址；一旦真要切到多机部署，这条必须先做（`loopback → service-bot token` + TLS，可做成配置开关，`ROUTER_URL` 非 localhost 才切路径，单机部署无感知）。

### MCP adapter —— **✅ 已实现(2026-07-03)**
- **在哪**：`api/core/mcp/`（新服务，第 14 个，参照 `gateway`/`ingress` 的独立适配层模式——作为 Router 的一个 JSON-RPC 客户端接入，未改 router 内部逻辑），端口 8091（`deploy/services.json` + `CLAUDE.md §2` + `api/monolith-entry.js` 已登记）。
- **范围（workflow-first）**：`POST /mcp` 实现 MCP JSON-RPC 2.0 的 `initialize`/`tools/list`/`tools/call`（+ `notifications/initialized` 202 空响应）。`tools/list` 把 `orchestrator.workflow.list` 里 `status==='ACTIVE'` 的 workflow 映射成 MCP tool，`input_schema`（checkParams flat 方言）转换成标准 JSON Schema（`logic/tools.js` 的 `inputSchemaToJsonSchema`）；`tools/call` 转发到 `orchestrator.workflow.run({workflowId, input})`。
- **能力表（其余 RPC 方法）**：仍是 workflow-first 范围内**未做**——只接了 workflow 这一条数据源，其余服务 introspection 汇入同一个 `tools/list` 出口是后续可加项，不阻塞这次落地。
- **鉴权**：`api/core/user/logic/bot.js` 现成的 bot 账号原语（`user.bot.create/issue.token`，`permit` 强制显式枚举方法，§7.3）。adapter 自身**不做鉴权、不持有自己的 relay 身份**——`/mcp` 直接透传 `Authorization: Bearer <caller-token>` 给 `relay.callAs(token, method, params)`，Router `checkAccess` 是唯一执行点；`tools/list` 全部失败（如 token 过期/`orchestrator.workflow.list` 未在 permit 内）按协议级错误返回；`tools/call` 的下游失败（workflow 跑失败、Router 拒绝）统一按 MCP 规范落成 `{content, isError:true}` 的正常工具结果，不是协议错误。
- **验证**：`core/mcp/tests/tools.test.js`（8 例，schema 转换 + isError 分支，已加入 `jest.ci.config.js`）+ 实机起服务对 `/mcp` 五条路径（initialize/无 token/缺 name/未知方法/notification）做了 curl 冒烟，行为符合预期；Router 侧转发（`relay.callAs` 本身、`checkAccess`）复用既有已测机制，未起完整多服务栈做端到端联调（`deploy/seed-registry.js` 是纯 `services.json` 驱动的注册，机制与其余 13 个服务完全一致，无需 router/ 改动）。
- **依赖**：无 router 内部改动（adapter 是外挂客户端）。

| 项 | 在哪 | 一句话 |
|---|---|---|
| passport TOTP 自助 | `api/core/user/logic/passport*.js` | OTP 自助已落地（2026-06-30），加 TOTP 第二档；`passport.md §3.5b` 已有设计。 |
| SSE 推送 | `api/core/gateway/logic/webhook.js`、`notification` | 现在是诚实拒绝（fail-closed）；`gateway.webhook.send` 的出站+签名+SSRF 防护骨架可当模子。 |
| 外部 agent SDK | 新增 | 包装现有"投稿面"（窄 bot + 配额 + snapshot 裁剪）机制，给外部开发者更友好的接入方式。 |
| metrics 正式档 | `library/health.js` | 现有最小 `/metrics` 基础上扩到 Prometheus/Alertmanager 全套；DLQ 深度告警已有最小档。 |

- **依赖**：这几项彼此独立，可以按需挑单条做，不需要整批一起上。

---

## P5 · 既有 minor 磨光（低优先级，toFix.md 历史遗留）

| 项 | 在哪 | 备注 |
|---|---|---|
| README §11 防御上限未强制 | `orchestrator/logic/runner.js` | `steps≤50`/`payload≤64KB`/`depth≤8`/`retry≤5` 四条文档承诺，代码零强制。 |
| nexus scheduler 事件注册表按流手工加条目 | `router/config.js` | `emit_event` 发往非默认流需要手工登记，否则被 `checkRegistry` 挡。 |
| nexus `schedule.list()` 全扫键空间 + 非注入式 `Date.now()` | `nexus/logic/scheduler.js`、`stream.js` | `keys(prefix*)` 效率问题；`identity.js` 已用注入式 clock，`scheduler`/`stream` 还没跟上。 |
| relay refresh 错误分类粗糙 | `library/relay.js:185-197` | 永久 4xx 被当临时错重试；瞬时网络错却清 token 逼手动重注。 |
| 实体 WAL json RMW 并发竞态 | `library/entity.js` | 写+账本已原子，但读改写本身无 CAS，并发 update 互相覆盖。 |
| WAL 单实体快照 >32KB 截断 | `library/entity.js` | 完整版应存 storage CAS + SHA-256 指针，跨服务调用进不了 MULTI，设计待定。 |
| nexus bot 自动发证 | `nexus/logic/sentinel.js` | 现在新建 Sentinel 靠 admin 手工发证；自动发证需要 guard-railed 非-admin `user.bot.*`。 |
| `method.grant` 服务凭证永久化治理 | `docs/protocol/zh/event.md §5.3`（设计已写，实现待查） | "让某个 method 以后都能被 orchestrator 常规调用"的永久授权通道，跟一次性提权（已实现）、C1（已实现）是三条正交机制；这条实现状态需要先核实清楚再排期。 |

---

## 明确不做 / 已取消（存档，避免以后被误当遗漏重新翻出）

- **多租户开放档**：已取消（非推迟）。用 v2 E 线 SOLO Bridge 的联邦隔离替代（每租户一套独立网格），见 [`VERSION.v2.md`](./VERSION.v2.md) §3.1。
- **actor-claim 全量**（用户/服务凭证签名）：仍留 v2，涉及用户私钥管理体系，判定为真正的破坏性架构改动。
- **完整 at-least-once + 全网统一幂等键**：见上方 P2，降级为可选/非阻塞，不算欠账。

---

## 建议推进顺序

> 2026-07-05 更新：**P0-P1-P2-P4（MCP adapter）全部实现落地**，v1-implementation-plan.md 主线清单已清空。P3 全部、P4 多机部署硬化已明确暂缓存档；P4 剩余四项 + P5 六项 minor 是低优先级可选项，见缝插针，不专门排期。

1. ~~**P0**（`_task` 丢投修复）~~ —— **已实现（2026-07-05）**，见上方 P0 小节。
2. ~~**P1 的 AI injection 基础检测**~~ —— **已实现（2026-07-03）**，见上方小节。
3. ~~**P1 的 deprecate/reactivate**~~ —— **已实现（2026-07-05）**，见上方小节。
4. ~~**P2 的 Saga durable 补偿**~~ —— **已实现（2026-07-03）**，见上方小节。
5. ~~**P4 的 MCP adapter（workflow-first）**~~ —— **已实现（2026-07-03）**，见上方小节。
6. **P3 全部、P4 多机部署硬化**——已确认暂缓，不排期。
7. **P4 剩余（passport TOTP/SSE/外部 agent SDK/metrics 正式档）、P5**——低优先级可选项，见缝插针，不用专门排期。
