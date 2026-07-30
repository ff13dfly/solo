# gateway 出站缺口 · 台账

> **总入口在 [`BACKLOG.md`](./BACKLOG.md) §3。** 本文是其中"gateway 出站缺口"那行的 drill-down。
> **来源**：2026-07-30 gateway 全量读码审计（`api/core/gateway/` 19 个文件全读，交叉核 `core/notification/logic/worker.js`（唯一 worker 消费者）、`deploy/scaffold/init.sh`（下发 .env）、`portal/system/src`（管理面）、既有三份债台账）。
> **约定**：SOLO 是纯框架，缺业务不算 gap。本清单只收 gateway 这一层**"声明了却做不到"** 或 **"与系统其余部分明显不对称"** 的项。已在别处记账 / 明确暂缓的不重复开条（见 §5）。
> **图例**：🔴 声明了实际不通 · 🟠 结构性缺失 · 🟡 能力空白 · ⚪ 一致性债
> **归属**：`v1.1.x` = 只加不破、现在就能落；`v2` = 需破坏性变更或语义收敛。
>
> **进度（2026-07-30 首轮补齐）**：19 条中 **11 条已修**（G1–G5、G7、G14–G18）+ **2 条部分**（G8 成功侧 / G13 的 cc-bcc-replyTo），
> 全部"只加不破"。剩 G6 / G9 / G10 / G11 / G12 + G8·G13 的尾巴，逐条状态见 §6 的表。
> **未部署 · provider 真机未验证**（阿里云/Twilio 需真凭证 + 已审模版）；hermetic 全绿见 §7。

---

## 0. 基线：审计当时已实现的部分（不在清单内）

SMTP 账号 CRUD（密码 AES 加密 + `gateway.smtp.test` 探活）· 邮件模版 CRUD + `{{var}}` 插值 · 邮件发送三通道（smtp / api / mock）· 短信模版 CRUD + 发送（aliyun / twilio / mock）· 出站 webhook（HMAC-SHA256 签名 + SSRF 闸 + 有界超时 + 响应体上限）· rmbg 抠图（local ONNX → remove.bg 回落）。

方法面 24 个（`handlers/introspection.js`），声明↔注册同步，返回契约 `returns_schema` 全覆盖，hermetic 测试 2 套在 CI 白名单内。**缺口都在这条基线之外。**

> 首轮补齐后（2026-07-30）基线已推进到：方法面 **26 个**（+`gateway.delivery.get/list`）· hermetic **5 套**在 CI 白名单（+`sms-provider` / `send-validation` / `delivery`）· 两个投递事件进 `emits` 声明。

---

## 1. 🔴 声明了但生产上不通（4 条）

### G1. 阿里云短信通道签名协议不对 —— 配了凭证反而全 4xx  ✅ 已修（2026-07-30）

- **现象**：`logic/sms.js:10-33` 用 `Authorization: AccessKeyId <id>` + JSON body 打 `dysmsapi.aliyuncs.com`。阿里云要的是 **RPC 风格签名**（规范化 query + HMAC-SHA1 的 `Signature` 参数）或 **V3 头签名**（`Authorization: ACS3-HMAC-SHA256 Credential=…,SignedHeaders=…,Signature=…`）。代码注释自己就写着 `requires official SDK or signed REST call in production`（`sms.js:11`）。
- **影响**：比不实现更糟——`resolveChannel` 一见 `accessKeyId` 就选 aliyun（`sms.js:5`），**不会降级 mock**，每条短信直接 4xx。notification 侧按临时错重试 5 次（`core/notification/config.js:38`）后进死信；passport OTP 走 relay 同步调用则直接失败发不出码。
- **修法**：实现 V3 头签名（无新依赖，`crypto` 够用：canonical request → hashed payload → `ACS3-HMAC-SHA256` 签名串）；不引官方 SDK（bundle 减肥方向，见 BACKLOG §4）。签名逻辑抽 `logic/providers/aliyun-sign.js` 便于单测。
- **验收**：hermetic 套用**固定输入 + 冻结时间**断言签名串与阿里云文档示例逐字节一致（离线，不打真实网络）；`SMS_ALIYUN_*` 配齐后手工发一条真短信记进 CHANGELOG。
- **归属**：`v1.1.x`（纯修，无 wire 变更）。**优先级最高**——这是唯一"配了就坏"的条目。
- **修法（已落地）**：新增 `logic/providers/aliyun-sign.js` —— V3 `ACS3-HMAC-SHA256` 头签名（canonical request 六段 + `x-acs-*` 签名头 + RFC3986 percent-encode + 空 body 载荷哈希），无新依赖（只用 `crypto`），`date`/`nonce` 可注入以便冻结时间测试。`logic/sms.js` 的 `sendAliyun` 改为参数进 query、body 空、签名走该模块。**顺手修掉一个更隐蔽的 bug**：阿里云业务失败是 **HTTP 200 + body `Code: 'isv.*'`**，旧代码只看 `res.ok` → **失败当成功上报**；现在 `Code !== 'OK'` 即失败，且非限流类标 `httpStatus:400`（永久错 → 直接 DLQ），限流类（`isv.BUSINESS_LIMIT_CONTROL` 等）留临时错走退避。
- **验证**：`tests/sms-provider.test.js`（19 用例，入 CI 白名单）—— canonical request 逐行断言、签名与独立重算的 HMAC 逐字节一致、Authorization 头格式、改任一输入签名即变、空/非空 body 载荷哈希、缺凭证 fail-fast、业务码三类分流（OK / 永久 / 限流）、200 但 body 不可解析算失败。**⚠️ 未对真实阿里云端点验证**（需真凭证 + 已审模版）——算法按公开文档实现并单测，真机首发仍需人工确认。
- **证据**：`api/core/gateway/logic/providers/aliyun-sign.js`、`logic/sms.js:57-110`、`tests/sms-provider.test.js`。

