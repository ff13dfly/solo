# Authority 收口 —— 外部主体接入 + 内外隔离（结论：不建独立服务）

> [!NOTE]
> **状态：v1 已实现并过 e2e（2026-06-05）。结论：不建 `authority` 微服务。**
> **① 外部接入 = `user.passport.*`（`user/logic/passport.js`）** —— role.set / register / verify，复用 user 的 session/permit/撤销；
> **② Router 零改动**（`checkAccess` 即方法墙；`forward.js:39` 已转发 `permit.constraints`，owner 谓词搭车）；
> **③ 行隔离** v1 在 `collection` 按 `constraints.$owner` 自 scope（盖戳/过滤/校验），通用版后续抽到 `library/entity.js`。
> 名字"authority"弃用。测试：e2e `68-external-isolation`（边界+行隔离+身份，5 测）、单元 `user/tests/passport.test.js`。决策见 §9。

> **协议版本**: 0.2.0（决策版）
> **作者**: Fuu
> **依赖**: `passport.md`（外部认证原语）、`security.md §2.6/§7`（身份与令牌）、`context.md`（约束/fieldmask）

---

## 0. 命名与定位（已决策）

历史上"`authority`"曾是规划中的**内部授权/签发服务**，已被 **ADR 1.4.1 砍掉**（bot 账号统一走 `user.bot.*`，权限走 `permit` + Router `checkAccess`，见 `BACKLOG.md §1.1`）。

**决策：不复活它。** "外部→内部授权桥"的职责很薄（验 passport → 组装 permit → 铸 session），90% 复用 `user` 服务现成件，**做成 `user.passport.*` 能力即可，不新起 `api/core/authority/`**。"authority"作为服务名**弃用**——这样 §1.1 清理可以无脑"见 `authority` 就删"。本文标题保留"Authority"仅因它是 `BACKLOG §1` 那条线的文档落点。

---

## 1. 摘要 / 目标

一个复杂应用里，**外部用户**（客户 / 供应商 / 合作方）也需要权限配置，但绝不能因此穿透到内部、也不能互看数据。本协议把"隔离"拆成**两档**，落在**三个咽喉点**，不铺到每个业务服务：

| 档 | 防什么 | 咽喉点 |
|----|--------|--------|
| **边界隔离** | 外部碰不到内部方法 / 是谁 / 能不能撤销 / 限流 | `authority` + **Router** |
| **行隔离** | 外部 A 看不到外部 B 的行（多租户） | **`library/entity.js`** |

**核心理念**：复用内部已有的 `permit` + `checkAccess` 引擎（不造第二套授权），靠**三件事**保住隔离：
1. **统一机制**：外部走同一套 permit / checkAccess。
2. **隔离暴露面**：外部 session 的 permit 只列"可暴露方法" → 结构上够不到内部方法。
3. **隔离数据**：每个外部请求带**按人的 owner 谓词**，由 Entity Factory 在数据访问咽喉点强制行级作用域。

---

## 2. 三者定位（authority / user / passport）

| | `user`（内部轴） | `passport`（外部认证原语） | `authority`（本文，外部桥） |
|---|---|---|---|
| 谁 | 内部人 + bot | 外部实体的设备凭证 | —— |
| 职责 | 内部账号 / permit / session | 验"设备属于某 anchor"（`sha256(token+salt)`） | **验 passport → 铸受限内部 session** |
| 输出 | 内部 session | `{ok}`（仅认证） | 带 `kind:external` + owner 谓词的 session |

`authority` = 把 `passport` 的"认证结果"翻译成 Router 认得、且**受限**的 session。它是业界"API 网关令牌中介 / trusted-subsystem"模式（见 §10）的 SOLO 落点。

---

## 3. 端到端数据流（目标态）

