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
- **套模版**：`{ to, templateId, variables }`——服务端拉模版、按 `{{var}}` 插值出 subject/html。
- 可选 `smtpId`：指定一个已存的 SMTP 账号（`gateway.smtp.create` 建的）发；不传则
  走 config 通道（见下）。
- 先建模版：`gateway.email.template.create { name, subject, html, variables }`，拿 `id` 当 templateId。

## 配方二：发短信（只能套模版）

`gateway.sms.send { templateId, phone, variables }`——**没有自由文本短信**。
必须先 `gateway.sms.template.create` 建模版，其 `providerCode` 要是提供商侧**已审批**的
模版码（`channel`: aliyun/twilio/mock）。运营商只认预审模版，随手发文本会被拒。

## 配方三：发 webhook（机器目标）

`gateway.webhook.send { url, payload, type?, targetId?, secret?, timeoutMs? }`——
把 JSON POST 到外部端点。body 会被包成 `{ type, targetId, payload, sent_at }`。
`url` 来自调用方（notification 规则参数 / sentinel 配置），**绝不取自用户资料**。

## 通道解析（config.js，决定"到底发没发出去"）

email `channel`: `auto|smtp|api|mock`；sms `channel`: `auto|aliyun|twilio|mock`。
`auto` 按凭证探测：有 API key 走 api，有 SMTP host 走 smtp，**都没有则落 `mock`**。

## 坑与约定

- **`provider:'mock'` = 什么都没真发出去。** 无凭证时静默降级为 mock，`messageId` 是
  随机 UUID。notification 会记 `deliver.mocked` 但仍 ack（重试变不出凭证）。判断"真投递
  成功"必须看 `result.provider !== 'mock'`，别只看 `success:true`。
- **SSRF 护栏**：webhook 只允许 http/https；`localhost/127./0.0.0.0/::1` 等 loopback
  被拒（内部互调走 Router，不走 webhook）。`WEBHOOK_ALLOW_LOOPBACK=1` 仅供 e2e/dev 放开。
- **HMAC 签名**：webhook 传了 `secret` 才签——`X-Solo-Signature: sha256=<hex>` +
  `X-Solo-Timestamp`，接收方按同一 scheme 验。email/sms 无此机制。
- **webhook 判成功**：仅 2xx；非 2xx 抛错（带 `httpStatus`）。响应体上限 64KB（超出丢弃），
  默认超时 10s（`timeoutMs` 可调）。
- **模版插值**：`{{var}}` 未提供的变量**原样保留**，不报错——漏传变量会把 `{{code}}`
  当字面量发出去，发前自查。
- **SMTP 密码加密存储**：需 `GATEWAY_SECRET_KEY`（未设则 create/解密抛错）；`smtp.get/list/create`
  输出**永远抹掉 `pass`**，拿不到明文是设计如此。
- 实体全为**硬删除**，无软删回收站；`createdAt/updatedAt` 是时间戳数字。
- 本服务满足不了你的任务时，把缺口提到 `system.report`（用法见 Router guide §6）。