### G2. Twilio 通道从未对真实提供商验证  ✅ 已修（2026-07-30）

- **现象**：`logic/sms.js:35-62` 走 `ContentSid` + `ContentVariables`（Content Template API），但 Twilio 要求 `ContentVariables` 是**位置键** `{"1":"…","2":"…"}`，gateway 把命名 variables 原样 JSON 塞进去（`sms.js:43`）。`tests/` 只有 `webhook.test.js` + `returns-contract.test.js`，**两个真实 provider 的发送路径零测试覆盖**（契约测试全部走 mock，`tests/returns-contract.test.js:139`）。
- **影响**：Twilio 侧模版变量不替换或直接报错；没有任何测试会发现。
- **修法**：① 模版实体加 `variableOrder`（声明命名变量 → 位置序的映射），发送时按序转成 `{"1":…}`；② 补 provider 层 hermetic 测试（拦 `fetch`，断言请求 body/头/URL 形状），aliyun/twilio 各一套。
- **验收**：两个 provider 各一套请求形状测试进 CI 白名单。
- **归属**：`v1.1.x`（`variableOrder` 是新增可选字段，不填则退化为现行为）。
- **修法（已落地）**：`sms_template` 实体新增可选 `variableOrder`（声明命名→位置序），`logic/sms.js` 的 `toPositionalVariables()` 按序映射成 `{"1":…,"2":…}`；不声明则原样透传（现行为，零破坏）。另加 E.164 校验：twilio 通道的 `phone` 必须 `+…`（阿里云仍收国内裸号）。
- **验证**：`tests/sms-provider.test.js` —— 位置映射、缺位不移位（`['a','b','c']` 只给 a/c → `{1,3}`）、无声明时透传、请求 body/Basic 头形状、4xx 带 `httpStatus`；`tests/send-validation.test.js` 断言 twilio 非 E.164 直接 `-32602`。**⚠️ 未对真实 Twilio 端点验证**（需真账号 + Content SID）。
- **证据**：`logic/sms.js:38-52,112-141`、`handlers/entities.js`（sms_template.variableOrder）、`handlers/introspection.js`（SMS_TEMPLATE_RETURN + create params）。

### G3. README 承诺的 SendGrid / SES 不存在  ✅ 已修（2026-07-30，走 b 档 + 留扩展点）

- **现象**：`README.md:12` 写"邮件走 SendGrid / SES"，实际 api 通道只有**一种 body 形状**——Resend 的 `{from,to,subject,text,html}`（`logic/email.js:38-63`，默认 URL `https://api.resend.com/emails`，`config.js:38`）。SendGrid 要 `personalizations`，SES 要自己的 Action + SigV4。改 `EMAIL_API_URL` 指过去只会 400。
- **影响**：文档承诺 ≠ 代码能力，部署方按 README 选型会踩空。
- **修法**（二选一，**建议 b**）：(a) 真加两个 provider 适配器；(b) **诚实收敛**——README 改成"api 通道 = Resend 兼容形状（`{from,to,subject,text,html}`）；其它提供商需加适配器"，并把 `logic/email.js` 的 api 分支重构成 `providers/{resend}.js` 留出扩展点。
- **验收**：README / GUIDE.md 与代码一致；(a) 则每 provider 一套请求形状测试。
- **归属**：`v1.1.x`。
- **修法（已落地）**：选 b 档并补扩展点——`logic/email.js` 新增 `API_PROVIDERS` 适配器表（body/headers/messageId 三个钩子，当前只登记 `resend`），`EMAIL_API_PROVIDER` 选适配器，未登记的名字 fail-fast 且报错直说"改 URL 不够、要加适配器"。README 改成通道能力表（明说 api 通道 = Resend 兼容形状），GUIDE 同步。顺手给 api 通道的 4xx 挂 `httpStatus`（永久错 → 不再白烧 5 次重试）。
- **证据**：`logic/email.js:55-101`、`core/gateway/README.md`（通道表）、`config.js`（`email.api.provider`）。

### G4. SMTP 账号功能在脚手架下发的项目里默认不可用  ✅ 已修（2026-07-30）

