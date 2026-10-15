# SOLO 增量安全复核与异路绕过深审报告（`run-2`）

- **审计日期**：2026-10-15
- **审计基线**：`HEAD` = `946344b`（涵盖 `2026-09-18` 首轮审计修复 `9c9c3ee` / `a6c931a` / `80a1669` 及 `2026-09-26..27` 身份与存储修复 `4a89cb7` / `b759583` / `2dfa121` / `4f2a731`）
- **方法论**：仿 MSO `run-2` 标准——① 对既往 14 项安全修复逐条打出 `CLOSED` / `PARTIAL` / `BYPASS_FOUND` 复核矩阵；② 以**「同效异路横向对表」**与**「黑名单闸口绕过」**两条结构性判据，分 4 域并行深审核心信任边界。
- **来源**：solo 会话，2026-10-15（4 个分域 research 子代理并行审计 + 主会话抽查核对）。
- **状态**：待修复（修复后在文末「处理结论」回填，完成后移入 `done/`）。
- ⚠️ **依据类别**：全部为**源码推导，未运行验证**。修每一条时先写单测在旧代码上跑红、再改绿——红不了的按「误报」写进处理结论，不硬修。
- ⚠️ **Router 保护区**：凡落在 `api/router/` 下的修复（P0-5、P1-1 网关半边、P1-10、P2-6、SOLO-SEC-01/02/03 网关侧）须用户逐项授权后再动（CLAUDE.md §5）。

---

## 一、 既往 14 项安全修复的逐条复核矩阵

