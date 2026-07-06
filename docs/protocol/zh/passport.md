# Solo Passport 协议 (Passport Protocol)

---

> **协议版本**: 1.2.0
> **状态**: 草案 (Draft)
> **作者**: Antigravity/Fuu
> **核心机制**: 加盐令牌安全 (Salted Token Security) + 自助注册 / 登录（OTP）

---

## 1. 摘要

本协议定义了一种针对"非登录用户（外部实体）"的安全访问机制。它允许微服务在不依赖中心化账户体系的前提下，为外部合作伙伴（如供应商、客户）提供具有审计性、可撤销且抗碰撞的安全访问凭证。

协议已收拢进 `user` 服务（方法前缀 `user.passport.*`），外部实体是一等可管理实体。对外用户的常规体验映射为**注册**（OTP 证明 Anchor 归属 → 颁发设备令牌）与**登录**（凭设备令牌换取 `kind:external` 受限会话）——见 §3.4–3.6。资料字段（用户名 / 手机 / 邮箱）只是"资料"，**OTP 验证才是"实名 / 可信"**。

## 2. 设计原语

### 2.1 参与者 (Actors)

- **Anchor (锚点)**: 外部实体的稳定唯一标识（如 `supply_id` 或 `notif_id`）。
- **Salt (私有盐)**: **仅存储在服务器端**，针对每个 Anchor 唯一生成的 16 字节随机字符串，**绝对不返回给客户端**。
- **Device Token (设备令牌)**: 服务端签发的强随机字符串（建议 32 字节 Base58），由客户端持有。
- **Device ID (设备标识)**: 由服务端在 OTP 验证成功时生成，返回客户端，用于标识一个已授权设备。客户端不得自报设备标识。
- **Proof (凭证)**: 服务端存储的哈希值：`sha256(deviceToken + salt)`，**仅在服务端计算和存储**。

### 2.2 核心理念

**"本地加盐，垂直验证"**：
Router 仅负责透传请求，具体的验证逻辑由拥有数据（及其对应 `Salt`）的微服务在本地执行。这保证了即使一个微服务的 Salt 泄露，也不会影响到系统中其他业务域的安全性。

Salt 是整个协议的安全基石，必须满足：
- 永不通过网络传输
- 永不写入日志
- 仅通过内存传递给 `computeProof()`

---

## 3. 标准流程 (Standard Workflow)

### 3.1 预认证识别 (Identification)

客户端通过公开链接访问系统，请求携带 `Anchor`。

- 服务端校验 `Anchor` 合法性。
- 返回 `{ status: 'identified' | 'pending_otp' }`，**不返回 Salt 或任何内部凭证**。
- 若需要设备授权，触发 OTP 挑战（如短信验证码）。

### 3.2 令牌颁发 (Issuance)

OTP 验证成功后（**锁定应打在 Anchor 上，不是设备上**）：

1. 服务端生成随机 `deviceToken`（32 字节 Base58）。
2. 服务端生成随机 `deviceId`（8 字节 Base58），作为此次设备授权的稳定标识。
3. 服务端调取该 Anchor 对应的 `Salt`（不离开服务端）。
4. 计算 `Proof = sha256(deviceToken + salt)`。
5. 将 `{ deviceId, proof, issuedAt }` 存入该 Anchor 的 Proof 白名单（Redis Hash/Set）。
6. 返回 `{ deviceToken, deviceId }` 给客户端，客户端存储在 `localStorage`。

> **为什么同时返回 deviceId？**
> `deviceId` 是稳定的设备标识，用于管理端显示"哪些设备已授权"、执行单设备撤销操作。`deviceToken` 是访问凭证，不应暴露给管理界面。

### 3.3 访问验证 (Verification)

后续业务请求（如 `supply.orders.list`）：

1. 客户端将 `deviceToken` 放入 **`X-Solo-Device-Token` 请求报头**，将 `Anchor` 和 `deviceId` 放入 `params`。
2. 微服务从报头读取 `deviceToken`，根据 `Anchor` 从 Redis 取出 `Salt`。
3. 在服务端重新计算：`tempProof = sha256(deviceToken + salt)`。
4. 在 Proof 白名单中查找是否存在 `tempProof`（Redis `SISMEMBER` 或 Hash 查找）。
5. 匹配成功则通过，同时校验 Proof 是否已过期；否则返回 `401 Unauthorized`。