- **现象**：`logic/smtp.js:9-11` 硬依赖 `GATEWAY_SECRET_KEY`（未设则 `create` 与解密抛错），而 `deploy/scaffold/init.sh:333-347` 生成的 `.env` 模版**只有 `EMAIL_*` 段**——没有 `GATEWAY_SECRET_KEY`，也没有任何 `SMS_*` 位。e2e harness 反而设了（`e2e/harness/setup.js:247`），所以测试绿、生产坏。
- **影响**：消费项目里 `gateway.smtp.create` 直接抛 `GATEWAY_SECRET_KEY is not set`；短信凭证没有下发位置，部署方得自己猜变量名。
- **修法**：`init.sh` 的 .env 模版补 ① `GATEWAY_SECRET_KEY=`（**随机生成**，与其它密钥同源；注明"改了则存量 SMTP 密码解不开"）② 完整 `SMS_*` 注释段（aliyun/twilio 两组，对齐 `config.js:45-58`）。同时 `logic/smtp.js` 的报错话术加"请在 .env 设置"提示。
- **验收**：跑一次 `init.sh` 生成新项目，`grep GATEWAY_SECRET_KEY .env` 命中且非空；新项目里 `gateway.smtp.create` 能成功。
- **归属**：`v1.1.x`。**一行的活，先做。**
- **修法（已落地）**：`init.sh` 与其它密钥同处随机生成 `GATEWAY_SECRET_KEY`（32 字节 hex）并写进 `.env`，带"换掉它 = 存量 SMTP 密码解不开"警告；.env 的 gateway 段重写为完整注释位（email 三通道 + sms 两 provider 全部变量 + `GATEWAY_STRICT_VARIABLES`），并写明 mock 降级 / 模版制 / variableOrder 三个坑。
- **验证**：`bash -n deploy/scaffold/init.sh` 过。**⚠️ 未跑完整 `init.sh` 生成新项目**（会在磁盘上建一整个仓库）——下次真建项目时确认 `.env` 里 `GATEWAY_SECRET_KEY` 非空即可。
- **证据**：`deploy/scaffold/init.sh:134-138`（生成）、`:333-372`（.env 模版段）。

---

## 2. 🟠 结构性缺失（与系统其余部分不对称）

### G5. 无投递台账 —— "这封邮件发了没"只能上机器翻文件  ✅ 已修（2026-07-30）

- **现象**：发送记录只走 `library/logger` 的 `insert()`（`logic/index.js:103,142,162`），落成 **md5 哈希三级目录下的本地 `.log` 文件**（`library/logger.js:109-128`）。没有 delivery 实体、没有 `list` 方法、没有任何 RPC 可查；多机部署还散在各机磁盘。
- **影响**：出站是整个系统对外的唯一出口，却是**唯一没有可查台账的核心链路**。排障、对客户举证、投递率统计全做不了。
- **修法**：新增 `delivery` 实体（Entity Factory，`entities.js` + `introspection.js` 声明）——字段建议 `channel / to / templateId / provider / providerMessageId / status(SENT|MOCKED|FAILED) / error / requestedBy / idempotencyKey / createdAt`；三个 send 路径写入，新增 `gateway.delivery.list/get`（`ai:false`，admin 面）。`insert()` 的 WAL 保留（灾备），实体是查询面。
- **验收**：hermetic 套断言 mock 发送后 `delivery.list` 能查到且 `status='MOCKED'`；e2e `100-delivery` 加一条"发完能查到台账"。
- **归属**：`v1.1.x`（纯新增）。**和 G7、G8 同批做最省事——都要动同一处写入点。**
- **修法（已落地）**：新增 `logic/delivery.js`（台账 + 幂等 + 事件三合一，因为都挂在"一次 send 刚落地"这一刻）。`delivery` 实体走 Entity Factory（`searchFields: target/channel/provider/status`），三条 send 路径统一经 `ledger.run({channel,target,templateId,subject,idempotencyKey,send})` 包裹；新增 `gateway.delivery.get/list`。**字段名避坑**：投递结果叫 **`deliveryStatus`**（SENT/MOCKED/FAILED），不占用 Entity Factory 自己的 `status`（ACTIVE/DELETED）——就是 `return-contract-debt` 里记的 `state`↔`status` 同名陷阱。台账写入**尽力而为**：Redis 挂了只丢 `deliveryId`，不把已被提供商收下的投递变成失败（故 `deliveryId` 在契约里是可选键）。
- **验证**：`tests/delivery.test.js`（16 用例，入 CI 白名单）—— mock 邮件记 `MOCKED`、真 provider（本地监听器 webhook）记 `SENT`、连接失败记 `FAILED` 且 error 非空且错误照旧抛出、sms 记 channel/phone/templateId、`get`/`list` 返回过契约检查、**台账写失败不影响投递成功**（注入会抛的 multi）。
- **证据**：`api/core/gateway/logic/delivery.js`、`logic/index.js`（三处 `ledger.run`）、`handlers/entities.js`（delivery 实体）、`handlers/introspection.js`（`DELIVERY_RETURN` + 两方法）、`index.js`（注册）。
- **遗留**：台账没有 `requestedBy`（调用者身份）——gateway 的 logic 层拿不到 `req.user`，要透传得改 `index.js` 全部 handler 签名，本轮没动。

### G6. 无回执 / 状态回流 —— `status` 恒 `sent`

- **现象**：三个 send 路径写的 `status` 全是硬编码 `'sent'`（`logic/index.js:112,149`），provider 的异步回执（bounce / complaint / delivered）没有任何入口。
- **影响**：退信、投诉率、黑名单一概不知；给已失效地址反复发信会伤发信域名信誉。
- **修法**：**复用 ingress，不新造入站面**——provider 的 webhook 由 listener 归一化 → `ingress.ingest` → `EVENT:WEBHOOK:{provider}`；gateway 订阅该事件（`handlers/events.js` 的 `subscribes`）把 `delivery` 台账（G5）的 status 推进。**依赖 G5**。
- **验收**：e2e 用 mock listener 打一条 bounce → 台账里对应 delivery 变 `BOUNCED`。
- **归属**：`v1.1.x`（依赖 G5）。抑制列表（发前查黑名单）可作为第二步。

### G7. 无幂等键 —— 重试可能重复发送  ✅ 已修（2026-07-30）