```
外部用户(持 device token)
   │  ① 认证：authority 用 passport 验 token↔anchor-salt（passport.md）
   ▼
authority.session.mint
   │  ② 铸 session：
   │     user        = <外部用户 anchor-id>            ← 独立 identity
   │     permit      = { allow_all:false,
   │                     services: <共享 external 方法白名单>,   ← 边界（方法墙）
   │                     constraints: { $owner:{field, value:<本人>} } }  ← 行隔离谓词
   │     kind        = 'external'
   │  ③ 存进现有 session 库 + 写撤销反向索引 USER:SESSIONS:{anchor-id}
   ▼
（之后外部用户拿 session token 走正常 Router 流程）
Router 入口
   │  ④ resolveSessionUser → 拿到上面的 session
   │  ⑤ checkAccess(permit, service, method) → 不在 services 白名单即 FORBIDDEN（方法墙）
   │  ⑥ 签发 X-Router-Token，转发 { user, permit(压缩), constraints(含 $owner) }
   ▼
目标微服务 logic → library/entity.js
   │  ⑦ 从请求上下文读 $owner 谓词：
   │     list   → 读 BY_OWNER:{value} 索引（只出本人 id）
   │     get/update/delete → 校验 entity[field] === value
   │     create → 盖 owner 戳 + 入 BY_OWNER 索引
   │     无谓词但实体声明了 ownerScoped → default-deny
```

---

## 4. 组件改动

### 4.0 `user.role.*` —— 统一角色实体（RBAC，内部用户 + 外部 passport 共用）
逻辑 `user/logic/role.js`。**角色 = 命名的 permit 模板**（`USER:ROLE:{role}` `{id, scope, name, services, constraints:{$owner:{field}?}}` + `USER:ROLE:IDS`），内部用户和外部 passport 都引用它 —— 一套 RBAC。
- **`set` / `list` / `get`**：定义/列举/查看角色。`ownerField` 给行隔离谓词模板；`scope`(internal/external/both) 是标签。
- **`assign({uid, role})`**：把角色的 permit **物化(materialize)** 到**内部用户** `user:{uid}.permit`（+ 记 `user.assignedRole`）。
- **本质（关键）**：role 只是"设 permit 的工具"。**赋角色时**解析一次 → 物化到主体（内部写 user.permit；外部在 `verify` 时烤进 session）；**请求时只读主体自己那份 permit**（Router Scheme F 直读 `user:{uid}.permit`），**不在运行时查 role → user**，**零 Router 改动**。改角色 → 重新 assign/verify 才生效（admin 侧成本，非每请求）。
- **授权**：`role.set`/`assign` 是高权方法（定义/授予 permit），按 permit 放行(checkAccess)，admin 谨慎授予。
- 外部应用区分:角色可带 app 前缀/`scope`,passport 实体带 `app` 字段(见 §4.1),"不同外部应用的用户"分得开。

> **⚠️ 两个正交的轴,别混（命名已厘清）**：旧的 tier "role" 已**改名 `power`**,把"role"让给 RBAC。
> | 轴 | 字段 | 答什么 | 谁用 |
> |---|---|---|---|
> | **role（RBAC）** | `user.role.*` → `user.permit` + `user.role` | "能调哪些**方法**" | Router `checkAccess` |
> | **power（tier）** | `categories.POWER`（admin/operator/normal） | "**哪种用户 / 能进哪个台**" | **portal/operator 登录门禁**(`Login.tsx` 读 `categories.POWER`)+ Router 会话策略(`auth.js` 的 `power`) |
>
> `assign` **只动 role 轴**（`user.permit` + `user.role`），**绝不碰 `power`** —— 否则会扰乱"谁能进运维台"。`power` 没被 RBAC 取代,是 portal 准入轴,留着。e2e `70-operator-tier` 守这条契约 + 证明两轴独立。
> （历史:旧 `ROLE` 分类已改 `POWER`,`Login.tsx`/`UserManagement`/`auth.js`/seed 同步;`user.role` 现在专表 RBAC 角色。）

