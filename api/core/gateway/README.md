# Gateway Service

外部通信网关服务，负责与第三方服务集成（邮件、短信等）。

> [!NOTE]
> 此服务作为系统对外通信的统一出口，由内部服务通过 `_tasks` 机制调用。

## 方法

> **方法清单与参数以 introspection 为准** —— 调 `system.introspect` 或读本服务 `handlers/introspection.js`（声明↔注册由 `deploy/check-doc-drift.js` CI 守护）。

出站通道（每条通道对应一个外部提供商适配器）。提供商凭证由 `config.js` 注入（env），逻辑收敛在 `logic/`，使本服务成为系统对外通信的唯一适配出口。

| 通道 | 已实现的适配器 | 说明 |
|------|---------------|------|
| **email** | `smtp`（nodemailer，支持 `gateway.smtp.*` 多账号）· `api`（**Resend 兼容 body**）· `mock` | api 通道的 body 形状登记在 `logic/email.js` 的 `API_PROVIDERS`（当前只有 `resend`）。**SendGrid（`personalizations`）/ SES（自有 Action + SigV4）body 形状不同，只改 `EMAIL_API_URL` 不通**，需在 `API_PROVIDERS` 加适配器并设 `EMAIL_API_PROVIDER`。 |
| **sms** | `aliyun`（Dysmsapi，V3 `ACS3-HMAC-SHA256` 签名，见 `logic/providers/aliyun-sign.js`）· `twilio`（Content Template API）· `mock` | 只能套**提供商侧已审批**的模版码。Twilio 的 `ContentVariables` 是位置键 `{"1":…}`，由模版实体的 `variableOrder` 声明命名→位置映射。 |
| **webhook** | 出站 HTTP POST（可选 HMAC-SHA256 签名 + SSRF 闸 + 有界超时） | 机器目标，`url` 来自调用方配置，绝不取自用户资料。 |

> ⚠️ **`provider:'mock'` = 什么都没真发出去**（无凭证时的静默降级）。判断真投递看 `result.provider !== 'mock'`，别只看 `success:true`。
> 剩余缺口（投递台账 / 回执回流 / 幂等键 / 事件 / 配额 / 附件）见 [`docs/planning/gateway-gaps.md`](../../../docs/planning/gateway-gaps.md)。

## 目录结构

```
api/core/gateway/
├── index.js            # 服务入口
├── config.js           # 配置（端口、API Key 等）
├── package.json
├── handlers/
│   ├── auth.js         # Router 握手认证
│   ├── bootstrap.js    # Redis 初始化
│   └── introspection.js# 方法自省
├── logic/
│   ├── index.js        # 编排 + 校验（模版完整性、收件人格式、变量严格模式）
│   ├── email.js        # 邮件通道（smtp / api：API_PROVIDERS body 适配器 / mock）
│   ├── sms.js          # 短信通道（aliyun / twilio / mock）
│   ├── smtp.js         # SMTP 账号实体 + 密码加密 + transporter 缓存
│   ├── webhook.js      # 出站 webhook（HMAC 签名 + SSRF 闸）
│   ├── rmbg.js         # 抠图（职责越界，见 gateway-gaps G19）
│   └── providers/
│       └── aliyun-sign.js  # 阿里云 V3 ACS3-HMAC-SHA256 请求签名
└── tests/
```

## 配置

在环境变量或 `config.js` 中配置：

```bash
GATEWAY_PORT=8020
GATEWAY_SECRET_KEY=<32-byte hex>        # 加密 SMTP 账号密码，缺失则 gateway.smtp.* 不可用
GATEWAY_STRICT_VARIABLES=false         # true = 模版变量漏传直接拒发（推荐带 OTP 的部署开启）

# email
EMAIL_CHANNEL=auto                     # auto|smtp|api|mock
EMAIL_FROM=noreply@example.com
EMAIL_API_KEY=re_xxxx                  # api 通道（Resend 兼容）
EMAIL_API_PROVIDER=resend              # API_PROVIDERS 里的适配器名
EMAIL_SMTP_HOST=smtp.example.com       # smtp 通道（也可改用 gateway.smtp.create 建多账号）

# sms
SMS_CHANNEL=auto                       # auto|aliyun|twilio|mock
SMS_ALIYUN_KEY_ID=LTAI_xxxx
SMS_ALIYUN_KEY_SECRET=xxxx
SMS_ALIYUN_SIGN_NAME=Solo·AI
SMS_TWILIO_SID=ACxxxx
SMS_TWILIO_TOKEN=xxxx
SMS_TWILIO_FROM=+15551234567
```

> 变量名以 `config.js` 为准；脚手架下发的 `.env` 模版（`deploy/scaffold/init.sh`）已带全部注释位。

## 调用示例

由其他服务通过 `_tasks` 返回调用：

```json
{
  "result": {
    "data": { "message": "操作成功" },
    "_tasks": [
      {
        "service": "gateway",
        "method": "gateway.sms.send",
        "params": { "phone": "+86138xxxx", "code": "123456" }
      }
    ]
  }
}
```

Router 会提取 `_tasks` 并转发到本服务执行。