- **现象**：ingress 有 `(source, request_id)` 去重（`core/ingress/README.md §5`），**出站侧完全没有对称物**：send 方法不接受 `idempotencyKey`（`handlers/introspection.js:101,118,128`），也不做任何去重。
- **影响**：notification worker 对瞬时错误按 `maxRetries:5` 重试（`core/notification/logic/worker.js:167-183`）——provider 已收下但响应超时/连接断，就是**同一封邮件发多次**。
- **修法**：send 方法加可选 `idempotencyKey`；Redis `SET NX` + TTL（建议 24h）声明，命中则直接返回首次结果（连同 `deduplicated:true`）。notification worker 侧用 `messageId` 当 key 传下来（worker 是主消费者，改动集中）。
- **验收**：hermetic 套连发两次同 key → provider 只被调一次、第二次返回首次 messageId；worker 测试断言 key 已透传。
- **归属**：`v1.1.x`（可选参数，不填则现行为）。
- **修法（已落地）**：三个 send 都接可选 `idempotencyKey`（`GATEWAY:IDEM:*`，TTL 24h）。`claim` = `SET NX` 写 `IN_FLIGHT`；命中 `DONE` → **回放首次结果** + `deduplicated:true`（不重发、不新增台账行、不再发事件）；命中 `IN_FLIGHT` → 抛**临时错**（不带 `httpStatus`，让上游退避重试后命中回放）——这是唯一安全答案，此刻真发就是这把锁要防的双发。**失败会 release key**，否则一次失败把 key 永久锁死、重试再也发不出去。
  **上游接线**：`core/notification/logic/worker.js` 自动带 key = `notification:{messageId}:{channel}:{resolved target}`。**key 必须含 channel + 解析后的收件人**——同一条消息命中两条规则、发给两个不同收件人是合法的，只按 messageId 去重会静默吞掉第二条（这是设计这把 key 时最容易踩的坑）。
- **验证**：`tests/delivery.test.js` —— 同 key 只打 provider 一次 + 台账只一行 + `deduplicated:true`、不同 key 互不影响、无 key 则行为不变、失败释放 key 后重试是真重试（两行台账）、并发 IN_FLIGHT 抛 retryable 且**一条都没发**；`core/notification/tests/worker.test.js` 断言 key 逐字节正确。
- **证据**：`logic/delivery.js:claim/settle/release`、`handlers/introspection.js`（三个 send 的 `idempotencyKey` 参数 + `deduplicated` 可选返回键）、`core/notification/logic/worker.js:98-135`。

### G8. 不发任何事件 —— sentinel 无法对投递失败做反应  🟡 部分已修（2026-07-30，成功侧已通；失败侧受机制限制）

- **现象**：`handlers/events.js` 是 `{ emits: [], subscribes: [] }`。投递成功 / 失败 / 降级 mock 都不上事件总线。
- **影响**：v1.1 的主场景之一（nexus sentinel 事件订阅式反应体）对"投递失败"完全瞎——只能靠人翻 notification DLQ。
- **修法**：**不需要 relay、不需要 bot token、不碰 router**——Router 支持 `_event` 夹带（`router/handlers/events.js:107-113` 从 result 抽 `_event` 并在回客户端前删掉），gateway 在 send 结果里返回 `_event: [{ type:'EVENT:GATEWAY:DELIVERY_FAILED', payload:{…} }]` 即可。建议三个事件：`DELIVERY_SENT` / `DELIVERY_MOCKED` / `DELIVERY_FAILED`（失败路径需把 throw 改成"发事件后再 throw"）。`emits` 声明同步补齐（Router 注册时会拉）。
- **验收**：hermetic 套断言 mock 发送的 result 带 `_event`；e2e 断言事件进流 + 一个订阅它的 sentinel 被触发。
- **归属**：`v1.1.x`（纯新增；注意 `_event` 的 actor 不可信任，由 Router 盖章，见 `router/handlers/events.js:123`）。
- **⚠️ 修正上面写错的一处**：原文说"失败路径需把 throw 改成'发事件后再 throw'"——**做不到**。Router 的 `extractEvents` 只从**成功结果** `responseData.result._event` 里抽事件（`router/handlers/events.js:107-113`），错误响应没有 `result`，所以**失败事件根本搭不上这趟车**。`_tasks` 同理。
- **修法（已落地，成功侧）**：`ledger.run` 在结果里挂 `_event` → stream `EVENT:GATEWAY:DELIVERY`，type `gateway.delivery.sent`（真 provider 收下）/ `gateway.delivery.mocked`（**什么都没发出去**）；`handlers/events.js` 的 `emits` 按舰队体例（`stream`/`type`/`trigger`/`description`/`mechanism`/`payload`）如实声明。幂等回放**不重复发事件**。无 relay、无 bot token、未改 router 代码。
- **⚠️ 落地过程中踩到的两个真坑（记下来，下次做事件的服务照抄）**：
  1. **`_event` 的信封形状是 `{stream, type, payload}`**，`stream` = Redis 流名、`type` = 点分逻辑名。第一版写成 `{ type: 'EVENT:GATEWAY:DELIVERY_SENT' }`（缺 `stream`）—— 单测里长得完全正常，**在 Router 里被静默 skip**（`router/handlers/events.js:143` 缺 stream 直接 continue）。hermetic 测试证不了这个，是 e2e 才抓到的。现测试里已按 Router 契约逐字段断言（`assertRouterWireShape`）。
  2. **还有一道注册表闸**：Router 只放行登记在事件注册表里的 `(source, stream, type)` 三元组，未登记 → `BLOCKED — not in registry`。已加进 **e2e harness 的 `FIXTURE_REGISTRY`** 与 **dev 的 `deploy/mock/inject-workflows.js`**（都不是 router），所以 e2e/dev 已真通；但**生产默认表在 `api/router/config.js` 的 `eventRegistry`（受保护目录）**，尚未登记 → **生产上这两个事件目前仍会被拦下**。需授权后加一行：`'gateway': { 'EVENT:GATEWAY:DELIVERY': ['*'] }`。**在那之前，投递可查性靠 G5 台账，不靠事件。**
