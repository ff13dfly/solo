# toFix —— API 待修问题清单

> **总入口在 [`BACKLOG.md`](./BACKLOG.md)（集中清单 + 推进顺序）。** 本文是其中"API 待修"那条的 drill-down 详情。
> 来源:**2026-06-07 全框架缺口审计**(6 子系统并行 reader,逐条核到 `file:line`)。覆盖并刷新 2026-06-04 旧审计。
> 约定:SOLO 是纯框架,缺业务服务不算 gap。本清单只收**框架级**问题。

---

## ✅ 自上轮已闭(对照核实)

- **operator 切换缝(auto↔manual,2026-06-07)** —— 架构评估 1+2:① **auto→human 通知**:orchestrator worker 因缺权限暂停 run(`PAUSED_AWAITING_HUMAN`)时,除发 `EVENT:WORKFLOW:NEEDS_GRANT` 外,还 `notification.send` 到**共享 ops 收件箱**(fail-soft)→ 暂停的 run 从"只能轮询"变推送。② **运行时自动化暂停**:每服务 `{NEXUS,ORCHESTRATOR}:CONTROL:PAUSED` 开关 + `{service}.control.pause/resume/status`(admin)→ 4 个自动化循环(nexus consumer+scheduler、orchestrator worker+matcher)运行时跳过,**手工 RPC 照常** → 不重启即可降级到人工。fulfillment 无循环不适用。**A 尾巴也已收(2026-06-07)**:③ portal **Automation Control** 页(每服务 pause/resume + 一键全暂停 + Sentinel/调度/DLQ/暂停-run 总览,tsc 绿);④ **/health + /readyz** 探针落到全部 13 个服务(共享 `library/health.js`;修了 gateway/user/orchestrator 把探针挂在全局 auth 之后导致被门禁的 bug → 现为公开;e2e `70` 验证 4 个服务公开可探);⑤ **跨服务聚合/全暂停**:administrator `setting.automation.status/pause/resume`(直写共享 Redis 的两个 control flag,无需 relay)。hermetic(control×2 / scheduler-paused / worker-notify / health×4)+ e2e `70`(/health 公开 + 全 13 服务 boot-smoke + per-service control.status)绿。**遗留**:metrics/`/metrics`(Prometheus)未做;administrator 聚合方法在 e2e harness 不路由(预存 harness 局限,非缺陷 —— 生产经 portal 路由,同 `setting.config.*`)。
- **nexus §2.2 emit-event 动作闭环(2026-06-07)**:`context.emit` → 真实 `event.emit` → 总线 → 下游 Sentinel/matcher 消费;e2e `69` full-profile 跑通。详见下方 nexus 节。
- **nexus agent→Sentinel 改名 + `nexus.sentinel.update`(热重配,保 id/历史)+ §1.2 读路径身份**:`data_fetchers` 经 `relay.callAs` 走每个 Sentinel 自己的 bot token、create 期 fetcher⊆permit 预审(**best-effort**:bot 没被授 `user.permit.get` 时跳过、不挡 create;运行时 Router 仍兜底)、`disable` 软吊销 token。→ 旧 #4(disable 空操作)**已修**;旧 #3(契约过头)随改名对齐。**注**:Sentinel bot 应带 infra-permit `user.token.refresh`(续签)+ `user.permit.get`(开启预审)。
- **storage→OSS**:driver 化(local/aliyun)、内容寻址 key、SHA256 去重、签名/CDN URL(`apps/storage/logic/asset.js`)。→ 旧"Storage 无签名 URL"**已补签名/CDN**;但**对象级授权仍空**(见 二.storage)。
- **fulfillment 核心闭环**:声明式状态机把转移动作发为 Router `_tasks`,幂等键 `{transitionId}:A{idx}`(`apps/fulfillment/logic/instance.js:95-107`)。仅 Phase-3 workflow 回调/ai_hooks 仍占位。
- **nexus 动态订阅流**:`discoverStreams()` 并默认流 ∪ 每个 ACTIVE Sentinel 的订阅,自动建组 + NOGROUP 自愈(`stream.js:147-208`)。→ 旧"消费流硬编码"**已闭**。
- **orchestrator C1 单签审批闸 + H6 footprint 预审**:自审禁止、PENDING_REVIEW→ACTIVE、非 ACTIVE 拒跑、足迹静态并集预检 —— 已在 CI 绿色子集。
- **Router 事件总线**:`event.emit` RPC + `_event` 夹带 + `EVENT:WEBHOOK:*` glob 订阅 + `trustEventActor`(`router/handlers/events.js`)。→ 旧"router _event 缺失"**已闭**;node-redis v5 scheduler 回归(`zPopMinCount`)已修。
- **三类 principal 硬吊销**:`USER:SESSIONS:{uid}` 反向索引,`bot.revoke`/`passport.disable` 直删活 session。
- **凭证脱敏**:`logger.redactSensitive` 在入 `ERROR:QUEUE` 前打码,hermetic 测试入 CI。

> **贯穿主题(比逐条更重要)**:① **内部调用无超时** ✅(2026-06-07)→ 一.1;② **投递死信漏斗** ✅(2026-06-10:webhook.send 落地 + sse fail-closed + payload/地址解析链 + 永久错误分类 + DLQ 上限)→ 一.3 / 二.notification;③ **写/act 侧半成品**(emit 闭环已通,autorun 结构化产出契约仍欠)→ 二.nexus;④ **事件总线无幂等 + token 可重放** ✅(2026-06-10:event_id SETNX 去重 + iat 新鲜度门;jti 级反重放仍欠)→ 二.router;⑤ **治理链断桩**(approval/C1/NEEDS_GRANT 各自跑没串成链)——**当前最大的未动主题**;⑥ **机器身份控制比人弱** ✅(2026-06-10:bot permit 热刷咬活 session + 可逆 suspend/resume)→ 二.identity;⑦ **全队基础硬化未做**(CORS/Redis/metrics);⑧ **自治联动护栏补了两块**(✅ trace 全链传递 + ✅ depth 预算刹车,2026-06-10;**仍缺**:触发来源≠动作授权的 confused deputy、AI 置信兜底失效)→ 二.事件链。

---

## 🔴 一、真 blocker / 真 bug(声称能用、实际不工作)