> **为什么 deviceToken 用报头而非 params？**
> params 字段会被 WAL 日志、请求日志原样记录。`deviceToken` 等同于明文密码，记录在日志中会造成凭证泄露。报头通常不进入业务日志。

> **实现位置（与代码对齐）**：passport 不是独立微服务，已收拢进 `user` 服务（authority.md §4.1），方法前缀 `user.passport.*`，外部实体是一等可管理实体（与 `bot` 镜像）。底层令牌算法 + `verify`/`register` 已实现（`library/passport.js` + `user/logic/passport.js`）；§3.4–3.6 的自助注册 / OTP 投递为**待实现规格**（issuance 流程此前标记 deferred）。
>
> ⚠️ **现状与本规格的一处偏差**：§3.3 / §4.5 / §5 描述的"`deviceToken` 走 `X-Solo-Device-Token` 报头、禁入 params"是**目标硬化项，尚未实现**。当前 `user.passport.verify` / `register` 实际把 `deviceToken` 当 **JSON-RPC param** 收。**泄日志已止血**：`library/logger.js` 的 `redactSensitive` 在 `ERROR:QUEUE` 入队前对 deviceToken / 登录凭证打码（2026-06-06）；报头传输仍为后续硬化（BACKLOG §1.4），落地后可免入 params。

### 3.4 注册 / 登录 模型（对外用户自助接入）

§3.1–3.3 是底层令牌机制。从对外用户视角，它映射为两个常规动作 + 一个运维动作：

| 动作 | 协议含义 | 方法 |
|---|---|---|
| **注册**（首次接入 / 新设备） | 证明 Anchor 归属（OTP）→ 颁发设备令牌（§3.2）+ 建立 passport 实体 + 绑默认角色 | `user.passport.otp.request` → `user.passport.otp.verify` |
| **登录**（日常访问） | 凭已持有的设备令牌换取一个受限会话（§3.6） | `user.passport.verify` |
| **运维供给**（管理员代开） | 管理员直接建实体 + 指定角色 + 录入设备 | `user.passport.register`（permit-gated，已实现） |

要点：
- **anchor 是身份槽位**（邮箱 / 手机 / 钱包地址），**不是匿名**。让它"实名 / 可信"的是 **OTP 验证那一步**，不是填了多少资料字段。`username / phone / email` 等资料随实体的 `name` + `meta` 在注册时一并落库，但只有**经 OTP 验证过的联系方式**才可信——没验证的字段只是自称、可伪造。
- **自助注册不得由客户端自选权限**：`otp.verify` 成功后绑定一个**可配置的默认角色**（`config.passport.defaultRole`，如 `external`，给最小 permit），或落 `PENDING` 状态等管理员提权。角色始终绑在实体上，verify 从实体读取，永不信任客户端上报的 role。
- **登录后用会话、而非每次携带设备令牌**：见 §3.6。

### 3.5 OTP 申请与投递（通道抽象）

OTP 有两类机制，**投递方式根本不同**，实现时是两条并行的路：

**(a) 推送式 OTP（邮件 / 短信）——经 gateway 投递**

```
user.passport.otp.request({ anchor, channel })   // channel: 'email' | 'sms'
```

1. 服务端生成随机验证码，存**哈希 + 短 TTL**（建议 5 分钟）于 `USER:PASSPORT:OTP:{anchor}`（**绝不存明文**）。
2. 经 **gateway** 投递（§5：服务间不直连，走 Router RPC 或返回 `_tasks` 异步派发，参照 notification 的投递方式）：
   - `email` → `gateway.email.send`（需先配 SMTP 账户：`gateway.smtp.create`）
   - `sms`   → `gateway.sms.send`（需配短信 provider）
3. 用户回填 → `user.passport.otp.verify({ anchor, otp, channel, name?, meta? })`：比对哈希 + 未过期 + 未锁定（§4.4）→ 成功则执行 §3.2 颁发设备令牌、建实体、绑默认角色，并落库随表单提交的资料字段。

**(b) 验证器 / TOTP（Authenticator App）——本地校验，不经 gateway**

TOTP **没有"发送"动作**：服务端与 App 共享一个密钥，双方各自用「密钥 + 当前时间」算出同一个 6 位码。