- **失败侧仍缺（follow-up）**：`DELIVERY_FAILED` 事件需要 gateway 自己持 relay token（`deploy/seed-bots.js` + e2e harness 双镜像加 `system.gateway` bot，与 G13 附件所需的 relay 是同一份基建）→ **和 G13 一起做最省事**。当下失败可查性由 G5 台账兜住（`deliveryStatus=FAILED` + `error`），不是黑洞，但 sentinel 还订阅不到。
- **验证**：`tests/delivery.test.js`（hermetic）—— 信封形状按 Router 契约断言、mock 带 `.mocked`、真 provider 带 `.sent`、幂等回放不带 `_event`、声明↔实发的 stream|type 与 payload 键一致（防漂移）。**e2e 真链路**：`suites/100-delivery` 新增用例 6 —— 经真 Router 发一封 → 事件**真写进 `EVENT:GATEWAY:DELIVERY` 流**（`source:'gateway'` 由 Router 盖章、payload 含 deliveryId）、且 Router 已把 `_event` 从回客户端的结果里摘掉。
- **证据**：`logic/delivery.js`（`EVENT_STREAM` + EVENTS + run 的 `_event`）、`handlers/events.js`、`e2e/harness/setup.js`（FIXTURE_REGISTRY 加 gateway）、`deploy/mock/inject-workflows.js`（dev 同步）、`e2e/suites/93-service-events.e2e.test.js`（gateway 从"空声明"移到"≥2 emits"）。

### G9. 无出站配额 / 频控 / 熔断，且 AI 出站无治理门

- **现象**：① Router 有入口限流（`router/handlers/ratelimit.js`），但那是**按调用方 session**，不是按收件人/按提供商；gateway 这层零配额、零熔断，api 通道失败也不回落 smtp（`logic/email.js:71-78` 单选一条路）。② `gateway.email.send` 是 `ai:true`（`handlers/introspection.js:105`）——AI 可给**任意外部地址发任意自由文本**，没有域名白名单、没有日配额、没有 approval 门（approval 服务在，但 gateway 不是它的消费者）。
- **影响**：一个循环的 workflow 或一次 AI 误判 = 无上限对外发信（伤域名信誉、可能被当垃圾邮件源）。这是**框架级出站风险**，不是业务问题。
- **修法**（建议分两步）：**(a) v1.1.x 只加不破**：`config.js` 加可选 `outbound.limits`（每收件人/小时、每通道/日），超限抛 `RATE_LIMITED`（永久错，notification 侧应识别为 permanent 直接 DLQ 而非重试）；默认**不限**（零破坏）。**(b) v2**：`ai:true` 路径的域名白名单 + 高额发送经 approval 门（语义收敛，会改 AI 可调用面）。
- **验收**：(a) hermetic 套断言超限抛 `RATE_LIMITED` 且默认配置下不触发。
- **归属**：(a) `v1.1.x` · (b) `v2`。

### G10. 无管理 UI —— 三个实体全靠裸 RPC

- **现象**：`portal/system/src` 里没有任何 gateway 页面（全仓只有 `pages/Login.tsx:140` 一句"系统网关配置"文案）。`smtp` / `email_template` / `sms_template` 三个实体没有任何界面。
- **影响**：部署方要配 SMTP 账号、改邮件模版只能手搓 JSON-RPC；对照 ingress 有完整的 `IngressManagement.tsx`，出站侧是明显的空白。
- **修法**：加 `pages/gateway/`——SMTP 账号列表（含 `smtp.test` 按钮）+ 邮件模版编辑（带 `{{var}}` 预览）+ 短信模版 + （G5 落地后）投递台账查询页。**红线**：任何确认走页内组件，禁 `window.confirm`（CLAUDE.md §8）。
- **验收**：`portal-tsc` 绿；`/run-portal` 截图三个页面渲染有数据。
- **归属**：`v1.1.x`（依赖 G5 才有台账页；账号/模版页可先做）。

### G11. 通道凭证只有全局 env 一份

- **现象**：smtp 有多账号实体，email api / sms **没有**：阿里云 `signName`、Twilio `from`、Resend key 都是进程级单例（`config.js:36-58`）。
- **影响**：做不了多发信身份 / 多签名 / 多租户；改一个通道要重启进程。
- **修法**：仿 smtp 实体加 `channel_account` 实体（`type: resend|aliyun|twilio`，敏感字段加密，复用 `logic/smtp.js` 的 `deriveKey/encrypt` 那套），send 支持 `accountId` 选账号；env 保留为默认账号（零破坏）。
- **归属**：`v1.1.x`（纯新增）。**优先级中**——单发信身份够用时可延后。

### G12. 只有 `smtp.test` 一个连通性探针

