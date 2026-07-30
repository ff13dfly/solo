# gateway 服务任务配方

> 由 fleet-standard `guide` 方法下发（经 Router：`system.guide { service: "gateway" }`）。
> 与服务代码同目录、同 commit 更新。方法签名与参数约束以 `methods` 自省为准，
> 本文只讲自省说不出的**任务流程与语义**。

## 这是什么

出站通信适配层：把系统内部的"发一封邮件 / 一条短信 / 一个 webhook"翻译成对外
提供商调用（SMTP/Resend、阿里云/Twilio、任意 HTTP 端点）。是 ingress（入站
webhook）的镜像。

**外部 AI 一般不直接调本服务。** 大多数方法 `ai:false`，只有 `gateway.email.send`
/ `gateway.sms.send` 标了 `ai:true`。真正的驱动者是内部服务经 Router relay 调用：
- **notification worker** 是主消费者——它带队列、重试、死信，最终 `relay.call('gateway.{channel}.send')`。
- **user/passport** 直连 `gateway.email.send` / `gateway.sms.send` 投递 OTP。
- **nexus sentinel** 配置里带 webhook target，触发 `gateway.webhook.send`。

要发通知，**优先投给 notification**（有可靠性纵深），别自己直连 gateway；只有
像 OTP 这种即时同步场景才直接 relay。

## 配方一：发邮件（两种模式，二选一）

`gateway.email.send`：
- **直发**：`{ to, subject, content }`（可选 `html`）——自由内容。
- **套模版**：`{ to, templateId, variables }`——服务端拉模版、按 `{{var}}` 插值出 subject/html/text。
- 可选 `smtpId`：指定一个已存的 SMTP 账号（`gateway.smtp.create` 建的）发；不传则
  走 config 通道（见下）。
- 可选 `cc` / `bcc` / `replyTo`：单个地址或数组，两条通道（smtp / api）都透传。
- 先建模版：`gateway.email.template.create { name, subject, html, text?, variables? }`，拿 `id` 当 templateId。
  `name`/`subject`/`html` **必填**（缺了当场 `-32602`，不再是发送时崩）；`text` 是可选的
  纯文本正文，不给则由 html 自动去标签派生（**别再靠把 HTML 当纯文本发**）。

## 配方二：发短信（只能套模版）

`gateway.sms.send { templateId, phone, variables }`——**没有自由文本短信**。
必须先 `gateway.sms.template.create { name, channel, providerCode, variables?, variableOrder? }`，
其 `providerCode` 要是提供商侧**已审批**的模版码（`channel`: aliyun/twilio/mock）。
运营商只认预审模版，随手发文本会被拒。

- **aliyun**：`providerCode` = TemplateCode；`phone` 可以是国内裸号（`13800138000`）。
- **twilio**：`providerCode` = Content SID（`HX…`）；`phone` **必须 E.164**（`+8613…`，否则 `-32602`）；
  且 Twilio 的 `ContentVariables` 是**位置键** `{"1":…,"2":…}`，所以模版要声明
  `variableOrder: ['code','ttl']` 把命名变量映射成位置——**不声明就发不对**。

## 配方三：发 webhook（机器目标）

`gateway.webhook.send { url, payload, type?, targetId?, secret?, timeoutMs? }`——
把 JSON POST 到外部端点。body 会被包成 `{ type, targetId, payload, sent_at }`。
`url` 来自调用方（notification 规则参数 / sentinel 配置），**绝不取自用户资料**。

## 配方四：查"到底发出去了没"（投递台账）

每次 send（三个通道都算）都会写一行 `delivery` 实体，返回值里带 `deliveryId`：

- `gateway.delivery.get { id }` —— 看单条。
- `gateway.delivery.list { page?, limit?, search? }` —— 看台账，新的在前。

关键字段 **`deliveryStatus`**（≠ 实体生命周期 `status`）：
- `SENT` —— 真提供商收下了。
- `MOCKED` —— **什么都没发出去**（无凭证降级 mock）。
- `FAILED` —— 打提供商失败，`error` 里是原因（截断 500 字）。

台账是**尽力而为**的：Redis 写失败只会让 `deliveryId` 缺失，**不会**让一次已被提供商
收下的投递变成失败。所以"没有 deliveryId"≠"没发出去"。

## 配方五：防重复发送（幂等键）

三个 send 都接可选 `idempotencyKey`（24h 窗口）：

- 首次调用正常发，结果连同 key 落盘。
- **同 key 再调 → 直接回放首次结果**，带 `deduplicated: true`，**不会二次投递**、不新增台账行、不再发事件。
- 首次**失败**会释放 key —— 重试才能真正重发（不然一次失败会把这个 key 永久锁死）。
- 并发撞同一个 key（前一次还在飞）→ 抛**临时错**（`already in flight`，不带 `httpStatus`），
  让调用方退避重试，重试时命中回放。

