# 落地规格 · Passport 自助发证（OTP issuance）+ 公开面收敛

> **状态**：✅ **第一阶段已实现（2026-06-30）** —— §10 步骤 1–4 落地（OTP 自助发证 + per-app 策略 + relay 接线 + `storage.asset.multi` 公开面收敛），过 hermetic（`core/user/tests/passport-otp.test.js`）+ e2e（`e2e/suites/111-passport-self-issuance`）。剩：请求级限流 / TOTP / 报头硬化 / `agent.chat` 收窄（产品决定）。**版本归属**：拉回 **v1.1.x**（原 §1.4 倾向 v2）——理由见 §0。
> **纪律**：默认 `closed` = 完全等于现状，**只加不破**，符合阶段一（[`VERSION.md`](./VERSION.md) §5.3）。
> **权威基准**：协议 [`docs/protocol/zh/passport.md`](../protocol/zh/passport.md) §3.4–3.7、本台账 [`BACKLOG.md`](./BACKLOG.md) §1.4。
> **校对基准**：2026-06-30。代码锚点均带 file:line。

---

## 0. 为什么进 v1（不是 v2）

这一档原本在出版清单（VERSION.md §4「passport 自助注册 OTP/TOTP」）。**拉回 v1 的唯一理由：它是"公开方法收敛"的前置依赖。**

现状（生产）免会话可达的 RPC 已经很窄——`access.js:36-44` 在非 debug 下拒绝所有 discovery 方法。残留的匿名面只有 `agent.chat`（`system.js:33` `public:true`，开放 LLM 端点）、`storage.asset.multi`（`system.js:42`）、`user.passport.verify`（capMap public）、`ping`、`GET /publickey`。

要把 `agent.chat` / `storage.asset.multi` 也挪到会话之后（消除匿名 LLM/资产面），就必须先有一条**"访客首触即能拿到一个最小会话"**的自助通道——否则等于要求人工给每个访客开户（VERSION.md §2「手工发证」）。**自助发证存在 → 公开面才能收敛到 `{发证, 登录, 健康, 公钥}`。** 这是安全收益，且实现是 per-app opt-in 的纯增量，故进 v1.1.x。

---

## 1. 范围

**入档（本规格）**
1. `config.passport` 新增 **per-app 发证策略**（`issuance` + `defaultRole`，fail-closed）。
2. 新方法 `user.passport.otp.request` / `user.passport.otp.verify`（推送式 OTP，经 gateway）。
3. passport 工厂注入 `relay`（现 `(redisClient, config, {role})` → 加 `relay`），打通 §1.4「接线缺口」。
4. 安全不变量：防枚举、限流、OTP 哈希+TTL、anchor 锁定、MULTI 原子、role 永远从实体读。
5. **公开面收敛**（第二阶段，需 router 授权）：`agent.chat`/`storage.asset.multi` 翻 `public:false`。

**出档（留后续 / v2）**
- **TOTP**（passport.md §3.5(b)）——本地校验、不经 gateway，作为 §6 的可选第二档，**不阻塞本规格**。
- **报头硬化** `X-Solo-Device-Token`（passport.md §3.3 偏差）——deviceToken 改走报头免入 params；日志已脱敏止血，留 BACKLOG §1.4。
- **真实 SMS provider**——SMS 投递已按 gateway 的**模板契约**接好（`{phone,templateId,variables}` → §4.1.4），但具体 provider（Aliyun/Twilio 凭证 + 已审模板）是部署方配置，gateway `logic/sms.js` 的 `resolveChannel→sendXxx` 多渠道结构早已存在；本规格只调，不实现 provider。

---

## 2. 现有代码锚点（实现以此为准，勿臆造）