- **现象**：`handlers/introspection.js:89` 只有 SMTP 一个 test 方法；email api 通道、sms 两个通道没有对应探针。
- **影响**："凭证配对了吗"只能真发一条试（短信还要花钱）。
- **修法**：加 `gateway.channel.test { channel, accountId? }` —— email api 走 provider 的 domains/验证端点（Resend 有），sms 走"余额/签名查询"类只读接口，无只读接口的通道诚实返回 `{ supported:false }`（禁假报成功）。
- **归属**：`v1.1.x`（与 G11 同批更省事）。

---

## 3. 🟡 邮件能力空白（5 条）

### G13. 无附件 / cc / bcc / replyTo  🟡 部分已修（2026-07-30：cc/bcc/replyTo 已通；附件未做）

- **现象**：`gateway.email.send` 参数只有 `to/subject/content/templateId/variables/smtpId`（`handlers/introspection.js:101`），逻辑层同样只透传这些（`logic/index.js:64-100`）。
- **影响**：storage 有 CAS 文件却发不出去——发对账单、发票、导出报表这类需求直接卡死。这是**能力空白里最刚需的一条**。
- **修法**：send 加可选 `cc/bcc/replyTo/attachments`。附件建议**只接 storage 引用**（`attachments: [{ storageKey, filename }]`，gateway 经 relay 取内容），**不接裸 base64**——避免 20MB bodyLimit 打爆 Router 审计日志。注意：这是 gateway 第一次需要 relay（仿 `core/user` 的接法：`deploy/seed-bots.js` 加 `system.gateway` bot + permit `storage.asset.get`，e2e harness 镜像同步）。api 通道（Resend）与 smtp 通道（nodemailer）附件形状不同，需在 provider 层分别处理。
- **验收**：hermetic 断言 smtp 分支收到 nodemailer 的 `attachments` 数组；e2e 发一封带 storage 附件的邮件到 mock 收件端。
- **归属**：`v1.1.x`（纯新增可选参数）。
- **修法（已落地，一半）**：`cc` / `bcc` / `replyTo` 已加——单地址或数组，两条通道都透传（smtp 走 nodemailer 字段，api 走 Resend 的 `cc/bcc/reply_to`），且**逐个做格式校验**、报错点名是哪个字段。
- **附件仍未做**：需要 gateway 持 relay token 去 storage 取内容（与 G8 失败事件同一份基建，建议同批），且 api/smtp 两通道附件形状不同要分别适配。**别接裸 base64**——20MB bodyLimit 会把 Router 审计日志打爆。
- **验证**：`tests/send-validation.test.js`（cc/bcc/replyTo 各自的非法值 → `-32602` 且 message 点名字段）。
- **证据**：`logic/index.js`（email.send 的 cc/bcc/replyTo + 校验循环）、`logic/email.js:36-49,58-70`。

### G14. 模版没有纯文本正文  ✅ 已修（2026-07-30）

- **现象**：`email_template` 只有 `subject`/`html`（`handlers/entities.js:20-34`），发送时 `resolvedContent = resolvedHtml`（`logic/index.js:75`）→ `text` 字段塞的是 HTML 源码。
- **影响**：纯文本客户端 / 部分网关的降级视图里用户看到一堆标签；也会拉低反垃圾评分。
- **修法**：模版加可选 `text` 字段；缺失时由 html 做一次朴素去标签而非原样塞。
- **归属**：`v1.1.x`。
- **修法（已落地）**：`email_template` 加可选 `text`（同样走 `{{var}}` 插值）；不给则 `htmlToText()` 派生（去 script/style、`<br>`/块级闭合转换行、常见实体解码、折叠空行）。
- **验证**：`tests/send-validation.test.js` —— 声明了 text 就用 text、没声明则派生出无标签无 `&nbsp;` 的纯文本且段落间保留一个空行。
- **证据**：`logic/index.js`（`htmlToText` + email.send 的 text 分支）、`handlers/entities.js`（email_template.text）。

### G15. 模版必填字段无人校验 → 崩在插值上  ✅ 已修（2026-07-30）

- **现象**：Entity Factory 不强制 `entities.js` 的 `required`（已记 `return-contract-debt.md:108`）。建一个没有 `html` 的模版，send 时 `interpolate(undefined)` 在 `logic/index.js:9-11` 抛 `Cannot read properties of undefined (reading 'replace')`。
- **影响**：不是可读业务错，排障要读栈；notification 侧还会把它当临时错重试 5 次。
- **修法**：`interpolate` 对非字符串 fail-fast，抛结构化错（`TEMPLATE_INCOMPLETE: template <id> missing html`）；`template.create/update` 侧做最小必填校验。
- **归属**：`v1.1.x`。**顺手就做（几行）。**
- **修法（已落地）**：两道闸。① `assertTemplateFields()` 在 create 时要求 email 模版有 `name/subject/html`、sms 模版有 `name/channel/providerCode`，update 只校验**正在写的字段**（部分更新照旧合法），并对 present-but-wrong-type 一律拒（含 `variables`/`variableOrder` 必须是数组）。② `interpolate()` 对非字符串模版字段抛 `-32602` 并**点名是哪个字段**（`Template <id> is incomplete: 'html' is missing`），不再是 `undefined.replace is not a function`。用现成错误码，未新增码（`deploy/check-error-codes.js` 无需登记）。
- **验证**：`tests/send-validation.test.js` —— create 三个必填各自报错、空白串也算缺、update 部分更新仍合法、类型错在 create/update 两侧都拒、**绕过闸写入的历史脏数据在 send 时也报可读错**（直接用 Entity Factory 造一条没有 html 的模版）。
- **证据**：`logic/index.js`（`interpolate` / `assertTemplateFields` + 四个 template create/update 包装）。