```
user.passport.totp.enroll({ anchor })       // 生成密钥，返回 otpauth:// URL / 二维码（通常页面直接显示，仅此一次）
user.passport.totp.verify({ anchor, code }) // 服务端用存好的密钥本地算预期码 + 比对
```

- 密钥存 `USER:PASSPORT:TOTP:{anchor}`（服务端，保密级别等同 Salt）。
- **gateway 完全不参与 TOTP 校验**。

> 通道抽象只覆盖**推送式 OTP（email / sms → gateway）**；TOTP 是并行的、无 gateway 的本地机制。**不要把验证器塞进 gateway。**

### 3.6 外部会话（登录产物）

`user.passport.verify`（登录）校验设备令牌成功后，**不是逐请求携带令牌，而是签发一个受限会话**：

- 会话 `kind: 'external'`、短 TTL（实现为 24h），`permit` 由**实体绑定的角色**解析得到。**当且仅当**该角色定义了 `ownerField` 时，`constraints.$owner` 才锁到该 anchor（**行级隔离**：外部用户只能访问自己的数据）；未定义则**无**行级隔离——故默认外部角色**必须**带 `ownerField`（见 §3.7）。
- 之后业务请求走**标准 Router 会话鉴权**（携带会话 token），**不再每次携带设备令牌**——设备令牌只在登录 / 换会话时出现，降低泄露面。
- 停用实体（`user.passport.disable`）同时阻断后续 verify 并撤销其所有在线会话。

> 设备令牌 ≈ 长效"刷新凭证"（90 天，§4.3）；会话 ≈ 短效"访问凭证"（24h）。令牌过期或更换设备 → 重新走 §3.5 的 OTP 注册。

### 3.7 实现约束与安全清单（实现者必读）

§3.4–3.6 是草案骨架；落地前以下决策必须钉死，否则两人实现会不一致或留洞。

**OTP 码与存储**
- 码：**6 位纯数字**，`crypto.randomInt(0, 1_000_000)` 零填充到 6 位（熵约 20 bit——仅因 §4.4 限 3 次在线尝试才可接受）。
- 存储：`{ hash, attempts:0, expiresAt }`，`hash = sha256(otp + salt)`，salt **复用已有的 `PASSPORT:SALT:{anchor}`**（永不出网）；Redis TTL 300s。
- 比对：必须用 `crypto.timingSafeEqual` 比十六进制摘要（仓库目前无此调用，需新增）。
- **一次性**：首次命中即在签发令牌的同一 `MULTI/EXEC` 里 `DEL` 掉 OTP 键，杜绝重放；不命中**不删**（留 TTL 内重试）但 +1 计入 §4.4 锁。

**otp.request 自身限流 + 防枚举**（§4.4 只锁失败验证，挡不住这两条）
- **发送节流**（独立于失败锁）：每 anchor 如 1 条/60s、5 条/小时，键 `USER:PASSPORT:OTP_SEND:{anchor}`，防短信轰炸 / 费用滥用。
- otp.request **恒定返回** `{ status:'otp_sent' }`（响应体与耗时不随 anchor 是否存在而变）；未知 anchor 照走节流记账、静默不投递。**不要**用 §3.1 的 `identified/pending_otp` 枚举泄露存在性。

**成功路径的原子性**
- 单 `MULTI/EXEC`：`SET entity` + `SADD ids` + **`SET salt`（用 `SETNX`，避免并发覆盖——注意现 `register()` 是非原子 get+set，一并改）** + `HSET proof` + `DEL otp`；角色 permit 事务前只读解析，角色名事务内写实体；EXEC 成功后才返回 `{deviceToken, deviceId}`。
- 首次 vs 老用户新设备：首次建 salt+实体+绑默认角色；老用户**只加一条 proof，不动 role/salt**。

**默认角色（自助注册的越权风险——最关键）**
- `config.passport.defaultRole` **必填、无代码兜底**（未配则 otp.verify 报配置错拒绝，fail-closed）。
- 默认角色**必须** `scope:'external'`、**必须**定义 `ownerField`（使 `$owner` 行隔离非可选）、**禁止** `allow_all`；verify 时校验解析出的 permit 含 `constraints.$owner`，否则**拒签会话**（fail-closed）。
- ACTIVE vs PENDING **二选一钉死**：要么自助即 ACTIVE（挂锁死的 external 角色），要么落 PENDING 且扩展 `verify()` 支持降级会话——别两可（现 `verify()` 只认 `status==='ACTIVE'`）。

