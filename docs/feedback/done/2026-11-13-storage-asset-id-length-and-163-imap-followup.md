# 跨仓反馈：`storage` 环境变量 `ASSET_ID_LENGTH` 数值转型缺失（阻塞下游同步发版）及 163 IMAP 跟进（2026-11-13）

- **日期**：2026-11-13
- **投递来源**：全域履约生产巡检（关联 `steward` `BC001`、`finance` `BC002`、`catalog` `catalog-mini`）
- **关联文档**：
  - `catalog/docs/feedback/steward-storage-asset-id-length-string-bug.md`
  - `steward/docs/feedback/solo-v1.3.4-minor-followup.md`
  - `finance/docs/feedback/2026-11-13-catalog-ollama-peer-ready-for-bc002.md`
- **状态**：✅ 已修复并重新构建 `api/publish/solo.v1.3.4.js`（已归档至 `docs/feedback/done/`）

---

## 一、🔴 P0 阻塞项：`ASSET_ID_LENGTH` 字符串传入 `crypto.randomBytes` 导致 `storage.asset.upload` 崩溃

### 1. 生产阻塞背景
目前 `steward`、`finance`、`catalog` 准备统一拉齐 `solo@cb9012b` 最新 bundle 并将 `steward.bridge v2` 发布至生产机 `BC001`。但核查 `solo` 当前 HEAD 源码与 `api/publish/solo.v1.3.4.js` 发现，`ASSET_ID_LENGTH` 仍未做数值转型：
- `BC001`（`rpa.w3os.net`）的 `.env` 配置了 `ASSET_ID_LENGTH=16`，当前线上依赖对 `BC001:/home/web/AI/steward/api/publish/solo.v1.3.4.js` 的手工热修维持正常上传；
- **一旦下游直接同步当前未修复的 `solo.v1.3.4.js` 并执行 `prod.sh`，会立即覆盖 `BC001` 热修，导致所有 RPA 文件抓取（`grab from: 'download'`：财务平台结算单、电子税务局发票 ZIP、聚水潭 Excel 导出、异常现场截图）全部报 `ERR_INVALID_ARG_TYPE` 中断！**

### 2. 源码定位
1. `api/apps/storage/config.js`（第 131–133 行）：
   ```js
   idLengths: {
     asset: process.env.ASSET_ID_LENGTH || 8
   },
   ```
   `process.env.ASSET_ID_LENGTH` 为字符串 `'16'`。
2. `api/library/generator.js`（第 14–18 行）：
   ```js
   function generateId(length = 8) {
       if (length <= 0) return '';
       const bytes = crypto.randomBytes(length);
   ```
   Node.js `crypto.randomBytes('16')` 直接抛出：
   `[ERR_INVALID_ARG_TYPE] The "size" argument must be of type number. Received type string ('16')`。

### 3. 建议修复（双保险）
1. `api/apps/storage/config.js`：
   ```js
   idLengths: {
     asset: parseInt(process.env.ASSET_ID_LENGTH, 10) || 8
   },
   ```
2. `api/library/generator.js`：
   ```js
   function generateId(length = 8) {
       const n = Math.trunc(Number(length));
       if (!Number.isFinite(n) || n <= 0) return '';
       const bytes = crypto.randomBytes(n);
   ```
3. 重新打包 `api/publish/solo.v1.3.4.js`（或步进版本号），供 `steward`、`finance`、`catalog`、`procurement` 一次性安全升级。

---

## 二、🟡 P2 顺带收敛的小尾项（非阻塞，可同批处理）

1. **`SoloPeerProvider` 密码登录字段名对齐**：
   - 现状：`SoloPeerProvider` 走用户名密码挑战登录分支时发送 `{ username }`，而 `core/user` 校验 `{ name }`（目前 `BC002 ⇄ catalog-mini` 通过配置 `SOLO_AGENT_PEER_TOKEN` 走 `Authorization: Bearer <token>` 快路径规避）。建议在 `SoloPeerProvider` 中对齐为 `{ name }`，让密码挑战模式也原生可用。
2. **网易系邮局（`163.com` / `126.com` / `yeah.net`）IMAP RFC 2971 `ID` 握手扩展**：
   - 现状：`core/gateway` 标准 `gateway.imap.poll` 未发送 `ID ("name" "..." "version" "1.0.0")` 扩展帧，网易 IMAP 服务端在 `SELECT INBOX` 时返回 `NO Unsafe Login`。补齐可选 `clientId` 握手后，`steward` 即可彻底删除 `api/apps/steward/logic/imap-client.js` 中的最后一段 163 兜底分支。

---

## 处理结论（2026-11-13）

1. **🔴 P0 `ASSET_ID_LENGTH` 数值转型双保险已落地**：
   - `api/apps/storage/config.js`：`idLengths.asset` 改为 `intFromEnv('ASSET_ID_LENGTH', 8)`（符合 SOLO `[env-int]` 静态门禁规范）；
   - `api/library/generator.js`：`generateId(length)` 与 `validateId(id, length)` 均统一执行 `Math.trunc(Number(length))` 强制数值转型，彻底阻断 `.env` 字符串参数传入 `crypto.randomBytes()` 抛 `ERR_INVALID_ARG_TYPE` 或 `validateId` 严格类型比对失败。
2. **🟡 P2-1 `SoloPeerProvider` / `peer-relay.js` 密码挑战登录双向兼容已落地**：
   - `api/library/peer-relay.js`：`user.login.request` 同时携带 `{ name: user, username: user }`，`user.login.verify` 同时携带 `{ name: user, username: user, challenge, response: signature, signature, deviceId }`；
   - `api/core/user/logic/user.js`：`loginRequest` 与 `loginVerify` 兼容读取 `params.name || params.username` 及 `params.response || params.signature`。
3. **🟡 P2-2 网易系邮局（`163.com` / `126.com` / `yeah.net`）IMAP RFC 2971 `ID` 握手扩展已落地**：
   - `api/core/gateway/logic/imap.js`：`testImapConnection` 与 `pollImapAccount` 在 `LOGIN` 成功后、`EXAMINE`/`SELECT` 前自动发送 RFC 2971 `ID ("name" "SOLO-Gateway" "version" "1.0.0" "vendor" "SOLO")` 扩展命令（并支持通过 `clientId` 参数自定义标识字段，对不支持 `ID` 的服务端自动容错忽略）；
   - `api/core/gateway/handlers/introspection.js`：`gateway.imap.create` 与 `gateway.imap.poll` 参数白名单补齐 `clientId`。
4. **发布包与回归验证**：
   - 已重新打包 `api/publish/solo.v1.3.4.js`，包含 `run-2` 对抗性安全审计修复与本单全部 3 项修复；
   - 新增单测覆盖（`api/library/tests/generator.test.js`、`api/library/tests/outbound-peer-ollama.test.js`、`api/tests/unit/security-run2-v134.test.js`），全量静态门禁与 `check-upgrade-path.sh` 100% 通过。