### G16. 变量漏传静默通过  ✅ 已修（2026-07-30，opt-in 档；默认值翻转仍归 v2）

- **现象**：`interpolate` 对未提供的变量**原样保留** `{{code}}`（`logic/index.js:10`，GUIDE.md:59-60 已如实记账），`variables` 声明字段纯装饰。
- **影响**：真会把 `{{code}}` 当字面量发给用户（OTP 场景尤其致命）。
- **修法**：send 时校验"模版 declared variables ⊆ 传入 variables"，缺失抛 `TEMPLATE_VARS_MISSING`（列出缺哪些）。**这是行为变更**（原本静默成功 → 现在拒），建议 `strictVariables` 配置开关，v1.1.x 默认关 + GUIDE 明示，v2 翻默认开。
- **归属**：`v1.1.x`（默认关）· 默认值翻转归 `v2`。
- **修法（已落地）**：`GATEWAY_STRICT_VARIABLES=true`（`config.strictVariables`）→ 邮件按**模版里真实出现的 `{{var}}`** 判缺、短信按模版 `variables` 声明判缺，缺则 `-32602` 并列出缺哪些；默认关 = 行为不变（原样保留 `{{code}}`）。GUIDE 明写"带 OTP 的部署建议开"。
- **验证**：`tests/send-validation.test.js` —— 默认关时 subject 里如实留 `{{code}}`（锁住历史行为）、开启后 email/sms 各自缺变量即拒、补齐后放行。
- **证据**：`logic/index.js`（`interpolate(..., {strict})` + sms 的 declared-variables 检查）、`config.js:strictVariables`。

### G17. 收件人不做任何格式校验  ✅ 已修（2026-07-30）

- **现象**：`to` / `phone` 未做校验直接交给 provider（`logic/email.js:66-69` 只查非空，`logic/sms.js:65` 同）。
- **影响**：拼错地址 → provider 4xx → 被当临时错重试 5 次才死信；配额白烧。
- **修法**：发前做基本形状校验（email 一个保守正则、phone 要求 E.164），不合法抛**永久错**让 notification 直接 DLQ 不重试。
- **归属**：`v1.1.x`（与 G15 同批）。
- **修法（已落地）**：复用 `library/validate.js` 的 `PATTERNS.email` / `PATTERNS.phone`（不另造正则），`to`/`cc`/`bcc`/`replyTo` 支持单值或数组、逐个校验；`phone` 过基本形状后**按通道分档**：twilio 额外要求 E.164，阿里云允许国内裸号（否则会把合法的 `13800138000` 拒掉）。抛 `-32602` —— 正好在 notification 的 `PERMANENT_RPC_CODES` 里 → **直接 DLQ，不烧 5 次重试**。
- **验证**：`tests/send-validation.test.js` —— 6 种非法邮箱形态、5 种非法手机号、数组含一个坏值也拒、空数组拒、twilio 非 E.164 拒而阿里云放行。
- **证据**：`logic/index.js`（`assertEmailAddress` / `assertPhoneNumber`）、`core/notification/logic/worker.js:6`（`PERMANENT_RPC_CODES` 含 -32602）。

---

## 4. ⚪ 一致性债（2 条，顺手做）

### G18. `Date.now()` 散落 5 处，未用 `library/clock.js`  ✅ 已修（2026-07-30）

- **现象**：`logic/webhook.js:43`、`logic/index.js:105,144,164`、`logic/rmbg.js:52` 全是裸 `Date.now()`；gateway **完全没引** `library/clock.js`（全目录零命中）。违反 CLAUDE.md §5"不要 `Date.now()` 散落：用 `api/library/clock.js`（可注入、测试可冻结）"。
- **影响**：G1 的签名测试、G5 的台账测试都需要冻结时间，现在冻不了。
- **修法**：换 `clock.now()`。注意 webhook 的 `X-Solo-Timestamp` 与签名绑定，改动后 `tests/webhook.test.js` 要一起看。
- **归属**：`v1.1.x`。**做 G1/G5 之前先换，否则测试写不干净。**
- **修法（已落地）**：`logic/index.js` 三处审计 stamp、`logic/webhook.js` 的 `sentAt`（签名绑定的时间戳）全换 `clock.now()`；新代码（`delivery.js`、`sms.js` 签名时间）一律用 clock。`logic/rmbg.js` 的 multipart boundary **不是时间语义**，改成 `crypto.randomBytes(12)`——用时间当 boundary 本来就会在并发/冻结时钟下撞车。
- **验证**：`tests/sms-provider.test.js` 靠 `clock.freeze()` 断言签名逐字节确定（这正是"换 clock 才写得出的测试"）；`tests/webhook.test.js`（既有 6 用例）仍绿，签名与 `X-Solo-Timestamp` 一致性未变。
- **证据**：`logic/index.js`、`logic/webhook.js:43`、`logic/delivery.js`、`logic/rmbg.js:53`。

### G19. rmbg 抠图放在"出站通信适配层"里是职责越界

