# 用户权限系统测试计划

> 覆盖范围：`api/router/` — `auth.js`、`permit.js`、`validator.js`、`forward.js`、`index.js`
> 测试类型：单元 → Mock 集成 → E2E（按优先级排序）
> 运行方式：`cd api/router && npm test`（Jest 自动扫描 `tests/**/*.test.js`）

---

## 完整透传流水线（index.js `rpcHandler`）

```
POST /  或  POST /api/rpc
  │
  ├─ 1. extractToken(req)                      ← Bearer / x-admin-token
  ├─ 2. resolveSessionUser(token, redis)        ← Redis 会话 + Scheme F 动态 permit
  ├─ 3. validateGlobalConstraints(params)       ← OOM 保护（全局参数大小上限）
  │
  ├─ 4. 本地 METHODS 表匹配（系统方法）
  │     ├─ system.service.add / remove          ← 内联 if (!isAdmin) 拒绝
  │     └─ admin.*、setting.*                   ← 内联 isAdmin 检查
  │
  ├─ 5. resolveTargetService(method, SERVICES)  ← 反查服务注册表
  ├─ 6. checkAccess(sessionUser, service, method)
  │     ├─ Phase 0: 无 targetService → 直接通过
  │     ├─ Phase 1: checkPermission()            ← RBAC/ACL
  │     ├─ Phase 2: isPublicMethod()             ← 静态白名单；DEBUG=false 时禁 discovery
  │     └─ Phase 3: capMap[method].public        ← 动态 public flag
  ├─ 7. ratelimit.checkLimit()                  ← 限流
  ├─ 8. validateParams(params, methodSchema)    ← 下游服务 schema 校验
  └─ 9. forwardRequest()                        ← Ed25519 签名 + 透传下游
        ├─ 构造 authPayload（iss/iat/user/permit/constraints）
        ├─ 签名写入 X-Router-Token / X-Router-Signature header
        └─ 传播原始 authorization / x-admin-token header
```

---

## 现有测试状态（运行 `npm test` 后实际结果）

### 已有但存在 bug 的测试

**`tests/auth.test.js` — 1个 fail**
```
MockRedisClient 未实现 expire()
→ "should normalize legacy admin role" → TypeError: redisClient.expire is not a function
```
根因：`MockRedisClient` 没有 `expire` 方法，admin role 触发 sliding expiration 时崩溃。

**`tests/validator.test.js` — 2个 fail**
```
1. isPublicMethod('user.login.request') 期望 true，实际 false
   → user.login.request 不在 system.js 静态注册表里

2. PUBLIC_METHODS.forEach(...) → TypeError: Cannot read properties of undefined
   → validator.js 根本没有导出 PUBLIC_METHODS 常量
```

### 已覆盖且通过的场景

| 函数 | 通过的场景 |
|------|-----------|
| `extractToken` | Bearer header、x-admin-token、无 token |
| `resolveSessionUser` | 无 token、Redis 未开、有效 session、permit 字符串归一化 |
| `checkPermission` | allow_all、null permit、通配符、精确方法、拒绝未授权服务 |
| `resolveTargetService` | 找到服务、找不到服务 |
| `validateParams` | null schema、required 缺失、类型不符、array 类型、合法参数 |

---

## 覆盖缺口全图

| 步骤 | 函数/逻辑 | 当前覆盖 | 优先级 |
|------|----------|---------|--------|
| 2 | `permit.constraints` 反序列化（session 路径）| ✅ 已覆盖 | — |
| 2 | `permit.constraints` 反序列化（Scheme F 路径）| ✅ 已覆盖 | — |
| 9 | constraints 完整链路（Redis → authPayload）| ✅ 已覆盖 | — |

**剩余缺口：**

| 步骤 | 函数/逻辑 | 当前覆盖 | 优先级 |
|------|----------|---------|--------|
| 2 | `resolveSessionUser` Scheme F（动态 permit 加载）| ❌ 无 | 🔴 |
| 2 | admin/operator session TTL 续期 | ❌ 无（mock 有 bug）| 🔴 |
| 3 | `validateGlobalConstraints`（OOM 层）| ❌ 无直接测试 | 🔴 |
| 4 | 本地 METHODS 内联 `isAdmin` 检查 | ❌ 无 | 🟡 |
| 6 | `checkAccess` 全部（Phase 0-3）| ❌ 完全无测试文件 | 🔴 |
| 6 | Phase 2 discovery 锁定（DEBUG=false）| ❌ 无 | 🔴 |
| 7 | `ratelimit.checkLimit` | ❌ 无 | 🟡 |
| 9 | `forwardRequest` authPayload 构造 | ❌ 无 | 🔴 |
| 9 | `forwardRequest` header 传播 | ❌ 无 | 🟡 |
| 9 | `extractTasks` 后台任务提取 | ❌ 无 | 🟢 |
| - | `isAdmin` 函数 | ❌ 无独立测试 | 🟡 |

