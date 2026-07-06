# 安全与权限协议 (Security Protocol)

---

> **协议版本**: 1.5.0  
> **状态**: 稳定 (Stable)  
> **作者**: Fuu  
> **许可证**: Apache 2.0

---

## 摘要

本协议定义了 Solo·AI 系统的安全体系，包括零知识认证机制和细粒度权限控制。

## 1. 简介

### 1.1 设计原则

| 原则 | 说明 |
|------|------|
| **零知识** | 服务器永不接收明文密码 |
| **最小权限** | 新用户默认无权限，按需分配 |
| **细粒度** | 支持服务级和方法级权限控制 |
| **会话隔离** | 不同设备独立会话 |

### 1.2 安全体系架构

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   客户端     │───▶│   Router    │───▶│   微服务    │
│ (密钥派生)   │    │ (认证+权限)  │    │ (业务逻辑)  │
└─────────────┘    └─────────────┘    └─────────────┘
```

### 1.3 Router 信任锚点（Trust Anchor）

微服务通过验证 Router 的 Ed25519 签名来确认请求来源合法。验证所需的 Router 公钥**必须静态配置**，禁止运行时从 Router 动态获取。

**配置方式**：

各微服务通过 `.env` 文件注入 `ROUTER_PUBLIC_KEY`，由 `config.js` 读取：

```bash
# 每个微服务的 .env
ROUTER_PUBLIC_KEY=<Router 的 Ed25519 公钥（Base58）>
```

**禁止动态获取的原因**：

如果微服务启动时从 Router 的 `GET /auth/key` 拉取公钥来验证 Router 签名，等于"用 Router 自己的声明来证明 Router 的身份"，中间人可以同时伪造公钥接口和签名，验证形同虚设。

**运维要求**：

| 场景 | 操作 |
|------|------|
| Router 首次部署 | 将生成的公钥写入所有微服务的 `.env` |
| Router 更换 keypair | 所有微服务的 `.env` 需同步更新并重启 |
| 新增微服务 | 部署前必须配置 `ROUTER_PUBLIC_KEY` |

## 2. 认证机制 (Z-Handshake)

### 2.1 概述

**Z-Handshake** (Zero-Knowledge Handshake) 采用挑战-响应模式，确保：
- 服务器永不存储明文密码
- 仅通过密码验证子 (Verifier) 进行零知识证明

### 2.2 算法流程

#### 阶段一：密钥派生

- **算法**: `PBKDF2-HMAC-SHA256`
- **迭代次数**: 200,000

```javascript
InputKey = password + username
LoginHash = PBKDF2(InputKey, salt, {
    keySize: 256 / 32,
    iterations: 200000,
    hasher: SHA256
}).toString(Hex)
```

#### 阶段二：挑战响应

- **算法**: `SHA256`

```javascript
Response = SHA256(challenge + LoginHash).toString(Hex)
```

### 2.3 通信流程

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: 握手请求                                                 │
├─────────────────────────────────────────────────────────────────┤
│ Client → POST /login_request { username }                        │
│ Server ← { challenge, salt, iterations }                        │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: 计算签名 (客户端)                                        │
├─────────────────────────────────────────────────────────────────┤
│ LoginHash = PBKDF2(password + username, salt, iterations)        │
│ Response = SHA256(challenge + LoginHash)                         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: 验证 (服务端)                                            │
├─────────────────────────────────────────────────────────────────┤
│ Client → POST /login_verify { username, challenge, response }    │
│ Server: Expected = SHA256(challenge + StoredLoginHash)           │
│         if (Expected === Response) → 颁发 Session Token          │
└─────────────────────────────────────────────────────────────────┘
### 2.6 内部服务透传协议 (Inter-Service Context Protocol)

当 Router 完成认证并在向后端微服务（下游）转发请求时，会将当前用户的核心上下文通过 `X-Router-Token` 请求头透传。下游微服务通过验证该 Token 的 Ed25519 签名来信任该上下文。

Token 解析后的 JSON Payload 遵循统一的三区结构规范：

```javascript
{
  // --- 1. 基础身份区 (Identity) ---
  "user": "zhangsan",       // Username 或 UID，未登录时为 "anonymous"
  
  // --- 2. 授权管控区 (Security) ---
  "iss": "router",          // 签发方，固定为 "router"
  "iat": 1709530000000,     // 签发时间戳，下游可用于防重放
  "permit": "admin",        // 粗粒度角色身份 ("admin" / "operator" / "user")
  "constraints": { ... },   // (v1.1.0 新增) 数据级约束，由下游业务自行解释

  // --- 3. 扩展元数据区 (Metadata) ---
  "meta": {                 // (v1.2.0 新增) 业务扩展唯一入口
    "erpOperatorId": "001", // 示例：关联 ERP 的操作员 ID
    "dingtalkUser": "d123"  // 示例：关联钉钉的用户 ID
  }
}
```

**设计规范与红线：**
1. **Router 零业务感知**：Router 只负责从 User Redis 中读取 `meta` 对象并原样透传下发，**绝不解析或干预** `meta` 内的任何字段。
2. **唯一扩展通道**：下游微服务（如 `sale`, `crm`, `erp`）严禁向基础身份区和授权管控区追加自定义字段。所有业务级的外部系统映射（如企微、ERP、钉钉账号绑定）、个性化配置，**必须且只能**存放在 `meta` 对象内。

```
```

### 2.4 安全特性

| 特性 | 说明 |
|------|------|
| **数据库泄漏免疫** | 仅存储 LoginHash，无法逆向 |
| **抗重放攻击** | challenge 一次性使用，60 秒过期 |
| **零知识** | 服务器内存中从未出现明文密码 |

### 2.5 代码参考

**前端 (TypeScript)**:
```typescript
export const deriveLoginHash = (password: string, username: string, salt: string, iterations: number) => {
    const key = password + username;
    const saltWords = CryptoJS.enc.Hex.parse(salt);
    return CryptoJS.PBKDF2(key, saltWords, {
        keySize: 256 / 32,
        iterations,
        hasher: CryptoJS.algo.SHA256
    }).toString();
};
```

**后端 (Node.js)**:
```javascript
const expected = crypto.createHash('sha256')
    .update(challenge + user.login_hash)
    .digest('hex');

