# 立项反馈：`apps/storage` 单资产私有可见性字节层穿透、`library/logger` 复合敏感键与大体积 Base64 脱敏截断、`library/entity` 公共字典豁免 `$owner`、`apps/fulfillment` 正交挂起态取消闭环

- **来源**：`finance`（财务与自动开票栈，SOLO `v1.3.3`），2026-11-09 执行 `Finance ⇄ Steward` 跨系统对抗性安全审计（`security-audit-run1`）时核实提炼
- **前置排重（已核对 `docs/feedback/` 现存挂单，不重复立项）**：
  - 单端登出 `user.session.logout`、`>3.7MB` 大文件预签名直传 `storage.asset.presign/commit` 与 `ttlSec` 中转擦除已见 [`./steward-remaining-bypasses-convergence.md`](./steward-remaining-bypasses-convergence.md)；
  - 多值 `$owner`、M2M `service_client` 与 `library/sealed-envelope.js` 已见 [`./m2m-principal-scope-and-sealed-envelope.md`](./m2m-principal-scope-and-sealed-envelope.md)；
  - `LOCAL_OSS_OUTWARD_ORIGIN` 生产回环死链自检已见 [`./entity-lifecycle-retention-and-oss-loopback-guard.md`](./entity-lifecycle-retention-and-oss-loopback-guard.md)；
  - Built-in Bot 生产标准播种路径关联 [`./no-production-bot-seeding-path.md`](./no-production-bot-seeding-path.md)。
- **依据分类**：以下 4 项均逐行核对了 SOLO `HEAD = e3f2b1a`（`v1.3.3`）真实源码，属于上游框架/基础库层尚未覆盖的共性安全与契约缺口。

---

## 零、总览对表

| 编号 | 模块与源码定位（`solo@e3f2b1a`） | 审计暴露的真实问题 | 目标收敛方向（只加不破） |
| :--- | :--- | :--- | :--- |
| **1** | `api/apps/storage/config.js:19,31,151,187`<br>`api/apps/storage/logic/asset.js:237,395`<br>`deploy/local-oss.js:23,26` | 业务层上传时显式传 `visibility: 'private'`（如数电发票包、对账单），JSON-RPC `resolve/get` 虽做鉴权，但默认 `STORAGE_ACCESS='public'` 令底层 `local-oss` 开启 `publicRead=true` 且 `urlFor(meta)` 忽略单资产 `meta.visibility`，字节层可被无签名匿名直读；且未配密钥时回退硬编码 `'solo-local-oss-dev-secret'` | `urlFor(meta)` 按单资产 `meta.visibility` 决定签发预签名 URL 还是公开 URL；`local-oss` 默认关闭全局无差别 `publicRead`（或仅对 `public` 资产放行）；生产环境拒绝默认开发密钥启动 |
| **2** | `api/library/logger.js:48-58` | `redactSensitive` 使用全词锚定正则且 `depth > 4` 停止递归，`loginPassword`/`newPassword`/`sealedInputs`/`ciphertext`/`encKey`/`apiToken` 等复合驼峰敏感键在异常入 `ERROR:QUEUE` 时明文泄漏；且未截断 `data:*;base64,...` 大载荷（单条报错可塞入数十 MB 字符串） | 升级为子串/后缀感知敏感键匹配、深度提至 `6`，并对 `data:*;base64,...` 及超长字符串（如 `>4096` chars）自动摘要截断 |
| **3** | `api/library/entity.js:62,129-148` | `walContext` 一旦注入 `ctx.owner`（`$owner`），同请求内触碰的**所有** `createEntity` 实例一律强制盖章与过滤；受限租户会话在业务链路中顺带查询全局公共字典实体（如平台渠道表、国税 19 位税收分类编码表）时，因字典行无租户字段全部被判 `NOT_FOUND` | `createEntity` 新增可选 `ownable = true` 参数；显式声明 `ownable: false` 的全局公共字典实体跳过 `$owner` 盖章与过滤 |
| **4** | `api/apps/fulfillment/logic/instance.js:189-209,446-471` | `suspend()` 设计为「无需声明 N×M 转换规则的正交挂起栈」，但 `cancel()` 内部走 `advance(event='cancel_requested')` 仍强求 `profile.transitions` 显式声明 `{ from: suspendState, event: 'cancel_requested' }`，否则挂起态工单无法取消；且 `cancel()` 不收 `metaUpdate` / `expectedTransitionId` | 允许 `cancel()` 在正交挂起态（`current.suspension !== null`）直接原子清锁进入 `CANCELLED`（不强求 Profile 为虚拟 `suspendState` 补写 `cancel_requested` 边），并支持可选 `metaUpdate` 与 `expectedTransitionId` |