### 1. 内部 RPC 客户端无超时 —— 一个上游卡死,worker 永久挂  ✅ 已修(2026-06-07)
- **现象(原)**:`relay.rpcViaRouter` 只挂 `req.on('error')`,**无 socket 超时**;Router 接了 TCP 却不回 → Promise **永不 settle**,拖死每个 relay 驱动的 worker(notification/orchestrator/nexus scheduler/ingress/callAs)。`library/category.js` 的 `makeRpcCall` 同样无超时。
- **修法(已落地)**:两个裸 HTTP 客户端都加 socket 超时 → `req.destroy(timeoutErr)` → reject。relay 新增 `requestTimeoutMs`(默认 120s,> Router 最长 forward 90s,故不误杀 agent.chat 等慢调用;可 per-service 覆盖),超时抛 `RPC_TIMEOUT`;category 默认 15s(`CATEGORY_RPC_TIMEOUT_MS` env 覆盖)。
- **验证**:`library/tests/relay-callas.test.js` 加"never-respond server → RPC_TIMEOUT"用例(入 CI 子集);CI 子集 50 套/646 测试绿。
- **证据**:`library/relay.js`(rpcViaRouter timeout + RPC_TIMEOUT)、`library/category.js`(makeRpcCall timeout)。
- **遗留**:category 的**认证**那半(#2)未做 —— 本次只补超时。

### 2. 联邦分类 `category.create/delete` 永远 FORBIDDEN  ✅ 已修(2026-06-07)
- **现象(原)**:`makeRpcCall` 去 Router 登记 key **不带 bot token** → guest、`isAdmin=false` → `system.category.reserve/.delete` 要求 admin → 永远 `FORBIDDEN`,每个非-admin 服务注册分类全坏。
- **为何没走 relay**(旧方案不可行,核实):用 category 的三个服务 **user/planner 没有 relay**(只 orchestrator 有),且 `ensureDefaultCategories` 在 **boot** 跑——那时 bot token 还没注入(手动发证)。relay 路线对 relay-less 服务 + 启动期都不成立。
- **修法(已落地,= loopback 信任)**:Router 把 reserve/delete 从 `isAdmin` 放宽成 **`isAdmin || isLoopbackRequest(req)`**。SOLO 部署是单机 localhost(`urlFor→http://localhost`),服务都经 loopback 调 Router;Router 无 `trust proxy` → `req.ip` 不可被 XFF 伪造;`delete` 仍在 handler 里 owner-scope(`data.owner!==service→DENIED`)。新增 `auth.isLoopbackRequest` helper。**多 HOST 部署**(ROUTER_URL 非 localhost)才需改走 service-bot token —— 已在代码注释标注。
- **验证**:`router/tests/auth.test.js` 加 `isLoopbackRequest` 3 用例(入 CI);CI 子集 50 套/649 测试绿。端到端(e2e 54/55 旧"已知坏"分类套)需全栈 mesh 复跑确认转绿。
- **证据**:`router/handlers/auth.js`(isLoopbackRequest)、`router/index.js:226-240`(放宽闸)。
- **遗留**:`category.js` 的 `makeRpcCall` 仍不带身份(loopback 即信任,无需);超时已在 #1 补。

### 3. gateway 无 `webhook.send`/`sse` —— 4 种投递模式 2 种端到端不通  ✅ 已修(2026-06-10)
- **现象(原)**:`notification.config.set` 接受 channel∈{email,sms,webhook,sse},worker 调 `gateway.${channel}.send`,但 gateway 只注册 email/sms/rmbg → webhook/sse 规则命中 `METHOD_NOT_FOUND`→ 被当临时错重试 5 次 → 静默死信。`nexus.sentinel.broadcast` 还对 webhook/sse **假报 `broadcasted:true`**。
- **修法(已落地)**:① **`gateway.webhook.send`**(`gateway/logic/webhook.js`):POST JSON 到外部端点(机器目标,URL 来自规则/sentinel 配置),`secret`→HMAC-SHA256 `X-Solo-Signature` 签名(镜像 ingress 的信任方向),超时有界,loopback 默认拒(SSRF 守卫,`WEBHOOK_ALLOW_LOOPBACK=1` 给 test/dev);② **sse 正式 fail-closed**:`notification.config.set` 与 `sentinel.broadcast` 都直接拒绝("配上即死信"变"诚实拒绝");③ broadcast 的 webhook 路径(URL 进规则 params)随 webhook.send 落地自动转真。
- **验证**:hermetic `gateway/tests/webhook.test.js`(签名/超时/状态/SSRF,6 用例,入 CI);e2e `100`(本地监听器收到带可验签名的完整 payload + sse 拒绝)。

---

## 🟠 二、生产就绪的真窟窿

### notification(投递数据面)— ✅ 四连已修(2026-06-10,与一.3 同包落地)
- ✅ **丢 `msg.payload` + 无地址解析 已修**:worker 现在把消息自身 payload(subject/content/variables)合并进 gateway 参数;**地址解析链**:规则 params 显式地址 > **user.profile 的 email/phone(默认出站地址,`user.account.update` 已开放 email/phone 字段)** > 都没有 → **降级回 inbox**(send 时已写的站内副本即投递,记 degraded,不算失败不重试);webhook 是机器目标无 profile,`config.set` 强制规则带 `params.url`。`worker.js`(resolveAddress/buildParams)。**注**:`system.notification` bot 需要 `gateway.*.send` + `user.profile` permit(deploy/seed-bots.js 与 e2e harness 已同步)。
- ✅ **永久错误当临时重试 已修**:relay 现透传下游 JSON-RPC `err.rpcCode` 与 HTTP `err.httpStatus`(不再 opaque);worker 对永久类(-32600/-32601/-32602/-32002/-32003、4xx 除 408/429)**直接进 DLQ**(记 `permanent:true`),不再烧满 5 次重试。
- ✅ **mock provider 假报成功 已修**:`result.provider==='mock'` → 记 `deliver.mocked`(ack 但绝不记成真投递;重试变不出凭证)。
- ✅ **DLQ 无界无兜底 已修**:DLQ `lTrim` 硬上限(`NOTIFICATION_DLQ_MAXLEN`,默认 1000,消息体仍在 NOTIFICATION:MSG 可查);`requeue` 加 loop guard(`requeues` 计数 ≤3,毒丸最多重烧 3 次后留死信等人工)。
- **验证**:`worker.test.js` 重写+扩(13 用例:解析链/降级/永久分类/mock 诚实/loop guard);e2e `100`(profile email 投递留痕、降级回 inbox 不失败、webhook 端到端)。**剩**:DLQ 深度无告警/指标(随 §四 metrics 一起)。

### orchestrator(工作流引擎)
- ✅ **Saga 补偿(同步 best-effort)已落地(2026-06-25)**:`ignore_error:false` step 失败 → 引擎逆序执行已提交 step 的 `compensate`(step-id 引用,走同一执行器 + 稳定 `idempotency_key`);补偿目标自动排除出正向 pass;§7.3 + 目标存在性在 `create()` 校验;补偿失败 → `compensation_failed` + `EVENT:WORKFLOW:DEAD_LETTER`。`runner.js`(`runCompensations`/`executeCall`)+ `workflow.js`(校验);hermetic 覆盖(static-workflow-hardening:补偿成功/失败/校验)。**前置幂等接线**(`idempotency_key` 接进 `makeRpcCall`)同批落地。**残留(明确)**:跨重启耐久补偿(需 run-state checkpoint)+ §7.4 approve 期下游接口存在性校验。
- ✅ **`input_schema`/`result_schema` 不强制(2026-07-03 核实:已被 §6.3 修,本条此前漂了未同步)**:`runner.js` 现有 `checkParams` fail-closed 校验(在 footprint 预审前),`result_schema` warning/`strict_result` 阻断两档。
- ✅ **并发覆盖(2026-07-03 核实:已被 §6.6 修,本条此前漂了未同步)**:`create/update/approve/deny/delete/restore` 全部走 `optimisticJsonUpdate` CAS,`expected_version` 不匹配 → FORBIDDEN,不可变快照 `ORCHESTRATOR:WORKFLOW_V:{id}:{n}` 同事务写入。`workflow.js:122-128,225-275`(AUDIT M1/M6)已闭。
- ✅ **执行轨迹(trace)持久化已补(2026-07-03)**:新增 `logic/trace-audit.js`,镜像 `ingress/logic/audit.js` 的按天 JSONL 落盘模式(`{LOG_DIR}/orchestrator-trace/{YYYY}/{YYYY-MM-DD}.jsonl`)——run 实体本身不动(不塞进 RedisJSON 文档,避免重演 WAL 那边 >32KB 截断的问题),`runner.js:run()` 的两个 return 点(成功/失败)都落一行完整 trace,写盘前统一过 `logger.redactSensitive`(unlike ingress 的 audit 只记元数据,trace 的意义就是要留 params/result,所以脱敏是强制的、不是调用方可选)。同步/异步两条调用路径(index.js 直调 / worker.js 队列)都覆盖,`runId`(异步路径)透传进去与 `run` 实体的 id 对得上。新增 RPC `orchestrator.run.trace`(镜像 `ingress.log.recent` 的 `{runId,workflowId,limit,days}` 过滤形状,admin-only)。`tests/utils/harness.js` 顺手补了 LOG_DIR 隔离(不然全套 orchestrator 测试会真往 repo `logs/` 写文件)。hermetic `trace-audit.test.js` 7 用例(append/recent/过滤/排序/脱敏/fail-soft + 两条真实 harness wiring 用例)。**残留**:`deprecate`/`reactivate` 独立生命周期状态仍未做——这个需要先定策略(重新激活要不要强制走完整审批),不是纯技术活,故意留着没动;仍与 ⚪三·路线图并列。`workflow.js`。**minor(路线图,需先拍板策略)**
- **README §11 防御上限未强制**(steps≤50/≤64KB/depth≤8/retry≤5):per-step retry 裸读 `step.retry||0` 无 clamp → 坏 workflow 放大下游负载。`runner.js:216`。**minor**

### nexus(§1.2 读路径 + §2.2 emit 动作闭环已闭,以下是剩余)
- **`system.nexus` 事件注册表**:✅ 已加 `'EVENT:SENTINEL:*':['*']`(`router/config.js`),Sentinel 现可往该命名空间发决策事件。**剩**:scheduler `emit_event` 发往**其它**流仍需按流加注册表条目(否则被 `checkRegistry` 挡)。**minor**
- ✅ **autorun 死胡同已闭(§2.2 emit-event 动作闭环,2026-06-07)**:新增声明式 `context.emit:{stream,type,emit_when?,payload_template?}`(inverted gate:stream/type 写死、模型只填值),autorun 后经真实 Router `event.emit` 把决策事件发上总线(`actor=sentinel:{id}`),at-most-once SETNX 守卫,inbox 留作审计副本。**e2e `68-nexus-emit-loop` full-profile 跑通**(A 唤醒→autorun→emit→总线→B 收到)。`context.js`(validate+buildEmit)、`stream.js` emit 分支。
- ✅ **生命周期收圆(§2.4,2026-06-07)**:加 `nexus.sentinel.enable`(重激活 + 重加订阅集 + 重建消费组)、`nexus.sentinel.delete`(从注册表硬删:profile/SET/订阅集/online/token);`disable()` 现**清 `NEXUS:SUB` 订阅集** + 软吊销 token(`subscribersOf` 不再返回 stale id)。`sentinel.js`、hermetic 测试覆盖。
- ✅ **scheduler 失败不再杀循环(2026-06-07)**:action 失败单独 catch + 日志,recurring **仍 reschedule 下一次**(cron 语义,瞬时失败不丢);并删掉 `emit_event` 那个过时的"event.emit not yet in Router"吞错(失败现在透传、可见)。`scheduler.js`、hermetic 测试覆盖。
- **autorun 仅裸文本 `agent.chat`**:无结构化/tool-call 产出契约,即使有 emit-loop 也难可靠解析成动作。`stream.js`。**minor**(未做)
- ✅ **写侧身份起步(2026-06-07)**:autorun(`agent.chat`)现按 §1.2 走该 Sentinel **自己的 token**(callAs;permit 须含 `agent.chat`),e2e 67 覆盖。**剩**:`emit` 刻意留 `system.nexus`(registry 按 source 鉴权 + `actor=sentinel:{id}` 归属,非退化);`notification.send` 是投递不计。
- **`schedule.list()` 用 `keys(prefix*)` 全扫键空间**;scheduler/stream 用裸 `Date.now()` 非可注入时钟(`identity.js` 已用注入式 now)。**minor**

### identity / 治理
- ✅ **bot permit 改了不咬活 session 已修(2026-06-10)**:Router Scheme F 热刷在 `user:{uid}` miss 且 uid 为 `system.*` 时补读 `user:bot:{uid}` → bot 的 permit 编辑即时生效于活 session;顺带:**非 ACTIVE 的 bot 即时降为 guest**(暂停立刻咬住,不等 TTL)。`router/handlers/auth.js`;hermetic `auth.test.js` +3 用例。
- ✅ **无可逆 bot 暂停 已修(2026-06-10)**:新增 `user.bot.suspend`(status→SUSPENDED + 杀全部活 session;自刷新被读侧 ACTIVE 门挡死)/ `user.bot.resume`(恢复 ACTIVE,admin 重发证上线),声明+注册+en/zh 描述同步,审计入文件 WAL。hermetic `bot-suspend.test.js`(4)+ e2e `100` test-5(suspend 即时拒活 token → resume 恢复)。
- ✅ **passport 外部行隔离 fail-closed(2026-06-07)**:两层防御 —— ① `role.set` 拒绝 `scope:'external'` 但无 `ownerField` 的角色;② `verify` 拒签解析出的 permit 不含 `constraints.$owner` 的外部会话(misconfig 当 INTERNAL_ERROR,不泄露)。落地了 passport.md §3.6/§3.7 早已写明、代码从没强制的契约。`role.js` set + `passport.js` verify;hermetic 测试 + e2e `68-external-isolation`(8/8)覆盖。
- ✅ **passport 无自助注册(2026-06-30 已修,本条此前漂了未同步)**:`user.passport.otp.request/verify`(public)+ per-app `config.passport.{issuance,defaultRole}` 落地(spec-passport-self-issuance.md),过 hermetic + e2e `111`。**剩**:TOTP 第二档、请求头硬化。
- ✅ **approval 零消费者(2026-07-03 核实:已有消费者,本条此前漂了未同步)**:`governance.md §3` 的"双轨审批收敛"三选一 —— 现状已是**方向1+方向2的混合**,不是零消费者:orchestrator `workflow.approve` 按 `risk_level` 路由(`workflow.js:568-632`)——LOW 走 C1 自包含单签快速道,HIGH 走 `approval.gate.open/sign`(approval 服务的多签状态机);另 collection `payment.refund` 用 `approval.record.get` 校验一个面向本次退款、需 3 个独立签名审批人的 approval.record(`collection/logic/payment.js`)。governance.md §3 的"三个方向需你定"已按用户决策定为**方向2**(orchestrator 继续自建 C1,approval 服务专注非工作流类敏感变更——collection 退款正是这类场景的既有范例);HIGH 风险 workflow 走 approval.gate 是既有实现,不因此决策回退。**剩**:governance.md §3 表格本身未更新反映现状,纯文档同步。
- **下游看不到细粒度 permit**:token 压成 'admin'|'user' 丢了 services map,任何 per-principal 下游判断要回 `user.permit.get`(H6 模式)。已知信任模型约束,非洞。`forward.js:38-39`。**minor**
- **actor-claim / 用户级信任根缺**:执行归属仅 server-attested(Router Ed25519),无用户密钥、无 X-Actor-Claim → admin 可抵赖高敏感流程;单信任域下故意暂缓。**minor(路线图)**

### storage
- ✅ **无 per-asset 授权(2026-07-03 核实:已被 §6.4 修,本条此前漂了未同步,与该节重复登记)**:详见下方 §6.4——`asset.js` 现有 `owner`/`visibility` + canRead/canDelete + `/file/:id` 签名闸。

### router
- ✅ **`X-Router-Token` 可重放 已修(2026-06-10)**:`parseRouterToken` 加新鲜度门(fail-closed):无 `iat`/超龄(`ROUTER_TOKEN_MAX_AGE_MS`,默认 300s)/超前超 60s 偏移 → `-32001` 拒——抓到的 (token,signature) 不再永久有效;`_tasks` 载荷同(同一解析器)。**剩**:窗口内重放仍可(要 jti/nonce 才能закрыть,代价是下游记状态;单机部署下 300s 窗已大幅收面)。`router-auth.test.js` +7 用例。
- ✅ **`event.emit`/`_event` 无幂等 已修(2026-06-10)**:接受调用方 `event_id`(格式校验)→ `EVENT:DEDUP:{id}` SETNX(TTL `EVENT_DEDUP_TTL_SEC` 默认 1h)→ 重发同 id 被抑制(suppress-only:伪造/猜测 id 只能丢自己的 emit);信封 `event_id` 保留客户端 id 便于对账;`processEvents` 返回 `{written,blocked,deduped}`。**注**:发射方要享受幂等需主动带稳定 `event_id`(nexus/scheduler 接入待办)。`trace.test.js` +3 用例。
- ✅ **rate limiter 两洞已修(2026-06-10)**:① Redis 出错/不可用不再 fail-open → 退化为**进程内计数器**继续限流;② 限流闸**上提到本地 METHODS 分发之前** → `event.emit`/`system.category.*`/`setting.*` 全部进闸(`system.report` 特判合并删除)。`ratelimit.test.js` +3 用例。
- ✅ **`_tasks` 白名单清理(2026-06-10)**:删掉已不存在的 `authority`/`log` 条目;gateway/notification 的 `allowFrom:['*']` 收紧为 `['fulfillment']`(代码里唯一的 _tasks 生产者),gateway allowMethods 改为真实的三个 send 方法(原 'push' 是死方法)。运行时仍可经 `setting.task.update` 扩。`tasks.test.js` 重写(6 用例,含 trace meta 透传)。
- ✅ **checkAccess public 面无 Router 侧白名单 ceiling(服务侧缓解,2026-07-03)**:`access.js:50-55` 本身未动(改动属红线,未授权)。改在服务侧补等效防线:`autocheck/static/public-surface-check.js` 把当前已核实、必要的 public 方法钉成显式白名单(user 8 个登录/OTP/发证前置方法、administrator 2 个 admin 登录、ingress 1 个 webhook 接收(另有 API key 鉴权)、fulfillment 3 个 ping/methods/entities 样板;其余 11 个服务 0 个),CI static 门(`ci.yml` 的 per-service 循环,覆盖全部 core/+apps/+sample,不含 router)逐服务扫描 introspection,出现白名单外的新 `public:true` 方法直接拦停(已实测:注入一个假 public 方法触发 ❌ FAILED)。**实际暴露面现状**(2026-07-03 核实):全队仅 14 个 public 方法(+ router 自己写死的 5 个系统方法,另受 `DISCOVERY_METHODS` 生产环境门控),`storage.asset.get/resolve` 等早前风险点已在 v1.1.8 收窄为 `public:false`。**残留**:Router 侧仍无机制上的上限(access.js 本身没变),这道门槛是"新增即拦"而非"从根上不可能",真要根治仍需 Router 侧改动(需授权)。`ci.yml` 已跑该门;`deploy/precheck.sh` 因既有 apps-only 范围限制未覆盖 core/,不额外处理(与既有设计一致)。
- **relay refresh 错误分类粗糙**:永久 4xx(如已 revoke 的 bot)被重抛成 generic `REFRESH_FAILED` 并重试;token 刚过期时的瞬时网络错却清掉存储 token 逼手动重注。`relay.js:185-197`。**minor**
- **relay refresh 错误分类粗糙**:永久 4xx(如已 revoke 的 bot)被重抛成 generic `REFRESH_FAILED` 并重试;token 刚过期时的瞬时网络错却清掉存储 token 逼手动重注。`relay.js:185-197`。**minor**

### administrator
- ✅ **`setting.config.*` in-handler admin 门已补(2026-07-03)**:`get/set/del/list/schema` 五个方法加 `if (!p.isAdmin) throw jsonrpc.UNAUTHORIZED()`(同文件 `setting.automation.*` 既有写法,纵深防御,不再纯靠 Router permit 下发保护)。`administrator/index.js:103-131`。**核实澄清(自锁那半是误诊)**:`admin.self.lock` 其实早有 in-handler 门,只是实现方式不同——不比 `p.isAdmin`,而是 `logic/identity.js:174-188` 独立重读 session 校验 `isAdmin`(比简单透传更强的一种硬门,本条当初把它算漏了)。无回归测试新增(同文件 `setting.automation.*` 这个既有精确写法本身也无专项测试覆盖,一致);CI 子集 110 套/1755 绿、`autocheck --static` 通过。

### 实体 WAL / 审计账本(2026-06-10 重构:write-behind 文件 → 原子流账本 + 归档器)

> **架构(本轮落地)**:`entity.js` 把账本行(op/key/before/after/user/txn/stamp)用 `xAdd WAL:STREAM` 绑进**与数据写同一个 MULTI**(string 走 CAS 事务内 `onMulti` 钩子,json 同 multi —— node-redis v5 起 json 命令可入事务,旧注释已过时);`library/walarchiver.js`(bootstrap 自动起,`WAL_ARCHIVER=off` 关)消费组异步落盘成原文件 WAL(灾备回放 `wal-recovery` 兼容,格式不变,行新增 txn/trace/ref)。覆盖:单测 `entity-wal-stream`(含 20 并发 CAS 账本链严格性)+ `walarchiver`(at-least-once/xAutoClaim/NOGROUP 自愈)、灾备脚本全管线、e2e `98`。

- ✅ **"先写库后补日志"窗口已闭**:数据与账本同生共死,"改了没记账 / 记了没改"两态结构性消失(原 entity.js:162 write-behind)。
- ✅ **账本写失败静默吞掉已闭**:原子路径下不存在"交易成功账本丢失";降级路径(mock 客户端)保留旧文件直写。
- ✅ **持久化域分裂已闭**:热账本与数据同域(Redis,AOF 一个旋钮管两者);文件成为独立故障域的第二副本,多副本安全(consumer group 分工)。
- ✅ **回放乱序隐患已修**:多归档消费者下文件行序≠提交序,`recoverAfter` 改为按 stamp 重排(stable sort 保同毫秒流序)。
- **json 实体 RMW 并发竞态仍在**(写+账本已原子,但读改写本身无 CAS,并发 update 互相覆盖且 before 快照可能过期;原 §8.2 已知缺口,无并发 patch 热点,候)。**minor**
- **>32KB 快照仍截断**(标记+preview+id 占位,不再整行丢失;完整版应存 storage CAS + SHA-256 指针——跨服务调用进不了 MULTI,设计待定)。**minor**
- **归档尾窗**:Redis 被毁瞬间未归档的尾部(典型亚秒)不在文件副本;数据本体靠 AOF,文件definitionally是审计/取证副本,定位如此。**记录在案,非洞**
- ✅ **`trace` 字段已灌上(2026-06-10)**:trace 全链传递落地(见下节)后,服务 `walContext.run` 注入 `req.meta.trace` → 账本行 `trace` 字段携带链 id;e2e `99` 验证 workflow 驱动的实体写,账本行 trace 与触发事件同链。跨服务审计可按 trace 精确 join。

### 事件链 / 自治联动(decision→workflow,e2e `97` 暴露)
> 新能力(e2e `97` 跑通):`事件 → Sentinel autorun(agent.decide)→ context.emit → orchestrator matcher → workflow → 动作(又发事件)`。复杂度经总线横向组合(choreography)。该能力把安全重心从"每服务方法级权限"挪到"总线 emit 授权 + 链路治理"——恰是最薄的两块。以下问题多为既有洞被**级联放大**,外加一类全新的(自治环路)。

- ✅ **无环防护 / 无链路预算 已修(2026-06-10,深度预算刹车)**:信封新增 `depth`(事件跳计数,每次 emit +1),Router `processEvents` 超过 `EVENT_MAX_DEPTH`(env,默认 16)即**拦截**(写 0 条)+ `ERROR:QUEUE:router` 记 `EVENT_DEPTH_EXCEEDED`(带 trace_id)→ 自喂环在有界跳数内终止,不再无限烧 LLM。e2e `99` test-4 实测:depth=16 的触发,Sentinel emit 被拦、链终止。**残留**:预算是钝刀(等环跑满 16 跳才停,每跳仍烧一次 LLM 调用);"同链同节点去重"(精准断环)未做,候。
- ✅ **链路不可追溯 已修(2026-06-10,trace 全链传递)**:统一规则"**有则继承、无则铸造**"——Router 入口(`handlers/trace.js`)从 `X-Trace-Id/X-Trace-Depth` 继承或铸造;三条管道全部透传:① 转发 token `meta.trace/depth`(服务 `req.meta`→`walContext`);② `_tasks` 异步分发同链同深;③ 事件信封 `trace_id` **改为透传**(不再每跳随机)+ `parent_event_id`(精确因果边,仅 event.emit 路径可信,同 actor 规则)+ `depth`。链中节点显式携带:orchestrator matcher→run 记录(`trace`/`parentEventId` 字段)→ worker 步骤调用 `X-Trace-*` 头;nexus 消费者 walContext 包裹 + buildEmit 填 parent;fulfillment history 行落 `trace` 戳;实体 WAL 账本行 `trace` 字段**灌上了**(与 WAL 节互证)。e2e `99` 全链验证:注入触发(T0)→决策信封 trace=T0/depth=2/parent=触发id → run.trace=T0 → 实体账本行 trace=T0 → 收款事件 depth=3;且 trace 穿过**第二个**被链式触发的 workflow(auto-settle)仍连续。hermetic `router/tests/trace.test.js`(12)入 CI。**残留**:`parent_event_id` 在 `_event` 夹带路径为空(夹带方不知父事件,只有 trace 线性链);trace 是 advisory 关联键(可自带,不防伪造)——定位即如此。
- ✅ **confused deputy(触发来源 ≠ 动作授权)最小档已修(2026-07-02,actor-claim 最小可行档)**:原状——事件触发的 workflow 跑在**共享 `system.orchestrator` bot** 下,H6 拿该 bot 的宽 permit 预审 trivially pass,从不校验触发来源;actor 在信封里带着但被 matcher 丢弃 → advisory 都算不上。现修:① **透传**——matcher 把信封 `actor`(引发者)+`source`(Router 认证发射者)带进 run-command→run 实体(`actor`/`actorSource`)→`$context.trigger_actor`,grant/requeue 恢复全程保留;② **opt-in 预审**——workflow `require_actor_permit:true` 时 runner 在 H6 后加查 **actor 本人 permit 覆盖全足迹**(fail-closed:actor 缺失/`sentinel:{id}` 等不可解析形态直接 FORBIDDEN,刻意不走 NeedsGrant 防 grant 洗白);字段 ACTIVE 冻结+审中改动作废签名闸;③ **审计**——ops 通知带 actor,永久拒绝的 run 实体收尾 DEADLETTER(顺修"被拒 run 滞留 RUNNING→假 STALLED 告警")。默认关=现状,纯增量。hermetic `actor-precheck`(11)+matcher/worker/run/hardening 扩展,CI 子集 110 套/1751 绿。**剩(仍暂缓,跨信任域档)**:X-Actor-Claim 签名头+服务凭证+`library/actor-claim.js`(AUDIT C4);事件注册表宽 glob 的收口纪律不变。
- 🟡 **AI 当执行器:闭集内可被注入翻转(部分缓解,2026-07-03 起源头收窄)+ 置信兜底失效(2026-07-03 部分缓解,配置化)**:inverted gate(闭集 choices、emit stream/type/payload 建档固定)限死 blast radius(模型选不出新目标)——**真 containment**,这半没变。置信兜底半:原 `confidence<0.6→escalate` 硬编码阀已加 `risk_tolerance` 具名档位(`agent.decide` 新参数,`decide.js` `RISK_TOLERANCE_LEVELS`:`permissive`=0.6(=旧默认,不加档位行为不变)/`balanced`=0.8/`strict`=0.95,按 Gemini/Qwen 实测置信度聚在 1.0/0.9 标定),经 nexus `context.autorun.risk_tolerance` 透传(hermetic `decide.test.js` +4、`context.test.js` +1)——只是把"阀值不可调"变可调,不改变信号本身可信度。**新增(源头收窄)**:注入内容最主要的入口——ingress webhook——现可挂 `dataSchema`(`ingress.source.create/update` 新参数,`checkParams` 扁平方言)白名单+类型化 `data` 字段:未声明字段 OR 声明字段类型/pattern 不符 → **整条投递拒绝,进入 `ingress.review.*` 人工审核队列**(不静默丢字段、不放行),ops 收 `notification.send` 提醒(fail-soft);人工 `approve`(照发)/`discard`(丢弃)裁决。配了 `dataSchema` 的 source,未声明字段**连事件总线都上不了**,自然也进不了后续 nexus 装配给 LLM 的 context——把"prompt injection 能在闭集内翻转决策"从"任意字段都能打"收窄到"只有声明过的自由文本字段还能打"。`logic/{source,ingest,review}.js`,hermetic +9(`ingest.test.js`/`returns-contract.test.js`)。**残留(仍开,故意不在本次范围)**:① 声明为 `type:'string'` 的自由文本字段本身仍可携带注入内容(schema 管得了"有没有这个字段/是不是字符串",管不了字符串语义);② 字段级"信任标记 → nexus prompt 组装时特殊隔离"未做(第二轮,需要动 nexus 那侧);③ 非 ingress 来源的注入面(比如 `data_fetchers` 拉取的下游服务数据)不在本次覆盖。**minor(残留 major:自由文本字段内容 + 非 ingress 注入面)**
- ✅ **激活治理缺口被链式放大(2026-07-03 核实:premise 已不成立,本条此前漂了未同步)**:全文搜索 `workflow.js` 里所有把 `status` 写成 `'ACTIVE'` 的位置,只有两处,都在 `approve()` 内部且都受 C1 自审禁止 + `PENDING_REVIEW` 前置态门控:①LOW 风险单签道(`:578`)②HIGH 风险 `approval.gate` 多签阈值达成后(`:624`)。`create()` 恒 `PENDING_REVIEW`(`:276`),`restore()` 显式注释"C5:never directly to ACTIVE"只回 `PENDING_REVIEW`(`:675-680`),`update()` 的参数解构里根本不接受 `status` 字段——没有找到能绕过这两条审批道直接注入 ACTIVE 的路径。写这条时(2026-06-07 审计)风险路由 + CAS 审批闸尚未落地,现状已随其收口。若之后发现新旁路,按 major 重开此条并附具体绕过路径。
- ✅ **matcher 删流即卡死(NOGROUP)已修(本轮,未提交)**:`matcher.consumeOnce` 一次 `xReadGroup` 读全部 `knownStreams`,任一流的组被删 → 整读抛 `NOGROUP` → loop 仅 log、`knownStreams` 从不剪枝 → **永久卡死、停掉全部事件编排**到重启;链式测试每轮删自己的 DECISION 流即触发(第 1 轮过、之后全挂)。修法:镜像 nexus `stream.js` 的 NOGROUP 恢复(`knownStreams.clear()`+下一拍重发现)。`matcher.js` xReadGroup 处;e2e `97` 连跑 4 轮稳定即回归。

---

## ⚪ 三、路线图(NOT bug,需设计/暂缓)

- **orchestrator**:版本快照 / revise / versions、deprecate / reactivate、trace 持久化、**Saga compensate**(需补偿链+幂等+死信设计)、method.grant 服务凭证治理 —— AUDIT.md / README §9。
- **双轨审批收敛**(orchestrator C1 自建 vs approval 服务,governance.md §3 未决);**approval 接入消费者**。
- **actor-claim**(执行凭证签名)/ 用户级信任根 —— 单信任域 H6+C1 暂覆盖;真做需给 user 身份加私钥。
- **nexus**(emit-event 闭环 + scheduler 失败存活 + autorun 写侧身份已落地):SSE 推送模式 B / MCP adapter、自动发证、autorun 结构化产出契约(tool-call)。
- **passport 自助档**(OTP/TOTP + defaultRole)。

---

## 🛡 四、全队基础硬化(逐服务"minor",但全队统一、挡生产姿态)

- **CORS 全开**:16 个 Express 服务都 `app.use(cors())` 无 origin 白名单。
- **Redis 明文无密无 TLS**:每个 dev/run 路径(`deploy/dev.sh`)无 `requirepass`/TLS,而 Redis 存着全部 session/permit/bot token/WAL/relay token;无生产硬化脚本。
- **零可观测面**:无 `/metrics`、无 `/health|/readyz|/livez`,liveness 只有 JSON-RPC `ping`;无延迟/队列深度(notification & nexus DLQ)/错误率指标。
- **CI 覆盖**:`jest.ci.config.js` 跑已验证的 hermetic 子集（header 现标"59 suites"，非"27"）,非 hermetic 套(live-mesh e2e / LLM / process.exit 脚本 / RedisJSON / 已知坏的 validator.test.js)排除。**live-stack E2E job 已建**(`.github/workflows/ci.yml` 的 e2e job,对全栈跑)。原"无 e2e job / 27 suites"已过时。`jest.ci.config.js` 头注。

---

## 📄 五、文档过时(2026-06-07 已打真一批)

- ✅ **`governance.md` §3**:C1 approve/deny + H6 footprint + `permit.js` 三处 ❌→✅(已落地、CI 绿);actor-claim 仍 ❌。
- ✅ **notification README §6/§8**:webhook 矛盾已对齐 —— 模式 A 标注"`gateway.webhook.send` 未建、配得上投不出、会进死信",worker 走 `gateway.{channel}.send` 而非 `_tasks`。
- ✅ **orchestrator README §2**:加 ⚠️ banner —— 角色表是目标设计,现状只 `permitIsAdmin()` 单门 + 部分方法(deprecate/restore/method.grant)未实现。
- ✅ **`jest.ci.config.js` header**:"27 suites" → "50 suites"(2026-06-07)。
- ✅ **`security.md` resolver 条目**(2026-06 核实并改):冲突已厘清 —— *resolver 方法名黑名单*确已删(`workflow.js:204-205` / `:391`,C1+H6 取代);router 的 *`PERMIT_BLACKLIST`*(枚举节流)是另一回事、仍在。两者不再混为一谈。

---

## 🧱 六、静态 workflow 上线档 —— 整体修缮章(scenario-scoped,2026-06-11)

> **前提条件(本章的适用边界,先确认再动手)**:应用系统以 SOLO 为基座上线,且:
> ① workflow 全部人工编写、测试、上线时审定(**静态**)——运行期不依赖 AI 创建/修改 workflow;
> ② 权限人工调好:bot permit、事件注册表(per-source glob)、`allowed_triggers` 上线时收口;
> ③ 单机部署(loopback 信任成立;多机见末尾"条件项")。
>
> **在此前提下退场、本章不做**:approval 消费链 / C1×NEEDS_GRANT 收敛、AI 置信兜底、actor-claim、
> 自动发证——全是"变更治理"线(贯穿主题⑤),AI 不在运行期改 workflow 时不构成回退阻塞;
> confused deputy 降级为配置纪律(注册表 per-source + `allowed_triggers` 闸已有,`runner.js:55-60`)。
> ⚠️ 一旦放开"AI 运行期调整 workflow",退场项全部回表(回到 贯穿主题⑤ + 三、路线图)。
>
> 本章主旨:**静态 workflow ≠ 静态输入、≠ 不会半途失败、≠ 不会被重复触发。**
> 推进顺序:6.1→6.2→6.3(运行时可信三件套,一波做)→ 6.4(若存用户文件)→ 6.5 → 6.6/6.7。
>
> **✅ 全章已落地(2026-06-11,同包实现)**。验证基线:CI hermetic 子集 **61 套/790 测试绿**(新增
> static-workflow-hardening 20 用例、asset-authz 12 用例、checkParams/metrics/cors/DLQ-alert
> 扩展若干,全部入白名单);全栈 e2e **54 套/267 测试全绿**(harness full 档,含 95/96 mock 链路
> ——现已自包含可复现)。与原方案的偏差均在对应小节以 **「实现偏差」** 标注;落地途中顺手修掉的
> 预存问题见 §6.x —— 审阅时看这两类即可。

### 6.1 失败语义补齐 —— 失败的 run 必须"可见 + 有人管 + 有清单"  ✅ 已修(2026-06-11)

- **现象 1(失败被记成 DONE)**:worker 对 runner 返回的 completed/failed **一律 `run.done()`** → run 实体 status=DONE(`worker.js:129-140`);run.js 没有 FAILED 态(现有 RUNNING/PAUSED_AWAITING_HUMAN/RESUMING/DONE/DEADLETTER,`run.js:30-127`)。人工在总览里分不出成败。
- **现象 2(失败不通知人)**:非 ignore 步骤失败 → runner 只 xAdd `EVENT:WORKFLOW:STATUS` 就返回(`runner.js:265-275`);对比 NEEDS_GRANT 有直达 ops 收件箱的 `notification.send`(`worker.js:186-203`)——**不对称**。失败事件在总线上,没配 Sentinel 订阅 = 没人知道。
- **现象 3(补偿零实现)**:失败时前序步骤副作用已提交,`step.compensate` 被静默忽略(二.orchestrator 既有条目,`runner.js:33-35`)。人工接手时框架说不清"哪些已执行、要收拾什么"。
- **现象 4(run 会凭空卡死)**:worker 用 **`blPop` 破坏性读**命令队列(`worker.js:250`)——进程崩在 run 中途,命令已出队、永不重投,run 实体**永远卡 RUNNING**,无人发现。
- **修法**:
  ① `run.js` 加 `fail(runId, {failedStep, error, cleanupManifest})` → status=**FAILED**;worker 按 `result.status` 分流(completed→done / failed→fail)。
  ② worker 失败路径镜像 NEEDS_GRANT 模式发 `notification.send` 到共享 ops 收件箱(fail-soft),payload 带 workflowId/runId/failedStep/error/trace。仅异步路径通知(sync 调用方自己拿 result,不重复叫人)。
  ③ **补偿最小档(本章做)= 披露**:失败时把已成功步骤的 `{id, method, result 摘要, compensate 声明}` 列表(cleanup_manifest)写进 run 实体 + 通知 payload → 人工照单收拾。**自动补偿不做**(逆序执行 + 补偿自身幂等 + 补偿失败处理是一整套设计,留在 三、路线图 Saga 条目)。
  ④ 卡死兜底:扫描器把 RUNNING 超过 `RUN_STALL_MS`(默认 ~10min,env)的 run 标 **STALLED** + 通知 ops。**不**在本章把 blPop 改成 lMove+回收的重投队列——重投 = at-least-once = 必须先有步骤幂等键(取舍见 6.2③)。
- **验证**:hermetic `worker.test.js` 扩(failed→FAILED+notify 恰一次;STALLED 扫描);e2e:注入必失败步骤 → ops 收件箱收到通知、run.list 见 FAILED + cleanup_manifest。
- **落地证据**:`run.js`(fail/stall + FAILED/STALLED 态)、`worker.js`(status 分流 + notifyRunFailed + scanStalledRuns,stallMs/stallScanMs 进 config)、`runner.js`(buildCleanupManifest,失败 result 带 cleanup_manifest+workflowVersion,事件 payload 带 committed_steps)。hermetic:`static-workflow-hardening.test.js`(cleanup_manifest×2 / worker seam×3 / stall×3)。

### 6.2 触发幂等 —— at-least-once 的事件别变成两次副作用  ✅ 已修(2026-06-11,③刻意挂账)

- **现象 1(同事件二次起 run)**:matcher"先 enqueue 后 xAck,失败不 ack 等重投"(`matcher.js:172-178` 自注释)——crash 在 enqueue 与 ack 之间 → 重启后事件重投 → **同一事件第二次起 run**。
- **现象 2(发射方不带稳定 event_id)**:Router `EVENT:DEDUP` SETNX 已落地(二.router ✅),但 nexus/scheduler 发射时不带稳定 `event_id` → 享受不到去重(该待办归并到此)。
- **修法**:
  ① matcher enqueue 前 SETNX `ORCH:FIRED:{event_id}:{workflowId}`(TTL 同 `EVENT_DEDUP_TTL_SEC`),enqueue 失败则 DEL 释放(镜像 nexus emit guard,`stream.js`);event_id 缺失回退流 entryId。→ per (event, workflow) at-most-once 起 run。
  ② nexus `buildEmit` 生成确定性 `event_id = snt:{sentinelId}:{ref}`;scheduler `emit_event` 用 `sch:{scheduleId}:{slot}`。
  ③ **步骤幂等键(取舍点,先挂账不做)**:方案是 runner 给每步注入 `idempotency_key: {runId}:S{idx}`(复用 fulfillment 参数约定,`instance.js:132`)+ 新增 `library/idempotency.js` helper(SETNX+缓存 result)供下游接。**但当前 worker 是 blPop at-most-once,①做完后步骤级重复没有来源**;只有将来把 6.1④ 升级成重投队列时,③才从可选变必需。两种语义二选一:**丢任务不重复(现状+STALLED 兜底,本章选这个)vs 不丢任务但需全网幂等(重投)**——翻案时③随行。
- **验证**:hermetic matcher 测试(同 event_id 重投只起一次 run、enqueue 失败释放 guard);e2e 97 连跑验证决策事件去重。
- **落地证据**:`matcher.js`(SETNX guard + 失败 DEL 释放)、`nexus/logic/stream.js`(emit event_id=snt-{id}-{ref})、`scheduler.js`(sch-{id}-{slot})。**实现偏差**:guard 前缀用 `ORCHESTRATOR:FIRED:`(服务命名空间约定),非草案的 ORCH:FIRED。hermetic:matcher.test.js +4、scheduler.test.js +2(同槽位重发同 id)。③步骤幂等键按本节取舍**未做**(现状 at-most-once+STALLED 兜底;翻成重投队列时随行)。

### 6.3 input_schema 强制 —— 静态 workflow 也挡不住脏输入  ✅ 已修(2026-06-11)

- **现象**:runner 只查 `required_inputs` **存在性**(`runner.js:63-70`),无类型/格式校验,untyped input 直接 spread 进下游 params;事件路径 payload 直接成 `$input`(`matcher.js:153`)——典型来源是 ingress webhook(外部输入)。
- **修法**:
  ① 校验器**下沉 library**:扩展 `library/validate.js`(现有 checkString/PATTERNS)加 `checkParams(items, params)`,dialect 与 Router 参数卫生一致(name/required/type/pattern/minLength,`router/handlers/validator.js` 的规则形状)——**不动 router**(红线),router 将来是否反向复用另议。
  ② workflow `input_schema` 采用同一 flat dialect;runner 在 footprint 预审**之前** fail-closed 校验,违例 `INVALID_PARAMS` 带字段清单(事件路径 = run 拒起 + 6.1② 通知含原因)。
  ③ `result_schema` 先做 **warning 档**(违例记 stepTrace+日志,不阻断)——避免误杀已上线 workflow;per-workflow `strict_result: true` 升级为阻断。
- **验证**:hermetic runner 校验用例;e2e:坏 payload 的 webhook 触发 → run 拒起、通知含字段错误。
- **落地证据**:`library/validate.js` checkParams(flat dialect,7 用例)、`runner.js` 2.1 节(fail-closed,在 footprint 预审前)+ result_schema warning/strict_result 阻断(hermetic 各 2 用例)。

### 6.4 storage 对象级授权 —— 拿到 id 就拿到文件  ✅ 已修(2026-06-11)

- **现象**:`apps/storage/logic/asset.js` 全文无 `req.user`/`constraints`/owner 引用(grep 零命中);`/file/:id` 302 无鉴权(`index.js:67-76`);`private` 模式签 OSS URL 但不门控谁能拿签名(二.storage 既有条目,本章给修法)。
- **修法**:
  ① asset 实体加 `owner`(创建时记 `req.user`)+ `visibility: public|internal|private`(**默认 internal**=须登录;开放问题:要不要默认 private)。
  ② get/resolve/delete 按 `constraints.$owner` 校验(镜像 collection 行隔离),admin 越过;`sensitiveFields` 按 CLAUDE.md §5 显式声明。
  ③ `/file/:id`:public 直 302;非 public 要求短期签名 query(复用 `oss/presign.js` 原语,local 驱动同走签名)。**breaking**:现有直链失效,上线前出迁移说明。
- **验证**:hermetic asset 授权用例;e2e `60-storage-ops` 扩(他人 id 拿 private→403;签名过期→403)。
- **落地证据**:`asset.js`(canRead/canDelete + owner-aware CAS dedup + list 行过滤)、`index.js`(RPC ctx 透传 + /file/:id 签名闸)、`config.js`(defaultVisibility=internal / routeSecret)、introspection+entities 同步声明。hermetic:`asset-authz.test.js` 12 用例(private/internal/public×get/delete/list/dedup/legacy fail-closed)。**实现偏差**:同一文件不同 owner 上传不再共享 metadata 记录(各得各的 owner/visibility,字节仍 CAS 去重)——这是把"visibility 不被首传者劫持"做对的必要改动。

### 6.5 生产硬化包 —— 上线姿态四件套  ✅ 已修(2026-06-11)

- **Redis**:deploy 加 prod 档(`redis.prod.conf`:requirepass+可选 TLS;`library/config` 统一读 `REDIS_PASSWORD/REDIS_TLS`,**所有**连接点——bootstrap/relay/walarchiver——同一构造)。
- **CORS**:收口到 `library/bootstrap`(`CORS_ORIGINS` 白名单 env,prod 默认拒;dev.sh 显式放开)。⚠️ **router 也在 16 服务之列——动 router 的 CORS 需用户单独授权**(CLAUDE.md §5 红线),先做其余服务,router 留授权点。
- **metrics**:`library/health.js` 扩 `/metrics`(Prometheus 文本):DLQ 深度(notification deadletter / nexus DLQ / FAILED+STALLED run 数)、事件流 XLEN+pending、ERROR:QUEUE 深度。
- **最小告警档**:administrator 定时扫阈值,超限 → `notification.send` ops——不架 Prometheus 也有告警;正式档交 Alertmanager。
- **验证**:e2e 70 扩(/metrics 公开可抓);带密 Redis 全栈冒烟。
- **落地证据**:`library/health.js` /metrics(全 13 服务自动获得;notification/nexus/orchestrator 挂 getMetrics:队列深度+FAILED/STALLED run 计数;collector 失败降级不拖垮探针,hermetic 3 用例);`library/cors.js` corsOptionsFromEnv(15 个服务一行接入,CORS_ORIGINS 未设=现状全开、none=拒、列表=白名单,hermetic 3 用例;**router 未动,留授权点**);`deploy/redis.prod.conf`(requirepass+AOF+noeviction+危险命令改名)+ 带密连接冒烟已实测(redis://:pw@ 正反两向);告警:**实现偏差**——扫描器放在 notification worker 而非 administrator(它拥有收件箱,进程内 message.send 无 relay 跳板,ref-dedup 天然限频),扫自己 deadletter + NEXUS:DLQ + ORCHESTRATOR:RUNQ:DEADLETTER 三队列,hermetic 5 用例。

### 6.6 版本快照 + 并发编辑保护  ✅ 已修(2026-06-11)

- **现象**:approve 原地改单一 JSON、update 无并发保护(`workflow.js:122-128, 225-275`,AUDIT M1/M6)——上线后修订 workflow,历史 run 无法回答"当时跑的是哪一版";两 admin 并发编辑互相 clobber。
- **修法**:① update/approve 走 `library/optimistic.js`(现成)防 lost-update;API 加可选 `expected_version`,不匹配→CONFLICT(防改陈旧副本)。② approve/update 成功即写不可变快照 `WORKFLOW:V:{id}:{n}`,run 记录 `workflowVersion`;run 详情可回放当时定义。deprecate/reactivate 仍在 三、路线图。
- **验证**:hermetic 并发 update(两写者无丢失);run 实体含版本号、快照可读。
- **落地证据**:`library/optimistic.js` 新增 `optimisticJsonUpdate`(RedisJSON 版 WATCH/MULTI CAS,onMulti 钩子把快照写绑进同一事务);`workflow.js` create/update/approve/deny/delete/restore 全部走 CAS,版本单调递增,快照前缀 `ORCHESTRATOR:WORKFLOW_V:`(下划线,免被 WORKFLOW:* glob/rebuildIndex 误扫);DELETED 复建续版本线(旧快照不被覆盖);expected_version 不匹配 → FORBIDDEN(-32005,无专用 CONFLICT 码)。hermetic 6 用例。

### 6.7 运维操作面 —— 死信和失败 run 的"最后一公里"  ✅ 已修(2026-06-11)

- **现象**:`nexus.dlq.list/retry`、`notification.deadletter.list/requeue`、`orchestrator.run.grant/abort` RPC 全部现成(introspection 已声明),但 portal 只有 AutomationControl 总览(pause/resume + 3 个 RPC)——人工处理要手敲 RPC。
- **修法(纯 portal 前端)**:AutomationControl 加 drill-down:DLQ 列表+重投/丢弃、FAILED/STALLED run 列表(依赖 6.1)+ cleanup_manifest 展示 + grant/abort 按钮。UI 遵守 CLAUDE.md §8(无系统弹窗,危险操作内联确认 + danger 按钮)。
- **验证**:e2e/ui Playwright(system 组)补 DLQ 重投与 run 处理用例。
- **落地证据**:`AutomationControl.tsx` 新增三个 drill-down 区:"Runs needing a human"(PAUSED/FAILED/STALLED 三态列表,行展开见 missingMethods / failedStep+lastError+cleanup_manifest 表格 / STALLED 处置指引;Grant=UIProvider confirm 模态+一次性授权说明,Abort 同)、Nexus DLQ(逐条 Retry)、Notification dead letters(逐条 Requeue,毒丸耗尽诚实提示)。tsc --noEmit 绿。**遗留**:Playwright 用例未补(e2e/ui 需起双 portal+全栈,留下一轮)。

### 6.x 落地途中顺手修掉的预存问题(2026-06-11,e2e 跑通过程中暴露,均经基线比对确认非本章改动引入)

- ✅ **三个服务的 events 声明被自家 auth 拦死**:user/gateway/administrator 用自带 auth(非 library/auth),public 白名单漏了 `events` → Router 注册时拉事件声明被 401 → `system.service.status` 的 events 恒 null(e2e 93 三连红)。各自白名单补 `'events'`。*(上游 2026-06 全服务铺 events.js 时漏的)*
- ✅ **public 方法身份盲区**:`library/auth.js` 对 public 方法直接 `next()`,连 Router 已转发的合法身份都不解析 → `storage.asset.resolve`(public)永远 req.user=null,撞上 §6.4 的 internal 门(e2e 21 红)。改为 best-effort 解析:有票带身份、没票才匿名——public=不强制鉴权≠身份盲。
- ✅ **fulfillment.token.set 的 expiresAt 声明类型离群**:全队约定 number(orchestrator/nexus/notification),fulfillment 声明 string → 参数校验上线(2026-06 拉取)后 harness 播 token 被拒 → relay 无 token → `EVENT:FULFILLMENT:TRANSITIONED` 发不出(e2e 96 链路腰斩)。改 number。
- ✅ **e2e 95/96 不可复现**:依赖手工跑 dev 栈 + deploy/mock 工具链。harness full 档现在自包含拉起:bootstrap.js(source+keys.env)→ inject-workflows --active → listener(:8091),fail-soft(装不齐只影响 95/96)。`e2e/harness/setup.js` 6a' 节。
- ✅ **e2e 96 首事件竞态**:盲睡等 matcher 发现新流,但消费组 '$' 起点建立晚于 POST → 首事件被静默错过、后到杂事件误匹配(诡异的 $input 丢失假象)。改为 XINFO GROUPS 轮询消费组真实存在再发。
- ✅ **e2e 50/62 断言过时**:50 的"email 空 params=投递失败"杠杆已被地址解析链(2026-06-10)变成降级回 inbox;62 还在 config.set 里用已 fail-closed 的 sse。50 改用 webhook→关闭端口(连接拒绝=瞬时错→重试/死信),62 改 webhook+url 并显式断言 sse 被诚实拒绝。

### 6.y 防腐化三件套(2026-06-11,§6 落地后的复盘产物 —— 把这轮人工抓出来的漂移模式变成机器看守)

- ✅ **auth 分叉清零**:本轮共发现 **5 个**手搓 Router-token 验签分叉(user/gateway/administrator 人工排查 3 个 + 新静态检查又揪出 agent/orchestrator 2 个),全部迁到 `library/auth` createAuthHandlers,各服务只留 publicMethods 白名单。副产物:orchestrator 同步 RPC 路径的 `req.meta`(trace/depth)此前被分叉静默丢弃,迁移后接通;administrator 补齐 /auth/seed+verify、entities、config.description 三个结构豁免。
- ✅ **CI static gate 空转修复 + 两条新检查**:原 `node autocheck/checker.js --static` 指向 api 根目录 → structure 检查直接 bail("纯文档/设计阶段")、**整个静态门什么都没查**。改为 ci.yml 里逐服务循环(14 个真实服务目录,全部跑绿)。新增 `param-conventions`(基建参数名 token/expiresAt/page… 跨服务类型唯一,约定表即代码)与 `auth-fork-check`(x-router-token+sign.detached 而不经 library/auth = 红)。**遗留**:`api/sample/` 模板自身过不了 security/ed25519 检查(脚手架豁免,未入 CI 循环),择期对齐。
- ✅ **live e2e 进 CI**:ci.yml 新增 `e2e` job(redis-stack 服务容器 6699 + api/e2e 双 npm ci + `E2E_PROFILE=full jest --runInBand`,54 套全量,blocking)。harness 复用外部 Redis 的路径已本地实测(起 6699 redis-stack → "Redis already up" → teardown 不杀外部实例)。这条堵上"行为改了、测试没同步"的最大漂移通道——本轮拉取的 29 个提交合入时就带着 6 套红 e2e 而无人知晓。

### 6.8 条件项(按应用形态启用,不计本章工作量)

- **外部用户自助接入**:passport OTP/TOTP 自助档(BACKLOG §1.4 已细化设计)——应用面向外部用户才需要。
- **多机部署**:category loopback 信任、`urlFor` localhost 假设要改 service-bot token(`router/handlers/auth.js` 注释已标)。
- **SSE 推送**:现 fail-closed 诚实拒绝;要推送再做(三、路线图)。
- **fulfillment Phase-3**:workflow 回调/ai_hooks 占位——workflow 要联动履约状态机才需要。