| 件 | 位置 | 现状 |
|---|---|---|
| Token 原语 | `api/library/passport.js` | `issueToken(32)` / `issueDeviceId(8)` / `createSalt()` / `createProofEntry(token,salt)` / `verify(token,salt,entry,ttl)` —— **齐备，直接复用** |
| passport 工厂 | `api/core/user/logic/passport.js` | `(redisClient, config, {role})`；有 `register/list/get/disable/verify`。`register` **要外部传 `deviceToken`**（admin 供给档）；`verify` 已 **fail-closed 行隔离**（`:125-127`，role 无 `$owner` → 拒发会话） |
| Redis key | `api/core/user/config.js:40-44` | `redis.passport.{prefix=USER:PASSPORT:, idsSet=USER:PASSPORT:IDS, saltPrefix=PASSPORT:SALT:, proofPrefix=PASSPORT:PROOFS:}` |
| 方法注册 | `api/core/user/index.js:222-227` | `register/list/get/disable` permit-gated；`verify` public（capMap `public:true`） |
| 角色/permit | `role.resolve(roleName, anchor)` | 把 role 物化成 permit，`$owner` scoped 到 anchor（行隔离） |
| 发信 | gateway `gateway.email.send` / `gateway.sms.send`（`core/gateway`，`logic/email.js`、`logic/sms.js`） | 已存在，本规格 relay 调用 |

> **核心观察**：自助 `otp.verify` ≈ `register()` 的"自助变体"——区别是 ① 由 OTP 证明 anchor 归属（而非 admin 权限）② **服务端生成 deviceToken**（而非外部传入）③ role = `defaultRole`（而非客户端指定）。**抽出共享内部 `_provision()`，admin-register 与 otp-verify 都调它**，避免两套实体落库逻辑漂移。

---

## 3. 控制参数（per-app 发证策略，fail-closed）

`api/core/user/config.js` 的 `passport` 块新增（**不改现有 key**）：

```js
passport: {
  prefix: 'USER:PASSPORT:', idsSet: 'USER:PASSPORT:IDS',
  saltPrefix: 'PASSPORT:SALT:', proofPrefix: 'PASSPORT:PROOFS:',

  // ── 新增 ────────────────────────────────────────────────
  otpPrefix: 'USER:PASSPORT:OTP:',     // OTP 挑战（哈希 + TTL）
  lockPrefix: 'USER:PASSPORT:LOCK:',   // anchor 锁定

  // 发证模式：按 app 决定。缺省 = closed（fail-closed，= 现状，纯增量）
  issuance: {
    default: 'closed',                 // 'closed' | 'otp' | 'pending'
    byApp: { /* 'myapp': 'otp' */ },
  },
  // 自助发证绑定的默认角色：必须是已存在且行隔离（带 $owner）的角色，否则发证拒绝
  defaultRole: {
    default: null,                     // null = 即使 issuance 开了也不发（双保险）
    byApp: { /* 'myapp': 'external' */ },
  },
  otp: {
    codeLen: 6, ttlSec: 300,           // 6 位、5 分钟
    maxAttempts: 5, lockoutSec: 900,   // 5 次错 → 锁 15 分钟（锁打在 anchor 上）
    requestRateLimit: { perAnchorPerHour: 5, perIpPerHour: 20 },
  },
},
```

**三条铁律（passport.md §3.4 / §3.7）**
1. **fail-closed**：`issuance(app)` 缺省 `closed`；`defaultRole(app)` 缺省 `null`。两者都显式配了才发证。
2. **defaultRole 必须行隔离**：发证前 `role.resolve(defaultRole, anchor)` 必须有 `$owner`，否则 `INTERNAL_ERROR`、不发证（与 `passport.js:125-127` 同一道防线，提前到发证期）。
3. **role 绑实体、不信客户端**：客户端**永远不能**传 role；`otp.verify` 只认 `defaultRole`。

`mode='pending'`：OTP 通过后建实体落 `PENDING`、不绑 role、不发 deviceToken，返回 `{status:'pending_review'}`，等 admin `register`/提权。给"要人审"的 app。

---

## 4. 新 RPC 契约

### 4.1 `user.passport.otp.request` — 申请验证码（**public**）