---

## 一、`apps/storage` + `deploy/local-oss.js`：单资产 `visibility: 'private'` 在默认配置下被桶级 `publicRead` 架空

### 1.1 源码现状与穿透机理
1. **RPC 元数据层与底层字节层策略分裂**：
   - `api/apps/storage/config.js:151` 将 `defaultVisibility` 设为 `'internal'`，`api/apps/storage/logic/asset.js:237-259` 在 `get` / `resolve` / `list` 上严格执行 `canRead(meta, ctx)`（`private` 仅 owner/admin 可读，`internal` 仅已认证主体可读）。
   - 但同文件 `config.js:19` 默认 `const STORAGE_ACCESS = process.env.STORAGE_ACCESS || 'public'`，并在 `config.js:187-189` 推导出 `local.publicRead = (STORAGE_ACCESS === 'public')`（即 `true`）；独立启动器 `deploy/local-oss.js:26` 同样写死 `const publicRead = process.env.LOCAL_OSS_PUBLIC_READ !== 'false'`。
   - 同时，`asset.js:395-406` 的 `urlFor(meta)` 完全不读取 `meta.visibility`，直接调用 `store.resolveUrl(objectKeyOf(meta))`——在默认 `STORAGE_ACCESS='public'` 下，连 `visibility: 'private'` 的资产返回的也是无签名永久直链。
2. **真实业务风险**：
   - 同一个业务栈通常同时存在两类资产：公开静态图（如渠道图标 `visibility: 'public'`）与高敏私有归档（如 `finance` 的数电发票 PDF 压缩包、平台结算单，`upload` 时显式传了 `visibility: 'private'`）。
   - 在现行全局一刀切 `STORAGE_ACCESS` 模型下：若保持默认 `public`，`visibility: 'private'` 资产在 `/_oss/solo/<2/2/2/sha256.zip>` 上可被未授权直读；若整栈切 `STORAGE_ACCESS=private`，所有公开图标又全部变成 30 分钟过期的签名链接。
3. **默认开发密钥回退隐患**：
   - `api/apps/storage/config.js:17,31` 与 `deploy/local-oss.js:23` 在未设 `LOCAL_OSS_SECRET` 时静默回退公开常量 `'solo-local-oss-dev-secret'`；一旦生产漏配，外部攻击者可自行离线伪造任意对象的 `presign` 读写签名。

### 1.2 建议契约（只加不破）
1. **按单资产 `meta.visibility` 驱动签名策略**：
   - `store.resolveUrl(key, { visibility, expires })`（或 `asset.js:urlFor(meta)`）：当 `meta.visibility === 'private' || meta.visibility === 'internal'`（或全局 `STORAGE_ACCESS === 'private'`）时，一律调用 `presignGet` 生成短效签名 URL；仅当 `meta.visibility === 'public'` 且全局允许公开读时才返回无签名 URL。
