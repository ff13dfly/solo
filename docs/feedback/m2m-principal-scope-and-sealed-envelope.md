# 立项：M2M 机器主体（Service Principal）、多值 `$scope` 约束、Sealed Envelope 凭据信封上收与闲置 Relay Token 预刷新

> 来源：2026-11-07 四栈（`Catalog` / `Steward` / `Finance` / `Solar`）RPA 与跨系统调用真实运行盘点立项。
>
> **依据分三类**：
> - **线上实测与事故复盘（2026-11-07）**：
>   1. `Steward` ↔ `Finance` / `Catalog` 的无人值守 RPA 集成账号借用普通人类 `user` 实体或手工注入 bot token，撞上人类会话/OTP 生命周期与单值 `$owner` 限制；
>   2. 财务代账员/集团 RPA 节点在 `Finance` 需要同时被授权访问 `books: ['B01', 'B02', 'B05']`（多账套子集，既非单账套也非全库 `admin`），现行 `$owner: { field, value }` 仅支持单值等值过滤；
>   3. `Steward` 已在业务仓手搓 RSA-OAEP + AES-256-GCM 零明文凭据信封（端到端加密平台密码/Cookie，服务端 Redis 只存密文、仅目标执行手私钥可解），而 `Finance`（电子税务局/银行回单密码）与 `Catalog`（1688/Temu 店铺会话）仍有同类需求，不应三仓各抄一份密码学代码；
>   4. 低频业务栈（周末/节假日 >24h 无业务流量）的内置服务 relay bot token 因只在被动 401 时尝试刷新或依赖流量触发，闲置窗口后首跳 `event.emit`（fire-and-forget）易静默丢事件。
> - **源码核对**：
>   - `api/core/user/logic/{passport,key,bot}.js`（主体模型与 API key / bot 生命周期）；
>   - `api/library/entity.js` 与 `api/router/handlers/access.js`（`constraints.$owner` 单值 `{ field, value }` 行级过滤）；
>   - `api/library/relay.js`（bot token 刷新时机与 `event.emit` 调用链）。
> - **判断与规划**：四项均为 SOLO 框架级安全与身份基础设施，属 `v1.3.x → v2`「只加不破」演进项，立项统一设计，严禁下游各业务仓各自发明鉴权或加密方言。

---

## 一、问题拆解与目标规格

### 1.1 M2M `service_client` 机器主体（与人类 `user` 解耦）
- **现状**：跨箱 RPC 调用（`v2-bridge-interaction.md` §3 通道二）及外部 RPA 调度方若使用人类账号登录态，会受 OTP 挑战、密码过期、会话顶号与 UI 登录流程干扰；若直接塞 `SYSTEM:BOT:*` Redis 键则绕开管理员可观测面与密钥轮换审计。
- **目标**：在 `core/user` 提供一等机器主体（或专用 `user.client.*` / 增强 `user.key.*` M2M 模式）：
  - 显式绑定 `ownerUid`（责任归属人）、`allowedIps / cidr`（可选来源网段，如 Tailscale 内网段）、`permit`（窄方法白名单 + `$scope` 数据范围）与独立轮换周期（`expiresAt` + 双钥重叠宽限期 `graceUntil`）；
  - **永不走人类短信/邮箱 OTP 交互流**，支持一键 `revoke` / `rotate` 并写入 WAL 审计。

### 1.2 多值行级范围约束 `$scope`（向后兼容单值 `$owner`）
- **现状**：`constraints.$owner = { field: 'bookId', value: 'B01' }` 在 `library/entity.js` 中只支持单值相等判定。多店铺运营（`Catalog` 一个人管 4 家 Temu 店）与多账套代账（`Finance` 一个 RPA 采集团队管 12 套账）只能在「建 N 个机器人账号」和「直接给全局无约束权限」之间二选一。
- **目标**（只加不破）：
  - 保留 `$owner: { field, value }` 100% 兼容；
  - 在 `library/entity.js` 行级注入/过滤与 `fulfillment` `assertOwner` 中扩展支持集合成员判定（如 `$owner.values: string[]` 或 `$scope: { [field]: string[] }`）：
    - **读/改/删**：`record[field] ∈ allowedSet`；
    - **创建（`create`）**：调用方显式传入 `params[field]` 时校验 `params[field] ∈ allowedSet`（未传且集合长度为 1 时自动填入唯一值；长度 > 1 且未传时报 `-32602 INVALID_PARAM` 要求显式指定目标账套/店铺，防止误落默认桶）。

### 1.3 上收 `library/sealed-envelope.js`（零明文敏感凭据信封）
- **现状**：RPA 采集无法回避外部站点登录态/税盘口令托管。明文或服务端对称密钥加密（`GATEWAY_SECRET_KEY` 同机可解）一旦业务箱 Redis/环境变量泄露即全量暴露。
- **目标**：将 Steward 已验证的 **Sealed Envelope（执行端生成非对称密钥对、公钥注册入库、前端/管理端直接用执行端公钥封装 `AES-256-GCM + RSA-OAEP/X25519` 密文信封、SOLO 服务端全程只存密文与 key fingerprint、零私钥落服务端）** 提炼为 `api/library/sealed-envelope.js` 标准纯函数库 + 配套 `autocheck` 规则，供 `Steward`、`Finance`、`Catalog` 共享同一套信封格式（`solo.sealed/v1`）。

### 1.4 闲置 >24h 栈的 Relay Bot Token 后台预刷新
- **现状**：`library/relay.js` 依赖调用触发刷新或进程启动播种；对于 fire-and-forget 的 `event.emit`（如 `fulfillment` 状态转移在周末闲置 48 小时后的第一单），若旧 token 已过期且首跳并发触发，易出现首条事件丢失或刷新竞态。
- **目标**：在 `library/relay.js` 增加轻量级单实例合并刷新锁（inflight promise coalescing）+ 可选低频后台预刷新定时器（仅在距 `exp` 剩余 `< 15%` TTL 时静默换票，`unref()` 不阻塞进程退出，零外部轮询风暴），并在 `/health` 或 `token.status` 暴露 `lastRefreshAt` / `expiresAt` 供 `v2-bridge-interaction.md` §3 L1 巡检直接读取。

---

## 二、分阶段实施建议（只加不破）

1. **Phase 1（纯 `library/` + `core/user`，零 Router 改动）**：
   - `api/library/relay.js`：合并并发换票请求 + `unref()` 预刷新定时器（立即可做，风险最低）；
   - `api/library/sealed-envelope.js`：落 `solo.sealed/v1` 加解密与指纹校验纯函数库 + 100% 单测覆盖。
2. **Phase 2（`library/entity.js` + `core/user` 约束扩展）**：
   - `$owner` 支持 `values: string[]` 多值白名单（读过滤 + 写校验）并补齐 `entity-owner-scope.test.js` 矩阵；
   - `core/user` 补齐 `service_client` M2M 密钥签发与双钥轮换宽限期。
3. **Phase 3（下游收敛）**：
   - `Steward` 切换引用 `library/sealed-envelope.js`；`Finance` 多账套代账与 `Catalog` 多店铺 RPA 采集团队切到多值 `$owner`。

---

## 处理结论（solo 侧）

- **2026-11-07 立项登记**：已纳入 `docs/planning/BACKLOG.md` §3 正式追踪；待按 Phase 1 → Phase 3 逐项先红后绿落地后移入 `docs/feedback/done/`。