**TOTP enroll 授权**
- `totp.enroll` 必须授权：要么在**已认证的 external 会话**内调用（先经 §3.5(a)/§3.6 证明 anchor），要么**两步确认**（enroll 写"待确认"槽，首个 `totp.verify` 才提升为正式）；**禁止**在无新鲜所有权证明下覆盖已确认的密钥（否则知道 anchor 即可接管账号）。

**gateway 投递接线**
- passport 工厂现为 `createPassportLogic(redis, config, { role })`，**没有 relay/gateway 客户端**；需注入（参照 notification 的 relay）并调 `gateway.email.send({to, subject, html/text})` / `gateway.sms.send({to, text})`；**user 服务自身 permit 要放行这两个方法**（否则 checkAccess 拦）。OTP 宜走**同步 relay RPC**（投递失败即时反馈），而非 `_tasks` 队列。

**anchor 与通道映射**
- §3.4 允许钱包地址做 anchor，但 §3.5(a) 只有 email/sms。要么把"身份 anchor"与"投递地址"解耦（otp.request 额外收 `deliveryAddress`，校验与 channel 匹配），要么明确**钱包类 anchor 不走 v1.2 推送 OTP**（改走钱包签名挑战），别留空。

**admin register vs 自助 otp.verify 共存**
- 自助路径**不得**改写已存在实体的 role/app（只加 proof）；绑默认角色**仅**在新建实体时；salt 统一 `SETNX`。指定非默认角色只能走 admin `register`。

---

## 4. 安全管理 (Security Management)

### 4.1 Salt 轮转 (Salt Rotation) — 待实现

> ⚠️ 当前未注册 `user.passport.rotate` 或等价方法；本节为目标规格。

当发生安全事故或人员离职时，管理员可以执行 **Rotate Salt** 操作：

1. 为该 Anchor 生成全新的随机 `Salt`。
2. **原子操作**：在同一 `MULTI/EXEC` 事务中，删除旧 Proof 白名单（`DEL`）并写入新 Salt。
3. 所有已授权设备立即失效，必须重新进行 OTP 验证。

> **为什么要原子删除旧 Proof？**
> 仅替换 Salt 而不清理旧 Proof Set 会导致 Redis 中死数据持续堆积。旧 Proof 永远无法匹配（Salt 已变），但不会自动消失，需要显式 `DEL`。

### 4.2 令牌撤销 (Revocation)

> 现状：仅实现**整主体停用** `user.passport.disable`（置 DISABLED + 撤销在线会话，但**不**清除 `PASSPORT:PROOFS` 里的单条设备 proof）。下面的**单设备撤销**为待实现（需新增 `user.passport.device.revoke` 类方法；`get` 已能列设备 id）。

支持单设备撤销（待实现）：

1. 管理端列出该 Anchor 的所有已授权设备（`deviceId` 列表）。
2. 选择特定 `deviceId`，从 Proof 白名单中删除对应的 Proof 记录。
3. 该设备的 `deviceToken` 立即失效（下次请求计算出的 Proof 找不到匹配项）。

### 4.3 Proof 过期机制 (Expiration)

颁发 Proof 时记录 `issuedAt` 时间戳。建议过期时间 **90 天**，可由各微服务在 `config.js` 中配置。

验证阶段额外检查：

```js
if (Date.now() - proof.issuedAt > config.passport.tokenTtl) {
    // Proof 已过期，要求重新认证
    return res.status(401).json({ error: 'TOKEN_EXPIRED' });
}
```

超期设备须重新通过 OTP 挑战获取新 Token。

### 4.4 OTP 防爆力 (Brute-force Protection)

OTP 失败次数锁定必须打在 **Anchor（notificationId 或 supply_id）** 上，而非设备上：

- 理由：设备标识（deviceId）由客户端持有，攻击者可无限更换设备标识绕过设备级锁定。
- 正确策略：同一 Anchor 累计失败 3 次，锁定该 Anchor 的 OTP 功能 24 小时。

```
USER:PASSPORT:OTP_LOCK:{anchor}  →  { attempts: 3, lockedUntil: timestamp }
```

