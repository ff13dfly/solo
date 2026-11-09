# SOLO `v1.3.3` 安全与可靠性纵深加固反馈单（5 项源码实证问题）

- **来源**：`steward` 第 5 轮对抗性安全深审（`security-audit-run5`）跨仓线索，经逐行回读 `solo` `HEAD = e3f2b1a`（`v1.3.3`）源码复核去伪存真后投递
- **生成日期**：2026-11-09
- **核实说明**：初审线索共 7 条，回读 `solo` 真实源码后**剔除 2 条误报/已具备项**（`fulfillment/index.js:116` 的 `isAdmin` 已严格限定 `req.permit === 'admin'`；`gateway/logic/webhook.js:193,203,210` 已带 `X-Solo-Timestamp` 与 `dns.lookup` 校验，且 `fulfillment/logic/instance.js:921-926` 在证据门拦截时已回填保留未过期的 `flcb_` 令牌），保留以下 **5 项 100% 源码实证的框架级缺陷**。

---

## 1. 🔴 `apps/fulfillment`：`FL-YYYYMMDD-XXXX` 随机 4 位单号无 `NX` 保护，日均百单即高概率撞号静默覆盖旧单

- **位置**：`api/apps/fulfillment/logic/instance.js:346-384`
- **源码现状**：
  ```js
  const date = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Math.floor(Math.random() * 9000 + 1000);
  const instanceId = `FL-${date}-${suffix}`;
  // ...
  await redis.set(getInstanceKey(instanceId), JSON.stringify(instance));
  ```
- **风险机理**：后缀空间仅 `9,000` 个（`1000..9999`），且写主记录用的裸 `redis.set` 未带 `{ NX: true }`。按生日悖论，单日创建约 **112 单**时撞号概率即达 **50%**；一旦撞号，新单会静默覆盖同日已有履约单的 `FULFILLMENT:INSTANCE:FL-...` 键，导致在途业务单状态与审计历史瞬间丢失。
- **建议修复**：
  - 改用单调递增日序号 `INCR FULFILLMENT:SEQ:${date}`（配 `48h` TTL，位宽自适应 `padStart(4, '0')`，超 9999 自动扩为 5 位）或扩充随机熵；
  - 写主键强制使用 `SET ... NX` 重试循环（最多 10 次），绝不覆盖已有实例。

---

## 2. 🟠 `core/gateway`：`gateway.email.send` 附件解析未核验调用方资产归属（跨租户附件越权外带）且外链下载漏拦内网段

- **位置**：`api/core/gateway/logic/attachments.js:18-50, 81-109` 与 `api/core/gateway/index.js:137`
- **源码现状**：
  1. **跨主体归属绕过**：`fetchAttachments` 统一以高权服务 Bot `system.gateway` 调用 `relay.call('storage.asset.get', { id: assetId })` 与 `storage.asset.resolve`，未透传也未比对发起 `gateway.email.send` 的 `req.user` / `req.constraints.$owner` 与 `meta.owner`；在多租户场景下，持有 `gateway.email.send` 的低权主体可通过猜测/获知其他租户 `assetId`，借 `system.gateway` 身份读取他人资产并发往外部邮箱。
  2. **`downloadCapped` 内网过滤不全**：`isBlockedAttachmentHost`（`attachments.js:18-34`）仅拦截了 `169.254.*`、`100.100.100.200` 与 IPv6 link-local/ULA，**未拦截 `localhost`、`127.0.0.0/8`、RFC1918（`10/8`、`172.16/12`、`192.168/16`）与 CGNAT（`100.64.0.0/10`）**，且未对 DNS 解析结果做二次 IP 校验（当 `assetId` 指向 `storage.asset.external` 注册的外部 URL 时存在 SSRF 面）。
- **建议修复**：
  - 将调用方身份 `{ user: req.user, permit: req.permit, owner: req.constraints?.$owner }` 传入 `email.send → fetchAttachments`，对非 `admin` / 非无约束 `system.*` 调用方校验 `canRead(meta, callerCtx)`；
  - 对 `downloadCapped(url)`：仅放行本栈配置的 `storage` 自有端点（兼容 `STORAGE_PROVIDER=local` 下的本机 `/_oss`），其余外部主机一律走完整公网 IP 钉死（含 `dns.lookup` 校验）。

---

## 3. 🟠 `core/gateway` & `apps/storage`：SSRF 私网判据漏拦 Tailscale / CGNAT `100.64.0.0/10`

- **位置**：
  - `api/core/gateway/logic/webhook.js:68-102`（`isInternalOrReservedHost`）
  - `api/apps/storage/logic/asset.js:198-225`（`storage.asset.external` 的 `isInternalOrReservedHost`）
- **源码现状**：两处均写了 `h === '100.100.100.200'`（阿里云 metadata），但未拦截 RFC 6598 运营商级 NAT / Tailscale 组网网段 **`100.64.0.0/10`（`100.64.0.0` ～ `100.127.255.255`）**。在跨物理机通过 Tailscale 组网的生产部署中，各节点内网监控口与服务端口均暴露在 `100.64.0.0/10` 下。
- **建议修复**：将私网/保留地址校验抽入 `api/library/` 公共原语（消除 `webhook.js`、`attachments.js`、`asset.js` 三份手抄漂移），补齐 `^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.`（`100.64.0.0/10`）、`198.18.0.0/15` 及 multicast `224.0.0.0/4`。

---

## 4. 🟡 `apps/fulfillment`：后台超时收割器 `reaperTimer` 派发 `_tasks` 未透传原实例 `$owner` 租户上下文