---

## 修复项（先于新测试，修改已有文件）

### Fix 1：`tests/auth.test.js` — MockRedisClient 补 `expire()`

```js
class MockRedisClient {
    constructor() {
        this.data = new Map();
        this.isOpen = true;
        this.expireCalls = [];                              // 记录调用，供断言
    }
    async get(key) { return this.data.get(key) || null; }
    set(key, val) { this.data.set(key, val); }
    async expire(key, ttl) { this.expireCalls.push({ key, ttl }); }
}
```

### Fix 2：`tests/validator.test.js` — 移除无效的 PUBLIC_METHODS 测试

删除：
- `isPublicMethod('user.login.request')` 期望 true（该方法不在注册表）
- `PUBLIC_METHODS.forEach(...)` 整段（导出不存在）

替换为基于实际 `system.js` 注册的方法验证：
```js
// 用 system.js 中真实存在且 public: true 的方法
expect(isPublicMethod('ping')).toBe(true);
expect(isPublicMethod('system.capability.list')).toBe(true);
expect(isPublicMethod('system.service.add')).toBe(false);   // public: false
expect(isPublicMethod('unknown.method')).toBe(false);
```

---

## Level 1：纯函数单元测试（零依赖）

### 1.1 `auth.js` → `checkPermission(permit, service, method)` — 补充场景

现有测试已覆盖 T1-T6，补充：

| # | 场景 | permit | 预期 |
|---|------|--------|------|
| T7 | services 字段缺失 | `{allow_all: false}` | `false` |
| T8 | 方法列表为空数组 | `{services: {erp: []}}` | `false` |
| T9 | 多方法列表中命中第二个 | `{services: {erp: ['erp.stock.query', 'erp.warehouse.query']}}` → `erp.warehouse.query` | `true` |
| T10 | 多服务，访问未授权服务 | `{services: {erp: ['*'], commodity: ['*']}}` → service=`authority` | `false` |

### 1.2 `auth.js` → `isAdmin(sessionUser)`

| # | 场景 | 输入 | 预期 |
|---|------|------|------|
| T11 | allow_all true | `{permit: {allow_all: true}}` | `true` |
| T12 | allow_all false | `{permit: {allow_all: false}}` | `false` |
| T13 | permit 缺失 | `{}` | `false` |
| T14 | sessionUser 为 null | `null` | `false` |

### 1.3 `validator.js` → `validateGlobalConstraints(params)` （新增）

| # | 场景 | 输入 | 预期 |
|---|------|------|------|
| T15 | 字符串超 102400 字节 | `{name: 'x'.repeat(102401)}` | INVALID_PARAMS |
| T16 | 数组超 1000 项 | `{ids: new Array(1001).fill(1)}` | INVALID_PARAMS |
| T17 | 对象序列化后超 204800 字节 | `{data: {k: 'x'.repeat(200001)}}` | INVALID_PARAMS |
| T18 | params 为 null | `null` | `null`（跳过）|
| T19 | null 值字段不计入大小 | `{a: null, b: undefined}` | `null` |
| T20 | 正常参数 | `{name: 'test', count: 5}` | `null` |

### 1.4 `validator.js` → `validateParams` — 补充场景

| # | 场景 | 预期 |
|---|------|------|
| T21 | optional 字段类型错误（提供了但类型不符）| INVALID_PARAMS |
| T22 | 嵌套对象参数，schema type=object | `null`（通过，只检查顶层）|

---

## Level 2：Mock Redis 集成测试

> 文件位置：`tests/auth.test.js`（扩展现有）

### 2.1 Mock Redis 结构（修复版）

```js
class MockRedisClient {
    constructor() {
        this.data = new Map();
        this.isOpen = true;
        this.expireCalls = [];
    }
    async get(key) { return this.data.get(key) || null; }
    async set(key, val) { this.data.set(key, val); }
    async expire(key, ttl) { this.expireCalls.push({ key, ttl }); }
}
```

### 2.2 `resolveSessionUser` — constraints 反序列化

> 验证 `permit.constraints` 经过 Redis JSON 序列化/反序列化后完整保留。

| # | 场景 | Redis 状态 | 预期 |
|---|------|-----------|------|
| T_C1 | session 携带 constraints | `permit.constraints = {maxAmount:5000, region:'cn'}` | `user.permit.constraints` 完整保留 |
| T_C2 | constraints 缺失 | permit 无 constraints 字段 | `user.permit.constraints` 为 undefined（不注入）|
| T_C3 | [Scheme F] user record constraints 覆盖 session | session constraints ≠ user record constraints | 返回 user record 的 constraints |

