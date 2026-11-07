# SOLO 履约原语与跨箱直连（`d831b1d`）专项对抗性安全审计报告（`run-3`）

- **审计日期**：2026-11-07
- **审计基线**：`HEAD` = `d831b1d`（`feat(fulfillment,gateway,ingress): 补齐履约五项 RPA 协同原语与 gateway↔ingress 跨箱直连`），并回溯复核 `756c89a`（`docs/security/FULFILLMENT_ROUTER_AUDIT_REPORT.md` 8 项历史修复）
- **方法论**：Cloudflare `security-audit` Skill + SOLO `run-2` 对抗性深审标准——① 既往修复逐条复核矩阵（`CLOSED` / `PARTIAL` / `BYPASS_FOUND`）；② 同效异路横向对表（Same-Effect Cross-Path）；③ 黑名单与输入归一化绕过排查；④ 3 个分域只读 `research` 子代理并行狩猎 + 主会话源码核实。
- **状态**：待修复（遵循「先写单测在旧代码上跑红 → 最小修复 → 跑绿回归」，完成后回填处理结论并移入 `docs/feedback/done/`）。

---

## 一、`756c89a` 既往 8 项安全修复的回归复核矩阵

| 编号 | 原修复目标 | 复核状态 | 代码依据 | 结论摘要 |
|---|---|---|---|---|
| **#1** | `instance.resume` 任意状态回滚与事件震荡 | `BYPASS_FOUND` | [`api/apps/fulfillment/logic/instance.js:450-535, 560-631`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/instance.js#L450-L631) | `advance()` 已正确清空 `suspension: null`；但新引入的 `suspend()` 存在 3 处绕过：① 允许调用方自定义任意 `suspendState`（如 `'PAID'` / `'COMPLETED'`）直接跳进受保护业务状态（**P0-1**）；② 仅拦截 `CANCELLED`，未拦截 `COMPLETED` 等终态，可对已完结实例无限 `suspend ⇄ resume` 震荡重放事件（**P1-1**）；③ 对已 `ON_HOLD` 实例调 `suspend()` 会覆盖 `prevState` 导致永久卡死（**P1-1**）。 |
| **#2** | `expectedTransitionId` 非原子读写 TOCTOU 竞态 | `CLOSED` | [`api/apps/fulfillment/logic/instance.js:37-52, 165, 481, 583, 769`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/instance.js#L37-L52) | `advance`、`suspend`、`resume`、`token.issue`、`update` 全部經 `withInstanceLock` + `optimisticUpdate` 串行化与 CAS 保护。 |
| **#3** | Router 本地 `METHODS` 绕过生产发现与鉴权门禁 | `CLOSED` | [`api/router/index.js:207-297`](file:///Users/fuu/Desktop/AI/solo/api/router/index.js#L207-L297) | 生产门禁与 `category.list` `includeDeleted` 管理员校验完好。 |
| **#4** | `_tasks` 异步分发丢失调用方 `constraints` | `PARTIAL` | [`api/apps/fulfillment/index.js:71-78`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/index.js#L71-L78) · [`logic/instance.js:708-731`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/instance.js#L708-L731) | 常规同步 RPC 路径已闭合；但 `fulfillment/index.js` 后台 `reaperTimer` 进程内直调 `Methods.instance.reap()` 导致超时转移产出的 `_tasks` 绕过 Router 被静默丢弃（**P1-3**）。 |
| **#5** | Profile 治理通道与职责分离（SoD）绕过 | `PARTIAL` | [`api/apps/fulfillment/logic/profile.js:36-47, 141-170`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/profile.js#L36-L47) | `isAdmin` 与 `contributors` 自审拦截完好，且 `stateTtls` 已纳入 `execDigest` 与 `execChanged`；但 `GOVERNANCE_FIELDS` 漏剥离 `status` / `createdAt` / `updatedAt`，`profile.submit` 可注入 `status: 'DELETED'`（**P2-1**）。 |
| **#6** | `loadProfile` 绕过软删除状态校验 | `CLOSED` | [`api/apps/fulfillment/logic/instance.js:107-115`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/instance.js#L107-L115) | `create`、`advance`、`suspend`、`resume`、`reap`、`token.issue` 均经 `loadProfile` 拦截 `DELETED`。 |
| **#7** | `profile.generate` 的 `maxRepairs` 循环无上限 | `CLOSED` | [`api/apps/fulfillment/logic/generate.js:102, 117`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/generate.js#L102) | `MAX_REPAIRS_CAP = 5` 钳制完好。 |
| **#8** | `system.capability.list` 通配符权限过度暴露 | `CLOSED` | [`api/router/handlers/service.js:305-321`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/service.js#L305-L321) | 显式列名校验完好。 |