notification worker 已自动带 key：`notification:{messageId}:{channel}:{resolved target}`。
自己直连 gateway 时**建议也带**：上游任何重试都可能在"提供商已收下但响应超时"处重复投递。

## 事件（nexus sentinel 可订阅）

send 成功后经 Router `_event` 夹带发出（Router 会在回客户端前摘掉，所以你在返回值里看不到）。
流名 **`EVENT:GATEWAY:DELIVERY`**，两个 type：

| type | 什么时候 |
|------|---------|
| `gateway.delivery.sent` | 真提供商收下 |
| `gateway.delivery.mocked` | 落到 mock —— **什么都没真发出去**（生产上出现即配置缺失） |

payload：`{ channel, target, provider, providerMessageId, deliveryId, templateId, status }`。

⚠️ 两条限制：
- **失败没有事件**：`_event` 只能搭在成功结果上，投递失败请查台账 `deliveryStatus=FAILED`。
- **生产上还需事件注册表放行**：Router 只发登记过的 `(source, stream, type)`。dev/e2e 已放行，
  生产默认表需加 `'gateway': { 'EVENT:GATEWAY:DELIVERY': ['*'] }`（在 `api/router/config.js`）。
  未加时事件被静默拦下 → **判断"发没发出去"请以台账为准，别依赖事件**。

（两条的进展见 `docs/planning/gateway-gaps.md` G8。）

## 通道解析（config.js，决定"到底发没发出去"）

email `channel`: `auto|smtp|api|mock`；sms `channel`: `auto|aliyun|twilio|mock`。
`auto` 按凭证探测：有 API key 走 api，有 SMTP host 走 smtp，**都没有则落 `mock`**。

- **email 的 api 通道 body 形状 = Resend 兼容**（`API_PROVIDERS` 登记，`EMAIL_API_PROVIDER` 选）。
  SendGrid / SES 形状不同，**只改 `EMAIL_API_URL` 不通**，要加适配器。
- **aliyun 走 V3 `ACS3-HMAC-SHA256` 签名**（`logic/providers/aliyun-sign.js`），参数在 query、body 空。

## 坑与约定

- **`provider:'mock'` = 什么都没真发出去。** 无凭证时静默降级为 mock，`messageId` 是
  随机 UUID。notification 会记 `deliver.mocked` 但仍 ack（重试变不出凭证）。判断"真投递
  成功"必须看 `result.provider !== 'mock'`，别只看 `success:true`。
- **阿里云 HTTP 200 不等于发出去了**：业务失败在 body 的 `Code`（`isv.*`）里。gateway 已
  按 `Code !== 'OK'` 判失败，并把**非限流类**错误标成永久错（带 `httpStatus:400`）→ 直接
  死信不重试；限流类（`isv.BUSINESS_LIMIT_CONTROL` 等）留作临时错走退避重试。
- **收件人格式发前就校验**：邮箱不合法、`phone` 不合法 → `-32602`，**不会打提供商**（永久错，
  notification 直接 DLQ 不烧 5 次重试）。
- **模版变量漏传**：默认**原样保留** `{{code}}` 不报错（历史行为）。部署可开
  `GATEWAY_STRICT_VARIABLES=true` → 漏传直接拒发（`-32602` 并列出缺哪些）。**带 OTP 的部署
  建议开**，否则用户会收到字面量 `{{code}}`。
- **SSRF 护栏**：webhook 只允许 http/https；`localhost/127./0.0.0.0/::1` 等 loopback
  被拒（内部互调走 Router，不走 webhook）。`WEBHOOK_ALLOW_LOOPBACK=1` 仅供 e2e/dev 放开。
- **HMAC 签名**：webhook 传了 `secret` 才签——`X-Solo-Signature: sha256=<hex>` +
  `X-Solo-Timestamp`，接收方按同一 scheme 验。email/sms 无此机制。
- **webhook 判成功**：仅 2xx；非 2xx 抛错（带 `httpStatus`）。响应体上限 64KB（超出丢弃），
  默认超时 10s（`timeoutMs` 可调）。
- **SMTP 密码加密存储**：需 `GATEWAY_SECRET_KEY`（未设则 create/解密抛错）；`smtp.get/list/create`
  输出**永远抹掉 `pass`**，拿不到明文是设计如此。
- **附件还不支持**：`attachments` 未实现（G13），要发文件目前只能把链接写进正文。
  `cc` / `bcc` / `replyTo` 已可用。
- **没有出站配额/频控**：本层不限速（Router 的限流是按调用方 session，不是按收件人），
  循环的 workflow 会一直发。见 `docs/planning/gateway-gaps.md` G9。
- 实体全为**硬删除**，无软删回收站；`createdAt/updatedAt` 是时间戳数字。
- 本服务满足不了你的任务时，把缺口提到 `system.report`（用法见 Router guide §6）。
