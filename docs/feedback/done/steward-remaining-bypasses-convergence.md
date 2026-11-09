# 立项反馈：清零下游最后四处非履约底座旁路 —— `core/user` 会话与改密、`apps/storage` 大文件直传与中转回收、`core/nexus` 轻量定时调用、`core/gateway` 入站 IMAP

- **来源**：`steward`（千手 RPA 栈，已升至 SOLO `v1.3.3` 并完成履约状态机全量回收到 `apps/fulfillment`），2026-11-09 旁路清零盘点
- **前置关联**：
  - 履约层旁路已随 [`./rpa-fulfillment-convergence-and-evidence-gate.md`](./rpa-fulfillment-convergence-and-evidence-gate.md) 收口至 SOLO 原生 `fulfillment` / `gateway`；
  - 机器主体与零明文凭据信封已立项于 [`./m2m-principal-scope-and-sealed-envelope.md`](./m2m-principal-scope-and-sealed-envelope.md)；
  - 时间总线轻量调用关联既有挂单 [`./cron-to-service-no-light-path.md`](./cron-to-service-no-light-path.md)。
- **依据分类**：以下结论均逐行核对了 SOLO `v1.3.3`（`HEAD = e3f2b1a`）真实源码，**先行剔除了 SOLO 现版本已具备的能力**，仅对真正迫使业务仓跨服务直读写底层 Redis 或手搓协议栈的缺口提出「只加不破」演进规格。

---

## 零、核实总表（区分「SOLO `v1.3.3` 已有」与「真缺口」）

| 领域 | 下游当前旁路文件（参照，不设跨仓链接） | SOLO `v1.3.3` 源码核实已具备的能力 | 仍缺失、需 SOLO 补齐的原语 |
| :--- | :--- | :--- | :--- |
| **1. 账号改密、单端登出与席位委托** | `steward/api/apps/steward/logic/explore.js`（直读写 `user:<uid>`、`user:name:<n>`、`USER:SESSIONS:<uid>`、`session:<tok>`） | `user.register` 已支持客户端传 `{ name, salt, hash }` 开户；`user.permit.update`、`user.role.assign`、`user.token.revoke`（按 `uid` 全量清会话）已存在 | ① 无密码重置方法（`user/logic/user.js:89` 明示无 password-reset）；<br>② 无普通用户单端自登出（`user.token.revoke` 硬锁 `isAdmin` 且只能全杀 `uid` 所有端）；<br>③ `user.*` 管理口全硬锁 `isAdmin`，`operator` 或受控 `system.*` 服务 Bot 无法在模板边界内开通/重置协作席位 |
| **2. 大文件直传与中转敏感资产擦除** | `steward/api/apps/steward/logic/{run,oss-client}.js` + 插件 `handlers/grab.js`（自造 `stewardChunkedAsset: 1` 清单，直删 `STORAGE:ASSET:*` 与 `/_oss/solo?delete`） | `storage.asset.delete`（`apps/storage/logic/asset.js:677-742`）**已原生实现** `withContentLock` + `REFCOUNT` 原子递减 + `store.deleteMany` 物理删块与缩略图（`config.js` 注释中的 "soft delete" 为陈旧文案） | ① 无 `>3.7MB` 大文件预签名直传/流式上传（`asset.js:580` 明示 JSON-RPC Base64 上限 `~3.7MB` 且未提供分片/直传，`external` 仅存外链不托管字节）；<br>② 跨主体中转资产（插件号上传、履约服务消费后擦除）受 `canDelete` owner/admin 门禁阻断，缺 `ttlSec` 自动过期回收或受权 `system.*` Bot 清理通道 |
| **3. 定时触发服务写方法** | `steward/api/apps/hive/logic/cron.js`（寄生 `EVENT:SENTINEL:HIVE_CRON` 10s 轮询 + 任务组 `checkSchedules` 自建定时器） | Router `EVENT_REGISTRY`（`router/handlers/events.js:74-81`）已支持按 `source` 增量合并，不再整表覆盖内置白名单 | ① `nexus/logic/scheduler.js:45-76` 仍仅有 `run_command`（含写方法必判 `HIGH` → 多签 + 默认 24h 冷静期）与 `emit_event`（无服务侧推回消费面），缺轻量 `call_method`；<br>② `nexus.schedule.*`（`core/nexus/index.js:155-163`）全部硬锁 `isAdmin`，业务服务 Bot 或 `operator` 无法同步业务任务组排程 |
| **4. 入站邮件读取与 OTP/附件收割** | `steward/api/apps/steward/logic/{apicall,imap-client}.js`（在 HTTP 代理 `apicall.js` 内硬编码 `if (method === 'mail.otp.poll')` 调 300 行裸 TLS IMAP 客户端） | `core/gateway` 已有成熟的 `gateway.smtp.*`（`GATEWAY_SECRET_KEY` 加密存密、读脱敏、`channel.test` 只读握手）与 `gateway.email.send` | `core/gateway` 纯出站、`core/ingress` 纯被动 HTTP Webhook，**完全无入站 IMAP 能力**；需对偶 `gateway.smtp.*` 新增受控 `gateway.imap.*` |

