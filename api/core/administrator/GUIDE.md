# administrator 服务任务配方

> 由 fleet-standard `guide` 方法下发（经 Router：`system.guide { service: "administrator" }`）。
> 与服务代码同目录、同 commit 更新。方法签名与参数约束以 `methods` 自省为准，
> 本文只讲自省说不出的**任务流程与语义**。

## 这是什么

系统管理后台，**单管理员模型**：只有一个主管理员账号，没有多操作员体系（普通账号在 `user` 服务）。
职责三块：身份/会话、系统级设置（config override + 自动化总控 + 显示清单）、全队错误日志汇聚。
**登录配方（`admin.login.request` → `verify`，PBKDF2 挑战-响应）见 Router guide §2a，本文不重复**，只讲登录之后的管理动作。

## 配方一：全队错误排查 → 修复后清理

1. `admin.log.error {}` — 不带 `service` 走全队扫描，返回 `{ logs }`（**无** `service` 键，每条 log 补了来源 `service` 字段，每服务默认取 100 条）。
2. `admin.log.error { service }` — 带 `service` 只看单服务，返回 `{ service, logs }`（默认 50 条，`limit`/`offset` 可翻页）。service 名会转小写，找不到再试首字母大写（兼容旧日志 key）。
3. 修好之后再清：`admin.log.clear { service }` 清单服务，或 `admin.log.clear {}` 清全部。清理**不可恢复**且需 admin 权限（handler 二次校验）。

## 配方二：一键把自动化面降级为人工

出故障要止血、或要人工接管时，用这组开关暂停整个自动化平面（`nexus` sentinel 反应 + `orchestrator` workflow 自动循环）。

1. `setting.automation.status {}` → `{ services: { nexus:{paused}, orchestrator:{paused} }, allPaused, anyPaused }`，先看当前态。
2. `setting.automation.pause {}` → 直接翻 Redis 的 pause flag（不发 RPC），两个循环立刻降级为手工，返回 `{ paused: true }`。
3. 处理完 `setting.automation.resume {}` → `{ paused: false }` 恢复。

**范围仅这两个服务**（config.automationServices 写死）；它不暂停别的服务，也不是全局静音。

## 配方三：服务级配置热覆盖

1. `setting.config.schema { service }` — 先看目标服务声明了哪些 override key；未发布 schema 时返回 `null`。
2. `setting.config.set { service, key, value }` — 写一个 override。**value 一律按字符串存**（内部 `String(value)`），数字/布尔取回时也是字符串，自己转。
3. `setting.config.get { service }` — 返回**裸 hash map** `{ key: value, ... }`（不是 `{ overrides }` 包裹）；无覆盖返回 `{}`。
4. `setting.config.del { service, key }` 删单个；`setting.config.list {}` 返回**裸数组**——有覆盖的服务名列表。

## 坑与约定

- **`admin.password.reset` 会物理删除 seed.json**：把凭据写进 Redis 后立即自毁引导种子，**没有自助找回**。忘密码只能手工（redis-cli 删记录 + 重投 seed），改密前务必记牢新密码。
- **`admin.self.lock` 是收工动作，不是临时静音**：把当前会话缩到 60s 并**关闭 administrator 的 HTTP 端口**；关掉后没有任何 RPC 能重启监听，只能靠外部脚本（`deploy/admin-up.sh`）。别在还要继续操作时调它。
- **isAdmin 硬门（纵深防御）**：`setting.config.*` / `setting.automation.*` / `setting.display.set`/`delete` / `admin.log.clear` 在 handler 里二次校验 `permit === 'admin'`，非 admin 即便 Router 放行也会 `UNAUTHORIZED`。
- **返回形状不规整**：`setting.config.get`=裸 map、`setting.config.list`=裸数组、`setting.config.schema` / `setting.index.schema` 未发布时=`null`——introspection 里这几个刻意没有 `returns_schema`，别当有固定包裹键。
- 时间字段都是 **ISO-8601 字符串**（loginAt / updatedAt / lockedAt），不是时间戳数字。
- 挑战 TTL 60s、会话 30 分钟滑动续期。
- `setting.display.*` 是 operator/Portal 启动拉取的实体显示清单存储（Display Protocol），写入只做**结构**校验，字段引用校验在 operator 侧——供 UI 配置用，不是给临时 agent 的业务实体。
- administrator **不托管任何业务实体**（`entities` 返回空）。
