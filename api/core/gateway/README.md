# Gateway Service

外部通信网关服务，负责与第三方服务集成（邮件、短信等）。

> [!NOTE]
> 此服务作为系统对外通信的统一出口，由内部服务通过 `_tasks` 机制调用。

## 方法

> **方法清单与参数以 introspection 为准** —— 调 `system.introspect` 或读本服务 `handlers/introspection.js`（声明↔注册由 `deploy/check-doc-drift.js` CI 守护）。

出站通道（每条通道对应一个外部提供商适配器）：邮件走 SendGrid / SES，短信走阿里云 SMS / Twilio。提供商凭证由 `config.js` 注入，逻辑收敛在 `logic/index.js`，使本服务成为系统对外通信的唯一适配出口。

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
│   └── index.js        # 业务逻辑（邮件、短信发送）
└── tests/
```

## 配置

在环境变量或 `config.js` 中配置：

```bash
GATEWAY_PORT=8020
EMAIL_API_KEY=your_sendgrid_key
SMS_API_KEY=your_aliyun_key
SMS_SIGN_NAME=Solo·AI
```

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