---

## 一、`core/user`：单端登出、密码重置与受控席位管理委托

### 1.1 源码现状与痛点
1. **无密码重置通路**：`api/core/user/logic/user.js:89` 明确注释 `there is no password-reset path`，`user.account.update`（`user.js:611-641`）仅允许修改 `categories` / `lang` / `email` / `phone` / `meta`。派生项目遇到协作方忘密或定期轮换口令时，只能跨服务直接 `redis.set('user:<uid>')` 改写 `salt` / `hash`。
2. **登出即死锁或误伤多端**：`api/core/user/index.js:233-236` 中 `user.token.revoke` 硬编码 `if (!isAdmin) throw jsonrpc.UNAUTHORIZED()`，导致任何非 `admin` 登录用户在前端点「退出登录」都无法销毁自己的服务端 Redis `session:<token>`（仅清 `localStorage` 会留下 7 天有效僵尸 Token）；且 `killSessions(uid)`（`logic/sessions.js:59-71`）只能一把清空该 `uid` 名下所有设备会话，无法只注销当前浏览器单端会话。
3. **`isAdmin` 硬门阻断受控运维委托**：`core/user/index.js:150-249` 对 `user.account.list`、`user.permit.update`、`user.role.assign`、`user.token.revoke` 全部硬写了 `if (!isAdmin)`。生产日常值班人员是窄权限 `operator`（而非全权 Root `admin`），业务服务 `system.steward` 经 `relay` 调 `user.*` 也因非 `admin` 被拒，迫使业务仓在 `explore.js` 内自建受控席位开通逻辑直写 Redis。

### 1.2 建议契约（只加不破，遵守 SOLO 2~4 段全小写点分命名）
1. **新增 `user.session.logout`（任意已认证主体可调）**：
   - 入参：`{ all?: boolean }`（当前会话 Token 直接由 Router 透传头提取，或校验传入 `token` 归属 `req.user` 本人）；
   - 行为：默认仅原子 `DEL session:<callerToken>` 并 `SREM USER:SESSIONS:<callerUid> <callerToken>`（单端精确登出，不影响同账号其他在线终端）；传 `all: true` 时调用 `killSessions(callerUid)` 注销本人全部会话。
2. **新增 `user.password.reset`（对偶 `administrator` 的 `admin.password.reset`）**：
   - 入参：`{ uid, salt, hash }`（与 `user.register` 一致，服务端只收客户端算好的 `salt + hash`，零明文口令落日志/WAL）；
   - 行为：拒绝 `type === 'bot'` 账号；以 `optimisticUpdate` 更新 `salt` / `hash`、清空 `devices`，并**强制联动执行 `killSessions(uid)`** 吊销全部旧会话，返回 `{ success: true, uid, revoked }`。
3. **收敛角色边界与委托门禁**：
   - 对已注册在 `user.role.*` 的非特权角色模板（`allow_all: false` 且不含 `setting.*` / `user.*` 管理权限），允许持有显式 `permit`（如 `user.role.assign`、`user.password.reset`、`user.account.list`）的 `system.*` 服务 Bot 或 `operator` 调用，同时在 handler 内强校验**目标账号非 `admin`（`!target.permit?.allow_all`）且目标角色非提权角色**，杜绝横向提权。

---

## 二、`apps/storage`：大文件预签名 HTTP 直传与中转敏感资产自动物理擦除

### 2.1 源码现状与痛点
1. **已核实无需改动的部分**：`api/apps/storage/logic/asset.js:677-742` 的 `storage.asset.delete` 已具备完整的 `withContentLock`、`STORAGE:SHA256:REFCOUNT:<sha>` 递减与 `store.deleteMany` 物理删除能力（顺手修正 `api/apps/storage/config.js:57,72` 中遗留的 `"soft delete"` 描述文案即可）。
2. **缺口 A —— `>3.7MB` 二进制文件无法入库托管**：
   - `asset.js:580-584` 注释写明：`storage.asset.upload` 走 Router JSON-RPC Base64（受限于 Router 10MB body limit 与 10s 转发超时，有效二进制上限约 `3.7MB`），而 `storage.asset.external` 不托管字节。
   - 在真实业务中（如百张数电发票 PDF 打包 `.zip` 跨站回传 1688 / Finance 归档，单包 `10MB~80MB`），客户端只能拆成多个 `3MiB` 分片调 `storage.asset.upload` 再额外上传一份 `stewardChunkedAsset: 1` JSON 清单，所有消费端被迫各自实现一遍分片下载重组与 SHA-256 校验。
