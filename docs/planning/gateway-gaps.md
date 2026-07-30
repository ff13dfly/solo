# gateway 出站缺口 · 台账

> **总入口在 [`BACKLOG.md`](./BACKLOG.md) §3。** 本文是其中"gateway 出站缺口"那行的 drill-down。
> **来源**：2026-07-30 gateway 全量读码审计（`api/core/gateway/` 19 个文件全读，交叉核 `core/notification/logic/worker.js`（唯一 worker 消费者）、`deploy/scaffold/init.sh`（下发 .env）、`portal/system/src`（管理面）、既有三份债台账）。
> **约定**：SOLO 是纯框架，缺业务不算 gap。本清单只收 gateway 这一层**"声明了却做不到"** 或 **"与系统其余部分明显不对称"** 的项。已在别处记账 / 明确暂缓的不重复开条（见 §5）。
> **图例**：🔴 声明了实际不通 · 🟠 结构性缺失 · 🟡 能力空白 · ⚪ 一致性债
> **归属**：`v1.1.x` = 只加不破、现在就能落；`v2` = 需破坏性变更或语义收敛。

---

## 0. 基线：已实现的部分（不在清单内）

SMTP 账号 CRUD（密码 AES 加密 + `gateway.smtp.test` 探活）· 邮件模版 CRUD + `{{var}}` 插值 · 邮件发送三通道（smtp / api / mock）· 短信模版 CRUD + 发送（aliyun / twilio / mock）· 出站 webhook（HMAC-SHA256 签名 + SSRF 闸 + 有界超时 + 响应体上限）· rmbg 抠图（local ONNX → remove.bg 回落）。

方法面 24 个（`handlers/introspection.js`），声明↔注册同步，返回契约 `returns_schema` 全覆盖，hermetic 测试 2 套在 CI 白名单内。**缺口都在这条基线之外。**

---

## 1. 🔴 声明了但生产上不通（4 条）

### G1. 阿里云短信通道签名协议不对 —— 配了凭证反而全 4xx

- **现象**：`logic/sms.js:10-33` 用 `Authorization: AccessKeyId <id>` + JSON body 打 `dysmsapi.aliyuncs.com`。阿里云要的是 **RPC 风格签名**（规范化 query + HMAC-SHA1 的 `Signature` 参数）或 **V3 头签名**（`Authorization: ACS3-HMAC-SHA256 Credential=…,SignedHeaders=…,Signature=…`）。代码注释自己就写着 `requires official SDK or signed REST call in production`（`sms.js:11`）。
- **影响**：比不实现更糟——`resolveChannel` 一见 `accessKeyId` 就选 aliyun（`sms.js:5`），**不会降级 mock**，每条短信直接 4xx。notification 侧按临时错重试 5 次（`core/notification/config.js:38`）后进死信；passport OTP 走 relay 同步调用则直接失败发不出码。
- **修法**：实现 V3 头签名（无新依赖，`crypto` 够用：canonical request → hashed payload → `ACS3-HMAC-SHA256` 签名串）；不引官方 SDK（bundle 减肥方向，见 BACKLOG §4）。签名逻辑抽 `logic/providers/aliyun-sign.js` 便于单测。
- **验收**：hermetic 套用**固定输入 + 冻结时间**断言签名串与阿里云文档示例逐字节一致（离线，不打真实网络）；`SMS_ALIYUN_*` 配齐后手工发一条真短信记进 CHANGELOG。
- **归属**：`v1.1.x`（纯修，无 wire 变更）。**优先级最高**——这是唯一"配了就坏"的条目。

### G2. Twilio 通道从未对真实提供商验证

- **现象**：`logic/sms.js:35-62` 走 `ContentSid` + `ContentVariables`（Content Template API），但 Twilio 要求 `ContentVariables` 是**位置键** `{"1":"…","2":"…"}`，gateway 把命名 variables 原样 JSON 塞进去（`sms.js:43`）。`tests/` 只有 `webhook.test.js` + `returns-contract.test.js`，**两个真实 provider 的发送路径零测试覆盖**（契约测试全部走 mock，`tests/returns-contract.test.js:139`）。
- **影响**：Twilio 侧模版变量不替换或直接报错；没有任何测试会发现。
- **修法**：① 模版实体加 `variableOrder`（声明命名变量 → 位置序的映射），发送时按序转成 `{"1":…}`；② 补 provider 层 hermetic 测试（拦 `fetch`，断言请求 body/头/URL 形状），aliyun/twilio 各一套。
- **验收**：两个 provider 各一套请求形状测试进 CI 白名单。
- **归属**：`v1.1.x`（`variableOrder` 是新增可选字段，不填则退化为现行为）。