if (response === expected) {
    // 认证成功
}
```

## 3. 权限控制 (Permit)

### 3.1 数据结构

存储在 `user:<uid>.permit` 字段中：

```typescript
interface Permit {
  allow_all: boolean;  // true = 管理员
  services: {
    [serviceName: string]: string[];  // "*" 表示全权限
  };
}
```

### 3.2 权限示例

```javascript
// 管理员
{ allow_all: true, services: {} }

// 财务专员
{ allow_all: false, services: { "finance": ["*"] } }

// 销售人员
{ allow_all: false, services: {
    "crm": ["crm.customer.get", "crm.customer.list"],
    "finance": ["finance.create"]
  }
}
```

### 3.3 校验流程

```
请求 → Router → 解析 Session → 检查 Permit → 通过/拒绝
```

**校验函数**:
```javascript
function checkPermission(permit, service, method) {
    if (!permit) return false;
    if (permit.allow_all) return true;
    
    const allowed = permit.services[service];
    if (!allowed) return false;
    if (allowed.includes('*')) return true;
    if (allowed.includes(method)) return true;
    
    return false;
}
```

### 3.4 公开方法白名单

以下方法无需权限校验：

```javascript
const PUBLIC_METHODS = [
  'user.register',
  'user.login_request',
  'user.login_verify',
  'system.ping',
  'system.capabilities'
];
```

### 3.5 数据级约束 (Constraints)

方法级权限控制"能不能调"，数据级约束控制"调了之后能做什么"。

`constraints` 与 `services` 平级存储，**不改动现有 `services` 结构**：

```typescript
interface Permit {
  allow_all: boolean;
  services: {
    [serviceName: string]: string[];   // 方法级控制（不变）
  };
  constraints?: {                      // 数据级约束（新增，可选）
    [method: string]: Record<string, any>;
  };
}
```

**示例**：

```javascript
{
  allow_all: false,
  services: {
    "erp": ["erp.stock.query", "erp.order.sync"],
    "srm": ["srm.purchase.create"]
  },
  constraints: {
    "erp.order.sync": {
      maxAmount: 100000,
      warehouseIds: ["001", "002"],
      rateLimit: { max: 10, window: 60 }
    },
    "srm.purchase.create": {
      maxAmount: 500000,
      supplierIds: ["S001", "S002"]
    }
  }
}
```

**职责分工**：

| 层级 | 职责 |
|------|------|
| **Router** | 透传 `constraints` 到微服务（附在转发 payload 中），不解释内容 |
| **微服务** | 读取自己方法名下的 constraints，执行业务校验 |

**`*` 全局规则**：

`constraints` 支持特殊 key `*`，表示对所有方法生效的全局规则。微服务在读取自身方法约束的同时，也应合并处理 `*` 下的同类规则：

```javascript
constraints: {
    'erp.order.sync': { maxAmount: 100000 },  // 仅对此方法
    '*':              { hide: ['internal_code'] }  // 所有方法均生效
}
```

合并语义：`*` 规则与方法级规则取**并集**（均生效），方法级规则不覆盖 `*`。

#### 按用户数据隔离 (Data Scope 模式)

实现行级记录过滤（如普通销售只能看到自己的订单，店长能看到本店的），**推荐采用“声明作用域（Data Scope）”模式**，而不是在 Constraints 中编写复杂的表达式或查询语句。

**配置示例（authority 中配置 Role）**：
```javascript
constraints: {
    "sale.order.list": { "dataScope": "OWN" }       // 销售员：仅看自己的
    // "sale.order.list": { "dataScope": "DEPARTMENT" } // 店长：看本部门的
    // "sale.order.list": { "dataScope": "ALL" }        // 老板：看所有的
}
```

**微服务解读逻辑（业务层实现）**：
微服务读取 `dataScope` 枚举值，并结合 Router 透传的 `X-Router-Token`（基础身份区 `user.uid` 或扩展元数据区 `user.meta`）将其转化为底层数据库查询条件。

```javascript
async function listOrders(params, ctx) {
    const scope = ctx.constraints?.['sale.order.list']?.dataScope || 'OWN'; // 默认最严格
    
    if (scope === 'OWN') {
        params.creatorId = ctx.user.uid; 
    } else if (scope === 'DEPARTMENT') {
        params.departmentId = ctx.user.meta.departmentId; 
    }
    // scope === 'ALL' 时不附加隔离条件

    return await db.orders.find(params);
}
```
*优势：Router 保持极简不解析业务逻辑，权限配置与底层数据库彻底解耦，防止表达式越权注入。*

**设计原则**：

- Router 不理解 constraints 的语义，只做搬运
- 每个微服务读取自身方法名下的约束，同时合并 `*` 全局规则
- `checkPermission` 函数零改动，constraints 由下游微服务自行解读
- 无 constraints 字段时行为与现有完全一致（向后兼容）

### 3.6 字段级访问控制 (Field Mask)

方法级权限控制"能不能调"，数据级约束控制"调了之后能做什么"，字段拦截控制"返回的数据里能看到什么"。

#### 配置来源

字段规则配置在 `authority` 的 **Role** 记录上，通过权限同步管道自动下发：

```
role.constraints 配置（authority）
    → employee.bind() 触发同步
    → _tasks: user.permit.update
    → user.permit.constraints（缓存到用户）
    → Router x-router-token 透传
    → req.user.constraints（微服务请求上下文）