**T_C3 是关键**：Scheme F 整体替换 `sessionUser.permit`，user record 的 constraints 优先于 session 里的旧值。

### 2.3 `resolveSessionUser` — 修复 + 补充 Scheme F

| # | 场景 | Redis 状态 | 预期 |
|---|------|-----------|------|
| T23 | session JSON 损坏 | `"{{broken"` | 返回 guest，不抛出 |
| T24 | 正常 session，无 uid | `{username:'bob', permit:{allow_all:false}}` | 使用 session.permit |
| **T25** | **[Scheme F] 动态 permit 加载** | session.permit 旧，`user:{uid}` permit 新 | 返回**新** permit |
| T26 | [Scheme F] user 记录不存在 | `user:{uid}` 为空 | 回退 session.permit |
| T27 | [Scheme F] user 记录 JSON 损坏 | `user:{uid}` = `"{{broken"` | 回退 session.permit，不崩溃 |
| T28 | admin role → TTL 续期 | session: `{role:'admin'}` | `expire()` 被调用 |
| T29 | operator role → TTL 续期 | session: `{role:'operator'}` | `expire()` 被调用 |
| T30 | user role → 不续期 | session: `{role:'user'}` | `expire()` 不被调用 |
| T31 | permit 归一化：字符串 'admin' | session.permit = `'admin'` | `{allow_all: true, services: {}}` |
| T32 | permit 归一化：缺失 + role=admin | session: `{role:'admin'}` | `{allow_all: true}` |
| T33 | permit 归一化：缺失 + role=user | session: `{role:'user'}` | `{allow_all: false}` |

**T25 是整个测试计划中最关键的场景**：
```js
// 模拟：用户已登录，管理员改了权限
const oldPermit = { allow_all: false, services: { erp: ['erp.stock.query'] } };
const newPermit = { allow_all: false, services: { erp: ['*'] } };

mockRedis.set('session:token123', JSON.stringify({ uid: '42', permit: oldPermit }));
mockRedis.set('user:42', JSON.stringify({ permit: newPermit }));

const user = await resolveSessionUser('token123', mockRedis);
expect(user.permit.services.erp).toContain('*');  // 用新 permit
```

---

## Level 3：checkAccess 三阶段测试

> 文件位置：`tests/security/permit.test.js`（新建）

### Mock 策略

`checkAccess` 内部 require 了 `config` 和 `capability`，测试 Phase 2 的 `debug` 切换需要 `jest.isolateModules()`，Phase 3 直接操作 `CAPABILITY_MAP` 对象引用。

```js
// Phase 3 mock：直接写入共享对象
const cap = require('../handlers/capability');
afterEach(() => {
    Object.keys(cap.CAPABILITY_MAP).forEach(k => delete cap.CAPABILITY_MAP[k]);
});
```

```js
// Phase 2 debug 切换：隔离模块缓存
function loadPermitWithDebug(debugValue) {
    let mod;
    jest.isolateModules(() => {
        process.env.DEBUG = String(debugValue);
        mod = require('../handlers/permit');
    });
    return mod;
}
```

### 3.1 场景列表

| # | Phase | 场景 | 预期 |
|---|-------|------|------|
| T34 | 0 | targetServiceName 为 null | `{allowed: true}` |
| T35 | 0 | targetServiceName 为 undefined | `{allowed: true}` |
| T36 | 1 | allow_all=true | `{allowed: true}` |
| T37 | 1 | permit 精确匹配 | `{allowed: true}` |
| T38 | 1→2 | permit 不匹配，ping 是静态 public | `{allowed: true}` |
| T39 | 2 | `system.service.list`，DEBUG=false | `{allowed: false, errorCode: -32604}` |
| T40 | 2 | `system.service.list`，DEBUG=true | `{allowed: true}` |
| T41 | 2→3 | 非 discovery public 方法，capMap.public=true | `{allowed: true}` |
| T42 | 3 | capMap 中无该方法 | `{allowed: false}` |
| T43 | 全拒 | 无 permit + 非 public + capMap 无 | `{allowed: false, errorCode: -32604}` |

---

## Level 4：forwardRequest 测试

> 文件位置：`tests/forward.test.js`（新建）

### 重点：constraints 完整链路（Redis → authPayload）

完整路径：Redis JSON → `resolveSessionUser` → `forwardRequest` → `X-Router-Token` payload

| # | 场景 | 预期 |
|---|------|------|
| T_FC1 | session 携带 constraints → 透传到下游 | `payload.constraints` 与原始一致 |
| T_FC2 | [Scheme F] user record constraints 经动态加载后透传 | 下游收到 user record 的 constraints，非 session 旧值 |
| T_FC3 | constraints 缺失 → 下游收到 `{}` | `payload.constraints` 为空对象（`forwardRequest` 默认值）|
| T_FC4 | 嵌套 constraints 结构完整保留 | 深层字段不丢失 |