3. **缺口 B —— 敏感中转资产的生命周期与跨主体擦除**：
   - 执行手（`owner = pluginUid`）抓取的税务发票包/回单属于跨栈中转敏感文件：上游业务栈消费落库后必须立即从 RPA 栈物理擦除，或超时自动销毁。但 `canDelete(meta, ctx)`（`asset.js:250-255`）仅放行 `meta.owner` 本人或 `permit === 'admin'`，受限业务主体（如 `fulfillment` 角色或非 admin 的 `system.steward` Bot）无法调用 `storage.asset.delete` 清理插件上传的中转包，迫使 `steward` 保留 `oss-client.js` 直连 `/_oss` 删除。

### 2.2 建议契约
1. **新增预签名直传闭环 `storage.asset.presign` + `storage.asset.commit`**（同构兼容 `local` 与 `aliyun` 两种驱动）：
   - `storage.asset.presign({ filename, mimeType, size, sha256, visibility?, ttlSec? })`：
     - 校验 `size <= STORAGE_MAX_DIRECT_BYTES`（默认如 `128MB`）与 `sha256` 格式；
     - 若 CAS 中该 `sha256` 字节已存在，直接返回 `{ alreadyExists: true, uploadUrl: null, ticket }` 秒传命中；
     - 否则签发短效单对象 `PUT` 预签名 URL（`local` 驱动复用 `oss/presign.js` HMAC 机制直传 `storage` 端口 `/_oss` 或反向代理挂载路径，绕开 Router JSON-RPC 内存三倍拷贝；`aliyun` 驱动签发 OSS 原生 `PUT` URL）与一次性 `ticket`。
   - `storage.asset.commit({ ticket })`：
     - 在 `withContentLock(sha256)` 内核验底层对象已落盘且实际字节长度/哈希与声明一致（`local` 流式算 SHA-256 校验），原子写入 `STORAGE:ASSET:<id>`、各二级索引与 `REFCOUNT`，返回标准资产元数据。
2. **可选生存期 `ttlSec` 与受权系统回收**：
   - `storage.asset.upload` 与 `storage.asset.commit` 支持可选参数 `ttlSec`（如中转敏感包设 `ttlSec: 3600`），写入 `expiresAt` 字段并登记到有界到期有序集 `STORAGE:ASSETS:EXPIRES`；
   - `storage` 后台低频（或 `storage.asset.reap`）到期自动复用 `delete()` 递减 `REFCOUNT` 并物理清块，且 `resolve` / `get` 对已过期资产立即按 `404` 拒绝；
   - 在 `canDelete(meta, ctx)` 中允许显式获授 `storage.asset.delete` 权限的受信内部服务主体（`system.*` 且无外部 `$owner` 租户锁时，或匹配 `meta.delegateDelete` 声明时）执行受控物理回收。

---

## 三、`core/nexus`：补全定时调度轻量服务调用（关联 `cron-to-service-no-light-path.md`）

### 3.1 现状补充核实
核查 [`./cron-to-service-no-light-path.md`](./cron-to-service-no-light-path.md) 提出后的 `v1.3.3` 进展：
- **已解决项**：Router 的 `EVENT_REGISTRY`（`api/router/handlers/events.js:74-81`）已改为按 `source` 合并覆盖，不再有整表替换丢失内置流的隐患。
- **未解决项（导致 `steward/api/apps/hive/logic/cron.js` 仍无法退役的两处根因）**：
  1. `api/core/nexus/logic/scheduler.js:45-76` 的 `executeAction` 仍只有 `run_command`（进 `orchestrator`，含 `hive.job.create` 写方法即判 `HIGH` 触发多签 + 默认 24h `APPROVAL_COOLING_MS_HIGH` 冷静期）和 `emit_event`（服务侧无声明式推回，仍得业务服务自建 `xRange` 轮询消费器）；
  2. `api/core/nexus/index.js:155-163` 中 `nexus.schedule.{create,get,list,update,delete}` 全部硬锁 `if (!isAdmin)`，业务服务（如 `hive` 管理采集任务组 `hive.group` 的每日/间隔排程）无法通过 `system.hive` relay 将业务排程托管到 `nexus.schedule`，只能在 `hive/logic/cron.js:124-179` 内自跑一套 `checkSchedules` 轮询器。