### G3. README 承诺的 SendGrid / SES 不存在

- **现象**：`README.md:12` 写"邮件走 SendGrid / SES"，实际 api 通道只有**一种 body 形状**——Resend 的 `{from,to,subject,text,html}`（`logic/email.js:38-63`，默认 URL `https://api.resend.com/emails`，`config.js:38`）。SendGrid 要 `personalizations`，SES 要自己的 Action + SigV4。改 `EMAIL_API_URL` 指过去只会 400。
- **影响**：文档承诺 ≠ 代码能力，部署方按 README 选型会踩空。
- **修法**（二选一，**建议 b**）：(a) 真加两个 provider 适配器；(b) **诚实收敛**——README 改成"api 通道 = Resend 兼容形状（`{from,to,subject,text,html}`）；其它提供商需加适配器"，并把 `logic/email.js` 的 api 分支重构成 `providers/{resend}.js` 留出扩展点。
- **验收**：README / GUIDE.md 与代码一致；(a) 则每 provider 一套请求形状测试。
- **归属**：`v1.1.x`。

### G4. SMTP 账号功能在脚手架下发的项目里默认不可用

- **现象**：`logic/smtp.js:9-11` 硬依赖 `GATEWAY_SECRET_KEY`（未设则 `create` 与解密抛错），而 `deploy/scaffold/init.sh:333-347` 生成的 `.env` 模版**只有 `EMAIL_*` 段**——没有 `GATEWAY_SECRET_KEY`，也没有任何 `SMS_*` 位。e2e harness 反而设了（`e2e/harness/setup.js:247`），所以测试绿、生产坏。
- **影响**：消费项目里 `gateway.smtp.create` 直接抛 `GATEWAY_SECRET_KEY is not set`；短信凭证没有下发位置，部署方得自己猜变量名。
- **修法**：`init.sh` 的 .env 模版补 ① `GATEWAY_SECRET_KEY=`（**随机生成**，与其它密钥同源；注明"改了则存量 SMTP 密码解不开"）② 完整 `SMS_*` 注释段（aliyun/twilio 两组，对齐 `config.js:45-58`）。同时 `logic/smtp.js` 的报错话术加"请在 .env 设置"提示。
- **验收**：跑一次 `init.sh` 生成新项目，`grep GATEWAY_SECRET_KEY .env` 命中且非空；新项目里 `gateway.smtp.create` 能成功。
- **归属**：`v1.1.x`。**一行的活，先做。**

---

## 2. 🟠 结构性缺失（与系统其余部分不对称）

### G5. 无投递台账 —— "这封邮件发了没"只能上机器翻文件

- **现象**：发送记录只走 `library/logger` 的 `insert()`（`logic/index.js:103,142,162`），落成 **md5 哈希三级目录下的本地 `.log` 文件**（`library/logger.js:109-128`）。没有 delivery 实体、没有 `list` 方法、没有任何 RPC 可查；多机部署还散在各机磁盘。
- **影响**：出站是整个系统对外的唯一出口，却是**唯一没有可查台账的核心链路**。排障、对客户举证、投递率统计全做不了。
- **修法**：新增 `delivery` 实体（Entity Factory，`entities.js` + `introspection.js` 声明）——字段建议 `channel / to / templateId / provider / providerMessageId / status(SENT|MOCKED|FAILED) / error / requestedBy / idempotencyKey / createdAt`；三个 send 路径写入，新增 `gateway.delivery.list/get`（`ai:false`，admin 面）。`insert()` 的 WAL 保留（灾备），实体是查询面。
- **验收**：hermetic 套断言 mock 发送后 `delivery.list` 能查到且 `status='MOCKED'`；e2e `100-delivery` 加一条"发完能查到台账"。
- **归属**：`v1.1.x`（纯新增）。**和 G7、G8 同批做最省事——都要动同一处写入点。**

### G6. 无回执 / 状态回流 —— `status` 恒 `sent`