2. **`local-oss-server` 与 `deploy/local-oss.js` 默认 Fail-Closed**：
   - `deploy/local-oss.js` 默认改为 `process.env.LOCAL_OSS_PUBLIC_READ === 'true'`（默认 `false`）；
   - 若需同桶混存 `public` 与 `private` 资产，`local-oss-server` 可在 `.meta/<key>.json` 记录公开标记或统一通过轻量签名放行，杜绝 `private` 对象无签名裸奔；
   - 当 `NODE_ENV === 'production'` 且 `LOCAL_OSS_SECRET` 未配置（命中 `DEV_OSS_SECRET`）时，启动直接拒绝并报错提示（与 `doctor.sh` 对齐）。

---

## 二、`api/library/logger.js`：`redactSensitive` 复合敏感键漏网与大体积 Base64 撑爆 `ERROR:QUEUE`

### 2.1 源码现状与痛点
`api/library/logger.js:48-58` 当前实现为：
```js
const SENSITIVE_KEY_RE = /^(device_?token|password|passwd|pwd|pass|secret|...|hash|proof)$/i;

function redactSensitive(value, depth = 0) {
    if (value === null || typeof value !== 'object' || depth > 4) return value;
    ...
}
```
在 `finance` 审计实测中暴露两处缺口：
1. **复合驼峰/前缀字段名全部漏脱敏**：业务 RPC 入参极少直接叫裸 `password` 或 `key`，而是叫 `loginPassword`、`newPassword`、`smtpPass`、`sealedInputs`、`ciphertext`、`encKey`、`pubKey`、`apiToken`；全词正则 `/^...$/` 对上述键名全部返回 `false`，一旦下游抛异常，明文口令或密文信封直接进入 Redis `ERROR:QUEUE` 与文件日志。且嵌套请求（如 `{ items: [{ credentials: [{ loginPassword }] }] }`）常达第 5 层，恰在 `depth > 4` 处停止脱敏。
2. **大体积 Base64 / DataURL 原样入列**：表格导入（`fileDataUrl` / `fileBase64`）或压缩包核销（`zipDataUrl`）入参常含 `5MB~50MB` 的 Base64 字符串；校验或解析抛错时，未截断的参数对象被整块序列化写入 `ERROR:QUEUE`，瞬间放大 Redis 内存与 AOF 体积。

### 2.2 建议契约
在 `api/library/logger.js:redactSensitive` 中：
1. 保留精确短词集（如 `pwd`、`pass`、`otp`、`salt`、`hash`，避免误伤 `compass` / `bypass` / `hashRate` 等正常业务词），同时新增**复合词子串/后缀正则**匹配：`/(password|passwd|secret|private_?key|signing_?key|api_?key|access_?token|refresh_?token|callback_?token|device_?token|sealed_?inputs|ciphertext|enc_?key|authorization|cookie)/i`；
2. 将递归深度上限从 `4` 提升至 `6`；
3. 对字符串值若匹配 `/^data:[^;]{1,128};base64,/i`、键名匹配 `/(dataurl|base64)$/i`（且长度 `> 256`）或任意单字段字符串长度 `> 4096`，自动替换为 `[TRUNCATED len=${v.length}]`。

---

## 三、`api/library/entity.js`：为全局公共字典实体提供 `ownable: false` 豁免开关

### 3.1 源码现状与冲突场景
- `api/library/entity.js:62,129-148` 在 `walContext` 带有 `ctx.owner`（即外部角色会话的 `constraints.$owner`，如 `{ field: 'bookId', value: 'B01' }`）时，对当前异步调用栈内调用的任何 Entity 无条件执行：
  - `create` 自动注入 `[o.field] = o.value`；
  - `get` / `update` / `delete` 校验 `data[o.field] === o.value`，否则抛 `NOT_FOUND`；
  - `list` / `multiGet` 自动过滤掉 `item[o.field] !== o.value` 的行。