### 4.1 `user.passport.*`（外部接入 + **可管理实体**，落在 user 服务）
逻辑放 `user/logic/passport.js`，复用 user 现成的 session/permit/撤销。**外部用户是一等、可管理的实体**（anchor 作 id，镜像 `bot` 之于机器主体）：`USER:PASSPORT:{anchor}` `{id,role,app,name,meta,status,createdAt}` + `USER:PASSPORT:IDS` 索引；设备凭证(`PASSPORT:PROOFS:{anchor}`)挂在实体下（一人可多设备）。方法：
- **`register`**：登记/更新外部主体（**把 role 绑到实体上**，可带 `app` 区分外部应用）+ 注册一个设备 proof。OTP 下发流程 v1 缓做（§9），直接登记。
- **`list` / `get` / `disable`**：列举 / 查看(含设备 id) / 禁用(翻 status + 吊销其 live session)。= "便于进一步处理"。
- **授权 = 按 permit（非硬 isAdmin）**：passport 管理方法（register/list/get/disable）+ `user.role.*` 都**不做服务级 isAdmin**，纯靠 Router `checkAccess`（CLAUDE.md §5）。admin 照常；**operator 只要 permit 里有对应方法即可调，且可按方法细粒度授**（如给 `register/list` 不给 `user.role.set`）。这才让 portal/operator（非 admin 运维）能管外部用户。
- **`verify`（public）**：`{anchor, deviceId, deviceToken}` → 校验实体 `status===ACTIVE` + `Passport.verify` → **role 从实体读(不信客户端)** → 组装 permit `{services:<角色方法表>, constraints:{...,$owner:{field,value:anchor}}}` → 铸 `kind:external` session（+ `USER:SESSIONS:{anchor}` 反向索引）→ 返回 `{token, role}`。
- **管理 UI**：`portal/operator`(运维台,**与内部 user/bot 的系统台隔离**) → `PassportManagement` 页:定义角色 / onboard(发设备凭证) / 列表 / 禁用。

### 4.2 Router 入口鉴权 —— 边界（✅ 零改动，已核实）
| 点 | 现状 | 改动 |
|----|------|------|
| `resolveSessionUser`（`router/handlers/auth.js:19`） | 认任何 session→permit | 复用。**Scheme F 注意**：它热重读 `user:{uid}.permit`；外部 uid 无此记录 → 自然保留铸入的 permit（`if(userStr)` 已兜住）。要热更共享 external permit，可加 `kind:external` 分支去重读那份共享 permit。 |
| `checkAccess`（`router/index.js:281`） | 按 permit.services 逐方法 enforce | **复用即方法墙**。system.* admin 方法本就 admin-gated（`router/index.js:163-232`），外部非 admin 够不着。 |
| 令牌转发（`router-auth.js:78-80`） | 已带 `{user, permit, constraints}` | **复用**。owner 谓词搭 `constraints.$owner` 一并转发；`permit` 仍压缩成 `'admin'/'user'`（下游不需要完整方法表）。 |
| 身份位 | session 仅 `type:'bot'` 等 | 加 `kind:'external'`，供限流/日志/Scheme-F 分支用（小）。 |
| 限流（`router/handlers/ratelimit.js`） | 默认 `by:'ip'` | 外部要按人限流则加 `by:'user'` 规则 + identity=anchor-id（小）。 |

> **不需要**给每个方法打 `external:true` 标志 —— "一份共享 external permit 的 services 列表" 本身就是外部暴露面的白名单（结构墙）。

### 4.3 行隔离 —— 由 `constraints.$owner` 驱动
读到请求带 `constraints.$owner = {field, value}` 时，对该实体按行作用域：
- `create` 盖戳 `entity[field]=value`；`list` 只出 `entity[field]===value` 的行；`get/update/delete` 校验 `entity[field]===value`，否则 NOT_FOUND。
- **无 `$owner`（= 内部/admin）→ 不 scope，行为不变**（保护现有内部流程与全部既有 e2e）。