- **现象**：三个 send 路径写的 `status` 全是硬编码 `'sent'`（`logic/index.js:112,149`），provider 的异步回执（bounce / complaint / delivered）没有任何入口。
- **影响**：退信、投诉率、黑名单一概不知；给已失效地址反复发信会伤发信域名信誉。
- **修法**：**复用 ingress，不新造入站面**——provider 的 webhook 由 listener 归一化 → `ingress.ingest` → `EVENT:WEBHOOK:{provider}`；gateway 订阅该事件（`handlers/events.js` 的 `subscribes`）把 `delivery` 台账（G5）的 status 推进。**依赖 G5**。
- **验收**：e2e 用 mock listener 打一条 bounce → 台账里对应 delivery 变 `BOUNCED`。
- **归属**：`v1.1.x`（依赖 G5）。抑制列表（发前查黑名单）可作为第二步。

### G7. 无幂等键 —— 重试可能重复发送

- **现象**：ingress 有 `(source, request_id)` 去重（`core/ingress/README.md §5`），**出站侧完全没有对称物**：send 方法不接受 `idempotencyKey`（`handlers/introspection.js:101,118,128`），也不做任何去重。
- **影响**：notification worker 对瞬时错误按 `maxRetries:5` 重试（`core/notification/logic/worker.js:167-183`）——provider 已收下但响应超时/连接断，就是**同一封邮件发多次**。
- **修法**：send 方法加可选 `idempotencyKey`；Redis `SET NX` + TTL（建议 24h）声明，命中则直接返回首次结果（连同 `deduplicated:true`）。notification worker 侧用 `messageId` 当 key 传下来（worker 是主消费者，改动集中）。
- **验收**：hermetic 套连发两次同 key → provider 只被调一次、第二次返回首次 messageId；worker 测试断言 key 已透传。
- **归属**：`v1.1.x`（可选参数，不填则现行为）。

### G8. 不发任何事件 —— sentinel 无法对投递失败做反应

- **现象**：`handlers/events.js` 是 `{ emits: [], subscribes: [] }`。投递成功 / 失败 / 降级 mock 都不上事件总线。
- **影响**：v1.1 的主场景之一（nexus sentinel 事件订阅式反应体）对"投递失败"完全瞎——只能靠人翻 notification DLQ。
- **修法**：**不需要 relay、不需要 bot token、不碰 router**——Router 支持 `_event` 夹带（`router/handlers/events.js:107-113` 从 result 抽 `_event` 并在回客户端前删掉），gateway 在 send 结果里返回 `_event: [{ type:'EVENT:GATEWAY:DELIVERY_FAILED', payload:{…} }]` 即可。建议三个事件：`DELIVERY_SENT` / `DELIVERY_MOCKED` / `DELIVERY_FAILED`（失败路径需把 throw 改成"发事件后再 throw"）。`emits` 声明同步补齐（Router 注册时会拉）。
- **验收**：hermetic 套断言 mock 发送的 result 带 `_event`；e2e 断言事件进流 + 一个订阅它的 sentinel 被触发。
- **归属**：`v1.1.x`（纯新增；注意 `_event` 的 actor 不可信任，由 Router 盖章，见 `router/handlers/events.js:123`）。

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

### G13. 无附件 / cc / bcc / replyTo

- **现象**：`gateway.email.send` 参数只有 `to/subject/content/templateId/variables/smtpId`（`handlers/introspection.js:101`），逻辑层同样只透传这些（`logic/index.js:64-100`）。
- **影响**：storage 有 CAS 文件却发不出去——发对账单、发票、导出报表这类需求直接卡死。这是**能力空白里最刚需的一条**。
- **修法**：send 加可选 `cc/bcc/replyTo/attachments`。附件建议**只接 storage 引用**（`attachments: [{ storageKey, filename }]`，gateway 经 relay 取内容），**不接裸 base64**——避免 20MB bodyLimit 打爆 Router 审计日志。注意：这是 gateway 第一次需要 relay（仿 `core/user` 的接法：`deploy/seed-bots.js` 加 `system.gateway` bot + permit `storage.asset.get`，e2e harness 镜像同步）。api 通道（Resend）与 smtp 通道（nodemailer）附件形状不同，需在 provider 层分别处理。
- **验收**：hermetic 断言 smtp 分支收到 nodemailer 的 `attachments` 数组；e2e 发一封带 storage 附件的邮件到 mock 收件端。
- **归属**：`v1.1.x`（纯新增可选参数）。

### G14. 模版没有纯文本正文

- **现象**：`email_template` 只有 `subject`/`html`（`handlers/entities.js:20-34`），发送时 `resolvedContent = resolvedHtml`（`logic/index.js:75`）→ `text` 字段塞的是 HTML 源码。
- **影响**：纯文本客户端 / 部分网关的降级视图里用户看到一堆标签；也会拉低反垃圾评分。
- **修法**：模版加可选 `text` 字段；缺失时由 html 做一次朴素去标签而非原样塞。
- **归属**：`v1.1.x`。