```

**设计原则**：字段限制是角色维度的业务规则，配置在 Role 上一次覆盖所有同角色用户，无需逐用户设置。用户级例外可直接写入 `user.permit.constraints`。

#### 两种模式

| 模式 | 字段 | 语义 | 新字段默认 | 适用场景 |
|------|------|------|-----------|---------|
| **白名单** | `show` | 只返回列出的字段 | 隐藏 | 敏感数据、严格管控 |
| **黑名单** | `hide` | 移除列出的字段 | 透传 | 字段少、迭代频繁 |

`show` 优先级高于 `hide`，两者不应同时出现在同一方法规则中。

#### 数据结构

```javascript
// Role.constraints（authority 配置，直接挂在方法名下）
constraints: {
    'sale.order.list': {
        hide: ['cost_price', 'margin']       // 黑名单：移除这些字段
    },
    'crm.customer.get': {
        show: ['id', 'name', 'company']      // 白名单：只返回这些字段
    },
    '*': {
        hide: ['internal_code']              // 全局黑名单：所有方法均生效
    }
}
```

#### 合并规则（method 级 + * 全局级）

```
1. method 级 show 存在 → 白名单，直接返回，忽略其余规则
2. 无 method 级 show，* 级 show 存在 → 白名单回退
3. hide → method 级 ∪ * 级，取并集均生效
```

#### 实现方式

字段拦截由 `core/lib/fieldmask.js` 提供工具函数，在微服务 **logic 层**按需调用：

```javascript
const fieldmask = require('../../core/lib/fieldmask');

// 模式 A：动态配置（从 constraints 读规则，支持 show/hide）
async function list(params, user) {
    const orders = await db.queryOrders(params);
    return fieldmask.apply(orders, 'sale.order.list', user.constraints);
}

// 模式 B：静态角色黑名单（代码级固定规则）
const mask = fieldmask.define({
    admin:    [],
    operator: ['cost_price'],
    user:     ['cost_price', 'margin', 'supplier_id']
});