```
params:  { anchor: string(req, ≤128), channel: 'email'|'sms'(req), app: string(≤64) }
returns: { status: 'pending_otp' }      // 恒定形状，见防枚举
```
流程：
1. `mode = issuance(app)`。`mode==='closed'` → `FORBIDDEN('self-service issuance disabled for app')`（**与 anchor 无关**，不泄露 anchor 是否存在）。
2. 限流：`otp.requestRateLimit`（per-anchor + per-IP）。超 → `-32605 RATE_LIMITED`。
3. 生成 `code`（codeLen 位数字）；存 `USER:PASSPORT:OTP:{anchor}` = `{ hash: sha256(code+anchorSalt-or-pepper), channel, app, expiresAt, attempts:0 }`，`EX ttlSec`。**绝不存明文。**
4. 按 channel 投递（best-effort，失败也返回同样的 `pending_otp`，不泄露通道有效性）：
   - `email` → `relay.call('gateway.email.send', { to: anchor, subject, content })`（自由文本，gateway 直收）。
   - `sms` → **模板制**（Aliyun TemplateCode / Twilio ContentSid 拒自由文本）：`relay.call('gateway.sms.send', { phone: anchor, templateId: config.passport.otp.smsTemplateId, variables: { code, ttl } })`。**未配 `smsTemplateId` → SMS 通道空转**（fail-soft，无模板不发），部署方需先 `gateway.sms.template.create` 建 OTP 模板并把 id 填进配置。
5. **防枚举**：无论 anchor 是否已是 passport 实体，返回**完全一致**的 `{status:'pending_otp'}`，耗时也尽量一致。

### 4.2 `user.passport.otp.verify` — 验码 + 发证（**public**）

```
params:  { anchor: string(req), otp: string(req), channel: string, app: string(≤64),
           name?: string(≤128), meta?: object, deviceName?: string(≤64) }
returns: { deviceToken: string, deviceId: string, anchor: string, role: string }   // mode='otp'
       | { status: 'pending_review', anchor: string }                              // mode='pending'
```
流程：
1. `mode = issuance(app)`；`closed` → FORBIDDEN。
2. 取 `USER:PASSPORT:OTP:{anchor}`；不存在/过期 → `UNAUTHORIZED`。检查 `attempts < maxAttempts`，否则置 `USER:PASSPORT:LOCK:{anchor}`（`EX lockoutSec`）+ `UNAUTHORIZED`。
3. 比对 hash。**不匹配** → `attempts++`（写回，保留 TTL）→ `UNAUTHORIZED`。匹配 → **删除 OTP 记录（一次性）**。
4. `mode==='pending'` → `_provision(anchor, role=null, app, name, meta, status='PENDING')` → 返回 `{status:'pending_review', anchor}`。
5. `mode==='otp'`：
   - `roleName = defaultRole(app)`；`null` → `INTERNAL_ERROR('no defaultRole configured')`。
   - **fail-closed 行隔离预检**：`permit = role.resolve(roleName, anchor)`；`permit.constraints?.$owner?.value === undefined` → `INTERNAL_ERROR(...not row-isolated...)`。
   - `deviceToken = Passport.issueToken(32)`；`deviceId = Passport.issueDeviceId(8)`。
   - `_provision(anchor, roleName, app, name, meta, deviceId, deviceToken, status='ACTIVE')`（建实体 + salt + proof，**MULTI 原子**，复用 register 的落库逻辑）。
   - 返回 `{ deviceToken, deviceId, anchor, role: roleName }`（**deviceToken 仅此一次**，客户端存 localStorage）。
6. 之后日常登录走**已实现的** `user.passport.verify({anchor, deviceId, deviceToken})`（public）→ `kind:external` 受限会话。

> 注：`_provision` = 现 `register()`（`passport.js:42-63`）抽公因子。admin `register` 仍要求外部传 `deviceToken`（保持兼容）；`otp.verify` 走服务端生成那条。

---

## 5. 状态机 + Redis key 一览

```
访客 ──otp.request──▶ [OTP pending]  USER:PASSPORT:OTP:{anchor}  (hash, TTL 5m, attempts)
        │                 │
        │ 错 maxAttempts   ▼
        │            USER:PASSPORT:LOCK:{anchor} (EX 15m)
        ▼
   otp.verify(otp) ──ok──▶ [Provision]
                              ├ mode=otp     → 实体 ACTIVE + salt + proof + 返回 deviceToken
                              └ mode=pending → 实体 PENDING（无 role/无 token）等 admin
                                   │
                                   ▼
   日常: passport.verify(anchor,deviceId,deviceToken) ──▶ kind:external 受限会话 (SESSION:{token})
```
新增 key：`USER:PASSPORT:OTP:{anchor}`、`USER:PASSPORT:LOCK:{anchor}`。其余沿用 `passport.js` 既有（实体/salt/proof/session）。

