# Spec · Passport identity-line convergence (device → upgrade → external), authority via bot account

> 状态：🟡 落地中（2026-06-30）。把**匿名 → 访客 → 注册 → 外部**整条身份线收敛到**一套 passport**，
> 权限走「passport.role/bot → 已配好权限的 bot account」的**路由**，而非每张 passport 单独配 permit。
> 与 [`spec-passport-self-issuance.md`](./spec-passport-self-issuance.md)（OTP 自助发证）同源、增量叠加。

## 1. 动机

公开面收敛后「人人有会话」。匿名怎么接？三种principals 各有定位：

| 主体 | 本质 | 给谁 |
|---|---|---|
| **passport** | per-visitor 身份（anchor + deviceToken），行隔离 | 匿名/访客/外部个体 —— 整条线 |
| **bot account** | 固定机器身份 + **预配 permit** | 权限模板（passport 路由到它） |
| **user** | 内部账号 | 员工/管理员 |

共享 guest-bot 的硬伤（已论证）：所有匿名collapse 成一个身份 → **匿名→注册丢状态**、**不同 client 不能按 role 区分**。
passport-for-everyone 解决这三点，代价是发证开销（实测很轻：sha256 + 几个 O(1) redis，一次性）+ 需补两件能力（device 模式、upgrade）。

## 2. 设计：三件事

### 2.1 Authority 路由 —— passport → bot account
passport 实体可绑 `bot`（bot account id）**或** `role`（现状，role store）。`verify`/`otpVerify`/`device.issue`
统一经 `resolveAuthority(entity, anchor)` 取 permit：
- **bot 路由**：读 `user:bot:{bot}`.permit（bot 永不 allow_all，create 期已 assert），注入
  `constraints.$owner = { field: ownerField, value: anchor }` → **行隔离到本 anchor**。不同 passport 绑不同 bot = 不同权限集。
- **role 路由**（现状不变）：`role.resolve(entity.role, anchor)`。
- **fail-closed**：解析出的 permit 必须含 `$owner.value`（bot 路由总注入；role 路由要求 role 有 ownerField），否则拒签 session（`-32603`）。

### 2.2 device 模式（TOFU，免 OTP）—— 匿名入口
新 issuance mode `device`。新 public 方法 `user.passport.device.issue`：
- 入参 `{ anchor(设备生成的稳定 id), app, name?, meta? }`。`anchor` = 客户端生成的 device UUID（**TOFU**：首次信任，无 email/手机可发码）。
- fail-closed：`issuanceMode(app) === 'device'` 才放行；否则 `FORBIDDEN`。
- 路由到 `defaultBotFor(app)`（或 `defaultRoleFor(app)`），`_provision` 写实体（绑 bot）+ 发 `deviceToken`/`deviceId`。
- 返回 `{ deviceToken, deviceId, anchor, bot }`。客户端存好 → 之后走 `passport.verify` 拿 session。
- **安全**：device token 是 bearer；anchor 客户端自选（碰撞是客户端自己的事）。**留项**：per-IP 请求级限流防批量造号（同 otp.request 的请求限流，本规格不阻塞）。

### 2.3 upgrade（device → email/手机）—— 匿名→注册不丢
新 public 方法 `user.passport.upgrade`：
- 入参 `{ anchor(device), deviceId, deviceToken, newAnchor, otp, channel?, name? }`。
- **双重证明**：① 验 device passport（`anchor`+`deviceId`+`deviceToken` 过 proof）→ 证明持有该设备；
  ② 验 `newAnchor` 归属（先 `otp.request(newAnchor)`，这里带 `otp`，复用 OTP 校验）→ 证明持有 email/手机。
- **迁移身份**：在 `newAnchor` 上 `_provision`（carry 原 device 实体的 `role`/`bot`/`meta`，记 `upgradedFrom: deviceAnchor`），发新 `deviceToken`；把 device passport 置 `DISABLED`（记 `upgradedTo`，吊销其 session，防重用）。
- **应用数据搬迁**：passport 只搬**身份**（role/bot/meta + upgradedFrom 标记）。业务行数据（`$owner=deviceAnchor` 的行）的 re-own 由应用侧按 `upgradedFrom` 自行改 `$owner` —— passport 不碰跨服务数据。
- 返回 `{ anchor: newAnchor, deviceToken, deviceId, role|bot }`；客户端用它 `verify` 拿注册态 session。

## 3. 配置（`config.passport`，全部 fail-closed / 默认关）

```
issuance.{default,byApp}          # 增 'device' 取值（closed|otp|pending|device）
defaultRole.{default,byApp}       # 现状
defaultBot.{default,byApp}        # 新：app → bot account id（路由目标，PASSPORT_DEFAULT_BOT_BYAPP）
ownerField                        # 新：bot 路由注入 $owner 的字段名，默认 'ownerId'（PASSPORT_OWNER_FIELD）
```

## 4. RPC 契约（新增，public）

| 方法 | 入参 | 返回 |
|---|---|---|
| `user.passport.device.issue` | `{ anchor, app, name?, meta? }` | `{ deviceToken, deviceId, anchor, bot? , role? }` |
| `user.passport.upgrade` | `{ anchor, deviceId, deviceToken, newAnchor, otp, channel?, name? }` | `{ anchor:newAnchor, deviceToken, deviceId, bot?|role?, upgradedFrom }` |

`verify`/`otpVerify` 不改签名，内部改走 `resolveAuthority`（bot 或 role）。声明↔注册同步红线照旧。

## 5. e2e（本地测试环境写入 bot account 数据）

`suites/113-passport-identity-line.e2e.test.js`（full profile）：
1. **seed**：admin `user.bot.create` 建一个带 permit 的 bot（如 `{ collection: ['collection.payment.list'] }`）。
2. **device.issue**（device 模式 app）→ `verify` → session：`kind:external`、permit = bot 的 services + `$owner=deviceAnchor`。
   - 调 bot 允许的方法 → 通；调不允许的 → `FORBIDDEN`（证明权限来自 bot）。
3. **upgrade**：`otp.request(email)` → `upgrade(device→email, otp)` → `verify(email)` → session 仍 = 同 bot 权限、`upgradedFrom=deviceAnchor`；device passport 已 `DISABLED`（旧 device token verify 被拒）。
4. fail-closed：device 模式未配 / 错 OTP / 缺 bot → 各自拒。

## 6. 迁移 / 兼容
纯增量：现有 role-routed passport 与 otp/pending 模式不变；bot 路由、device、upgrade 全是**新增、默认关**。
`resolveAuthority` 对没有 `bot` 字段的旧实体走原 `role.resolve` 路径，零行为变化。