- **现象**：`logic/rmbg.js` 是图像处理（local ONNX + remove.bg），与 gateway 的定位（`CLAUDE.md §2`："外部通道适配层（**出站**：邮件/短信等）"）不同族。
- **影响**：不影响运行，但让"gateway 是什么"这个判断变模糊；`gateway.rmbg.cutout` 的返回形状分歧已单独记账（`return-contract-debt.md:30`）。
- **修法**：**本轮不动**（搬走 = 破坏性 wire 变更）。记账即可，v2 若有 media/图像服务再迁。
- **归属**：`v2`（记账，不排期）。

---

## 5. 已在别处记账 / 明确暂缓（不在本台账开新条）

| 项 | 状态 | 权威处 |
|---|---|---|
| **SSE 主动推送** | 现为诚实 fail-closed（`notification/logic/config.js:11` + `sentinel.broadcast` 双拒），不是缺口 | `BACKLOG.md §2.3`、归 v2 |
| **`rmbg.cutout` 返回形状分歧** | local 路径不保证 `image`，声明已如实标 optional | `return-contract-debt.md:30` |
| **`success` 恒 true 无信息量** | 四个 send 方法皆然；靠 throw/catch 判成败 | `return-contract-debt.md:98` |
| **实体 `required` 未被 Factory 强制** | 全框架共性；gateway 侧的具体后果见 G15 | `return-contract-debt.md:108` |
| **`/metrics`（Prometheus）未做** | 全服务共性遗留 | `toFix.md §一.1 遗留` |
| **SMS provider 凭证 = 部署方职责** | 规格已明确"只调不实现 provider"——但**签名协议本身是 gateway 的活**，故 G1 仍开条 | `spec-passport-self-issuance.md:32` |

---

## 6. 推进顺序与进度

> 分批的依据：**同批改同一处写入点**，避免反复回改 + 反复跑 e2e。

| 批次 | 项 | 状态 |
|------|----|------|
| **一 · 小活** | `G4` 脚手架 .env · `G18` 换 clock · `G15`+`G17` fail-fast · `G3` README 收敛（b 档） | ✅ **全部落地**（2026-07-30） |
| **二 · 通道可信** | `G1` 阿里云 V3 签名 · `G2` Twilio 位置变量 | ✅ **落地**（2026-07-30，**未对真机验证**） |
| | `G12` 通道探针（email api / sms 无 test 方法） | ⬜ 未做（批次二尾巴，跳过没做） |
| **三 · 可观测+可靠** | `G5` delivery 台账 · `G7` 幂等键（含 notification worker 接线） | ✅ **落地**（2026-07-30） |
| | `G8` 投递事件 | 🟡 成功侧落地；`DELIVERY_FAILED` 需 relay（见下） |
| | `G6` 回执回流（依赖 G5，现在可做） | ⬜ 未做 |
| **四 · 能力与界面** | `G13` cc/bcc/replyTo | ✅ 落地 |
| | `G13` 附件 + `G8` 失败事件 —— **共用同一份 relay 基建，务必同批做** | ⬜ 未做（下一批的首选） |
| | `G14` 模版 text | ✅ 落地 |
| | `G10` portal 页（账号/模版/台账） · `G11` 多通道账号实体 | ⬜ 未做 |
| **五 · 治理** | `G16` opt-in 严格变量 | ✅ 落地（默认关） |
| | `G9(a)` 出站配额（默认不限） | ⬜ 未做 |
| | `G9(b)` AI 出站白名单/审批门 · `G16` 默认翻转 · `G19` rmbg 迁移 | ⬜ **v2** |

**下一批建议**：`G13 附件` + `G8 失败事件` + `G6 回执` —— 三者都要 gateway 持 relay token
（`deploy/seed-bots.js` + `e2e/harness/setup.js` 双镜像加 `system.gateway` bot），一次基建三个收益。
其次是 `G10 portal 页`（台账已有数据可展示了）。

---

## 7. 验收总则（每条都适用）

1. **门禁**：`cd api && node autocheck/checker.js core/gateway --static`（声明↔注册同步、参数约定、auth 分叉禁令、guide-check）。报错当场修。
2. **hermetic 测试**：放 `api/core/gateway/tests/`，**必须进 `api/jest.ci.config.js` 白名单**，否则等于没写。跑法见 CLAUDE.md §6（`redis-stack-server` + `REDIS_URL` 都不能漏）。
3. **契约同步**：动方法面就要同步 `handlers/introspection.js`（含 `returns_schema`）+ `handlers/entities.js` + `config.js` 的 `description.{en,zh}.methods` + **`GUIDE.md`**（任务配方，与代码同 commit；方法名必须全限定 `{service}.{entity}.{action}`）。`tests/returns-contract.test.js` 会咬住真实返回。
4. **e2e**：投递链改动跑 `e2e/suites/100-delivery`；新增事件跑事件链相关套。
5. **红线复核**：不碰 `api/router/`（G8 的 `_event` 夹带是**服务侧**能力，Router 已支持，无需改它）；portal 侧禁原生弹窗；`.env` / 密钥不进 git。
6. **汇报纪律**：每批完成时明示 **已部署/未部署** + **已验证/未验证**。

---

## 8. 台账维护

- 修完一条就在标题后加 `✅ 已修（YYYY-MM-DD）`，正文补 **修法（已落地）** + **验证** + **证据（file:line）** 三行，仿 `toFix.md` 的体例；**不要删除原条目**。
- 新发现的 gateway 缺口追加到对应 §，编号继续往后（G20…）。
- 全部收口后在 `BACKLOG.md §3` 把那行标 ✅ 并保留指针。