### 3.2 建议契约
1. 按 [`./cron-to-service-no-light-path.md`](./cron-to-service-no-light-path.md) 建议 1，在 `nexus.schedule` 增加第 3 种受限动作 `action: { kind: 'call_method', method, params }`：
   - 触发时由 `nexus` 经 Router `relay` 调用目标方法，自动注入确定性幂等上下文（如 `triggerId = "{schedule_id}:{firedAt}"`），方法级权限完全收敛在 `system.nexus`（或 `schedule` 绑定的受限 bot）的 `permit` 白名单上。
2. 允许持有显式 `nexus.schedule.*` `permit` 的内部服务 Bot（`system.<svc>`）管理自己命名空间前缀（`ownerService = req.user`）下的 `schedule` 条目，且仅允许其 `call_method` 指向该 Bot 自身 `permit` 允许的方法——从而让各业务服务的内生定时任务统一收归 `nexus.schedule` 单一时钟源。

---

## 四、`core/gateway`：对偶 `gateway.smtp.*` 新增入站 `gateway.imap.*` 读信与验证码/附件提取

### 4.1 源码现状与跨栈共性需求
- `api/core/gateway/index.js` 目前提供完整的**出站发信**体系（`gateway.smtp.*` + `gateway.email.send`），`api/core/ingress` 提供**被动 HTTP Webhook** 接收；但整个 SOLO 底座**没有主动入站读信（IMAP）原语**。
- 真实生产中已有两个核心栈强依赖受控 IMAP 读信：
  1. **`Steward`（二步验证 OTP 自动接码）**：电商后台（Temu / 1688 / 给货 / 税局）登录触发邮箱验证码时，剧本通过 `mail.otp.poll` 拉取最新验证码；因 `gateway` 无 IMAP，`steward` 目前在业务仓维护 300 行裸 TLS 状态机 `imap-client.js`，并在纯 HTTP 签名代理 `apicall.js:292` 硬塞了 `if (method === 'mail.otp.poll')` 特判；
  2. **`Finance`（数电发票与银行电子回单邮件自动收割）**：供应商开具的数电发票 PDF / XML / OFD 常通过邮件或交付链接发往企业财务收票邮箱，同样需要定时/按需经 IMAP 安全拉取邮件正文与附件并直接转存 `apps/storage`。

### 4.2 建议契约（对偶 `gateway.smtp.*`，100% 复用 `gateway` 安全边界）
1. **IMAP 账号托管（`gateway.imap.*`）**：
   - 方法：`gateway.imap.create` / `gateway.imap.get` / `gateway.imap.list` / `gateway.imap.update` / `gateway.imap.delete` / `gateway.imap.test`（与 `gateway.smtp.*` 完全对称）；
   - 安全护栏：
     - 授权码 `pass` 强制使用 `GATEWAY_SECRET_KEY`（AES-256-GCM）加密落盘，`get` / `list` / `create` 返回值永远抹除 `pass`；
     - 强制隐式 TLS（默认 `993`，拒绝明文 `143` 除非显式开发环境开关），并对 `host` 执行公网 IP 解析钉死（拦截 `127.0.0.0/8`、RFC1918、CGNAT `100.64.0.0/10`、云 metadata `169.254.169.254`，防止恶意传入自建假 IMAP 服务器套取托管授权码）；
     - 支持 `$owner` / 租户标签隔离，防止跨商家串读邮箱。
2. **受控拉取与提取（`gateway.imap.poll`）**：
   - 入参：
     - `imapId`（引用已托管加密账号，推荐生产唯一路径；避免调用方传明文密码）
     - 过滤条件：`mailbox`（默认 `'INBOX'`）、`sinceMs`、`fromContains`、`subjectContains`、`unseenOnly`、`limit`（上限封顶如 `20`）
     - 提取模式：`extractOtp?: { pattern?: string, length?: number }`（服务端直接解析出 `otp` 验证码，避免把整封含敏感链接的邮件全文暴露给低信任调用方）、`saveAttachmentsToStorage?: boolean`（启用时由 `system.gateway` relay 直接把 PDF/ZIP/XML 附件推入 `apps/storage` 并返回 `{ filename, mimeType, size, assetId }`，大附件零字节过 Router 响应体）。
   - 配额与连接保护：按 `imapId` 做单飞互斥（coalesce / 短冷却锁）与每分钟连接频控，防止并发轮询触发腾讯企业邮 / 163 / Gmail 的 IMAP 封禁。