async function list(params, user) {
    const orders = await db.queryOrders(params);
    return mask.forUser(orders, user.permit);
}
```

**职责分工**：

| 层级 | 职责 |
|------|------|
| **authority** | 在 Role.constraints 配置 show/hide 规则 |
| **Router** | 透传 constraints，不解析内容 |
| **微服务 logic 层** | 调用 fieldmask 工具，决定哪些方法需要过滤 |

### 3.7 权限生命周期

| 阶段 | 行为 |
|------|------|
| **注册** | 新用户 `permit = { allow_all: false, services: {} }` |
| **登录** | `permit` 写入 Session |
| **请求** | Router 从 Session 读取并校验 |

### 3.8 Workflow 权限

执行 Workflow 需要所有 steps 的权限：

```javascript
for (const step of workflow.steps) {
  if (!checkPermission(user.permit, step.service, step.method)) {
    throw { code: -32604, message: `Forbidden: ${step.method}` };
  }
}
```

### 3.9 数据安全防越权红线 (Security Blind Spots)

在实现“数据级约束 (Data Scope)”与“字段级拦截 (Field Mask)”时，微服务开发者必须严格防范以下三种常见的越权漏洞：

#### 红线一：防范侧信道数据泄漏（查询/排序越权）
**隐患**：`fieldmask.js` 仅能拦截最终输出的响应数据。如果用户在请求参数中传入了黑名单字段作为查询条件（如 `GET /api?cost_price_gt=1000`）或排序条件，攻击者可通过不断调整条件反向推测出敏感数据。
**规范**：微服务在处理入参时，必须校验查询（`where`）和排序（`orderBy`）条件。任何存在于用户 `hide` 约束中的字段，**严禁作为业务查询的条件参与运算**。

#### 红线二：防范写操作越权 (IDOR 漏洞)
**隐患**：`Data Scope` 极易在编写 `List`（查询列表）接口时被考虑到，但在编写 `Update` / `Delete` 接口时被遗忘。如果直接使用前端传来的 ID 去修改数据库，会导致跨租户或跨层级的数据篡改（Insecure Direct Object Reference）。
**规范**：`Data Scope`（如 `params.creatorId = ctx.user.uid`）不仅是查询的隔离域，更是**写操作必须的前置校验条件**。所有更新/删除操作必须带上用户身份约束（例如：`db.update({ id: 999, creatorId: ctx.user.uid })`）。

#### 红线三：防范开发者遗忘 (全局数据暴露)
**隐患**：行级隔离（Data Scope）强依赖于微服务开发者在每次 DB 查询前“自觉”拼接 `if (scope === 'OWN')`，一旦遗忘将引发全局数据泄露灾难。
**规范（远期目标）**：在系统重构时，应考虑将 `user.constraints` 直接透传给 `Entity Factory` 或数据库驱动层，由底层统一强制拦截，降低业务逻辑层的安全犯错概率。

## 4. 错误码

| 错误码 | 名称 | 说明 |
|--------|------|------|
| `-32600` | Unauthorized | 未登录或 Token 无效 |
| `-32604` | Forbidden | 无权限访问该方法 |
| `-32605` | SessionExpired | 会话已过期 |

## 5. 数据持久化与灾备

### 5.1 设计背景

Solo·AI 使用 Redis 作为唯一数据库。Redis 的持久化依赖 RDB 快照，两次快照之间的数据变更在 Redis 崩溃或数据损坏时不可恢复。需要一套写前日志（WAL）机制，使得"上次 RDB 快照 + 日志文件"可重放到最新状态。

### 5.2 架构概览

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│  微服务 Logic │────▶│ Entity Factory│────▶│  Redis (主存)  │
│              │     │  (core/lib)  │     └───────────────┘
│              │     │              │            │
│              │     │  写入成功后    │            │
│              │     │  ↓            │            │
│              │     │  磁盘日志写入  │────▶ logs/{hash}.log
└─────────────┘     └──────────────┘     (不依赖 Redis)
```

**核心原则**：

| 原则 | 说明 |
|------|------|
| **先 Redis 后日志** | Redis 写入成功后才写日志，日志永远 ≤ Redis 实际状态 |
| **日志不阻塞业务** | 日志写失败时记告警，不中断业务请求 |
| **日志不依赖 Redis** | 日志写入磁盘文件，Redis 崩溃不影响日志完整性 |

### 5.3 写操作事务性

Entity Factory 的写操作（create / update / delete）使用 `MULTI/EXEC` 保证原子性：

```javascript
// 伪代码：create 操作
const multi = redis.multi();
multi.json.set(key, '$', data);     // 写数据
multi.sAdd(indexKey, id);           // 更新索引
await multi.exec();                 // 原子执行

// 成功后写磁盘日志
logger.insert(key, { op: 'create', after: data, user, stamp });
```

| 场景 | 概率 | 后果 | 策略 |
|------|------|------|------|
| Redis 成功，日志失败 | 低（磁盘 IO 异常） | 恢复时丢这一条 | 告警，不阻塞业务 |
| Redis 失败（MULTI 回滚） | 低 | 无影响 | 不写日志，返回错误 |
| 索引与数据不一致 | 几乎为零 | MULTI/EXEC 保证原子 | 无需额外处理 |

### 5.4 敏感字段脱敏

日志记录实体全量快照，必须排除敏感字段。Entity 定义时声明 `sensitiveFields`，日志层自动剥离：

```javascript
// Entity 定义
const userEntity = createEntity('USER', {
    sensitiveFields: ['passwordHash', 'login_hash', 'secret', 'token']
});
```

**脱敏规则**：

| 字段类型 | 处理方式 |
|---------|---------|
| `passwordHash` / `login_hash` | 完全剥离，不记录 |
| `secret` / `token` | 完全剥离，不记录 |
| 其他业务字段 | 原样记录 |

**红线**：任何包含密码派生值的字段，即使是哈希后的值（如 PBKDF2 输出），也**禁止写入日志**。与 §5 安全建议中"任何日志不得包含密码"一致。

### 5.5 日志文件安全

| 维度 | 要求 |
|------|------|
| **文件权限** | `chmod 600`（仅 owner 可读写） |
| **存储位置** | 服务器工作目录下 `logs/`，禁止放在 web 可访问目录 |
| **访问控制** | 仅运维人员通过 SSH 访问，不通过 API 暴露 |
| **数据性质** | 运维工具，非业务接口，不受 field_mask 管控 |
| **生命周期** | 定期归档压缩，保留策略由运维决定 |

### 5.6 日志格式

每条日志为一行 JSON，支持重放：

```json
{
    "op": "create|update|delete",
    "key": "COMMODITY:PRODUCT:abc123",
    "before": null,
    "after": { "id": "abc123", "name": { "zh": "..." }, "status": "ACTIVE" },
    "user": "zhangsan",
    "stamp": 1711180800000
}
```

