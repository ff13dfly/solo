# 安全审计第二期漏洞沉淀与修复规划 (Cloudflare Security Audit Phase 2)

- **来源**：2026-09-18，基于 Cloudflare Security Audit Skill 深度摸排 SOLO 架构
- **状态**：已修复 (已通过全量 CI 回测，归档至 `docs/feedback/done/`)
- **级别**：MEDIUM 级（工作流原型链污染与存储型 XSS 防御）

---

## 漏洞问题清单与根因

### 1. Orchestrator `setPath` 原型链防污染缺失 (Prototype Pollution)
- **位置**：`api/core/orchestrator/logic/runner.js:828-852`
- **现象**：
  工作流引擎在执行外部 Resolver 抽取值并回填 context 时，调用 `setPath(context, targetPath, value)`。该函数按 `.` 拆分路径并逐级向下赋值对象。
  未对 `__proto__`、`constructor`、`prototype` 进行任何过滤阻断。
- **危害**：
  若工作流配置或外部输入的 Resolver 数据中包含恶意路径（例如 `$__proto__.polluted`），会将属性直接注入到全局 `Object.prototype` 上，导致全运行时进程原型链污染，严重破坏对象安全或导致任意属性覆盖。
- **修法**：
  在 `setPath` 递归导航前加入原型链关键字检查，遇到任何含 `__proto__`、`constructor`、`prototype` 的路径即刻拒绝并返回 `false`：
  ```javascript
  if (parts.some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype')) {
      logger.warn(`Blocked attempt to set dangerous path "${path}"`);
      return false;
  }
  ```

---

### 2. Storage 本地 OSS 静态直链缺乏 SVG/敏感 MIME 的 Stored XSS 防护
- **位置**：`api/apps/storage/oss/local-oss-server.js:235-265`
- **现象**：
  本地 OSS 模拟器在响应 `GET` / `HEAD` 请求时，直接下发文件扩展名或元数据推导的 `Content-Type`（如 `.svg` 下发 `image/svg+xml`）。
  未配置任何 `Content-Security-Policy` 或 `X-Content-Type-Options: nosniff` 响应头。
- **危害**：
  当用户或第三方上传包含内嵌 JavaScript（`<script>alert(1)</script>`）的 SVG 文件，管理员或受害者在浏览器中直接打开该文件直链进行预览时，浏览器将在当前域的上下文中解析并执行脚本，形成存储型 XSS（Stored XSS），可能被用于窃取凭证或进行未授权操作。
- **修法**：
  - 对所有静态文件响应统一增加 `X-Content-Type-Options: nosniff`，防 MIME-sniffing 降级攻击。
  - 针对 `image/svg+xml`、`text/html`、`text/xml` 等可执行脚本的标记语言，强制追加严格的内容安全策略：
    ```http
    Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'
    ```
    阻断浏览器执行其中的任何内嵌脚本与外部请求。

---

## 处理结论与回测记录

1. **代码修复落地**：
   - `api/core/orchestrator/logic/runner.js`：更新 `setPath`，对传入路径的所有分段严格检查 `__proto__`、`constructor`、`prototype`，命中任一危险字段立即阻断并警告；解析器调用循环中根据返回值跳过非法注入。
   - `api/apps/storage/oss/local-oss-server.js`：在 `HEAD` 与 `GET` 处理静态资源响应时，统一增加 `X-Content-Type-Options: nosniff` 响应头，且检测到 SVG、HTML、XML 等标记类 MIME 时自动增加 `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`，全面消除 Stored XSS 风险。

2. **单测套件扩充与全量 CI 回测**：
   - 新增 `api/core/orchestrator/tests/runner-security.test.js`，针对 `__proto__`、`constructor.prototype` 以及深层原型链注入进行 100% 覆盖验证。
   - 在 `api/apps/storage/tests/oss-provider.test.js` 中扩充测试用例，校验 `HEAD` 与 `GET` 对 SVG 资源的安全响应头。
   - 将 `runner-security.test.js` 纳入 `api/jest.ci.config.js` 白名单。
   - 运行全量回归套件：`REDIS_URL=redis://localhost:6699 npm run test:ci --prefix api`，结果：**135 suites passed, 2269 tests passed, 0 failed**，全量绿标通过。