---

## 6. 接线（gateway relay 注入）

§1.4「接线缺口」：passport 工厂没有 relay → 现在发不了 OTP。

1. **工厂签名**：`module.exports = (redisClient, config, { role, relay }) => {...}`。
2. **user/index.js 构造时注入** user 自己的 relay 客户端（仿 notification：`library/relay.js` + user 的 bot token 自刷新，`user/index.js:198` 已有 token self-refresh 钩子）。
3. **user permit 放行** `gateway.email.send` / `gateway.sms.send`（user 服务对 gateway 的最小调用权）。
4. relay 不可用（无 token / gateway 离线）→ `otp.request` 仍返回 `pending_otp`，但记审计 + 不发码（fail-soft 对客户端、fail-closed 对发证：没收到码就验不过）。

> passport 在 `core/user`、**不在 router**，§1–§6 全部可正常改，无需 router 授权。

---

## 7. 公开面收敛（第二阶段，**需 router 授权**）

自助通道就绪后，把残留匿名面挪到会话之后：

| 改动 | 文件 | 授权 |
|---|---|---|
| `agent.chat` `public:true → false` | `api/router/logic/system.js:33` | ⛔ router，需用户明确授权 |
| `storage.asset.multi` `public:true → false` | `api/router/logic/system.js:42` | ⛔ router，需用户明确授权 |

收敛后**生产匿名 RPC 面** = `{ user.passport.otp.request, user.passport.otp.verify, user.passport.verify, ping }` + `GET /publickey` + 内部账号挑战-响应登录。discovery 早已 debug-gated。**防御全部压到 `otp.request`/登录这一个语义清楚、可重点加固的入口。**

> ⚠️ 是否保留 `agent.chat` 匿名 = **产品决定**（有无"公开未登录聊天"UX）。无则翻；有则保留并对它单独限流。规格不替你拍，列为 §9 开放项。

---

## 8. 测试计划（hermetic，仿 `core/ingress/tests/ingest.test.js` 依赖注入）

注入假 `relay`（捕获 send）+ 假 `role`（可控 `resolve` 返回带/不带 `$owner` 的 permit）+ mock redis：
- `otp.request`：`closed`→FORBIDDEN；`otp`→存 hash+TTL、调一次 relay.send、**存在 vs 新 anchor 返回完全一致**（防枚举断言）；限流触发。
- `otp.verify`：错码→attempts++、UNAUTHORIZED；过期→UNAUTHORIZED；连错 maxAttempts→落 LOCK；成功→发 deviceToken + 建实体 + 绑 defaultRole + 删 OTP；**defaultRole 无 `$owner`→INTERNAL_ERROR 不发**；`pending` 模式→PENDING、无 token。
- **全链路**：`otp.request → otp.verify → passport.verify → kron:external 会话`（用真 `library/passport.js` 原语，证明 token/proof 往返）。
- 进 `jest.ci.config.js` 白名单。

---

## 9. 开放决策（请拍板）

1. **agent.chat 匿名是否保留**（§7）——决定第二阶段翻不翻它。
2. **OTP pepper**：`hash=sha256(code+pepper)` 的 pepper 取 anchor salt（已有）还是单独 `config.passport.otp.pepper`？建议复用 anchor salt（已是 server-only）。
3. **首版通道**：先只做 `email`（gateway SMTP 已较完整），`sms` 等 provider 就绪再开？建议是。
4. **TOTP**：本规格做完后再开第二档，还是同批？建议**分批**（TOTP 不阻塞收敛）。

---

## 10. 落地顺序（建议）

1. `_provision` 抽公因子（不改对外行为，先有测试）。
2. config.passport 新增块（默认 closed，纯增量）。
3. `otp.request`/`otp.verify` + relay 注入 + hermetic 测试 → **此时自助发证可用，纯增量、不破现状**。
4. （需授权）router `system.js` 翻 `agent.chat`/`storage.asset.multi` → **公开面收敛落地**，跑 e2e auth 链确认。
5. 回写 BACKLOG §1.4 / VERSION.md / passport.md（§3.4–3.6 从"待实现"转"已实现"）。
