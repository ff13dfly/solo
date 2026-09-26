# 普通用户的登录会话在 `user.token.revoke`、账号软删、账号硬删之后都还能用

- **来源**：steward，2026-09-25，给「探路者 API」（外部 AI 拿一个受限 user 账号驱动已登录浏览器）跑
  cloudflare/security-audit-skill 时，由 hunter 发现、两名独立验证者复核。
  完整记录：`~/security-audit-skill/steward/run-1/NEEDS-VALIDATION.md`，指纹
  `solo/user.loginVerify:session-unindexed-and-router-skips-user-status`。
- **场景**：发给外部系统 / 外部 AI 的 user 账号泄露或失控，运维想「立刻停掉这个号」。
- **依据分类**：**全部为源码推导，未实测**。审计在 source-only 模式下跑（本机凑不齐沙箱，目标代码一行未执行），
  所以下面每一条都是读 `api/publish/solo.v1.2.14.js`（v1.2.14）得出的，
  审计给的裁决是 `needs_validation`，不是 confirmed。**请先按文末的本地验证方法坐实，再定处理。**
- **级别（若坐实）**：静默——吊销接口正常返回，只是 `revoked: 0`；被删的号照样调得通。

## 源码推导的现象

| 运维动作 | 预期 | 按源码推导的实际 |
|---|---|---|
| `user.token.revoke { uid }`（自省描述：「Revoke all live session tokens of a uid」） | 该 uid 的全部会话失效 | 返回 `revoked: 0`，会话照常 |
| `user.account.remove`（软删，status → DELETED） | 该号不能再用 | 会话照常，且**权限完整** |
| `user.account.destroy`（硬删 `user:<uid>`） | 该号不能再用 | 会话照常，退回用**登录时快照**的权限 |

唯一能即时掐断的是 `user.permit.update` 把 permit 清空——Router 每次请求都会重读 `user:<uid>.permit`。

## 根因（行号为 v1.2.14 bundle）

1. **普通用户的会话没有按 uid 建反向索引**：`loginVerify` 用 `setEx session:<token>` 存 7 天（`:77735-77747`），
   会话里带登录时的 permit 快照（`:77741`），但**不** `sAdd USER:SESSIONS:{uid}`。
   只有机器人的 `persistSession` 会写这个索引（`:78980-78986`）。
2. **吊销只看那个索引**：`user.token.revoke` → `killSessions` 读 `USER:SESSIONS:{uid}`（`:79101-79117`、`:79167-79179`）
   ⇒ 对普通用户永远是空集。
3. **Router 只对机器人检查账号状态**：`resolveSessionUser` 对非 `system.*` 的 uid，存在 `user:<uid>` 就拷它的 permit、
   **不看 status**（`:44550-44556`）；status 闸门只在机器人分支（`:44563-44569`）。记录不存在时保留会话里的快照 permit。
4. `account.remove`（`:78019-78036`）/ `account.destroy`（`:77815-77828`）只改用户记录，不碰 `session:*`。
5. 小变体：`loginRequest` 查了 DELETED，`loginVerify` 没查，删号前 120 秒内拿到的挑战仍能换出 token。

## 为什么值得修

「一个外部系统一个号，丢一个只停一家」是多个派生项目发号脚本写在注释里的前提（steward
`deploy/provision-users.js`、finance 的协作者账号同理），而运维的直觉动作正是删号或吊销。
这两个动作都**不报错、不生效**，失控的 token 还能用满 7 天。

## 建议（按价值排序）

1. `loginVerify` 与机器人同样写 `USER:SESSIONS:{uid}`（带 TTL 或按会话过期清理），让 `user.token.revoke` 对普通用户生效。
2. `resolveSessionUser` 对普通用户同样检查 status：非 ACTIVE 或记录不存在 ⇒ 拒绝，而不是退回快照 permit。
3. `account.remove` / `account.destroy` 顺带调用 `killSessions`。
4. `loginVerify` 同样检查 DELETED。

## 本地验证方法（在隔离的 dummy 栈里跑，别动线上账号）

注册 dummy 用户 → 设一个窄 permit → 登录拿 token T →
1. admin `user.token.revoke {uid}`，预期 `revoked: 0`；用 T 调一个有权限的方法，预期仍成功；
2. 分别在 `account.remove`、`account.destroy` 之后重复，预期仍成功；
3. 对照组：`user.permit.update` 把 permit 清空，预期下一次调用 `-32005`。

线上只做只读观察：对某个仍在用的普通用户，`EXISTS USER:SESSIONS:<uid>` 为 0，
而 `SCAN session:*` 能看到它的会话。

## 处理结论

**2026-09-26 · 与 `done/account-deletion-does-not-revoke-live-sessions.md`（catalog，2026-09-21）是同一个洞，
按重复归档；4 条建议全部已落地。**

两家在 v1.2.14 的 bundle 上各自独立审出了同一处：catalog 那篇 09-22 已在真栈上双向复现并修完
（`4a89cb7`，随 v1.2.16 发布）。本篇的根因 1–4 与那篇 §一 逐条对应，行号换算到源码后一致，没有夸大。

| 本篇建议 | 落地 |
|---|---|
| 1 `loginVerify` 写 `USER:SESSIONS:{uid}` | `4a89cb7`：人类登录改走共用的 `logic/sessions.js` `persistSession` |
| 2 `resolveSessionUser` 对普通用户查 status | `4a89cb7`：Router 人类分支补 status 闸 + 硬删闸（与 bot 分支对称，passport 按 `type:'external'` 排除） |
| 3 删号顺带 `killSessions` | `4a89cb7`：`account.remove` / `destroy` 返回 `revoked` |
| 4 `loginVerify` 检查 `DELETED` | **那篇没覆盖，本篇独有**。已实测坐实（先 request、再软删、再 verify ⇒ 照样发 token）。有 Router 闸兜底，发出的 token 会解析成 guest、不可利用，但会作为活 session 挂在索引里直到 TTL。随 `user-login-challenge-one-slot-per-name.md` 一并修（同一个函数） |

**steward 侧**：v1.2.16 之前，唯一即时有效的应急手段仍是 `user.permit.update` 把 permit 清空（本篇原文已指出）。
升到 v1.2.16 后 `user.token.revoke` / 删号即生效，且对升级前就已发出的 token 同样有效（Router 闸无状态、追溯生效）。
