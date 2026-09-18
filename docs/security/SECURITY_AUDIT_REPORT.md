# SOLO 框架安全性与漏洞分析报告
**依据 Cloudflare Security Audit Skill 6 阶段审计方法论执行**

- **审计基准**：`cloudflare/security-audit-skill`
- **审计范围**：API Router 网关 (`api/router`)、微服务网络接口绑定 (`api/library/ports.js`)、系统运维与配置 (`api/core/administrator`)、类别管理 (`api/router/handlers/category.js`)、鉴权与限流模型 (`api/library/auth.js`)
- **审计方法**：侦察（Reconnaissance）→ 覆盖导向寻宝（Hunting）→ 对抗式反向证伪（Adversarial Validation）→ 证据链固化与报告

---

## 漏洞总览 (Vulnerability Executive Summary)

| 编号 | 漏洞名称 | 涉及模块与文件 | 风险等级 | 验证状态 |
| :--- | :--- | :--- | :---: | :---: |
| **SOLO-SEC-01** | `Host` 请求头伪造绕过 Router 本地回环 (Loopback) 访问控制 | `api/router/handlers/auth.js:136-138`<br>`api/router/index.js:210, 247, 251` | **HIGH** | 已反向验证 (Confirmed) |
| **SOLO-SEC-02** | `system.category.delete` 缺少强制属主校验导致任意类别被删 | `api/router/handlers/category.js:94-98` | **HIGH** | 已反向验证 (Confirmed) |
| **SOLO-SEC-03** | 速率限制器盲目信任未经验证的 `X-Forwarded-For` 头可被全量绕过 | `api/router/index.js:276-278` | **HIGH** | 已反向验证 (Confirmed) |
| **SOLO-SEC-04** | `administrator` 运维硬门存在形参污染漏洞 (`params.isAdmin`) | `api/core/administrator/index.js:180-183` | **MEDIUM** | 已反向验证 (Confirmed) |
| **SOLO-SEC-05** | 缺省网络绑定为 `0.0.0.0` 导致全部 14 个微服务端口直接暴露公网 | `api/library/ports.js:63-67`<br>`api/router/index.js:49` | **MEDIUM** | 已反向验证 (Confirmed) |
| **SOLO-SEC-06** | `system.service.add` 缺少 URL 合规校验存在内部网络 SSRF 风险 | `api/router/handlers/service.js:28-53` | **MEDIUM** | 已反向验证 (Confirmed) |

---

## 漏洞详细剖析与对抗式验证

### 漏洞 1 (SOLO-SEC-01): `Host` 请求头伪造绕过 Router 本地回环检查
- **所属攻击类**：`WEB-PROTOCOL-AND-AUTH`（Web 协议与鉴权绕过）
- **漏洞位置**：
  - `api/router/handlers/auth.js:136-138`
  - `api/router/index.js:209-211, 246-253`
- **根本原因**：
  在 `isLoopbackRequest(req)` 中，代码试图判断请求是否来自本机：
  ```javascript
  function isLoopbackRequest(req) {
      return req?.ip === '127.0.0.1' || req?.ip === '::1' || req?.hostname === 'localhost';
  }
  ```
  在 Express 框架中，`req.hostname` 是通过客户端 HTTP 请求头中的 `Host` 派生的（即 `req.get('host')` 剥离端口），**完全受客户端控制**。
- **对抗式推演与攻击路径**：
  1. 远程攻击者从外部 IP（如 `203.0.113.5`）向公网暴露的 Router 发起请求：
     ```http
     POST /jsonrpc HTTP/1.1
     Host: localhost
     Content-Type: application/json

     {"jsonrpc":"2.0","method":"system.category.reserve","params":{"key":"TEST","service":"evil"},"id":1}
     ```
  2. Router 未开启 `trust proxy`，`req.ip` 为 `203.0.113.5`。但由于存在 `|| req?.hostname === 'localhost'` 条件，表达式求值为 `true`。
  3. Router 放行 `system.category.reserve`、`system.category.delete`，以及在开启 `config.debug` 时的 `system.service.add`。