---

## 二、本次深审发现的漏洞清单（按严重度分级）

### 🔴 P0（High —— 状态机越权跳态与闸门全绕过）

#### P0-1：`fulfillment.instance.suspend` 允许注入任意 `suspendState` 跳入受保护业务状态，直接绕过 `transitions` 条件守卫与 `evidence` 证据闸门
- **位置**：[`api/apps/fulfillment/logic/instance.js:450-466, 527-535`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/instance.js#L450-L535) 及 [`176, 227`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/instance.js#L176-L227)
- **根因（同效异路）**：
  1. `suspend()` 允许调用方传入任意符合 `/^[A-Z][A-Z0-9_]{0,63}$/` 的 `suspendState`（第 464 行），并直接将 `instance.state` 设为 `targetState`（第 530 行），未校验 `targetState` 是否与 Profile 业务状态（如 `'PAID'`、`'DEPOSIT_CONFIRMED'`、`'COMPLETED'`）重名。
  2. 当调用方传入 `suspend({ id, reason: 'x', suspendState: 'DEPOSIT_CONFIRMED' })` 时，实例无需满足 `DRAFT -> DEPOSIT_CONFIRMED` 的 JsonLogic 条件与 `evidence` 证据闸门即直接进入 `'DEPOSIT_CONFIRMED'`，并广播 `EVENT:FULFILLMENT:TRANSITIONED (toState: 'DEPOSIT_CONFIRMED')`。
  3. 紧接着调用方调 `fulfillment.instance.transition({ id, event: 'ship' })`，`advance()` 从 `current.state === 'DEPOSIT_CONFIRMED'` 正常匹配下一跳规则并清空 `suspension: null`（第 227 行），彻底绕过前序状态的所有业务条件与证据校验。
- **最小修法**：
  1. 在 `suspend()` 中禁止 `targetState` 与 `profile.transitions` 中任何已声明的业务状态（`from` 或 `to`，除非该状态仅作为超时收割源状态且等于默认 `'ASSIST_REQUIRED'`）冲突；
  2. 在 `advance()` 中，当 `current.suspension` 非空时，除管理员 `forced`（`override`）、`cancel_requested` 或 `profile.stateTtls[current.state]` 声明的超时事件外，拒绝普通 `transition()`，强制先走 `resume()`。

---

### 🟠 P1（High / Medium —— 终态回滚、单次令牌误毁、证据闸门绕过、跨箱 SSRF 与幂等串单）

#### P1-1：`suspend()` 未拦截 `COMPLETED` 等终态及 `ON_HOLD` 挂起态，导致终态实例可被无限挂起/恢复重放事件、已 `hold` 实例被永久锁死
- **位置**：[`api/apps/fulfillment/logic/instance.js:491-496, 585-630`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/instance.js#L491-L496)
- **根因**：
  1. `suspend()` 第 491 行仅拦截 `current.state === 'CANCELLED'`，未拦截 `'COMPLETED'` 或 Profile 中无出边的终态（`transitions` 非空但无任何 `t.from === current.state`）。持有 `suspend` + `resume` 权限的调用者可将已完结实例在 `COMPLETED ⇄ ASSIST_REQUIRED` 间无限往返切换，重复触发 `EVENT:FULFILLMENT:TRANSITIONED`。
  2. 对处于 `hold` 状态（`lastEntry.event === 'hold_requested'`）的实例调用 `suspend()` 时，会用 `'ON_HOLD'` 覆盖 `prevState` 并写入 `suspension.blockedState = 'ON_HOLD'`；随后调 `resume()` 会回到 `'ON_HOLD'` 且 `lastEntry.event` 变为 `'resume'`，再次调 `resume()` 报错无法恢复，实例永久卡死在 `'ON_HOLD'`。
- **最小修法**：
  1. 在 `suspend()` 中拒绝 `current.state === 'CANCELLED' || current.state === 'COMPLETED'`，以及 `profile.transitions` 非空但不存在 `t.from === current.state` 的终态；
  2. 在 `suspend()` 中拒绝已处于 `hold_requested` 挂起态的实例（要求先 `resume` 再 `suspend`，或直接复用 `suspend`）。

#### P1-2：`fulfillment.instance.callback` 在 `advance()` 校验前提前 `GETDEL` 销毁令牌，一旦证据闸门或条件未过即永久烧毁单次回调令牌
- **位置**：[`api/apps/fulfillment/logic/instance.js:774-783, 843-878`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/instance.js#L843-L878)
- **根因**：
  1. `callback()` 在第 845 行先执行 `redis.getDel(tokenKey)` 销毁令牌，第 860 行才调用 `advance()`。若外部 RPA 执行手回传的 `metaUpdate` 因某项字段未通过 `evaluateEvidenceGate`（如残留掩码或少填字段）或 Profile 处于临时冻结态而抛错，令牌已在 Redis 中被物理删除，且 `catch` 块（第 869-876 行）还将 `tokenId` 从 `pending_callbacks` 抹除，导致 RPA 修好数据后无法重试，实例回调链路彻底断死。
  2. `token.issue`（第 774-782 行）允许对已处于终态的实例签发令牌，且 `pending_callbacks` 未设数量上限。
- **最小修法**：
  1. 在 `callback()` 中：若 `advance()` 抛出异常，检查实例当前的 `history.at(-1)?.transition_id` 是否仍等于令牌绑定的 `rec.expectedTransitionId` 且 `clock.now() < rec.expiresAt`；若是（说明状态尚未推进、仅因本次入参未过条件/证据闸门被拒），则将 `tokenRecord` 按剩余 TTL 写回 Redis 并保留 `pending_callbacks` 项，允许调用方修正参数后重试；仅当实例状态已发生变更（ABA 失效）或令牌已过期时才彻底作废并清理 `pending_callbacks`。
  2. 在 `token.issue` 中拒绝为无出边终态实例签发令牌，并对单实例 `pending_callbacks` 设上限（如最多保留最近 16 个活跃令牌）。

#### P1-3：`create({ idempotent: true })` 二级索引键缺少分隔符转义且先写实例后抢锁，以及后台 `reaperTimer` 静默丢弃 `_tasks`
- **位置**：[`api/apps/fulfillment/logic/instance.js:66-69, 353-365`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/instance.js#L66-L69) · [`api/apps/fulfillment/index.js:71-78`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/index.js#L71-L78)
- **根因**：
  1. `sourceIndexKey` 使用裸冒号拼接 `${SOURCE_PREFIX}${ownerScope}:${profileId}:${sourceId}`。由于 `sourceId` 允许包含冒号（如 `order:100`），`profileId="a", sourceId="b:c"` 与 `profileId="a:b", sourceId="c"`（或含 `:` 的 `owner.value`）会撞上同一个 Redis 键。
  2. `create()` 在第 353-355 行先写 `FULFILLMENT:INSTANCE:<id>` 和 `sAdd(INDEX)`，后执行 `redis.set(srcKey, instanceId, { NX: true })`；跨进程并发竞争失败回滚前，并发 `list()` 会读到短暂的幽灵实例。
  3. `api/apps/fulfillment/index.js:73` 后台定时器直调进程内 `Methods.instance.reap()` 并丢弃返回值，导致超时转移规则配置的 `_tasks`（如超时告警通知）从未发往 Router 执行。
- **最小修法**：
  1. `sourceIndexKey` 使用 `JSON.stringify([ownerScope, profileId, sourceId])`（或长度前缀编码）消除分隔符碰撞，并在 `idempotent` 模式下或新建前先协调索引；
  2. 后台 `reaperTimer` 若 `res._tasks` 非空，通过 `relay` 转发或经 Router 触发，确保超时动作不丢失。

#### P1-4：`evaluateEvidenceGate` 证据闸门存在 3 处绕过（IPv6 映射回环地址、`Object.prototype` 属性名、空对象 `{}`）且 `walkStrings` 无递归深度上限
- **位置**：[`api/apps/fulfillment/logic/rules.js:18-61, 81-109`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/rules.js#L18-L109)
- **根因**：
  1. **`rejectLoopbackUrls` 被 IPv6 映射地址与 `0.0.0.0/8` 绕过**：Node 的 WHATWG `new URL('http://[::ffff:127.0.0.1]:8124/a.pdf')` 会将 `hostname` 规范化为十六进制 `'[::ffff:7f00:1]'`，导致 `rules.js:39` 的 `/^::ffff:127\./.test(h)` 永远无法命中！同时 `http://[::]:8124/`（`h === '::'`）和 `http://0.0.0.1:8124/`（`0.0.0.0/8`）均被放行。
  2. **`getByPath` 原型链属性绕过**：`getByPath` 未拦截 `__proto__` / `constructor` / `prototype` 且未用 `Object.prototype.hasOwnProperty.call`，当 `meta = {}` 时，`getByPath({}, 'toString')` 返回函数并通过 `requiredFields` 检查。
  3. **空对象 `{}` 同时绕过 `requiredFields` 与 `rejectMasked`/`rejectLoopbackUrls`**：传入 `metaUpdate: { tax_id: {}, screenshot_url: {} }` 时，`requiredFields` 判定非空通过，而 `walkStrings` 从空对象提取出 0 条字符串，跳过掩码和死链扫描。
  4. **`walkStrings` 无递归深度上限**：超深嵌套对象可引发栈溢出。
- **最小修法**：
  1. 在 `rules.js` 复用与 `gateway/logic/webhook.js` 一致的 `normalizeHostname`（解包 `::ffff:7f00:1` 十六进制 IPv4 映射地址），并拦截 `h === '::'` 与 `/^0\./.test(h)`；
  2. `getByPath` 拦截原型链键并要求 `hasOwnProperty`；`requiredFields` 拒绝空普通对象 `{}`、非有限数值 `NaN` 与函数；
  3. `walkStrings` 增加最大递归深度限制（`MAX_WALK_DEPTH = 32`）且仅在开启 `rejectMasked || rejectLoopbackUrls` 时执行。

#### P1-5：`gateway.webhook.send` 的 `isLoopbackHost` 正则过宽、缺少 DNS 解析后 IP 校验、且 `GATEWAY:IDEM:<key>` 跨目标全局冲突导致多箱扇出丢单
- **位置**：
  - [`api/core/gateway/logic/webhook.js:51-57, 214-221`](file:///Users/fuu/Desktop/AI/solo/api/core/gateway/logic/webhook.js#L51-L57)
  - [`api/core/gateway/logic/delivery.js:60-96, 131-135`](file:///Users/fuu/Desktop/AI/solo/api/core/gateway/logic/delivery.js#L60-L96)
- **根因**：
  1. `isLoopbackHost`（`webhook.js:55`）使用 `/^127\./.test(h)`，会将以 `127.` 开头的普通域名（如 `127.internal.corp`）误判为本机 loopback 放行；
  2. `client.request` 未挂载自定义 `lookup` 校验，域名如 `127.0.0.1.nip.io` 或 `169.254.169.254.nip.io` 在静态 hostname 检查时放行，DNS 解析后直连回环或云元数据 IP；
  3. `delivery.js:60` 的幂等键 `GATEWAY:IDEM:${key}` 未绑定 `channel` 与 `target`。当同一业务事件用相同 `idempotencyKey` 扇出投递给两个不同 SOLO 箱子（Box B 与 Box C）时，第二次投递命中 Box B 的 `DONE` 记录被静默吞掉！
- **最小修法**：
  1. `isLoopbackHost` 收紧为严格四段 IPv4 `/^127(?:\.\d{1,3}){3}$/`（且每段 `0..255`）；
  2. 在 `webhook.js` 的 `client.request` 中注入自定义 `lookup`，对解析出的真实 IP 再次执行 `isInternalOrReservedHost` / `isLoopbackHost` 校验；
  3. 在 `delivery.js` 中当 `prior` 命中但 `prior.channel !== channel || prior.target !== target` 时（或将幂等键按 `channel + target` 作用域隔离），不复用跨目标结果。

#### P1-6：`ingress.ingest` 的 `meta` 缺少体积/深度/原型链清洗、`request_id` 未做格式与注入扫描、且 `scanDeclaredStrings` 漏扫无 `type` 字段
- **位置**：
  - [`api/core/ingress/logic/ingest.js:119-174`](file:///Users/fuu/Desktop/AI/solo/api/core/ingress/logic/ingest.js#L119-L174)
  - [`api/library/injection-detect.js:52-106`](file:///Users/fuu/Desktop/AI/solo/api/library/injection-detect.js#L52-L106)
- **根因**：
  1. `ingest.js` 未限制 `meta` 的序列化字节数（最大可塞入 10MB）、嵌套深度与 `__proto__`/`constructor`/`prototype` 键；
  2. Router 默认 `PARAM_VALIDATION='warn'`，故 `ingest.js:119` 必须自行校验 `request_id` 格式（禁止控制字符/空白或注入指令文本）；
  3. `injection-detect.js` 的 `scanDeclaredStrings` 仅当 `item.type` 显式声明为 `'string'` / `'object'` / `'array'` 时才扫描；若 `dataSchema` 条目省略了 `type`（如 `{ name: 'remark', required: true }`），该字段被 `extractDeclared` 放行却完全跳过 Prompt 注入扫描！同时 `scanValue` 无最大递归深度保护。
- **最小修法**：
  1. 在 `ingest.js` 增加 `sanitizeMeta(rawMeta)`（限制 `maxMetaBytes = 4096`、最大深度 6、剥离原型污染键），并对 `request_id` 执行字符集与 `scanValue` 检查；
  2. 在 `injection-detect.js` 的 `scanDeclaredStrings` 中兜底按 `val` 的运行时类型扫描，并为 `scanValue` 增加 `maxDepth = 16` 保护。

#### P1-7：`library/logger.js` 的 `logger.error` 向 `stderr` 输出未脱敏原文，且 `redactSensitive` 在 `depth > 4` 时直接返回明文对象
- **位置**：[`api/library/logger.js:48-58, 432-463`](file:///Users/fuu/Desktop/AI/solo/api/library/logger.js#L48-L58) · [`api/apps/fulfillment/logic/instance.js:14-21`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/instance.js#L14-L21)
- **根因**：
  1. `logger.error`（第 433 行）先执行 `console.error(..., ...args)` 打印原始入参，第 461 行才调用 `redactSensitive(params)` 写 Redis。当 `gateway.webhook.send`（含 `secret`）或 `fulfillment.instance.callback`（含 `callbackToken`）报错时，明文密钥直接打进进程标准错误日志。
  2. `redactSensitive` 第 51 行 `if (... || depth > 4) return value;` 在嵌套超过 4 层时原样返回未脱敏对象。
  3. `instance.js` 的 `stripSensitiveMeta` 仅浅删顶层大小写精确匹配的 `callbackToken` / `callback_token`。
- **最小修法**：
  1. `logger.error` 打印到 `console.error` 前先对非 `Error` 对象参数执行 `redactSensitive`；
  2. `redactSensitive` 在超过最大深度时返回 `'[Truncated]'`（或继续按键名脱敏），并扩充 `SENSITIVE_KEY_RE` 覆盖 `device_token`、`access_token`、`refresh_token`、`client_secret`、`webhook_secret`；
  3. `stripSensitiveMeta` 递归剥离敏感键（不区分大小写）与原型污染键。

---

### 🟡 P2（Medium / Low —— 治理字段剥离、Lint 完备性、错误码映射与监控转义）

#### P2-1：`fulfillment` 的 `profile.js` 漏剥离实体生命周期字段、`lint.js` 存在原型属性查找与 `evidence` 配置静默放行
- **位置**：
  - [`api/apps/fulfillment/logic/profile.js:36-47`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/profile.js#L36-L47)
  - [`api/apps/fulfillment/handlers/introspection.js:292-299`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/handlers/introspection.js#L292-L299)
  - [`api/apps/fulfillment/logic/lint.js:42, 106, 124, 157, 187, 264, 307-342`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/lint.js#L307-L342)
- **最小修法**：
  1. `profile.js` 的 `GOVERNANCE_FIELDS` 补入 `'status'`、`'createdAt'`、`'updatedAt'`；`introspection.js` 的 `fulfillment.profile.update` 补齐 `name`、`transitions`、`meta_fields`、`stateTtls` 参数声明；
  2. `lint.js` 的 `buildMethodIndex` 使用 `Object.create(null)` 并用 `hasOwnProperty` 查找 `methodIndex` 与 `taskWhitelist`；Rule 9a 校验 `evidence` 未知键、布尔字段类型、非空路径与非空映射表。

#### P2-2：`gateway/index.js` 错误日志参数传值错误导致客户端 400 错误刷爆 `ERROR:QUEUE:gateway`，且 `webhook.js` 校验错误未设 `-32602`
- **位置**：[`api/core/gateway/index.js:181-184`](file:///Users/fuu/Desktop/AI/solo/api/core/gateway/index.js#L181-L184) · [`api/core/gateway/logic/webhook.js:113-160`](file:///Users/fuu/Desktop/AI/solo/api/core/gateway/logic/webhook.js#L113-L160)
- **最小修法**：`gateway/index.js:181` 改为 `logger.error('Error:', err, { request: params })`；`webhook.js` 参数校验错误统一附带 `err.code = -32602`。

#### P2-3：`ingress.review.approve` 未校验源是否已被禁用或删除，以及 `library/health.js` Prometheus 标签转义不完整
- **位置**：[`api/core/ingress/logic/review.js:56-77`](file:///Users/fuu/Desktop/AI/solo/api/core/ingress/logic/review.js#L56-L77) · [`api/library/health.js:29-34`](file:///Users/fuu/Desktop/AI/solo/api/library/health.js#L29-L34)
- **最小修法**：
  1. `review.approve` 在弹出并发送事件前先校验 `source.get({ id: entry.sourceId })` 存在且 `src.enabled !== false`；
  2. `health.js` 的 `renderMetric` 对 `\`、`\n`、`"` 按 Prometheus 规范完整转义。

---

## 三、处理结论（2026-11-07 已全部闭环修复）

1. **红绿实证闭环**：
   - 先在 [`api/apps/fulfillment/tests/logic.test.js`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/tests/logic.test.js)、[`api/apps/fulfillment/tests/profile-lint.test.js`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/tests/profile-lint.test.js)、[`api/core/gateway/tests/solo-bridge.test.js`](file:///Users/fuu/Desktop/AI/solo/api/core/gateway/tests/solo-bridge.test.js)、[`api/core/ingress/tests/ingest.test.js`](file:///Users/fuu/Desktop/AI/solo/api/core/ingress/tests/ingest.test.js)、[`api/library/tests/logger-redact.test.js`](file:///Users/fuu/Desktop/AI/solo/api/library/tests/logger-redact.test.js)、[`api/library/tests/health.test.js`](file:///Users/fuu/Desktop/AI/solo/api/library/tests/health.test.js) 补齐覆盖全部 11 项发现（`P0-1`、`P1-1`..`P1-7`、`P2-1`..`P2-3`）的回归单测，并在旧代码上实测跑红。
   - 完成最小修复后复跑上述 6 个单测套件（266 项用例）与全仓 CI 套件（141 个套件 / 1875 项测试）100% 通过。
   - 执行 `bash deploy/precheck.sh` 与 `node api/autocheck/checker.js api/core/{gateway,ingress} --static`，全部 `Failed: 0`。
2. **修复状态汇总**：
   - `P0-1`、`P1-1`..`P1-7`、`P2-1`..`P2-3` 共 11 项全部 `CLOSED`，本报告归档至 `docs/feedback/done/security-audit-run3.md`。