| 字段 | 说明 |
|------|------|
| `op` | 操作类型 |
| `key` | Redis key 全路径 |
| `before` | 变更前快照（create 时为 null，已脱敏） |
| `after` | 变更后快照（delete 时为 null，已脱敏） |
| `user` | 操作人 |
| `stamp` | 毫秒时间戳 |

### 5.7 恢复流程

```
1. 还原最近一次 RDB 快照（deploy/auto_rollback.sh 或手动 redis-cli --rdb）
2. 找到快照时间点 T
3. 扫描 logs/ 目录，筛选 stamp > T 的日志条目
4. 按 stamp 排序，依次重放：
   - create → SET key + SADD index
   - update → SET key（覆盖）
   - delete → DEL key + SREM index
5. 验证数据完整性
```

### 5.8 现有审计能力对照

| 服务 | 审计能力 | 说明 |
|------|---------|------|
| **fulfillment** | ✅ 完整 | 状态机 history 数组记录每次转换 |
| **user / commodity / authority** | ⚠️ 仅时间戳 | 只有 createdAt/updatedAt，无变更历史 |
| **全局** | ⚠️ 错误队列 | Error Queue 存在 Redis 内，Redis 损坏时一起丢失 |

WAL 机制实施后，所有通过 Entity Factory 的写操作将自动获得磁盘级审计能力，无需各服务单独实现。

### 5.9 实施路径

| 阶段 | 内容 | 改动范围 |
|------|------|---------|
| **Phase 1** | Entity Factory 加 `MULTI/EXEC` 事务包装 | `core/lib/entity.js` |
| **Phase 2** | 写操作后调用 `logger.insert()`，支持 `sensitiveFields` 脱敏 | `core/lib/entity.js` + `core/lib/logger.js` |
| **Phase 3** | 编写恢复脚本，支持从 RDB + logs 重放 | `deploy/` 新增脚本 |

## 6. 安全建议

| 建议 | 说明 |
|------|------|
| ✅ 最小权限 | 按需分配，默认无权限 |
| ✅ 审计日志 | 记录权限变更 |
| ✅ 定期轮换 | Session Token 7 天过期 |
| ❌ 禁止明文 | 任何日志不得包含密码 |

## 7. 系统服务账号 (System Service Account)

### 7.1 问题背景

notification、nexus、orchestrator 等内部服务需要**主动发起**跨服务调用（如 notification 调用 gateway 发送邮件）。Router 采用零信任模型，所有请求必须携带有效的用户身份凭证——内部服务没有用户身份，无法直接调用。

### 7.2 拒绝的方案

| 方案 | 拒绝原因 |
|------|---------|
| **直接绕过 Router** | 破坏零信任架构，该路径上的所有安全检查失效 |
| **服务自签名（每个服务持有私钥）** | 信任锚从 1 个（Router）变成 N 个。任意一个微服务被打穿，攻击者即可用其私钥伪造合法请求，单点防御失效 |
| **`.env` 长期 SECRET 换 token** | 本质等同于服务自签名：持久化凭证泄漏后可持续生成新 token，无时间上限 |

### 7.3 选定方案：无密码 Bot 账号 + Admin 签发 + 自动轮换

**核心原则**：
1. 服务自身不持有任何长期凭证，token 仅存在于内存/Redis，具有有限生命周期
2. Bot 账号**无密码**（`login_hash: null`），禁止通过 Z-Handshake 登录，仅能通过 `user.bot.issue.token` 由 Admin 签发 token

**落点选择**：Bot 账号管理放在 `user` 服务中（不新建独立的 authority 服务）。理由：
- permit 数据已在 `user:<uid>.permit`，bot 本质是 `type='bot' + login_hash=null` 的扩展 user 实体
- 新增微服务会增加部署/监控复杂度与攻击面，对一个相对独立的小特性不划算
- 管理 UI 放在 `portal/system` 独立页面（与 UserManagement 平级），避免与人类用户管理混淆

#### Bot 账号实体规范

| 字段 | 取值 | 说明 |
|------|------|------|
| `type` | `'bot'` | 区分人类用户（`'human'`）与系统账号 |
| `login_hash` | `null` | 无密码，无法通过 `/login_verify` 登录 |
| `permit` | 精确到方法 | 禁止 `allow_all: true`，必须列出具体 `services.method` |
| `uid` | `system.<service>` | 命名空间前缀 `system.` 保留给 bot 账号 |

**Authority 强制约束**：
- 创建 bot 账号的 API（`user.bot.create`）拒绝设置 `login_hash`
- 登录流程（`user.login_request`）检测 `type === 'bot'` 直接返回 `-32600 Unauthorized`
- 签发 API（`user.bot.issue.token`）要求调用方 `permit === 'admin'`

#### Bootstrap（一次性，人工操作）

```
Admin → user.bot.create({
    uid: 'system.notification',
    type: 'bot',
    permit: { services: { gateway: ['gateway.email.send', 'gateway.sms.send'] } }
})
Admin → user.bot.issue.token({ uid: 'system.notification' })  → 返回 token
Admin → notification.setServiceToken(token)
notification → 将 token 存入 Redis（key: NOTIFICATION:SERVICE_TOKEN）
```

#### 运行时（全自动）

