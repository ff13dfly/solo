# SOLO `v1.3.4` 接入实测反馈与三项收尾建议（IMAP 网易 `ID` 扩展、`user.token.revoke` 委派门禁、`upgrade.sh` 单测过滤）

> 来源：2026-11-09 `steward`（千手 RPA，已升级至 `.solo-version = v1.3.4`）四处非履约历史旁路收敛实测反馈（2026-11-12 同步投递入库）。
>
> **依据**：
> - `api/core/gateway/logic/imap.js`（网易系邮局 `163.com` / `126.com` / `yeah.net` / `qiye.163.com` 实测返回 `NO SELECT Unsafe Login`）；
> - `api/core/user/index.js:277`（`user.token.revoke` 与 `user.password.reset` 委派门禁不对称）；
> - `deploy/scaffold/upgrade.sh`（将依赖 `solo` 源码仓内部路径 `../../apps/storage/oss` 的单测同步到下游 bundle 仓）。

---

## 建议 1：`core/gateway` (`logic/imap.js`) 在 `LOGIN` 后补发一行 RFC 2971 `ID` 扩展命令

- **现象**：国内高频使用的网易系邮局（`imap.163.com`、`imap.126.com`、`imap.yeah.net`、`imaphz.qiye.163.com`）强制要求客户端在 `LOGIN` 成功后、发送 `SELECT` / `EXAMINE` 前先发送一条 RFC 2971 `ID` 标识命令，否则服务端直接拒绝打开收件箱并返回 `NO SELECT Unsafe Login. Please contact kefu@188.com for help`。
- **现状影响**：`steward` 已将 QQ、Gmail、Outlook、阿里云、飞书及通用企业邮全部切至原生 `gateway.imap.{list,create,update,poll}`，仅针对网易系域名暂留 `steward/api/apps/steward/logic/imap-client.js` 兜底以避免线上验证码剧本断流。
- **建议改动**：在 `api/core/gateway/logic/imap.js` 的 `testImapConnection` 与 `pollImapAccount` 中，紧跟 `LOGIN` 之后加一行容错调用（不支持 RFC 2971 的邮局返回 `BAD`/`NO` 时忽略即可）：
  ```js
  await session.command('ID ("name" "SOLO-Gateway" "version" "1.0.0" "vendor" "SOLO")').catch(() => {});
  ```
  补齐后，`steward` 即可彻底删除 679 行的 `imap-client.js`，实现 100% 邮箱域名走 `gateway.imap.*`。

---

## 建议 2：`core/user` 为 `user.token.revoke` 开放与 `user.password.reset` 对称的受控服务机器人委派门禁

- **现象**：
  1. `v1.3.4` 已为 `user.account.list`、`user.account.update`、`user.role.assign` 与 `user.password.reset` 接入 `assertAdminOrDelegated(...)`（针对非 `admin` 目标账号），`system.steward` 席位目录读写与口令重置已完全打通；
  2. 唯独 `user.token.revoke`（`api/core/user/index.js:277`）仍保留硬 `if (!isAdmin)` 门禁——当业务服务在「吊销协作授权书（`revoke`）但无需为用户改密」的场景下想主动踢掉该受控席位在途会话时，目前只能借道调用一次 `user.password.reset` 顺带清退会话。
- **建议改动**：`user.token.revoke` 对齐 `user.password.reset` 的安全判据（经 `assertAdminOrDelegated('user.token.revoke')` 校验，且目标账号非 `admin` / 非 `POWER=operator` 时放行）。

---

## 建议 3：`deploy/scaffold/upgrade.sh` 同步 `api/library/` 时排除引用源码仓内部路径的单测

- **现象**：运行 `bash solo/deploy/scaffold/upgrade.sh /path/to/downstream` 时，会将 `api/library/tests/feedback-v133-convergence.test.js` 一并同步到下游业务仓。该测试内含 `require('../../apps/storage/oss')`，而在下游业务仓中 `apps/storage` 已打包进 `api/publish/solo.v1.3.4.js`（不存在源码目录 `api/apps/storage/oss`），若在下游根目录直接无过滤执行 `npx jest` 会因找不到模块报错。
- **建议改动**：将跨服务集成回归单测迁至 `solo` 仓顶层或对应服务 `tests/` 目录，或在 `upgrade.sh` 同步 `api/library/` 时排除依赖 `solo` 源码仓相对路径的测试文件。

---

## 处理结论（solo 侧）

- **2026-11-12 已全部核实并落地**：
  1. **建议 1（`core/gateway` `logic/imap.js` 补发 RFC 2971 `ID` 扩展命令）**：已在 `api/core/gateway/logic/imap.js` 的 `testImapConnection` 与 `pollImapAccount` 中紧跟 `LOGIN` 之后补发 `await session.command('ID ("name" "SOLO-Gateway" "version" "1.0.0" "vendor" "SOLO")').catch(() => {})`，兼容网易系邮局（`163.com` / `126.com` / `yeah.net` / `qiye.163.com`）强制 `ID` 握手要求，同时对不支持 RFC 2971 的邮局静默容错。
  2. **建议 2（`core/user` `user.token.revoke` 对称开放受控服务机器人委派门禁）**：已在 `api/core/user/index.js` 将 `user.token.revoke` 切换为 `await assertAdminOrDelegated('user.token.revoke')`，并在 `api/core/user/logic/bot.js` (`revoke`) 中增加非 `admin` 委派调用方保护（禁止吊销 `system.*` 机器人、`admin` 或 `POWER=operator` 账号的会话令牌）。
  3. **建议 3（下游 bundle 仓运行 `api/library/tests/*` 兼容）**：已在 `api/library/tests/feedback-v133-convergence.test.js` 与 `api/library/tests/outbound-peer-ollama.test.js` 中增加 `HAS_SOLO_SOURCE_TREE` 探测守卫（当运行在 `solo` 源码仓时全量执行跨 `core/*` 与 `apps/storage/*` 的集成断言；当随 `upgrade.sh` 同步至下游 bundle 仓时自动跳过依赖未打包源码目录的區塊，同时保持 `api/library` 与上游 100% 字节级一致并通过 `check-upgrade-path.sh`）。