**注意**：T_FC2 验证的是 Scheme F + constraints 的联动。session 里的旧 constraints 不应该泄漏到下游——只有 user record 里的最新值才有效。

### 重点：authPayload 构造和 isAdmin 对下游的影响

`forwardRequest` 向下游发送的 `permit` 字段决定了下游服务信任的身份级别。

| # | 场景 | sessionUser | isAdmin | 预期下游收到的 permit |
|---|------|-------------|---------|----------------------|
| T44 | admin 用户 | `{permit:{allow_all:true}}` | true | `'admin'` |
| T45 | 普通用户 | `{permit:{services:{erp:['*']}}}` | false | `'user'` |
| T46 | constraints 传递 | `{permit:{constraints:{maxAmount:1000}}}` | false | constraints 原样传递 |
| T47 | meta 传递 | `{meta:{region:'cn'}}` | — | meta 原样传递 |

### 重点：header 传播

| # | 场景 | 预期 |
|---|------|------|
| T48 | sourceHeaders 含 authorization | 下游请求头含 authorization |
| T49 | sourceHeaders 含 x-admin-token | 下游请求头含 x-admin-token |
| T50 | sourceHeaders 无 authorization | 下游请求头不含 authorization |
| T51 | X-Router-Token / X-Router-Signature 总是存在 | 每次都签名 |

### Mock 策略

```js
// mock axios，拦截 POST 调用
jest.mock('axios');
const axios = require('axios');
axios.post.mockResolvedValue({ data: { jsonrpc: '2.0', result: {}, id: 1 } });

// 验证发出的请求
const [url, body, options] = axios.post.mock.calls[0];
expect(options.headers['X-Router-Token']).toBeDefined();
expect(options.headers['X-Router-Signature']).toBeDefined();
```

---

## Level 5：本地 METHODS 内联 isAdmin 测试

> 无法单独 require METHODS 表（定义在 `rpcHandler` 闭包内），通过 E2E 验证。

| # | 方法 | 条件 | 预期 |
|---|------|------|------|
| T52 | `system.service.add` | 非 admin token | `error.code: -32604` |
| T53 | `system.service.add` | admin token | 正常执行（或 upstream error）|
| T54 | `system.service.remove` | 非 admin token | `error.code: -32604` |
| T55 | `admin.log.debug` | 非 admin token | 拒绝或空结果 |

---

## Level 6：E2E 测试（需要 Router + Redis 运行）

> 运行前提：`cd api/router && DEBUG=false node index.js`

### 6.1 匿名访问

```
无 token → erp.stock.query（public: true）            → 200 + result
无 token → erp.sale_order.create（非 public）          → error -32604
无效 token → Redis miss → guest → 同匿名路径
```

### 6.2 RBAC 精确控制

```
permit = {services: {erp: ['erp.stock.query']}}

→ erp.stock.query      允许（Phase 1）
→ erp.stock.create     拒绝（permit 不含，Phase 3 也无 public）
→ erp.warehouse.query  拒绝
```

### 6.3 Scheme F 实时权限感知

```
1. 用户 A 登录，获得 token（session permit_v1：只有 erp.stock.query）
2. 直接写 Redis：user:{uid}.permit = {services: {erp: ['*']}}
3. 用户 A 用原 token 访问 erp.stock.create
4. 预期：允许（Router 感知到 permit_v2）
```

### 6.4 Production discovery 锁定

```
DEBUG=false 模式：

system.service.list    → error -32604（禁止 topology 泄漏）
system.capability.list → error -32604
methods                → error -32604

DEBUG=true 模式：以上方法均通过
```

### 6.5 Rate Limit

```
对同一 IP / uid 快速连续调用同一方法超过阈值
→ 第 N+1 次：error.code = -32029（RATE_LIMIT_EXCEEDED）
→ 等待 resetIn 后恢复
```

---

## 实施顺序

```
优先级  目标文件                    任务
──────  ────────────────────────   ─────────────────────────────────────
P0      tests/auth.test.js         Fix MockRedisClient 加 expire()
P0      tests/validator.test.js    Fix PUBLIC_METHODS 引用和 isPublicMethod 用例
P1      tests/auth.test.js         补 isAdmin、Scheme F（T25-T33）
P1      tests/validator.test.js    补 validateGlobalConstraints（T15-T20）
P2      tests/security/permit.test.js  新建，覆盖 checkAccess T34-T43
P2      tests/forward.test.js      新建，覆盖 authPayload + header T44-T51
P3      tests/security/*.test.js   E2E：Scheme F、discovery 锁定（T52-T55）
```