- **修复方案**：
  移除对 `req.hostname` 的信任，且增加对 IPv4-mapped IPv6 地址（`::ffff:127.0.0.1`）的覆盖（对齐 `api/library/auth.js:127` 的成熟写法）：
  ```diff
  - function isLoopbackRequest(req) {
  -     return req?.ip === '127.0.0.1' || req?.ip === '::1' || req?.hostname === 'localhost';
  - }
  + function isLoopbackRequest(req) {
  +     const ip = req?.ip || req?.socket?.remoteAddress;
  +     return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  + }
  ```

---

### 漏洞 2 (SOLO-SEC-02): `system.category.delete` 缺少强制属主校验
- **所属攻击类**：`ATTACK-CLASSES` / 访问控制缺失 (IDOR)
- **漏洞位置**：`api/router/handlers/category.js:94-98`
- **根本原因**：
  ```javascript
  // Permission check: Only the owner can delete a category
  if (service && data.owner !== service) {
      return res.json({ jsonrpc: '2.0', error: { code: -32012, message: 'CATEGORY_PERMISSION_DENIED' }, id });
  }
  ```
  校验逻辑前置条件为 `if (service && ...)`。若调用方在 params 中根本不传入 `service` 字段，该校验条件直接为 `false`，校验被完全跳过！
  此外，公开无鉴权接口 `system.category.list` 会返回所有分类及其属主名称，攻击者即使需要 `service` 也能直接查阅并伪填。
- **危害**：结合漏洞 1，任意未授权客户端均可随意软删除集群中任何核心微服务的注册类别。
- **修复方案**：
  ```diff
  - if (service && data.owner !== service) {
  + if (!service || data.owner !== service) {
        return res.json({ jsonrpc: '2.0', error: { code: -32012, message: 'CATEGORY_PERMISSION_DENIED' }, id });
    }
  ```

---

### 漏洞 3 (SOLO-SEC-03): 速率限制器盲目信任未经验证的 `X-Forwarded-For`
- **所属攻击类**：`WEB-PROTOCOL-AND-AUTH` / 凭证暴力破解防线穿透
- **漏洞位置**：`api/router/index.js:276-278`
- **根本原因**：
  ```javascript
  const rlIp     = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const identity = (rlRule.by === 'user' && sessionUser.uid) ? sessionUser.uid : rlIp;
  const rlStatus = await handlers.ratelimit.checkLimit(redisClient, method, identity, rlRule);
  ```
  在未登录/匿名调用阶段（如 `user.login.request`、`user.login.verify`、`user.register`），`sessionUser.uid` 为空，限流标识完全依赖 `rlIp`。
  代码直接读取请求头中的 `x-forwarded-for`。攻击者在发起撞库或爆破时，每次请求变更一个随机的 `X-Forwarded-For`（如 `X-Forwarded-For: 1.1.1.1`，`1.1.1.2`…），限流计数器每次都在不同的 Redis Key 下累计，**全局速率限制彻底失效**。
- **修复方案**：
  除非应用明确配置在受信任的逆向代理之后（并通过环境变量声明），否则必须使用底层的物理 Socket IP：
  ```javascript
  const clientIp = req.socket?.remoteAddress || '127.0.0.1';
  // 仅在明确配置 TRUST_PROXY=true 时才解析首个代理 IP
  const rlIp = process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-for']
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : clientIp;
  ```

---

### 漏洞 4 (SOLO-SEC-04): `administrator` 运维硬门存在形参污染漏洞
- **所属攻击类**：`ATTACK-CLASSES` / 权限提升与纵深防御穿透
- **漏洞位置**：`api/core/administrator/index.js:180-183`
- **根本原因**：
  ```javascript
  const trustedParams = { ...params };
  if (req.permit === 'admin') {
      trustedParams.isAdmin = true;
  }
  trustedParams._user = req.user;
  ```
  在各运维管理方法中（如 `setting.config.set`、`setting.automation.pause`），代码均依赖：
  ```javascript
  if (!p.isAdmin) throw jsonrpc.UNAUTHORIZED();
  ```
  然而 `trustedParams` 浅拷贝了外部传入的 `params`。当普通用户或直连访问者传入 `{ "isAdmin": true, "service": "...", "key": "..." }` 时，`trustedParams.isAdmin` 在初始解构时即为 `true`，而 `if (req.permit === 'admin')` 并不会在非管理员时将此字段强制重置为 `false`。
