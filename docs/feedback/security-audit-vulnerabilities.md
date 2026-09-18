# 安全审计漏洞沉淀与修复规划 (Cloudflare Security Audit Skill 发现)

- **来源**：2026-09-18，基于 `cloudflare/security-audit-skill` 对 SOLO 全架构进行对抗式安全审计
- **全量审计报告**：[`docs/security/SECURITY_AUDIT_REPORT.md`](../security/SECURITY_AUDIT_REPORT.md)
- **状态**：待修复 (待回填处理结论后归档进 `docs/feedback/done/`)
- **级别**：HIGH / CRITICAL 级架构与网关鉴权缺陷

---

## 漏洞问题清单与根因

### 1. `Host: localhost` 伪造导致 Router 回环 (Loopback) 限制绕过
- **位置**：`api/router/handlers/auth.js:136-138`、`api/router/index.js:209-211, 246-253`
- **现象**：`isLoopbackRequest(req)` 判定逻辑中包含 `|| req?.hostname === 'localhost'`。Express 中的 `req.hostname` 取自 HTTP 请求头 `Host`。公网攻击者向 Router 发起请求并携带 `Host: localhost`，即可欺骗网关认定其为单机回环调用。
- **危害**：未授权调用 `system.category.reserve`、`system.category.delete` 以及 debug 模式下的 `system.service.add`。
- **修法**：移除 `req.hostname` 信任，严格校验物理 IP（并支持 `::ffff:127.0.0.1`）：
  ```javascript
  function isLoopbackRequest(req) {
      const ip = req?.ip || req?.socket?.remoteAddress;
      return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  }
  ```

### 2. `system.category.delete` 缺少强制属主校验
- **位置**：`api/router/handlers/category.js:94-98`
- **现象**：`if (service && data.owner !== service)` 在调用方未传 `service` 参数时求值为 `false`。
- **危害**：配合漏洞 1，任意外部人员可软删除微服务集群的所有注册类别。
- **修法**：强制校验 `service` 且必须与 `data.owner` 一致：
  ```javascript
  if (!service || data.owner !== service) {
      return res.json({ jsonrpc: '2.0', error: { code: -32012, message: 'CATEGORY_PERMISSION_DENIED' }, id });
  }
  ```

### 3. 全局速率限制器盲目信任未验证的 `X-Forwarded-For`
- **位置**：`api/router/index.js:276-278`
- **现象**：未登录阶段的限流标识直接取 `req.headers['x-forwarded-for']`。
- **危害**：攻击者在暴力破解 `user.login.verify` 时，每次请求变更一个随机 IP 即可完全绕过限流防线。
- **修法**：非 `trust proxy` 模式下只信任底层 `req.socket.remoteAddress`。

### 4. `administrator` 运维硬门存在形参污染漏洞
- **位置**：`api/core/administrator/index.js:180-183`
- **现象**：`trustedParams = { ...params }` 浅拷贝了外部请求体。非管理员在入参传入 `params.isAdmin: true` 时，该字段在非 admin 会话下未被重置为 `false`。
- **危害**：穿透下游 handler 对 `setting.config.*` 与 `setting.automation.*` 的内部硬门防线。
- **修法**：显式赋值 `isAdmin: req.permit === 'admin'`。

### 5. 缺省网络绑定 `0.0.0.0` 导致全量微服务暴露
- **位置**：`api/library/ports.js:63-67`、`api/router/index.js:49`
- **现象**：缺省未配 `BIND_ADDR` 时监听 `0.0.0.0`；网关硬编码了 `app.use(cors())`。
- **危害**：下游 14 个微服务端口直接面向公网；网关对任意 Origin 开放。
- **修法**：统一规范部署模板，推荐缺省绑定 `127.0.0.1`，并收敛 Router CORS。

### 6. `system.service.add` 缺少 URL 过滤存在 SSRF 风险
- **位置**：`api/router/handlers/service.js:28-53`
- **现象**：动态注册直接对调用方提供的 URL 发起探测与验签。
- **危害**：探测内网服务、劫持微服务路由。
- **修法**：对注册 URL 实施内网地址过滤及端口规范约束。

---

## 处理结论

- **状态**：待落地修复（待更新对应模块代码与回归单测）