```
收到请求 → 读取 Redis token → 检查 TTL
    TTL < 轮换阈值（建议剩余 < 10%）
        → 用当前 token 调 user.token.refresh（via Router）
        → 写回 Redis
    → 用 token 调目标服务（via Router）
```

#### 关键实现细节

**轮换阈值**：必须在 token 过期前完成轮换。token 过期后无法调 user 服务续签，服务将陷入无凭证状态，需 Admin 重新签发。建议 token 有效期 24 小时，剩余 < 2 小时触发轮换。

**并发保护**：多个并发请求可能同时判断"需要轮换"。使用 Redis 分布式锁（`SET NOTIFICATION:REFRESHING 1 NX EX 30`）确保同一时刻只有一个协程执行轮换，其余等待锁释放后读取新 token。

**`token.refresh` 身份校验红线**：user 服务实现 `token.refresh` 时**必须**校验 `caller.uid === currentToken.sub`，防止 A 服务用自己的 token 给 B 服务续签。这是该方案最关键的安全断言之一。

**冷启动/Redis 清空恢复**：token 随 Redis 一起丢失时，服务无法自行恢复（因为没有任何持久化凭证）。`setServiceToken` 注入接口必须永久保留，Admin 重新走 Bootstrap 流程（`user.bot.issue.token` → `setServiceToken`），无需重启服务。

**`setServiceToken` 接口安全**：该接口通过 Router 进入，要求 `permit === 'admin'`，与普通请求受同等 Z-Handshake 保护。

### 7.4 安全边界分析

| 维度 | 结论 |
|------|------|
| **信任锚数量** | 仍为 1 个（Router），架构单点防御不变 |
| **持久化凭证** | 无。Bot 账号 `login_hash = null`，user 服务的 Redis 泄漏不会暴露任何可重用凭证 |
| **暴露面** | Redis 中的短期 token（有 TTL，定期轮换） |
| **被打穿后的损害** | 仅限当前 token 剩余有效期，无法自行续签 |
| **与用户 token 的隔离** | Bot 账号 permit 由 Admin 精确配置，禁止 `allow_all`，最小权限 |

### 7.5 适用服务

| 服务 | 需要调用 | Bot 账号 uid |
|------|---------|--------------|
| notification | gateway.email.send, gateway.sms.send | system.notification |
| nexus | notification.send | system.nexus |
| orchestrator | 任意服务（workflow 步骤执行） | system.orchestrator |

> **实现状态**：notification、nexus 的调用逻辑当前为 stub（`TODO: ADR-007`），待 `user` 服务实现 `user.bot.create` / `user.bot.issue.token` / `user.token.refresh` 三个接口，并在 `portal/system` 新增 Bot Accounts 管理页后补全。

### 7.6 残余风险与缓解

无密码 Bot 设计消除了"login_hash 泄漏"这一最严重的被动攻击面，但仍有以下需要明确接受的风险：

#### 风险一：Admin 凭证被盗

**威胁**：攻击者拿到 admin 账号 token → 调用 `user.bot.issue.token` 签发任意 bot 的 token → 走 Router 调任意被授权的服务方法。

**缓解**：
- Admin 账号严格限制人数，启用强密码与 session 短 TTL
- `user.bot.issue.token` 写入 audit log（who/when/which bot/issued token jti），便于事后追溯
- 任何 bot token 签发都应记录到 WAL（§5），异常签发频率可被监控发现

#### 风险二：服务账号 permit 范围天然偏大

**威胁**：`system.notification` 必须能给**所有用户**发邮件，远超普通用户权限。一旦 token 在 TTL 窗口内被窃，爆炸半径远大于单个用户被打穿。

**缓解**：
- **强制最小权限**：每个 bot 账号 permit 必须精确到方法名，禁止使用 `*` 通配
- **constraints 收窄**（§3.5）：例如限定 `gateway.email.send` 的 `maxRecipientsPerCall`、`rateLimit`，防止被滥用群发
- **缩短 token TTL**：bot token 建议 24 小时，远短于用户 7 天，权衡运维与安全

#### 风险三：user 服务级失陷

**威胁**：user 服务进程被打穿（代码漏洞、依赖供应链）→ 攻击者可直接调用内部函数签发 bot token，绕过 admin 校验。

**缓解**：本设计不消除此风险（user 服务是 bot token 的签发方，被打穿等同于"造币厂被占"）。属于整体架构的固有信任假设，需通过 user 服务自身的纵深防御（最小依赖、定期审计、CI 漏扫）控制。注意：user 服务同时承载普通用户登录，攻击面本就比较集中，将 bot 管理放在此处是利弊权衡——避免新增 authority 服务带来更多攻击面，但需要 user 服务自身保持高质量代码审计。

#### 风险四：user 服务不可用导致内部服务集体瘫痪

**威胁**：user 服务宕机时间超过 token TTL → 所有需要内部调用的服务（notification/nexus/orchestrator）失效。

**降级策略（运维层面）**：
- 监控告警：user 服务不可用 > 5 分钟立即告警
- token 过期后**禁止使用旧 token**，避免在 user 服务故障期间产生未授权调用。服务应直接返回错误，由调用方/上游决定重试或降级
- 不允许"过期宽限期"机制（grace period）。一旦放宽，等同于削弱了 TTL 保护