- **真实业务冲突**：在一个微服务内部，往往同时存在**租户级业务表**（如 `company.store`、`company.fulfillment`，按 `bookId` 隔离）与**跨租户全局公共字典表**（如电商平台渠道定义 `company.channel`、国家税务总局 19 位商品税收分类编码字典 `company.taxmap`）。当携带 `$owner: { field: 'bookId', value: 'B01' }` 的受限会话调用业务方法，而该方法内部顺带读取 `channel.list()` 或 `taxmap.get()` 进行校验补全时，公共字典记录因不含 `bookId` 字段被 `entity.js` 全部过滤为空或抛 `-32001 NOT_FOUND`，迫使业务层每次手工用 `walContext.run({}, ...)` 剥离上下文绕行。

### 3.2 建议契约（可并入 `m2m-principal-scope-and-sealed-envelope.md` Phase 2）
- 在 `createEntity(redis, { ..., ownable = true })` 增加布尔选项 `ownable`（默认 `true`，100% 保持现有 fail-closed 默认安全态势）；
- 当实体显式声明 `ownable: false` 时，`ownerScope()` 直接返回 `null`（不注入 `$owner` 字段、不按 `$owner` 过滤），但**依然保留 `walFields` 中的 `ctx.uid` / `ctx.txn` / `ctx.trace` 审计归因**（比业务层粗暴用空 `walContext.run({}, ...)` 抹掉 `uid` 和 `txn` 更安全、审计链不断裂）。

---

## 四、`apps/fulfillment`：正交挂起态（`suspend`）与主动取消（`cancel`）契约闭环及 Bot 最小权限

### 4.1 源码现状与断点死锁机理
1. **正交挂起与非正交取消的自相矛盾**：
   - `api/apps/fulfillment/logic/instance.js:467-471` 明确定义 `fulfillment.instance.suspend` 为**正交断点栈**：*“Enters `suspendState` (default `ASSIST_REQUIRED`) from ANY active state **without requiring N×M `transitions` rules**”*。
   - 然而当管理员在挂起期间决定放弃并终止该工单、调用 `fulfillment.instance.cancel({ id, reason })`（`instance.js:446-452`）时，`cancel()` 内部委托 `advance({ id, event: 'cancel_requested', ... })`：
     - 虽然 `instance.js:189` 特判了 `event !== 'cancel_requested'` 放过了挂起锁检查；
     - 但紧接着 `instance.js:202-208` 仍然去 `profile.transitions` 里查找 `t.event === 'cancel_requested' && t.from === fromState`（此时 `fromState === 'ASSIST_REQUIRED'`）！
     - 凡是按 `suspend` 文档“不把 `ASSIST_REQUIRED` 写进 `transitions`”的 Profile，在挂起态调用 `instance.cancel` 会当场报错：`Event "cancel_requested" not defined from state "ASSIST_REQUIRED"`；而若调用 `instance.transition` 传业务自定义取消事件（如 `run.cancelled`），又会在 `L189` 被 `Instance is suspended ... and must be resumed before transitioning` 拦截（且报错文案未提示应调 `cancel`）。
2. **`cancel()` 缺少原子元数据合并与 CAS 参数**：
   - `transition`、`suspend`、`resume` 均已支持 `{ metaUpdate (或 meta), expectedTransitionId }`，唯独 `cancel({ id, reason, notifyCustomer })`（`instance.js:446`）不支持传入额外业务收口元数据（如 `resolution`、远端任务清理标记）与 `expectedTransitionId`，迫使调用方在 `cancel` 后再发一次非原子的 `instance.update`。
3. **`system.fulfillment` 播种权限过宽提醒**（补充关联 [`./no-production-bot-seeding-path.md`](./no-production-bot-seeding-path.md)）：
   - 早期派生项目拷贝的 `provision-fulfillment.cjs` 模板给 `system.fulfillment` 授予了 `notification: ['*']`、`approval: ['*']`、`agent: ['*']`（含 `notification.config.set` 等配置篡改权限）。上游落地标准 Bot 播种器时，`system.fulfillment` 默认应仅限 `event.emit` 及 Profile 显式声明的受控动作范围。