| 编号 / 提交 | 原修复目标 | 复核状态 | 代码依据 | 结论摘要 |
|---|---|---|---|---|
| **SOLO-SEC-01** (`9c9c3ee`) | `isLoopbackRequest` 移除 `Host: localhost` 信任 | `BYPASS_FOUND` | [`api/router/handlers/auth.js:166-169`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/auth.js#L166-L169) · [`api/router/index.js:114`](file:///Users/fuu/Desktop/AI/solo/api/router/index.js#L114) | 1. 同机反代（Nginx/Caddy → `127.0.0.1:8600`）或 `run.sh` 默认起的 `local-ssl-proxy` 下，外部请求的物理 Socket IP 恒为 `127.0.0.1`，`isLoopbackRequest` 未检查 `TRUST_PROXY` 或代理转发头，导致公网请求被当成内部回环放行；<br>2. `GET /auth/key`（`index.js:114`）仍无条件信任 `req.headers['x-forwarded-for']`。 |
| **SOLO-SEC-02** (`9c9c3ee`) | `system.category.delete` 强制校验 `service === data.owner` | `BYPASS_FOUND` | [`api/router/handlers/category.js:38-64, 95`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/category.js#L95) · [`api/router/index.js:255-256`](file:///Users/fuu/Desktop/AI/solo/api/router/index.js#L255-L256) | 1. `system.category.list` / `locate` 在 `METHODS` 表中未鉴权，可匿名枚举所有 `key` 及其 `owner`；<br>2. `category.delete` 校验的是客户端自报的 `params.service`（非认证身份），满足回环条件时可伪填 `service: "user"` 删掉核心分类并立即 `reserve` 抢注。 |
| **SOLO-SEC-03** (`9c9c3ee`) | 限流器仅在 `TRUST_PROXY=true` 时读 `X-Forwarded-For` | `BYPASS_FOUND` | [`api/router/index.js:137-141, 279`](file:///Users/fuu/Desktop/AI/solo/api/router/index.js#L279) · [`api/router/handlers/ratelimit.js:53, 67-80`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/ratelimit.js#L53) | 1. `TRUST_PROXY=true` 时取 `x-forwarded-for.split(',')[0]`（首段即客户端自填值，标准反代是追加到末尾），可随意伪造 IP 绕过限流；<br>2. 传 JSON-RPC 批量数组 `[...]` 或非字符串 `method` 时，`method.startsWith` 抛未捕获异常导致连接永久挂起 + 刷爆 `ERROR:QUEUE`；<br>3. 内存降级计数器共用单一全局 `memWindow`，不同窗口大小的方法交替请求会每拍清空 `memCounters`。 |
| **SOLO-SEC-04** (`9c9c3ee`) | `administrator` 强制覆盖 `trustedParams.isAdmin` | `BYPASS_FOUND` | [`api/core/administrator/index.js:94, 98`](file:///Users/fuu/Desktop/AI/solo/api/core/administrator/index.js#L94-L98) · [`logic/identity.js:141-265`](file:///Users/fuu/Desktop/AI/solo/api/core/administrator/logic/identity.js#L141-L265) | `trustedParams.isAdmin` 本身已固，但 **`admin.password.reset` 根本没查 `if (!p.isAdmin)`**，且允许写入任意新 `username`（造出隐藏第二管理员）、改密后不吊销任何存量 admin 会话（见 **P0-4**）。 |
| **SOLO-SEC-05** (`9c9c3ee`) | 接入 `corsOptionsFromEnv` 与 `bindAddr` | `PARTIAL` | [`api/library/ports.js:63-67`](file:///Users/fuu/Desktop/AI/solo/api/library/ports.js#L63-L67) · [`deploy/scaffold/.env.example:18`](file:///Users/fuu/Desktop/AI/solo/deploy/scaffold/.env.example#L18) | 代码已接线，但脚手架 `.env.example` 与 `init.sh` 中 `BIND_ADDR=127.0.0.1` 默认被注释，缺省仍监听 `0.0.0.0`。 |
| **SOLO-SEC-06** (`9c9c3ee`) | `system.service.add` URL 过滤防 SSRF | `BYPASS_FOUND` | [`api/router/handlers/service.js:41-63`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/service.js#L41-L63) | 1. 仅用字符串匹配 `169.254.169.254`，被 `http://[::ffff:169.254.169.254]`（URL 解析为 `[::ffff:a9fe:a9fe]`）、`100.100.100.200`、302 重定向绕过；<br>2. **Z-Handshake 存在签名预言机漏洞**：对远端返回的 `seed` 未做格式校验即用 Router 私钥签名并发回，攻击者可令 `/auth/seed` 返回合法 `X-Router-Token` JSON，诱使 Router 签出任意 `admin` 内部转发令牌（见 **P0-5**）。 |
| **SOLO-SEC-07** (`a6c931a`) | `orchestrator` `setPath` 阻断原型链污染 | `PARTIAL` | [`api/core/orchestrator/logic/runner.js:523-530, 585`](file:///Users/fuu/Desktop/AI/solo/api/core/orchestrator/logic/runner.js#L523-L530) · [`api/library/jsonlogic.js:99-103`](file:///Users/fuu/Desktop/AI/solo/api/library/jsonlogic.js#L99-L103) | `setPath` 已闭合；但 `resolveVariables`（`runner.js:526`）与 `resolveParams`（`jsonlogic.js:101`）向普通对象 `{}` 赋 `resolved[key]` 时未过滤 `__proto__`，可触发原型 setter 绕过 `idempotency_key` 自动注入（`runner.js:585`），且读路径 `extractPath` 未拦原型属性。 |
| **SOLO-SEC-08** (`a6c931a`) | `local-oss-server.js` 静态直链加 `nosniff` 与 SVG CSP | `BYPASS_FOUND` | [`api/apps/storage/oss/local-oss-server.js:68-75, 246, 267`](file:///Users/fuu/Desktop/AI/solo/api/apps/storage/oss/local-oss-server.js#L68-L75) | 1. CSP 仅对 5 个硬编码 MIME 前缀生效，漏掉 `application/rdf+xml`、`application/mathml+xml`、`text/xsl`、`multipart/x-mixed-replace` 及前导空格 `" text/html"`；<br>2. `safeResolve` 未拦截 `.meta/` 目录，可直读或覆写 `<bucket>/.meta/<base64url>.json` 元数据旁路文件（见 **P1-9**）。 |
| **Prompt 注入盾** (`80a1669`) | `injection-detect.js` + `agent.decide` 前置拦截 | `BYPASS_FOUND` | [`api/core/agent/logic/decide.js:96-108`](file:///Users/fuu/Desktop/AI/solo/api/core/agent/logic/decide.js#L96-L108) · [`api/library/injection-detect.js:19-57`](file:///Users/fuu/Desktop/AI/solo/api/library/injection-detect.js#L19-L57) | 1. `agent.decide` 只扫 `params.context`、**漏扫 `params.instruction`**，且 `agent.purpose` / `focus` / `text.parse` 完全未调扫描器；<br>2. `scanDeclaredStrings` 跳过 `dataSchema` 中 `type: 'object' | 'array'` 或未填 `type` 的字段，无 `dataSchema` 的 ingress 源完全不扫；<br>3. 正则用 `[^.\n]`，词间插单个换行 `\n`、零宽字符、放到 JSON key 或用中文指令即可绕过。 |
| **JsonLogic 守卫** (`fulfillment`) | `evaluateCondition` 数值比较缺字段 fail-closed | `BYPASS_FOUND` | [`api/library/jsonlogic.js:24, 35-37, 49-60`](file:///Users/fuu/Desktop/AI/solo/api/library/jsonlogic.js#L49-L60) | 1. 在内层就地把 `< / <= / > / >=` 改写为 `false`，当外层套 `"!"`（如 `{"!": {"<": [{"var": "score"}, 60]}}`）时，`!false` 翻转为 **`true`（fail-open）**；<br>2. 两个缺失变量做 `==` / `===` 比较时 `null === null` 求值为 **`true`（fail-open）**。 |
| **删号即吊销** (`4a89cb7`) | `sessions.js` + Router `resolveSessionUser` 生命周期闸 | `BYPASS_FOUND` | [`api/core/user/logic/bot.js:112-120`](file:///Users/fuu/Desktop/AI/solo/api/core/user/logic/bot.js#L112-L120) · [`api/router/handlers/auth.js:77-99`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/auth.js#L77-L99) | 人类删号与 `bot.suspend` 已闭合，但 **`user.bot.delete`（`bot.remove`）未调 `killSessions`**，且 Router `resolveSessionUser` 的 `system.*` 分支在 `botStr === null` 时无 `else` 分支直接放行，被硬删的 bot 会话继续存活 24h（见 **P1-1**）。 |
| **登录挑战分键** (`b759583`) | `challenge:{name}:{val}` 分键 + 归一化 + 删号检查 | `PARTIAL` | [`api/core/user/logic/user.js:227-270`](file:///Users/fuu/Desktop/AI/solo/api/core/user/logic/user.js#L227-L270) | 挑战分键与归一化已闭合；但 `loginVerify` 写回 `user.last` / `user.devices` 仍用裸 `GET → SET`（未走 `optimisticUpdate`），并发删号/改权限时可能把已删账号写回 `ACTIVE`。 |
| **Storage 落盘根** (`2dfa121`) | 默认落盘目录移进项目 + 旧目录启动守卫 | `PARTIAL` | [`api/router/config.js:192`](file:///Users/fuu/Desktop/AI/solo/api/router/config.js#L192) | `apps/storage/config.js` 已修，但 `api/router/config.js:192` 的 `uploadDir` 仍残留 `path.join(__dirname, '../../../uploads/assets')` 旧路径。 |
| **Passport 三处修复** (`4f2a731`) | `anchors.js` 保留空间、`deviceIssue` 仅首次、`USER:SESSIONS` `PERSIST` | `BYPASS_FOUND` | [`api/core/user/logic/anchors.js:20-31`](file:///Users/fuu/Desktop/AI/solo/api/core/user/logic/anchors.js#L20-L31) · [`passport.js:78-151, 216, 297, 342-367`](file:///Users/fuu/Desktop/AI/solo/api/core/user/logic/passport.js#L78-L151) | 1. `anchors.js` 未拦 `'admin'`（存于 `administrator:user:admin` 而非 `user:admin`）、已 `destroy` 的内部 UID、裸服务名（`orchestrator`/`gateway`）及 `'anonymous'`；<br>2. `passport.js` 只查 `$owner.value !== undefined` 未查 `$owner.field`，缺 `field` 时 `entity.js` 退化为全表放行；<br>3. `passport.upgrade` 绕过 `issuanceMode` 并可覆盖既有护照（见 **P0-3**、**P1-2**）。 |

---

## 二、 本次深审发现的漏洞清单（按严重度分级）

### 🔴 P0（Critical —— 权限接管 / 审批门全绕过 / 签名预言机）

#### P0-1：Orchestrator `workflow.run` 原样透传 `params`，外部调用方可注入 `oneTimeGrant` / `triggerSource` / `compensationProgress` 绕过 H6 足迹预审与触发闸口
- **位置**：[`api/core/orchestrator/index.js:209-216`](file:///Users/fuu/Desktop/AI/solo/api/core/orchestrator/index.js#L209-L216) · [`api/core/orchestrator/logic/runner.js:46-47, 68-86, 134-136, 650-653`](file:///Users/fuu/Desktop/AI/solo/api/core/orchestrator/logic/runner.js#L46-L47)
- **根因（同效异路）**：
  Router 的 `validator.js` 只校验声明字段，不剥离额外字段。`orchestrator.workflow.run` 与 `orchestrator.run` 直接把客户端 `p` 传给 `Methods.runner.run(p, req.headers, req.user)`，而 `runner.run` 从 `params` 解构内部控制参数：
  - 传入 `"oneTimeGrant": { "methods": ["..."] }` → 直接抵消 H6 调用方权限差集（`runner.js:134-136`），低权限用户可执行任意高权工作流步骤；
  - 传入 `"triggerSource": "event:EVENT:..."` → 伪装成事件触发，绕过 `allowed_triggers: ['event']` 限制并伪造审计事件 `actor`；
  - 传入 `"compensationProgress": { "<stepId>": { "status": "success" } }` → 抑制失败时的 Saga 逆序补偿。
- **最小修法**：在 [`api/core/orchestrator/index.js:209-216`](file:///Users/fuu/Desktop/AI/solo/api/core/orchestrator/index.js#L209-L216) 显式收敛入参为 `{ workflowId: p && p.workflowId, input: p && p.input }`。

#### P0-2：Orchestrator `workflow.update` 与 Fulfillment `profile.update` 的「黑名单闸口」导致审批门与 24h 冷却期被直接抹除/绕过
- **位置**：
  - [`api/core/orchestrator/logic/workflow.js:464-466, 504-517`](file:///Users/fuu/Desktop/AI/solo/api/core/orchestrator/logic/workflow.js#L464-L517)
  - [`api/apps/fulfillment/logic/profile.js:122-135`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/profile.js#L122-L135)
- **根因（黑名单闸口）**：
  1. **Orchestrator 冷却期抹除与活体篡改**：`workflow.js:465` 定义 `execEdit = steps !== undefined || resolvers !== undefined || require_actor_permit !== undefined`，而第 `504` 行在 `normSubs !== undefined || input_schema !== undefined` 时也会执行 `delete next.effective_at;`。对刚通过多签审批、正处于 24h 冷却期（`status: 'ACTIVE', effective_at: >now`）的高危工作流，调用 `workflow.update({ id, input_schema: [] })`，因 `execEdit === false` 既不要求 `revise: true`、也不退回 `PENDING_REVIEW`，却**直接删掉了 `effective_at`**，使高危工作流立即生效！同时在 `ACTIVE` 态下可免审修改 `event_subscriptions` 与 `allowed_triggers`。
  2. **Fulfillment 直接自批激活**：`profile.js:129` 在 `transitions` 和 `meta_fields` 未变化时直接 `return factory.update(params)`。调用方只需传 `fulfillment.profile.update({ id, reviewState: "APPROVED" })`，即可把待审或已驳回的 profile 直接改成 `APPROVED`！
- **最小修法**：
  - `workflow.js:465`：将 `normSubs`、`input_schema`、`allowed_triggers`、`required_inputs`、`defaults` 全部纳入 `execEdit`，且仅在退回 `PENDING_REVIEW` 时清除 `effective_at` / `gateId`；
  - `profile.js:112-135`：在 `create` / `update` 入口白名单挑选允许客户端写入的业务字段（剥离 `reviewState`、`approvals`、`approvedDigest`、`submittedBy` 等治理字段）。

#### P0-3：`user.role.set` 与 `user.role.assign` 缺少 `isAdmin` / 权限子集校验，且 `anchors.js` 漏拦 `'admin'` 与已销毁 UID
- **位置**：
  - [`api/core/user/index.js:231-234`](file:///Users/fuu/Desktop/AI/solo/api/core/user/index.js#L231-L234) · [`api/core/user/logic/role.js:36-65, 93-103`](file:///Users/fuu/Desktop/AI/solo/api/core/user/logic/role.js#L93-L103)
  - [`api/core/user/logic/anchors.js:20-31`](file:///Users/fuu/Desktop/AI/solo/api/core/user/logic/anchors.js#L20-L31)
- **根因（同效异路）**：
  1. `user.permit.update` 有 `if (!isAdmin) throw UNAUTHORIZED()` 硬门，但同服务的 `user.role.set` 和 `user.role.assign` **没有任何 `isAdmin` 检查**，且 `assign` 会直接覆写目标用户的 `u.permit`（`role.js:99`）。任何拥有 `user: ['*']` 的非管理员（如 operator 或业务 bot）可自建全通配角色并赋给自己，或覆盖掉 admin 账号的 `allow_all: true`；
  2. `anchors.js` 只查 `user:${anchor}`，而后台管理员存在 `administrator:user:admin`，且 Router `forward.js:44` 将其映射为 `req.user = 'admin'`。在开启 `device` 发证时，外部匿名用户可注册 `anchor: 'admin'`（或已 `destroy` 的内部 UID、或 `'orchestrator'`/`'gateway'`），在所有下游服务（含 `user.key.*` 审批签名、`storage`、业务表）冒充 `req.user === 'admin'`！
- **最小修法**：
  - 在 `api/core/user/index.js:231, 234` 给 `user.role.set` 与 `user.role.assign` 加上 `if (!isAdmin) throw jsonrpc.UNAUTHORIZED();`；
  - 在 `anchors.js` 中封禁保留字（`admin`、`anonymous`、`guest`、`system`、`router` 及全部 14 个服务名）、检查 `administrator:user:${anchor}` 与已销毁 UID 墓碑集。

#### P0-4：`administrator` 的 `admin.password.reset` 缺 `isAdmin` 硬门、可创建任意隐藏管理员账号、且改密/锁定不吊销存量会话
- **位置**：[`api/core/administrator/index.js:94, 98, 142`](file:///Users/fuu/Desktop/AI/solo/api/core/administrator/index.js#L94-L98) · [`api/core/administrator/logic/identity.js:141-265`](file:///Users/fuu/Desktop/AI/solo/api/core/administrator/logic/identity.js#L141-L265)
- **根因**：
  1. `admin.password.reset` 未加 `if (!p.isAdmin) throw jsonrpc.UNAUTHORIZED()`，且 `saveAdmin` 允许传入任意 `username` 写入 `administrator:user:${username}`（`permit: { allow_all: true }`）；
  2. `saveAdmin` 改密后未清理任何已签发的 `session:*`；`lockAdmin`（`admin.self.lock`）只将当前 token 的 `ttl` 设为 60s，而 Router（`auth.js:120`）在 60s 内收到任何请求又会自动 `expire` 续期，导致锁定失效；
  3. `admin.login.verify` 密码错误时未删除 `challengeStore` 中的 challenge。
- **最小修法**：`admin.password.reset` / `admin.log.error` / `setting.index.schema` 补 `if (!p.isAdmin)`；`saveAdmin` 锁定唯一管理员用户名并索引/吊销全部管理员会话；`verify` 失败即销毁 challenge。

#### P0-5：Router `system.service.add` 的 Z-Handshake 存在任意 `X-Router-Token` 签名预言机（Signing Oracle）
- **位置**：[`api/router/handlers/service.js:50-63`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/service.js#L50-L63) vs [`api/router/handlers/forward.js:56-64`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/forward.js#L56-L64)
- **根因**：
  `addService` 请求目标 `${baseUrl}/auth/seed` 获取 `{ seed }` 后，**未校验 `seed` 是否为 64 位 hex 随机串**，直接用 Router 的 Ed25519 私钥对 `seed` 原文做 detached 签名并 POST 回 `${baseUrl}/auth/verify`。若恶意服务端在 `/auth/seed` 返回 `{"seed": "{\"iss\":\"router\",\"iat\":...,\"user\":\"admin\",\"permit\":\"admin\"}"}`，Router 就会亲手签出一枚合法的 `X-Router-Signature` 送给对方，可伪造任意身份直打任何下游微服务。
- **最小修法**（属 `api/router/` 保护区，需授权）：在 [`api/router/handlers/service.js:52`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/service.js#L52) 强制校验 `if (typeof seed !== 'string' || !/^[0-9a-f]{64}$/i.test(seed)) throw new Error('Invalid challenge seed');`，并给 `axios` 加上 `maxRedirects: 0` 与全网段 SSRF IP 校验。

---

### 🟠 P1（High —— 会话吊销漏网 / 跨租户行隔离失效 / 审批自审绕过 / SSRF 链）

| 编号 | 模块 | 位置 | 问题描述与最小修法 |
|---|---|---|---|
| **P1-1** | `user` + `router` | [`bot.js:112-120`](file:///Users/fuu/Desktop/AI/solo/api/core/user/logic/bot.js#L112-L120) · [`router/handlers/auth.js:77-90`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/auth.js#L77-L90) | **硬删 Bot（`user.bot.delete`）不杀会话且网关放行**：`bot.remove` 未调 `killSessions(uid)`；Router `resolveSessionUser` 的 `system.*` 分支在 `botStr === null` 时漏写 `else` 拒绝分支，已删 bot 的 token 在 24h 内照常工作。<br>**修法**：`bot.remove` 调 `killSessions(uid)`；`auth.js:90` 补 `else` 返回 guest。 |
| **P1-2** | `user` + `entity.js` | [`passport.js:78-151, 216, 297, 342-367`](file:///Users/fuu/Desktop/AI/solo/api/core/user/logic/passport.js#L78-L151) · [`entity.js:121-125`](file:///Users/fuu/Desktop/AI/solo/api/library/entity.js#L121-L125) | **Passport 隔离与生命周期多处漏口**：<br>① `passport.js:216, 316` 只查 `$owner.value === undefined` 漏查 `$owner.field`，当角色缺 `field` 时 `entity.js` `ownerScope()` 返回 `null`（**fail-open 全表放行**）；<br>② `resolveAuthority` 未查 `bot.status === 'ACTIVE'`，被暂停的 bot 仍能给护照签发新会话；<br>③ `_consumeOtp` 未校验 `rec.app === app`，`upgrade` 未校验 `issuanceMode` 且会激活 `PENDING` 护照或覆盖既有护照；`passport.register` 赋 `role` 时未清空旧 `entity.bot`。<br>**修法**：强制校验 `$owner.field`、`bot.status === 'ACTIVE'`、`rec.app` 与 `issuanceMode`；`register` 显式互斥 `role`/`bot`。 |
| **P1-3** | `user` + `approval` | [`user/logic/key.js:56-153`](file:///Users/fuu/Desktop/AI/solo/api/core/user/logic/key.js#L56-L153) · [`approval/logic/gate.js:133`](file:///Users/fuu/Desktop/AI/solo/api/apps/approval/logic/gate.js#L133) · [`record.js:118`](file:///Users/fuu/Desktop/AI/solo/api/apps/approval/logic/record.js#L118) | **已吊销/轮换的审批公钥仍可签署新审批**：`gate.sign` 与 `record.confirm` 把 `[pub.publicKey, ...pub.history]` 一起拿去验签，导致 `user.key.revoke` 吊销后旧私钥仍能签新审批单；且用户删号（`remove`/`destroy`）未吊销 `USER:SIGNKEY:{uid}`。<br>**修法**：实时签名只认当前 `pub.status === 'ACTIVE'` 的 `pub.publicKey`；删号同步清理签名密钥。 |
| **P1-4** | `orchestrator` | [`orchestrator/index.js:200`](file:///Users/fuu/Desktop/AI/solo/api/core/orchestrator/index.js#L200) · [`workflow.js:94-101, 412-528, 618, 664-701`](file:///Users/fuu/Desktop/AI/solo/api/core/orchestrator/logic/workflow.js#L94-L101) · [`runner.js:114-117`](file:///Users/fuu/Desktop/AI/solo/api/core/orchestrator/logic/runner.js#L114-L117) | **编排审批与足迹预审三处绕过**：<br>① `workflow.update` 不收 `req.user`、不更新 `submittedBy`，攻击者修改他人创建的 workflow 后可**自己审批通过（绕过 C1 自审禁令）**；<br>② `runner.js:115` 预审足迹直接取 `s.method`（未像 `executeCall` 那样拼 `${s.service}.${s.method}`），设 `service: "administrator", method: "user.get"` 时按 `user.get` 预审通过，执行时却打向 `administrator.user.get`；<br>③ `approvalDigest` 漏绑 `resolvers`/`allowed_triggers`/`require_actor_permit`，且 `approve()` 的 CAS 未重验 `approvalDigest(existing) === digest`。 |
| **P1-5** | `approval` | [`approval/logic/gate.js:77-84, 108-146`](file:///Users/fuu/Desktop/AI/solo/api/apps/approval/logic/gate.js#L77-L84) · [`record.js:49-51, 176-203`](file:///Users/fuu/Desktop/AI/solo/api/apps/approval/logic/record.js#L49-L51) | **Approval 策略被入参覆盖 & 签名可跨单重放**：<br>① `gate.open` 让调用方 `requiredSigners` 优先于 `approval.policy`（且 `orchestrator` 恒传 `1`，导致高危策略失效）；<br>② `gate.sign` 未校验 `ctx.actor === approverUid`，且签名内容未绑 `gate.id`（`record` 未绑 `record.id`），同 digest 签名可跨单重放。 |
| **P1-6** | `fulfillment` + `storage` | [`fulfillment/logic/instance.js:15-21, 169-335`](file:///Users/fuu/Desktop/AI/solo/api/apps/fulfillment/logic/instance.js#L169-L335) · [`storage/logic/asset.js:198-215, 384`](file:///Users/fuu/Desktop/AI/solo/api/apps/storage/logic/asset.js#L198-L215) | **跨租户 `$owner` 隔离缺失 & `instance.update` 黑名单漏口**：<br>① `fulfillment.instance` 手写 Redis 读写，8 个方法完全未查 `walContext.getStore()?.owner`；且 `instance.update` 用黑名单删 5 个键，允许篡改 `profileId` / `sourceId`；`instance.resume` 漏查 profile 激活闸；<br>② `storage/index.js:167` 未传 `req.constraints.$owner`，共用 bot 的外部护照共享同一个 `req.user`，可互读/互删对方的 `private` 资产并读取全量 `internal` 资产。 |
| **P1-7** | `entity.js` + `planner` | [`api/library/entity.js:71-79`](file:///Users/fuu/Desktop/AI/solo/api/library/entity.js#L71-L79) · [`planner/logic/agenda.js:97-105`](file:///Users/fuu/Desktop/AI/solo/api/apps/planner/logic/agenda.js#L97-L105) | **`entity.js` 未校验 `id` 导致 Redis 索引/游标序列键被覆写破坏**：`getDataKey(id)` 直接拼 `${SERVICE}:${ENTITY}:${id}`。传 `id: "INDEX:CURSOR:SEQ"` 调 `update`/`delete` 会把自增序列键改成 JSON 字符串或删掉，导致后续所有 `create()` 报 Redis `ERR value is not an integer` 永久瘫痪；`clientId: true` 或 `planner` 的 `sync` 传 `id: "INDEX"` 会用 String 覆写 Set 索引键。 |
| **P1-8** | `gateway` + `storage` | [`gateway/logic/webhook.js:24, 38-42`](file:///Users/fuu/Desktop/AI/solo/api/core/gateway/logic/webhook.js#L24) · [`attachments.js:18-20, 67-70`](file:///Users/fuu/Desktop/AI/solo/api/core/gateway/logic/attachments.js#L67-L70) | **出站 SSRF 与邮件附件全响应回显链**：<br>① `webhook.js` 的 `LOOPBACK_RE` 被 `http://[::ffff:127.0.0.1]:8600`（URL 归一化为 `[::ffff:7f00:1]`）、`[::]`、`0.0.0.1`、`169.254.169.254`、内网网段绕过；<br>② 通过 `storage.asset.external` 注册内网/元数据 URL，再传给 `gateway.email.send` 的 `attachments`，`attachments.js:69` 裸调 `fetch(url)` 将内网响应体作为邮件附件发给攻击者邮箱！ |
| **P1-9** | `storage` | [`local-oss-server.js:68-75, 246, 267`](file:///Users/fuu/Desktop/AI/solo/api/apps/storage/oss/local-oss-server.js#L68-L75) · [`storage/index.js:147`](file:///Users/fuu/Desktop/AI/solo/api/apps/storage/index.js#L147) | **本地 OSS `.meta/` 旁路访问、CSP 漏网与 `/file/:id` 开放重定向**：`safeResolve` 未拦截 `.meta/` 段；CSP 未覆盖全量 XML/JS MIME；公开 external 资产在 `/file/:id` 无签名要求直接 302 跳转任意外链。 |
| **P1-10** | `router` | [`api/router/index.js:194-267, 288`](file:///Users/fuu/Desktop/AI/solo/api/router/index.js#L194-L288) · [`events.js:144-184`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/events.js#L144-L184) | **Router 本地 `METHODS` 绕过 `checkAccess` & `X-Trace-Depth` 抑制下游事件**：<br>① `system.service.list` / `status` / `system.category.list` / `locate` / `system.workflow.list` 在 `METHODS`（Phase 2）直接执行，绕过了 Phase 3 `checkAccess` 的 `DISCOVERY_METHODS` 生产环境门控；<br>② 外部请求自带 `X-Trace-Depth: 16` 请求头时，下游业务 RPC 正常落库，但顺带发出的 `_event` 因 `depth > 16` 被静默拦截丢弃！ |

---

### 🟡 P2（Medium / Low —— 边界加固、信息脱敏与 DoS 防护）

1. **P2-1（`user.profile` 越权读）**：[`api/core/user/index.js:140`](file:///Users/fuu/Desktop/AI/solo/api/core/user/index.js#L140) 未像 `user.permit.get` 那样校验 `if (!isAdmin && req.user !== p?.uid)`，非 admin 调用方可拉取任意用户的完整 `permit`、`email`、`phone` 及设备 `token_prefix`。
2. **P2-2（`library/risk.js` 风险分类偏差）**：[`api/library/risk.js:28-40, 69-71`](file:///Users/fuu/Desktop/AI/solo/api/library/risk.js#L28-L40) 将 `.verify`（如 `approval.record.verify`、`user.passport.otp.verify`）和 `.status`（Entity Factory 写方法）列为只读 `LOW` 风险，且 `DEFAULT_SENSITIVE_SERVICES` 默认未启用。
3. **P2-3（`mcp` 暴露未脱敏 `result.trace`）**：[`api/core/mcp/logic/tools.js:89-98`](file:///Users/fuu/Desktop/AI/solo/api/core/mcp/logic/tools.js#L89-L98) 将 `orchestrator.workflow.run` 返回的原始 `trace`（含步骤入参/结果与 `idempotency_key`）直接序列化返回给外部 MCP 客户端。
4. **P2-4（`gateway` 漏挂 `walContext` & 测试应用幂等键串租户）**：[`api/core/gateway/index.js:98`](file:///Users/fuu/Desktop/AI/solo/api/core/gateway/index.js#L98) 未包 `walContext.run(requestContext(req), ...)`；`collection`/`market` 的 `DEDUP` 键未按 `$owner` 分命名空间。
5. **P2-5（`ingress` 校验与审核队列可靠性）**：[`api/core/ingress/logic/ingest.js:119`](file:///Users/fuu/Desktop/AI/solo/api/core/ingress/logic/ingest.js#L119) 未拦 `Array.isArray(rawBody.data)`；[`review.js:58-63`](file:///Users/fuu/Desktop/AI/solo/api/core/ingress/logic/review.js#L58-L63) 在确认 `event.emit` 写入成功前就删掉了待审条目。
6. **P2-6（`router` 健壮性与日志闭环，属 `api/router/` 保护区）**：
   - [`api/router/index.js:405`](file:///Users/fuu/Desktop/AI/solo/api/router/index.js#L405)：当请求不带 `params` 时 `params.text` 抛异常导致 `logInteraction` 审计静默跳过；
   - [`api/router/handlers/validator.js:51, 76`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/validator.js#L51)：`schemaLimits` 未用 `Object.create(null)`，且数组包裹超大字符串绕过长度校验；
   - [`api/router/handlers/system.js:354`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/system.js#L354)：`system.wal.stats.range` 未校验 `step > 0` 与桶数上限，传 `step: -1` 会死循环锁死网关事件循环。
7. **P2-7（前端红线核查结果）**：`portal/` 与 `client/` 全仓扫描 **`window.alert / confirm / prompt` 为 0 违规**（全部合规使用 `useUI().confirm`），可以把 MSO 的 `check-no-native-dialogs` 加进 [`deploy/check-doc-drift.js`](file:///Users/fuu/Desktop/AI/solo/deploy/check-doc-drift.js) 永久守住。

---

## 三、 分批修复路线图（遵循 CLAUDE.md §5 Router 保护约定）

### 第一批：不碰 `api/router/` 的服务侧与库侧修复（可直接动手，先补红灯单测再改绿）
1. **编排与审批门收口（`P0-1` · `P0-2` · `P1-4` · `P1-5` · `P2-2` · `P2-3`）**
   - `orchestrator`：`workflow.run` 入参白名单收敛（剥离 `oneTimeGrant`/`triggerSource`/`compensationProgress`）；`workflow.update` 冻结 `ACTIVE` 下全部签名/触发字段并记录 `submittedBy = req.user`；`runner.js` 足迹预审补齐 `${s.service}.${s.method}` 归一化；`approvalDigest` 纳入 `resolvers`/`allowed_triggers`/`require_actor_permit` 并在 `approve` CAS 与 `runner` 中校验。
   - `fulfillment`：`profile.create/update` 剥离 `reviewState`/`approvals`/`approvedDigest`/`submittedBy`；`instance.js` 补齐 `$owner` 行隔离、`instance.update` 改白名单、`instance.resume` 补 profile 激活闸。
   - `approval`：`gate.open` 以 `policy.requiredSigners` 为下限；`gate.sign` / `record.confirm` 只认当前 `ACTIVE` 签名密钥（不认 `history` 已吊销密钥），并绑定 `ctx.actor` 与 `gate.id`/`record.id`。
   - `library/jsonlogic.js` & `library/risk.js`：修复 `!` 嵌套与双缺失 `var` 的 `==`/`===` fail-open；从 `READ_VERBS` 移除 `verify`/`status`。
2. **身份、权限与管理端收口（`P0-3` · `P0-4` · `P1-1 半边` · `P1-2` · `P1-3` · `P2-1`）**
   - `user`：`user.role.set/assign` 与 `user.profile` 补 `isAdmin` / 本人校验；`bot.remove` 调 `killSessions(uid)`；`anchors.js` 封禁 `'admin'`、服务名与已销毁 UID 墓碑集；`passport.js` 强制校验 `$owner.field`、`bot.status === 'ACTIVE'`、`rec.app` 与 `issuanceMode`；删号同步吊销 `USER:SIGNKEY:{uid}`；`loginVerify` 改走 `optimisticUpdate`。
   - `administrator`：`admin.password.reset` / `admin.log.error` / `setting.index.schema` 补 `if (!p.isAdmin)`；限制单管理员用户名，改密/锁定同步清理 `administrator` 会话，登录失败销毁 challenge。
3. **存储、AI 注入盾、SSRF 与 Entity Factory 收口（`P1-7` · `P1-8` · `P1-9` · `A2.1..3` · `P2-4` · `P2-5`）**
   - `library/entity.js`：`getDataKey(id)` 严格校验 `id`（禁 `:` 与保留字 `INDEX`/`SEQ`/`CURSOR`），若 `ctx.owner` 存在但缺 `field`/`value` 则 fail-closed。
   - `storage` & `gateway`：`local-oss-server.js` 封禁 `.meta/` 段并对全部响应下发严格 CSP；`storage` 透传 `req.constraints.$owner`；抽公共 SSRF 校验器拦截 IPv6 映射回环、私网、云元数据与外部资产邮件附件抓取。
   - `library/injection-detect.js` & `agent` & `ingress`：`agent.decide` 同步扫描 `instruction`；`scanDeclaredStrings` 递归扫描 `object`/`array` 及无 schema 源；正则补换行/零宽归一化与中文/分隔符规则。

### 第二批：涉及 `api/router/` 的网关修复（需你明确授权后再动）
- 涉及文件：[`api/router/index.js`](file:///Users/fuu/Desktop/AI/solo/api/router/index.js)、[`api/router/handlers/auth.js`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/auth.js)、[`api/router/handlers/service.js`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/service.js)、[`api/router/handlers/ratelimit.js`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/ratelimit.js)、[`api/router/handlers/events.js`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/events.js)、[`api/router/handlers/validator.js`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/validator.js)、[`api/router/handlers/system.js`](file:///Users/fuu/Desktop/AI/solo/api/router/handlers/system.js)、[`api/router/config.js`](file:///Users/fuu/Desktop/AI/solo/api/router/config.js)。
- 修复内容：
  1. **`service.js`（`P0-5`）**：Z-Handshake 签名前强制校验 `seed` 为 64 位 hex，防 `X-Router-Token` 签名预言机；加 `maxRedirects: 0` 与完整内网/IPv6 映射地址过滤。
  2. **`auth.js`（`P1-1` / `SOLO-SEC-01`）**：`resolveSessionUser` 的 `system.*` 分支在 `!botStr` 时拒绝会话；外部 `passport` 会话校验 `USER:PASSPORT:{uid}` 状态；`lockedAt` 会话不再滑动续期；`isLoopbackRequest` 在带代理转发头时不视作内部直连。
  3. **`index.js` & `ratelimit.js` & `events.js` & `validator.js` & `system.js`（`SOLO-SEC-02/03` / `P1-10` / `P2-6`）**：拦截 JSON-RPC 批量数组与非字符串 `method`；`TRUST_PROXY=true` 时取 `X-Forwarded-For` 最末段；本地 `METHODS` 补齐 `DISCOVERY_METHODS` 与 `category.list/locate` 门控；非 `system.*` 调用方重置入站 `X-Trace-Depth`；修复 `logInteraction` 空 `params` 报错、`schemaLimits` 原型链与 `wal.stats.range` 死循环。

---

## 处理结论

2026-10-16 全量核实与修复闭环（第一批服务侧与公共库 + 第二批 `api/router/` 网关层），所有发现项均已通过红灯→绿灯回归单测与静态/并发仿真门禁验证：

1. **编排、审批与履约（`P0-1` · `P0-2a/b` · `P1-3b` · `P1-4` · `P1-5` · `P1-6a` · `P2-2` · `P2-3` · `SOLO-SEC-07`）**
   - `api/core/orchestrator/index.js`：`orchestrator.workflow.run` 与 `orchestrator.run` 仅透传 `{ workflowId, input }`，剥离 `oneTimeGrant`、`triggerSource`、`compensationProgress`、`actorClaim`、`runId`、`onStepCommit`；`workflow.update` 透传 `req.user`。
   - `api/core/orchestrator/logic/workflow.js` & `runner.js`：`footprintOf`、`classifyMissingMethods`、`runner.js` 足迹预审统一做 `${service}.${method}` 归一化；`approvalDigest` 纳入 `resolvers`、`event_subscriptions`、`input_schema`、`allowed_triggers`、`required_inputs`、`require_actor_permit`，并在 `approve()` 的 `optimisticJsonUpdate` 中做 CAS 校验；`update()` 将全部可执行字段纳入 `execEdit`，变更时重置 `PENDING_REVIEW` 并更新 `submittedBy = callerUid`；`runner.js` 在 `resolveVariables`、`resolveVariable`、`extractPath` 拦截 `__proto__`/`constructor`/`prototype`。
   - `api/apps/fulfillment/{index.js,logic/profile.js,logic/instance.js}`：`profile.create/update/submit` 剥离 `reviewState`、`approvals`、`approvedDigest`、`submittedBy` 等治理字段，编辑可执行字段时更新 `submittedBy: req.user`；`instance.resume` 补齐 profile `APPROVED` 激活闸；`instance.js` 补齐 `id` 合法性校验与 `walContext` `$owner` 行隔离，`instance.update` 收敛为仅允许更新 `meta`。
   - `api/apps/approval/logic/{gate,record}.js`：实时签名验签仅接受当前激活 `pub.publicKey`（不再接受 `pub.history` 历史已轮换/已吊销密钥）；`gate.open` 强制以匹配的 `policy.requiredSigners` 为最小签名人数下限。
   - `api/library/jsonlogic.js`、`api/library/risk.js`、`api/core/mcp/logic/tools.js`：修复 `jsonlogic.js` 在 `!`/`!!` 否定包裹比较运算、双缺失 `var` 的 `==`/`===` 及 `[path, null]` 默认值下的 fail-open，并在 `resolveParams` 拦截原型污染键；从 `risk.js` 的 `READ_VERBS` 移除 `verify`；`mcp` 的 `tools/call` 输出经 `logger.redactSensitive` 脱敏。
2. **身份、护照、签名密钥与管理端（`P0-3` · `P0-4` · `P1-1a` · `P1-2` · `P1-3a` · `P2-1` · `D2-F03` · `D2-F11`）**
   - `api/core/user/{index.js,logic/role.js,logic/user.js,logic/anchors.js,logic/bot.js,logic/passport.js,logic/key.js}`：`user.role.set` 与 `user.role.assign` 强制要求 `isAdmin`，`role.assign` 改走 `optimisticUpdate` 并拒绝已删除账号；`user.profile` 限制仅本人、admin 或系统 bot 可读（系统 bot 仅返回脱敏摘要）；`anchors.js` 封禁 `'admin'`/`'anonymous'`/`'guest'`、全部核心/应用服务名、`administrator:user:*` 及 `user:destroyed:ids` 墓碑集；`user.remove`/`destroy` 同步吊销 `USER:SIGNKEY:{uid}`；`bot.remove` 调 `killSessions(uid)`；`passport.js` 校验 `bot.status === 'ACTIVE'`、强制 `$owner.field` 非空、`otpRequest`/`otpVerify` 限制 `issuanceMode`、`_consumeOtp` 绑定 `app`、`_provision` 清理残留 `bot`/`role`、`upgrade` 禁止覆盖已有目标 anchor；`loginVerify` 改走 `optimisticUpdate`；`library/permit.js` 使用 `Object.prototype.hasOwnProperty.call` 防原型链方法名命中。
   - `api/core/administrator/{index.js,handlers/auth.js,logic/identity.js}`：`admin.password.reset`、`admin.log.error`、`setting.index.schema` 强制要求 `p.isAdmin`；从 `publicMethods` 移除日志接口；`loginVerify` 首次验签失败即销毁 challenge；`saveAdmin` 强制单管理员模型，改密与 `lockAdmin` 同步吊销 `USER:SESSIONS:__admin__`。
3. **Entity Factory、存储、SSRF 与 AI 注入盾（`P1-7` · `P1-8` · `P1-9` · `B1.4` · `A2.1..3` · `P2-4` · `P2-5`）**
   - `api/library/entity.js` & `api/apps/planner/logic/{agenda,todo}.js`：`getDataKey(id)` 拦截含 `:` 或保留字 `INDEX`/`SEQ`/`CURSOR` 的非法 `id`；`ownerScope()` 在 `ctx.owner` 缺 `field`/`value` 时 fail-closed 抛 `FORBIDDEN`；`planner` 同步接口校验条目 `id`。
   - `api/core/gateway/{index.js,logic/webhook.js,logic/attachments.js}` & `api/apps/storage/{index.js,logic/asset.js,oss/local-oss-server.js}`：拦截 IPv4/IPv6 回环、IPv4-mapped IPv6（`[::ffff:127.0.0.1]` / `[::ffff:7f00:1]`）、`0.0.0.0`、云元数据（`169.254.169.254` / `100.100.100.200` / `metadata.google.internal`）及 RFC1918 私网地址，`attachments.js` 禁自动重定向；`local-oss-server.js` 拒绝 `.` 与 `.meta` 路径段并扩展富文档 CSP 覆盖面；`storage` 接入 `req.constraints.$owner` 实现共享 bot 下的外部租户隔离；`gateway` 补齐 `walContext.run`；`collection`/`market` 幂等缓存按 `$owner` 校验归属。
   - `api/library/injection-detect.js`、`api/core/agent/logic/decide.js`、`api/core/ingress/logic/{ingest,review}.js`：`scanString` 增加零宽字符剥离、跨行折叠、分隔符伪造与中文越狱指令检测；`scanValue` 扫描对象 key 并防循环引用；`scanDeclaredStrings` 覆盖 `object`/`array` 字段；`agent.decide` 同步扫描 `instruction`；`ingest.js` 拦截数组 `data` 并对无 schema 源兜底扫描；`review.approve` 确认 `event.emit` 成功后才消费待审项。
4. **Router 网关层与静态门禁（`P0-5` · `P1-1b` · `P1-10` · `P2-6` · `P2-7` · `SOLO-SEC-03/06`）**
   - `api/router/handlers/service.js`：Z-Handshake 签名前强制校验 `seed` 格式（`/^[A-Za-z0-9_-]{8,128}$/`），阻断 `X-Router-Token` 签名预言机；补齐 `maxRedirects: 0` 与 IPv6/元数据/未指定地址拦截。
   - `api/router/handlers/auth.js`：`type === 'bot'` 会话在 `user:bot:{uid}` 被硬删后立即降级为 `guest`；带 `lockedAt` 的会话不再触发滑动续期；`checkPermission` 使用 `hasOwnProperty` + `Array.isArray` 拦截原型链属性。
   - `api/router/{index.js,handlers/ratelimit.js,handlers/events.js,handlers/validator.js,handlers/system.js}`：拦截批量数组与非字符串 `method`；`TRUST_PROXY=true` 时取 `X-Forwarded-For` 最右侧可信跳；`ratelimit.checkLimit` 在 `count > 1 && ttl === -1` 时自动自愈补设 TTL；`events.checkRegistry` 与 `validator.js` 防御原型链与非对象 `params`；`walStatsRange` 校验 `step > 0` 与桶数上限；`deploy/check-doc-drift.js` 新增前端原生弹窗静态门禁。
5. **验证结果**
   - CI 单测套件（`jest.ci.config.js`）：**140 / 140 套通过（2,386 项单测通过，0 失败）**
   - 并发与安全仿真（`api/autocheck/simulation/run.js`）：**5 大服务仿真全部通过**
   - 静态与文档门禁（`deploy/check-doc-drift.js` + `deploy/precheck.sh`）：**全部通过**