#### 风险对比总览

| 攻击向量 | 当前设计是否消除 |
|---------|----------------|
| Bot 账号 login_hash 泄漏 | ✅ 已消除（无密码） |
| Redis 中 token 泄漏 | ⚠️ TTL 限制损害窗口 |
| Admin 凭证被盗 | ❌ 残余，靠 audit log 检测 |
| user 服务失陷 | ❌ 固有信任假设 |
| 服务自签名传播 | ✅ 不适用（无服务私钥） |

### 7.7 实现规范

所有需要发起内部跨服务调用的微服务，**必须**通过 `api/library/relay.js` 提供的统一客户端进行操作。禁止业务代码自行实现 token 存取、TTL 判断、刷新流程或 Router 调用。

#### 为什么强制使用共享库

| 单服务自实现的风险 | 统一库的解决方式 |
|------------------|----------------|
| 每个服务一份代码 → N 份审计成本，N 处潜在漏洞 | 一份代码，一次审计 |
| 不同开发者对"轮换阈值"理解不一致 | 库内固定常量，参数最小化 |
| 容易被诱导加入 grace period 等"善意"降级 | 库 API 不暴露此类参数 |
| 锁、TTL 解析等细节易写错 | 一次写对，所有服务受益 |

#### 库职责

| 职责 | 说明 |
|------|------|
| **Token 生命周期** | 从 Redis 读取、判断 TTL、必要时调 `user.token.refresh` 续签后写回 |
| **并发安全** | 使用 Redis 分布式锁 (`NX + EX`) 防止重复刷新 |
| **过期硬约束** | token 过期或刷新失败则直接抛错，**绝不重用**，**绝不提供 grace period 参数** |
| **身份一致性** | `setToken` 写入前校验 token sub 与 serviceName 匹配，防止串号注入 |
| **审计** | 签发、刷新、调用全部写 WAL（who/when/method/result） |
| **降级行为** | 刷新失败时清空内存与 Redis 中的 token，调用方收到明确错误，由上游决定重试或失败 |

#### 业务侧接入约定

```js
const { createRelay } = require('../../../library/relay');

const relay = createRelay({
    redis,
    serviceName: 'notification',
    routerUrl: config.routerUrl,
    rotateBeforeMs: 2 * 3600 * 1000     // 剩余 < 2h 触发轮换
});

// 通过 Router 调用其他服务（封装了完整的 token 生命周期）
const result = await relay.call('gateway.email.send', { to, subject, content });

// setServiceToken RPC handler 直接转发
async function setServiceToken({ token, expiresAt }, req) {
    if (req.permit !== 'admin') throw jsonrpc.FORBIDDEN();
    await relay.setToken({ token, expiresAt });
    return { ok: true };
}
```

#### 强制约束

1. **禁止跳过库直接调 Router**：业务代码中任何 `http.request(routerUrl, ...)` 类调用都属违规，由 autocheck `architecture` 规则检测
2. **修改流程**：该库属于核心安全设施，修改需要：
   - admin 同行评审
   - 单元测试覆盖率 ≥ 95%
   - 变更内容写入本协议附录 A 变更日志
3. **测试隔离**：业务测试**不允许** mock 此库，必须使用真实 Redis + mock Router（保证库的行为契约被真实验证）

## 8. 即时管理通道 (Just-in-time Admin Access)

### 8.1 问题背景

§6 安全建议中 Session Token 轮换是一条**应做但难以强制**的建议。Router 实现 sliding expiration（`api/router/handlers/auth.js`），admin/operator 会话每次访问自动续期，**理论上可无限期持有**。这与"定期轮换"原则冲突，是当前架构最大的残余风险来源：

| 风险 | 后果 |
|------|------|
| admin token 泄露（XSS / 内存 dump / 调试日志） | 攻击者通过持续访问让 token 永不过期，等同永久权限 |
| administrator 端点持续暴露 | 暴力破解、登录端点 0-day、登录服务 DoS 的持续攻击面 |

### 8.2 部署拓扑前提

本协议要求的部署模型限定唯一公网入口：

| 组件 | 网络可见性 | 说明 |
|------|-----------|------|
| Router | **公网** | 唯一公开 RPC 入口，所有调用强制 session 校验 |
| `portal/system` | **本机** | 管理员控制台，仅运行于管理员个人设备 |
| `portal/operator` | **本机** | 运营工作台，每位运营人员本机部署 |
| `client/*` | 公网 | 终端用户客户端 |
| 核心微服务（user / agent / gateway 等） | 内网 | 仅 Router 可达 |
| Redis | `bind 127.0.0.1` | 必须本机绑定，禁止暴露 |
| administrator | 99% 时间端口关闭 | 见 §8.3 |

**禁止条款**：
- `portal/system` 公网部署属违反本协议（XSS 偷 admin token 这条路径在公网暴露下重新打开）
- Redis 暴露 0.0.0.0 属违反本协议（session 与 WAL 数据直接外泄）

### 8.3 锁定机制 (admin.self.lock)

`administrator` 微服务提供 `admin.self.lock` RPC，原子化执行两项操作：