**落点分两步（先窄后通用）**：
- **v1（本次实现）**：在**暴露给外部的服务里直接按 `req.constraints.$owner` 自 scope**。本次用 `collection`（payment.record 盖戳 / list 过滤 / get 校验）。零侵入 Entity Factory，现有套件不受影响。
- **通用版（后续）**：把这套抽进 `library/entity.js`（`BY_OWNER:{value}` 索引 + 盖戳 + 校验 + `ownerScoped` 实体声明），enforce 在唯一数据访问口、各服务无感。**注意成本**：`walContext` 是**每服务**进入的（12 处），通用版要把 `$owner` 经共享中间件喂进 `walContext` 才能让 entity.js 读到 —— 故留作单独一步，不与本次混。

> 这是 SOLO 版的 Postgres RLS。`fieldmask`（字段遮罩）与本档**正交**——前者管"行里哪些列不给看"，本档管"哪些行不给"。

---

## 5. owner 谓词怎么"到达"entity.js（关键前提）

`entity.js` 在各服务进程内被调用，读不到 `req`。owner 谓词必须经**请求级 ambient context** 到达它：

```
Router 令牌(constraints.$owner)
  → 服务鉴权中间件解析(设 req.constraints)
  → 写入 walContext(AsyncLocalStorage，现已带 uid，扩展带 $owner)
  → entity.js 从 walContext 读 $owner
```

`walContext` 已存在（`library/entity.js` 的 `walContext.run({uid})`，见 `nexus/index.js`/`agent/index.js`）。需要：**共享的服务鉴权中间件**（一处共享基建，非每服务各写）在收到 Router 令牌时，把 `$owner` 一并放进 walContext。Router 端与 entity.js 端都在改动范围内，中间这段是共享中间件。

---

## 6. 权限 / 约束模型

外部 session 的 `permit`：
```jsonc
{
  "allow_all": false,
  "services": { "<service>": ["<external-safe method>", ...] },   // 方法墙
  "constraints": {
    "$owner": { "field": "supplierId", "value": "anchor-abc" },    // 行隔离谓词（本文新增的保留键）
    "<method>": { "hide": ["internal_code"] }                      // 既有字段遮罩（fieldmask，正交）
  }
}
```
- `services` 来自**共享** external 角色；`$owner.value` 是**按人**的（铸票时注入）。即"统一 permit + 按人身份"。
- `$owner` 是本协议新增的**保留键**，与既有 `constraints[method]` 字段规则共存；entity.js 只认 `$owner`，fieldmask 只认 `constraints[method]`，互不干扰。（也可选择放进令牌的独立 `scope` 字段，见 §9。）

---

## 7. 关键约定 / 前提（别误以为"改完三文件就万事"）

1. **行隔离是 per-entity opt-in**：每个要隔离的实体在 `entities.js` **声明 owner 字段**（`ownerScoped` + 字段名）。未声明的实体照旧全局。配置，非逻辑。
2. **只自动覆盖走 entity.js 的 CRUD**：自定义逻辑/直接读写 Redis 的方法绕过咽喉点，要自 scope。→ **外部尽量只暴露标准 CRUD**。
3. **owner 谓词必须可靠到达**（§5 的 walContext 管子要通且**默认 deny**）。

---

## 8. 安全考虑

| 风险 | 缓解 |
|------|------|
| 外部穿透到内部方法 | 共享 external permit 即白名单 + checkAccess 结构强制；admin 方法 admin-gated |
| 外部 A/B 互看数据 | entity.js owner scope（读 BY_OWNER / get·update·delete 验 owner）+ default-deny |
| 写侧越权（写别人的行） | `update/delete` 前校验 owner；`create` 强制盖戳 |
| 丢上下文（后台任务）裸跑全表 | `ownerScoped` 实体无谓词 → 拒，绝不回退全局 |
| 服务间调用丢用户身份 | 桥铸的是**按人** session；禁止用"共享身份"代替（见 §10 反模式） |
| salt 泄露 | passport"本地加盐、垂直验证"——每 anchor 独立 salt，半径小（passport.md §2.2） |
| **反模式（明确不采用）** | Router 出口过滤（全租户数据越界到 Router 再剔 + 写操作拦不住 + 分页乱）—— 不做 |

---