### 4.5 传输规范

- **强制 HTTPS**：`deviceToken` 在传输中等同于明文密码，必须通过加密链路传输。
- **报头传输（目标，待实现）**：`deviceToken` 应通过 `X-Solo-Device-Token` 报头传输，**禁止放入 JSON-RPC params**，防止被业务日志和 WAL 日志记录。⚠️ 当前实现仍把 deviceToken 放 params（见 §3.3 注）；泄漏已由 `library/logger.js` 的 `redactSensitive` 在 ERROR:QUEUE 入队前脱敏止血，报头传输作为后续硬化（BACKLOG §1.4）。
- **Anchor 与 deviceId 可放 params**：这两个字段不是秘密，放 params 可接受。

---

## 5. 实现建议 (Implementation)

微服务应使用核心库提供的 `Passport` 辅助类，确保算法一致性：

```javascript
// 颁发令牌（OTP 验证成功后）
const deviceToken = Passport.issueToken(32);          // 32 字节 Base58
const deviceId = Passport.issueToken(8);              // 8 字节 Base58，稳定标识
const proof = Passport.computeProof(deviceToken, salt); // sha256(token+salt)

// 存入白名单（Redis Hash，key = deviceId）
await redis.hSet(`PASSPORT:PROOFS:{anchor}`, deviceId, JSON.stringify({
    proof,
    issuedAt: Date.now()
}));

// 验证请求（从报头读取 deviceToken，从 params 读取 deviceId）
const deviceToken = req.headers['x-solo-device-token'];
const { deviceId, notificationId } = params;

const proofEntry = await redis.hGet(`PASSPORT:PROOFS:{anchor}`, deviceId);
if (!proofEntry) return unauthorized();

const { proof: storedProof, issuedAt } = JSON.parse(proofEntry);
if (Date.now() - issuedAt > config.passport.tokenTtl) return tokenExpired();
if (!Passport.verify(deviceToken, salt, [storedProof])) return unauthorized();
```

---

## 6. 数据结构

```
# 实体与索引（user 服务）
USER:PASSPORT:{anchor}          →  Redis String(JSON)  { id:anchor, role, app, name, meta, status, createdAt, updatedAt }
USER:PASSPORT:IDS               →  Redis Set           所有 anchor（供 list）

# 凭证（服务端机密，永不出网）
PASSPORT:SALT:{anchor}          →  Redis String        16 字节 hex salt
PASSPORT:PROOFS:{anchor}        →  Redis Hash          field=deviceId, value={ proof, issuedAt }（多设备）

# 会话（登录产物，§3.6）
session:{token}                 →  Redis String(JSON)  kind:external 会话，TTL 24h（前缀小写）
USER:SESSIONS:{anchor}          →  Redis Set           该 anchor 的在线会话 token（供撤销）

# 自助注册 / OTP（待实现，§3.5）
USER:PASSPORT:OTP:{anchor}      →  Redis String        验证码哈希 + TTL（建议 5 分钟）
USER:PASSPORT:OTP_LOCK:{anchor} →  Redis String        { attempts, lockedUntil }（TTL 24h，§4.4）
USER:PASSPORT:TOTP:{anchor}     →  Redis String        验证器共享密钥（服务端机密）
```

---

## 7. 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-03-xx | 初版 |
| 1.1.0 | 2026-04-14 | 修复 Salt 泄露设计矛盾；OTP 锁定改为 Anchor 级；deviceId 改为服务端签发；增加 Proof 过期机制；deviceToken 改为报头传输；Salt 轮转增加原子清理旧 Proof 要求 |
| 1.2.0 | 2026-06-06 | 补充注册 / 登录模型（§3.4）、自助 OTP 投递与通道抽象（§3.5：email/sms→gateway，TOTP 本地不经 gateway）、外部会话（§3.6）、**实现约束与安全清单（§3.7）**；对齐实现位置（user 服务 `user.passport.*`）+ 数据结构补全。经对照审查校正现状偏差：deviceToken 当前走 params 非报头（§3.3/§4.5 标注待硬化）、session 键小写、Salt 轮转（§4.1）与单设备撤销（§4.2）标注未实现、$owner 行隔离改为有条件（依赖角色 ownerField，§3.6） |