```
admin.self.lock
  ├── ① 在 Redis 中将调用者 session.ttl 字段改为 60，同时 EXPIRE 60s
  └── ② 延迟 500ms 后 server.close()——关闭 HTTP 监听端口
```

**关键实现细节**：

| 细节 | 原因 |
|------|------|
| 同时改 `session.ttl` 字段 + Redis EXPIRE | Router sliding refresh 读 `sessionUser.ttl` 决定续期值，单独 EXPIRE 会被反弹回 1800s |
| `server.close()` 延迟 500ms 执行 | 保证 RPC response 先返回再关端口，避免客户端拿不到结果 |
| 防御性 admin 校验 | 直接读 Redis session 校验 `permit.allow_all`，不依赖 middleware 注入 |
| `ai: false` | Bot/AI agent 不应主动调用此方法 |

### 8.4 架构使然

Lock 机制能成立依赖三个既有架构事实：

1. **Router 直接读 Redis 校验 session**（`api/router/handlers/auth.js:26`），不依赖 administrator 服务在线
2. **administrator 在 Router 注册表里是硬编码 URL**（`api/router/handlers/service.js:324` ensureAdministratorService），不走 handshake，Router 启停时序无依赖
3. **单体 solo.js 中 administrator 是同进程 Express 实例**，关其 `server.close()` 等效于关独立进程（端口不再 accept），但不影响其他服务

### 8.5 恢复路径

`admin.self.lock` 不可逆——锁定后无 RPC 路径可以解锁（端口已关）。重启依赖外部脚本：

```bash
bash deploy/admin-up.sh
```

该脚本逻辑：
1. `pgrep -f solo.{version}.js` 找到 bundle 进程
2. SIGTERM 优雅停止，5 秒不退则 SIGKILL
3. `exec bash deploy/run.sh` 重启

**重启不丢失任何状态**：所有 session 在 Redis 中持久化，重启 solo bundle 后所有用户会话继续有效。仅 administrator 重新可登录。

### 8.6 威胁面变化

| 攻击向量 | Lock 前 | Lock 后 |
|---------|---------|---------|
| 暴力破解 admin 密码 | ❌ 暴露 | ✅ 端口关闭，无法触达 |
| 登录端点 0-day | ❌ 暴露 | ✅ 端口关闭 |
| administrator DoS | ❌ 暴露 | ✅ 端口关闭 |
| admin token 长期持有横扫系统 | ❌ sliding expiration 永续 | ✅ token 60s 内死亡 |
| Router 自身 0-day | ❌ 暴露 | ❌ 暴露（Router 必须公网） |
| 业务服务逻辑漏洞 | ❌ 暴露 | ❌ 暴露（代码质量问题，与暴露模型无关） |

### 8.7 实现红线

| 红线 | 原因 |
|------|------|
| **禁止 grace period** | 任何"过期后宽限继续使用"机制都让 Lock 失去意义 |
| **禁止自动 unlock 机制** | 解锁必须需要外部 shell 权限，避免攻击者通过 RPC 链恢复登录 |
| **禁止从 Router 单元发起 administrator 重启** | Router 不应有重启其他服务的能力，单点权力越界 |
| **`portal/system` 必须本机部署** | 公网部署相当于让管理员浏览器成为公开 XSS 靶子 |
| **锁定后 60s 上限不可调** | 该值经过权衡（够完成手头操作但限制泄露窗口），不暴露为配置 |

## 附录 A. 变更日志

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| 1.0.0 | 2026-01-19 | 合并 auth, permit 两个协议 |
| 1.1.0 | 2026-03-04 | 新增 permit.constraints 数据级约束机制 |
| 1.2.0 | 2026-03-12 | 新增字段级访问控制规范（§3.6），constraints 支持 show/hide 双模式及 * 全局规则 |
| 1.3.0 | 2026-03-23 | 新增数据持久化与灾备规范（§5），定义 WAL 策略、敏感字段脱敏、恢复流程 |
| 1.3.1 | 2026-03-29 | 新增 Router 信任锚点规范（§1.3），明确公钥必须静态配置，移除动态获取逻辑 |
| 1.4.0 | 2026-05-12 | 新增系统服务账号机制（§7），定义无密码 Bot 账号 + Admin 签发 + 自动轮换方案，补充残余风险分析（§7.6），关闭 ADR-007 |
| 1.4.1 | 2026-05-12 | 明确 Bot 账号管理落点为 `user` 服务（非新增 authority 服务），API 命名规范为 `user.bot.*` / `user.token.refresh` |
| 1.4.2 | 2026-05-12 | 新增实现规范（§7.7），强制要求所有服务间内部调用通过 `library/relay.js` 统一客户端（`createRelay`），禁止自行实现 token 生命周期 |
| 1.5.0 | 2026-05-13 | 新增即时管理通道（§8），定义 `admin.self.lock` 机制、部署拓扑前提（仅 Router 公网）、本机 portal 部署红线、Lock + 60s session 双重 TTL 修改方案 |

## 附录 B. 相关协议

- [工作流协议](./workflow) - Workflow 权限校验
- [审批协议](./approval) - 审批人权限控制