## 9. 决策（已定，2026-06-05）/ 未尽

已定（✅ = 采纳）：
- ✅ **命名**：弃用"authority"为服务名，落成 `user.passport.*`。
- ✅ **落点**：**不建独立微服务**，放进 `user`（`user/logic/passport.js`）。仅当 OTP/onboarding/外部角色管理 UI 复杂起来再考虑拆服务。
- ✅ **owner 谓词载体**：`constraints.$owner` 保留键（Router 零改动）。
- ✅ **粒度**：**按外部角色**（`EXTERNAL:ROLE:{role}`），角色数 = 实际有几个（今天 1 个也走同一路径，不焊死"共享 permit"）。
- ✅ **顺序**：先边界（user.passport.* + Router 零改）→ 后行隔离（v1 窄到 collection，通用版抽 entity.js）。

未尽：
- **OTP / device token 首发流程**：passport.md §3，v1 缓做（测试/接入直接 `user.passport.register`）。
- **通用行隔离**：抽进 `library/entity.js` + `walContext` 经共享中间件喂 `$owner`（§4.3）。
- `nexus` 的 per-agent 身份（`BACKLOG.md §1.2 / context.md §11.2`）与本文同属"按主体最小权限"，机制可共享。

---

## 10. 与业界做法的对应（备查）

- **身份内外分离** = Workforce IAM vs CIAM（Cognito 用户池 / Azure AD vs AD B2C / Keycloak realm）。
- **桥铸内部令牌** = API 网关令牌中介 / OAuth2 Token Exchange(RFC 8693) / Trusted Subsystem（后端用自身身份 + 把用户 id 作 claim 下传）。**本协议即此模式**；反面是 Impersonation（完全冒充）/ 共享身份（丢隔离）。
- **方法墙** = OAuth2 scopes。
- **行隔离** = 行级多租户：DB Row-Level Security（Postgres RLS）/ ReBAC（Zanzibar/OpenFGA/SpiceDB）。本协议在无 SQL 的 Redis 形态下，用 **Entity Factory 作单一 enforce 点** 等价之。

---

## 11. 实现映射

| 协议要素 | 落点 | 状态 |
|----------|------|------|
| **角色实体(RBAC)** | `user/logic/role.js`（`USER:ROLE:{role}` + `user.role.set/list/get/assign`，assign 物化到内部用户） | v1 实现 |
| 外部主体**实体** + 认证 + 铸票 | `user/logic/passport.js`（`USER:PASSPORT:{anchor}` 实体含 `app` + `user.passport.register/list(by app)/get/disable/verify`，role 从统一角色读）+ `library/passport.js` | v1 实现 |
| 方法墙 + owner 谓词转发 | Router（`checkAccess` + `forward.js:39` 转发 `permit.constraints`） | ✅ 零改动复用 |
| 行隔离 | v1：`apps/collection`（payment.record/list/get 按 `req.constraints.$owner` 自 scope）；通用版：`library/entity.js` + `entities.js` 声明 | v1 窄实现 / 通用版后续 |
| 撤销 | `USER:SESSIONS:{anchor}` + `bot.js#revoke` 风格；`disable` 翻 status + 吊销 session | 复用 |
| **管理 UI** | `portal/operator` → `PassportManagement` 页 + 固定路由 `/passport`（与内部 user/bot 的 portal/system 隔离） | v1 实现 |
| 测试 | e2e `68-external-isolation` + `69-roles`（assign 物化）+ `70-operator-tier`（tier 门禁契约 + 两轴独立）；单元 `user/tests/role.test.js` + `passport.test.js` | v1 |

## 附 · 相关协议
- [Passport 协议](./passport) — 外部认证原语（anchor / salt / proof）
- [安全协议](./security) — 身份区 / 令牌 / 内部服务透传（§2.6/§7）
- [上下文组装协议](./context) — `constraints` / `fieldmask`（字段遮罩，与行隔离正交）
- [`BACKLOG.md`](../../planning/BACKLOG.md) §1 — authority 收口推进顺序