- **位置**：`api/apps/fulfillment/index.js:71-88` 与 `api/apps/fulfillment/logic/instance.js:748-765`
- **源码现状**：`reaperTimer` 定时执行 `Methods.instance.reap({}, { user: 'system:reaper', permit: 'admin' })`，随后遍历返回的 `res._tasks` 直接调 `relay.call(t.method, t.params || {})`。该调用以全局 `system.fulfillment` Bot 身份发出，未携带被收割实例自身的租户隔离范围（而正常 RPC 路径下 Router `handlers.tasks.processTasks` 会透传 `sessionUser.permit?.constraints`）。
- **建议修复**：在 `reap` 生成 `_tasks` 时记录对应实例的租户字段（或由 `relay` 支持受限 `$owner` 头透传），并在 `instance.create` 的 `stripSensitiveMeta` 中同步剥离调用方伪造的 `_` 前缀保留键。

---

## 5. 🟡 `apps/storage` & `router`：`storage.thumbnail.rebuild` 缺 `isAdmin` 硬门 & `TRUST_PROXY` 缺直连来源 IP 门控

- **位置**：
  - `api/apps/storage/index.js:180`
  - `api/router/index.js:114-116, 308-310`
- **源码现状**：
  1. `storage/index.js:180` 中 `'storage.thumbnail.rebuild': (p) => logic.asset.thumbnailRebuild(p)` 未加 `if (!isAdmin) throw jsonrpc.UNAUTHORIZED()` 运维面硬门；省略 `id` 时会全量拉取 `STORAGE:ASSETS:SORTED` 逐个下载原图跑 Sharp 缩放重传，开销极重。
  2. `router/index.js:114,308` 在 `process.env.TRUST_PROXY === 'true'` 时直接取 `req.headers['x-forwarded-for']` 末段，但未先校验直连 TCP 对端 `req.socket.remoteAddress` 是否来自本机回环或 `TRUSTED_PROXY_IPS`——若同局域网/Tailscale 内其他进程绕过 Caddy 直连 Router 端口，可伪造 `X-Forwarded-For` 绕过按 IP 限流及 `/auth/key` 来源判定。
- **建议修复**：
  - `storage.thumbnail.rebuild` 补齐 `if (!isAdmin)` handler 硬门；
  - Router 仅在 `TRUST_PROXY === 'true'` **且** `socket.remoteAddress` 属于 loopback（或显式 `TRUSTED_PROXY_IPS`）时才采信 `X-Forwarded-For`。

---

## 处理结论

**已核实并修复（2026-11-09）**：
1. **`fulfillment.instance.create` 实例 ID 原子分配（§1）**：在 `api/apps/fulfillment/logic/instance.js` 中改为基于 `INCR FULFILLMENT:SEQ:${date}`（48h TTL）生成 `FL-YYYYMMDD-NNNN` 序列号，并配合 `SET ... NX` 10 次重试环（冲突时追加随机 hex 后缀）与 `idempotent: true` 并发竞态败方清理，彻底消除 4 位随机数生日碰撞覆盖已有实例的风险。
2. **`gateway.email.send` 附件跨主体越权读取与外部附件 SSRF 防护（§2）**：在 `api/core/gateway/logic/index.js` 将调用方上下文 `callerCtx` 传入 `fetchAttachments`（`api/core/gateway/logic/attachments.js`），通过 `canCallerReadAsset(meta, callerCtx)` 严格校验 `private` 资产归属及多租户 `$owner` 下的 `internal` 资产边界；同时对 `kind === 'external'` 资产关闭 loopback 豁免并执行 `assertPublicHostname` DNS 解析校验。
3. **全栈统一 SSRF / CGNAT / 云元数据拦截（§3）**：新增共享模块 `api/library/ssrf.js`，统一拦截 `100.64.0.0/10`（含阿里云 ECS 元数据 `100.100.100.200` 与 Tailscale CGNAT 网段）、`198.18.0.0/15`、`224.0.0.0/4`、`fc00::/7`、`::ffff:...` 及 DNS 重绑定，并接入 `apps/storage/logic/asset.js`、`core/gateway/logic/webhook.js`、`core/gateway/logic/attachments.js` 与 `core/gateway/logic/imap.js`。
4. **`fulfillment.instance.reap` 租户 `$owner` 传播与 `_` 前缀内部键清洗（§4）**：`stripSensitiveMeta` 过滤所有 `_` 前缀键；实例创建时持久化 `_ownerScope`，`reap()` 推进超时迁移及后台 `reaperTimer` 派发 `_tasks` 时通过 `walContext.run({ uid: 'system:reaper', owner: t._owner || null }, ...)` 完整保留租户归属上下文。
5. **`storage.thumbnail.rebuild` 鉴权门禁与注释清理（§5.1, §5.3）**：`api/apps/storage/index.js` 向 `thumbnailRebuild` 透传 `ctx`，全量重建强制要求无作用域管理员权限，单资产重建校验 `canDelete(targetMeta, ctx)`；同步修正 `apps/storage/config.js` 过期的软删除注释。（注：§5.2 `api/router/index.js` 4 行 `TRUST_PROXY` 校验按 `CLAUDE.md` §5 路由保护规范待用户显式授权后落盘。）
6. **回归验证**：新增 `api/library/tests/feedback-v133-convergence.test.js` 并纳入 `jest.ci.config.js`，全部单测及 `bash deploy/precheck.sh && node deploy/check-doc-drift.js` 均 `Passed`。