### G15. 模版必填字段无人校验 → 崩在插值上

- **现象**：Entity Factory 不强制 `entities.js` 的 `required`（已记 `return-contract-debt.md:108`）。建一个没有 `html` 的模版，send 时 `interpolate(undefined)` 在 `logic/index.js:9-11` 抛 `Cannot read properties of undefined (reading 'replace')`。
- **影响**：不是可读业务错，排障要读栈；notification 侧还会把它当临时错重试 5 次。
- **修法**：`interpolate` 对非字符串 fail-fast，抛结构化错（`TEMPLATE_INCOMPLETE: template <id> missing html`）；`template.create/update` 侧做最小必填校验。
- **归属**：`v1.1.x`。**顺手就做（几行）。**

### G16. 变量漏传静默通过

- **现象**：`interpolate` 对未提供的变量**原样保留** `{{code}}`（`logic/index.js:10`，GUIDE.md:59-60 已如实记账），`variables` 声明字段纯装饰。
- **影响**：真会把 `{{code}}` 当字面量发给用户（OTP 场景尤其致命）。
- **修法**：send 时校验"模版 declared variables ⊆ 传入 variables"，缺失抛 `TEMPLATE_VARS_MISSING`（列出缺哪些）。**这是行为变更**（原本静默成功 → 现在拒），建议 `strictVariables` 配置开关，v1.1.x 默认关 + GUIDE 明示，v2 翻默认开。
- **归属**：`v1.1.x`（默认关）· 默认值翻转归 `v2`。

### G17. 收件人不做任何格式校验

- **现象**：`to` / `phone` 未做校验直接交给 provider（`logic/email.js:66-69` 只查非空，`logic/sms.js:65` 同）。
- **影响**：拼错地址 → provider 4xx → 被当临时错重试 5 次才死信；配额白烧。
- **修法**：发前做基本形状校验（email 一个保守正则、phone 要求 E.164），不合法抛**永久错**让 notification 直接 DLQ 不重试。
- **归属**：`v1.1.x`（与 G15 同批）。

---

## 4. ⚪ 一致性债（2 条，顺手做）

### G18. `Date.now()` 散落 5 处，未用 `library/clock.js`

- **现象**：`logic/webhook.js:43`、`logic/index.js:105,144,164`、`logic/rmbg.js:52` 全是裸 `Date.now()`；gateway **完全没引** `library/clock.js`（全目录零命中）。违反 CLAUDE.md §5"不要 `Date.now()` 散落：用 `api/library/clock.js`（可注入、测试可冻结）"。
- **影响**：G1 的签名测试、G5 的台账测试都需要冻结时间，现在冻不了。
- **修法**：换 `clock.now()`。注意 webhook 的 `X-Solo-Timestamp` 与签名绑定，改动后 `tests/webhook.test.js` 要一起看。
- **归属**：`v1.1.x`。**做 G1/G5 之前先换，否则测试写不干净。**

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

## 6. 推进顺序（建议）

> 分批的依据：**同批改同一处写入点**，避免反复回改 + 反复跑 e2e。

**批次一 · 立刻（半天，全是"改坏了会立刻发现"的小活）**
`G4`（脚手架 .env，一行）→ `G18`（换 clock，为后续测试铺路）→ `G15` + `G17`（fail-fast 错误话术）→ `G3`（README 收敛，选 b 档）

**批次二 · 通道可信（G1 是本台账最高优先级）**
`G1`（阿里云 V3 签名）→ `G2`（Twilio 位置变量 + 两个 provider 请求形状测试）→ `G12`（通道探针）

**批次三 · 可观测 + 可靠（同一处写入点，一起改）**
`G5`（delivery 台账实体）+ `G7`（幂等键）+ `G8`（`_event` 夹带三事件）→ `G6`（经 ingress 回流回执，依赖 G5）

**批次四 · 能力与界面**
`G13`（附件，需给 gateway 接 relay + `system.gateway` bot）→ `G14`（模版 text）→ `G10`（portal 三页 + 台账页）→ `G11`（多通道账号实体）

**批次五 · 治理（跨版本）**
`G9(a)`（出站配额，默认不限）→ `G9(b)` + `G16` 默认值翻转 + `G19` 迁移 → **v2**

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