- **修复方案**：
  ```diff
  - const trustedParams = { ...params };
  - if (req.permit === 'admin') {
  -     trustedParams.isAdmin = true;
  - }
  + const trustedParams = {
  +     ...params,
  +     isAdmin: req.permit === 'admin',
  +     _user: req.user
  + };
  ```

---

### 漏洞 5 (SOLO-SEC-05): 缺省网络绑定为 `0.0.0.0` 导致微服务全部端口公网暴露
- **所属攻击类**：`CLOUD-AND-DEPLOYMENT` / 不安全的默认网络暴露
- **漏洞位置**：`api/library/ports.js:63-67`、`api/router/index.js:49`
- **根本原因**：
  `bindAddr(name)` 实现如下：
  ```javascript
  function bindAddr(name) {
    const perService = name && process.env[`${String(name).toUpperCase()}_BIND_ADDR`];
    const addr = perService || process.env.BIND_ADDR;
    return addr && String(addr).trim() ? String(addr).trim() : undefined;
  }
  ```
  当未配置环境变量 `BIND_ADDR` 时，返回 `undefined`。Node.js 的 `server.listen(port, undefined)` 默认监听宿主机的全部网络接口（`0.0.0.0` 及 `::`）。
  在没有额外主机级防火墙配置的裸机或云主机部署环境下，外部可以直接探测并连通 `administrator(8680)`、`user(8710)`、`mcp(8091)` 等下游微服务。
  同时，`api/router/index.js:49` 硬编码了 `app.use(cors())`，未接入统一的 `corsOptionsFromEnv`，导致 API 网关跨域完全不设防。
- **修复方案**：
  生产环境下建议将缺省 `BIND_ADDR` 设为安全的 `127.0.0.1`（仅暴露 Router 8600），或在部署脚本中强制检查并注入 `BIND_ADDR=127.0.0.1`；同时统一 Router 的 CORS 配置。

---

### 漏洞 6 (SOLO-SEC-06): `system.service.add` 缺少 URL 白名单校验存在 SSRF 风险
- **所属攻击类**：`PROTOCOLS-RPC-AND-MESSAGING` / SSRF 与微服务仿冒
- **漏洞位置**：`api/router/handlers/service.js:28-53`
- **根本原因**：
  动态服务注册接口 `addService(inputUrl, ...)` 直接对传入的 `inputUrl` 发起 HTTP 请求：
  ```javascript
  const seedRes = await axios.get(`${baseUrl}/auth/seed`, { timeout: 3000 });
  const verifyRes = await axios.post(`${baseUrl}/auth/verify`, ...);
  ```
  缺乏对内网 IP（如云厂商元数据 `169.254.169.254`、私有网段 `10.0.0.0/8`）或危险协议的校验。一旦攻击者利用前述漏洞 1 绕过鉴权，便可驱使 Router 发起带 Ed25519 签名或特定载荷的内网探测，甚至劫持特定微服务的 RPC 路由。
- **修复方案**：
  对 `baseUrl` 实施严格的 URL Schema、域名/端口白名单限制，并禁止重定向与内网保留地址。

---

## 结论与建议修复路线

1. **第一优先级（立即修复）**：
   - 修复 `api/router/handlers/auth.js` 中的 `isLoopbackRequest`（消除 `Host: localhost` 伪造隐患）。
   - 修复 `api/router/index.js` 中的限流 IP 获取逻辑（杜绝 `X-Forwarded-For` 伪造穿透）。
   - 修复 `api/router/handlers/category.js` 中的 `delete` 属主校验条件。
2. **第二优先级（防御纵深加固）**：
   - 修复 `api/core/administrator/index.js` 中的 `trustedParams.isAdmin` 覆盖赋值。
   - 检查启动脚本与 Docker 部署模板，强制默认将下游微服务绑定到 `127.0.0.1`。