---

## 五、预期收敛收益（下游删减清单）

上述四项原语在 SOLO 落地并发布新 bundle 后，`steward` 可一次性净删以下全部历史旁路代码：
1. 删除 `steward/api/apps/steward/logic/explore.js` 中所有 `user:*` / `USER:SESSIONS:*` / `session:*` 底层 Redis 键直读写，切回 `user.register` + `user.password.reset` + `user.session.logout`；
2. 删除 `steward/api/apps/steward/logic/oss-client.js`、`run.js:destroySingleStorageAsset` 的 `STORAGE:*` Redis 直操，以及插件 `grab.js` / `integrations/finance-fulfillment.js` 的 `stewardChunkedAsset: 1` 自造分片协议，切回 `storage.asset.presign` + `commit(ttlSec)` + `delete`；
3. 删除 `steward/api/apps/hive/logic/cron.js`（192 行），切回 `nexus.schedule` `call_method`；
4. 删除 `steward/api/apps/steward/logic/imap-client.js` 与 `apicall.js` 中的 `mail.otp.poll` 特判分支，切回 `gateway.imap.*`，并与 `Finance` 收票邮箱能力同源复用。

## 处理结论

**已核实并修复（2026-11-09）**：
1. **`core/user` 密码重置、自助登出与受控代理授权（§1）**：
   - 新增 `user.password.reset`（管理员、本人或持有 `user.password.reset` 显式授权的非管理员代理可调；拦截非管理员重置管理员或 Bot 账号；原子更新 `salt`+`hash`、清空 `devices` 并调用 `killSessions(uid)` 吊销全部会话）。
   - 新增 `user.session.logout`（`public: true` 面向任意已登录会话，支持单 Token 注销 `logoutSession` 或 `all: true` 全会话吊销 `killSessions`）。
   - 在 `api/core/user/index.js`、`logic/user.js`、`logic/role.js` 为 `user.account.list`、`user.account.update`、`user.role.assign` 开放基于 `permit.services.user` 的受控代理调用，并在逻辑层拦截非管理员修改管理员账号、赋予 `categories.POWER = 'admin'` 或分配含 `setting.*`/`admin.*`/`user.permit.*`/`user.bot.*` 的高权角色。
2. **`apps/storage` 预签名直传（`presign` + `commit`）与临时资产 TTL 自动清理（§2）**：
   - 新增 `storage.asset.presign`（上限 128MB，支持 CAS 秒传检测 `alreadyExists: true` 或签发 `store.presignPut` 直传 URL 与 30 分钟 Redis 票据）与 `storage.asset.commit`（校验票据归属、在 `withContentLock` 内核验对象大小与 SHA-256 后落库）。
   - `upload`/`presign` 新增 `ttlSec` 与 `delegateDelete` 参数，`get` 执行惰性过期拦截，新增 `storage.asset.reap` 与后台定时清理器，并在 `canDelete` 中放行 `delegateDelete` 与无租户约束的 `system.*` 服务 Bot。
3. **`core/nexus` `call_method` 轻量定时动作与 `system.<svc>` 命名空间自治（§3）**：
   - `nexus.schedule` 新增 `action.kind = 'call_method'`（校验 2~4 段 RPC 方法名并拦截高权方法），`scheduler.js` 到期直调 `relay.call(action.method, { ...action.params, idempotency_key: triggerId })`。
   - 向无租户约束的 `system.<svc>` 服务 Bot 开放 `nexus.schedule.{create,get,list,update,delete}`，强制 `owner === 'system.<svc>'`、`schedule_id` 前缀限定为 `<svc>:`/`<svc>.`/`<svc>-`、且 `call_method` 仅限调用 `<svc>.*`。
4. **`core/gateway` `gateway.imap.*` 加密凭据托管与安全拉信提取（§4）**：
   - 新增 `api/core/gateway/logic/imap.js` 并注册 `gateway.imap.{create,get,list,update,delete,test,poll}`，基于 `EntityFactory`（`sensitiveFields: ['pass']`）实现 AES-256-GCM 静态加密与 `$owner` 隔离，强制默认 `port: 993` 隐式 TLS、SSRF 校验、单账号 Redis 互斥锁、RFC 5322 / MIME / RFC 2047 解析、验证码正则提取及附件自动转存 `storage`。
5. **回归验证**：于 `api/library/tests/feedback-v133-convergence.test.js` 完整覆盖并通过 `precheck.sh` 与 `check-doc-drift.js` 门禁。