### 4.2 建议契约
1. **支持挂起态直接原子取消**：
   - 在 `fulfillment.instance.cancel({ id, reason, notifyCustomer = false, metaUpdate, meta, expectedTransitionId })` 中：
     - 若 `profile.transitions` 中已定义 `(from = current.state, event = 'cancel_requested')` 规则，仍按原路径执行并触发声明的 `_tasks`；
     - 若当前实例处于正交挂起态（`current.suspension !== null`），且 Profile 未为 `suspendState` 单独声明 `cancel_requested` 边，但为原阻塞态 `current.suspension.blockedState` 声明了 `cancel_requested -> CANCELLED`（或允许挂起态内置回退直达 `CANCELLED`），则直接原子清除 `suspension: null`、合并 `safeMetaUpdate`、校验 `expectedTransitionId`、推入 `CANCELLED` 历史并触发 `emitTransitioned`（若 `blockedState` 的 `cancel_requested` 边带清理 `actions`，一并生成 `_tasks`）。
2. **改进 `L193` 报错可诊断性**：
   - 将 `transition()` 命中挂起锁时的报错补充为：`Instance ${id} is suspended in "${fromState}"; call fulfillment.instance.resume to continue or fulfillment.instance.cancel to terminate`。

---

## 处理结论

**已核实并修复（2026-11-09）**：
1. **`apps/storage` 按资产 `visibility` 动态签名与 `local-oss-server` 字节级门禁（§1）**：
   - `api/apps/storage/oss/index.js` 的 `driver.resolveUrl(key, opts)` 在 `opts.visibility && opts.visibility !== 'public'` 时强制走 `presignGet` 返回带过期签名的 URL（即便全局 `STORAGE_ACCESS=public`）；`logic/asset.js` 的 `urlFor` 与 `thumbnailsMapFor` 均透传 `{ visibility: meta.visibility || 'internal' }`。
   - `api/apps/storage/oss/driver-local.js` 上传时携带 `X-Oss-Meta-Visibility`，`local-oss-server.js` 在 `.meta/<key>.json` 持久化 `visibility`，对非 `public` 对象拒绝无签名 `GET`/`HEAD`（即便 `publicRead === true`）；`deploy/local-oss.js` 默认 `publicRead: false` 且在生产环境未配置 `LOCAL_OSS_SECRET` 时拒绝启动。
2. **`library/logger.js` 复合驼峰敏感键脱敏、深度 6 与大体积 Base64/Blob 截断（§2）**：扩展 `redactSensitive()` 支持驼峰/复合凭据键（`smtpPass`、`imapPass`、`passphrase`、`privateKey`、`apiKey`、`authToken`、`bearerToken`、`sealedInputs`、`ciphertext` 等），递归深度上限从 `4` 提升至 `6`，并对 `data:*;base64,...`、超 256 字符的 Blob 字段及超 4096 字符的长字符串截断为 `[TRUNCATED len=...]`。
3. **`library/entity.js` `EntityFactory` 新增 `ownable: false` 公共字典模式（§3）**：`EntityFactory` 支持 `ownable = true`（默认），当显式声明 `ownable: false` 时 `ownerScope()` 返回 `null`，跳过 `$owner` 盖章与行级过滤，同时完整保留 `walContext` 的 `uid`/`txn`/`trace` 审计落盘。
4. **`apps/fulfillment` 正交挂起态（`suspend: true`）直接取消（§4）**：`fulfillment.instance.cancel` 支持传入 `metaUpdate`/`meta` 与 `expectedTransitionId`，允许处于 `ASSIST_REQUIRED` 等正交挂起态的实例直接执行 `cancel`（优先匹配 `blockedState` 的 `cancel_requested` 规则或兜底迁移至 `CANCELLED`，并清空 `suspension: null`），同时优化挂起态拦截报错提示。
5. **回归验证**：于 `api/library/tests/feedback-v133-convergence.test.js` 覆盖上述全部场景并通过 CI 与 `precheck.sh` 门禁。
