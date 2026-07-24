# user 服务任务配方

> 由 fleet-standard `guide` 方法下发（经 Router：`system.guide { service: "user" }`）。
> 与服务代码同目录、同 commit 更新。方法签名与参数约束以 `methods` 自省为准，
> 本文只讲自省说不出的**任务流程与语义**。

## 这是什么

系统的账号与身份中枢：内部用户账号（SHA-256 挑战-响应登录）、Session、
权限（permit / role 模板）、以及**外部主体 passport 身份线**（设备令牌 → 升级到邮箱/手机锚）。
只管"人/主体"，不含业务逻辑。

> **注册 + 登录的完整配方（含 salt/hash 派生坑 + 可拷贝代码）不在这里**——见匿名
> `system.guide`（无参）返回的 **§2b**。本文只讲**登录之后**的能力。

## 配方一：认识自己（别用 user.profile 查自己）

- 登录回执 `user.login.verify` 已直接带回 `permit` **和** `categories`——读自己的权限/等级
  用登录回执即可，**不要再调 `user.profile`**。
- `user.profile` 是 **permit-gated**：读**别人**的档案需要显式 grant；拿它查自己会被挡。
- 系统有**两条互相独立**的权限轴（代码里 `role.assign` 注释明确，最容易混）：
  - **RBAC 轴** = `user.role` + `user.permit`（`{ allow_all, services, constraints }`）——决定能调哪些方法、看哪些行。
  - **TIER 轴** = `categories.POWER`（admin/operator/normal）——决定 portal 访问与 session 策略。
  - `user.role.assign` 只动 RBAC，**绝不碰** `categories.POWER`；改等级走 `user.account.update` 的 `categories`。

## 配方二：给用户配权限（RBAC，admin/permit-gated）

模板优先，别手搓 permit 对象：

1. 定义角色模板：`user.role.set { role, services, ownerField?, scope? }` — 命名的 permit 模板。
   - `scope:'external'` 的角色**必须**给 `ownerField`（行隔离 `$owner`），否则 `-32602`。
   - `set` 是整体覆盖 `constraints`——更新外部角色时要**重新带上** `ownerField`，否则会静默丢掉隔离。
2. 物化到内部用户：`user.role.assign { uid, role }` — 把模板 permit **拷贝**进 `user.permit`。
   是物化不是运行时解析：**改了 role 模板，得对每个用户重新 assign 才生效**。
3. 个别用户例外：`user.permit.update { uid, permit }` — `permit` 结构须 `{ allow_all:boolean, services:object }`，否则 `-32602`。

**幂等**：set / assign / update 都是覆盖写，重跑安全。查权限用 `user.permit.get { uid }`（会把 legacy 字符串 permit 归一成对象）。

## 配方三：外部主体身份线（passport：设备 → 升级）

面向"先匿名用、之后再绑邮箱/手机"的外部端。三段均 **public**，但受 `config.passport.issuance`
**fail-closed** 门控（缺省 `closed` = 全拒；要 `device` / `otp` / `pending` 模式才放行）：

1. 设备签发（TOFU，无 OTP）：`user.passport.device.issue { anchor, app }` → `{ deviceToken, deviceId }`。
   `anchor` 由设备自己生成；需 `issuance=device`。
2. 换会话：`user.passport.verify { anchor, deviceId, deviceToken }` → 受限 session（24h）。
   权限来自**实体绑定**的 bot/role，**绝不信客户端传的 role**；且必须行隔离（`$owner`），否则服务端拒发（`INTERNAL_ERROR`）。
3. 升级到邮箱/手机锚：先 `user.passport.otp.request { anchor:<新锚>, channel }` 拿 OTP，
   再 `user.passport.upgrade { anchor:<旧设备锚>, deviceId, deviceToken, newAnchor, otp }`
   —— 需**同时**握有设备证明 + 新锚 OTP。成功后旧锚置 `DISABLED`（记 `upgradedTo`），
   身份（role/bot/meta）迁到新锚并发新设备令牌。

**次序 / 幂等**：OTP 一次性消费，验证成功即删；错次累加到上限触发锁定；`otp.request`
有每锚固定窗口限流，超了抛 `-32029`（带 `retry_after`）。`upgrade` 前必须先 `otp.request`。

## 坑与约定

- **软删**：`user.account.remove` 置 `status='DELETED'` 保留记录、排除出默认 list；`user.account.restore` 复活。
  永久删不可逆：先 `user.account.check` 再 `user.account.destroy`。`DELETED` 账号无法登录。
- **时间**：`createdAt/updatedAt/last/deletedAt` 都是 **ISO-8601 字符串**（唯一例外：category item 的 `createdAt` 是毫秒数字）。
- **登录 handle 存在 `name` 字段，没有 `username`**——profile 里找不到 `username`（旧自省曾骗人）。
- **敏感字段** `salt`/`hash` 永不下发（profile / list 已剥离）；`user.hash` 服务端不透明，只做哈希比对。
- **签名审批**（approval 消费者）：`user.key.generate { password }` 先建密钥，再 `user.key.sign { digest, password }`
  自签——**严格 self-only**（admin 也不能替签），私钥用密码派生加密、密码从不落库；`sign` 有每 uid 限流。
- **限流**统一错误码 `-32029`，退避重跑。批量操作串行或小并发。
- 外键命名 `{targetService}Id`。`meta` / `categories` 走**浅合并**（`user.account.update`），不是整体替换。
- 本服务满足不了你的任务时，把缺口提到 `system.report`（用法见 Router guide §6），不要静默绕野路子。
