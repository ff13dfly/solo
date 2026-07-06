# 配置管理协议

**状态**：草案（部分已实现，部分待落地）  
**适用范围**：Router 全局配置、微服务运行时配置、服务结构可观测性

---

## 概述

Solo 的配置分三层：

| 层级 | 作用域 | 已实现 |
|------|--------|--------|
| **Router 配置** | 限流、任务白名单、权限黑名单等全局策略 | ✅ |
| **微服务配置** | 各服务的运行时参数覆盖（如缩略图开关） | 🔲 待落地 |
| **服务结构元信息** | RediSearch 索引等启动时初始化的结构信息 | 🔲 待落地 |

各层使用不同的 Redis 数据结构，原因见下方说明。

---

## 一、Router 全局配置

### 数据结构

存储为 **JSON String**（适合复杂嵌套对象，整体替换语义）：

```
SYSTEM:CONFIG:RATE_LIMITS       → String（JSON）
SYSTEM:CONFIG:TASK_WHITELIST    → String（JSON）
SYSTEM:CONFIG:PERMIT_BLACKLIST  → String（JSON Array）
```

### 配置项说明

#### 限流规则（RATE_LIMITS）

```json
{
  "default": { "window": 60, "max": 60, "by": "ip" },
  "prefixes": {
    "agent.":          { "window": 60, "max": 10, "by": "user" },
    "admin.":          { "window": 60, "max": 30, "by": "user" },
    "system.service.": { "window": 60, "max": 20, "by": "ip" }
  }
}
```

- `window`：时间窗口（秒）
- `max`：窗口内最大请求数
- `by`：计数粒度，`"ip"` 或 `"user"`

解析优先级：方法级 > 前缀级 > 全局默认

#### 任务白名单（TASK_WHITELIST）

```json
{
  "user": {
    "allowFrom": ["authority"],
    "allowMethods": ["user.permit.update"]
  }
}
```

控制哪些服务可以通过 `_tasks` 机制触发哪些后台方法。

#### 权限黑名单（PERMIT_BLACKLIST）

```json
["system.service.add", "admin.log.clear"]
```

黑名单内的方法不出现在角色权限分配界面，全局生效。

### RPC 接口

所有接口需要 Admin 权限：

| 方法 | 参数 | 说明 |
|------|------|------|
| `setting.limit.get` | 无 | 获取限流规则 |
| `setting.limit.update` | `{ rules: object }` | 更新限流规则 |
| `setting.task.get` | 无 | 获取任务白名单 |
| `setting.task.update` | `{ whitelist: object }` | 更新任务白名单 |
| `setting.blacklist.get` | 无 | 获取权限黑名单 |
| `setting.blacklist.update` | `{ blacklist: string[] }` | 更新权限黑名单 |

---

## 二、微服务运行时配置

### 数据结构

存储为 **Hash**（适合独立字段覆盖，支持单字段原子读写）：

```
config:{serviceName}  →  Hash { "dot.path.key": "value", ... }
```

示例：
```
HSET config:storage thumbnails.enabled false
HSET config:storage maxCacheSize 500
```

命名规范：
- key 全小写，层级用点号分隔
- 与 `config.js` 中的字段路径一一对应

### 优先级链

```
Redis HGET config:{service} {key}
  ↓ 为 null 时
process.env[ENV_KEY]
  ↓ 未设置时
config.js 默认值
```

### 类型转换

Redis 只存字符串，读取时按 `config.js` 默认值的类型自动 cast：

| 默认值类型 | 转换规则 |
|-----------|---------|
| boolean | `"true"` → `true`，其余 → `false` |
| number | `Number(val)` |
| string | 直接使用 |

### 标准读取方式

各微服务通过以下方式读取配置（待封装为 `core/lib/config.js`）：

```js
// 每次请求时读 Redis，无缓存层
async function getConfig(redisClient, serviceName, key, defaultVal) {
    const val = await redisClient.hget(`config:${serviceName}`, key);
    if (val === null) return defaultVal;
    if (typeof defaultVal === 'boolean') return val === 'true';
    if (typeof defaultVal === 'number') return Number(val);
    return val;
}
```

### 哪些配置适合动态覆盖

**适合**（运行时可变，无需重启）：
- 功能开关（thumbnails.enabled、debug 等）
- 数值限制（maxCacheSize、pageSize 等）
- 业务参数（超时时长、重试次数等）

**不适合**（需要重启才能生效，不纳入此协议）：
- 端口号（port）
- Redis 连接地址
- 密钥路径

### 变更生效方式

当前阶段：**改完 Redis 后重启整个 solo 进程**。

```bash
pm2 restart solo
```

> 后续可引入 Redis Pub/Sub 实现热重载，届时各服务订阅 `config:changed` channel，
> 收到通知后清空本地缓存即可生效，无需重启。当前阶段不做，等有实际需求再推进。

### RPC 接口

由 administrator 服务统一处理，Admin 权限：

| 方法 | 参数 | 说明 |
|------|------|------|
| `setting.config.get` | `{ service: string }` | 获取某服务的所有覆盖项 |
| `setting.config.set` | `{ service, key, value }` | 设置单个配置项 |
| `setting.config.del` | `{ service, key }` | 删除覆盖（回退到默认值） |
| `setting.config.list` | 无 | 列出所有有覆盖项的服务 |
| `setting.config.schema` | `{ service: string }` | 获取某服务的可配置 key 列表及默认值 |

### 配置 Schema（可观测性）

portal/system 需要知道某服务支持哪些 key，才能渲染结构化表单而非自由输入框。约定服务启动时将自身支持的可配置 key 写入 Redis。

**数据结构**：

```
SYSTEM:CONFIG:SCHEMA:{serviceName}  →  String（JSON）
```

**写入时机**：bootstrap 阶段，每次启动覆盖更新。

**格式**：

```json
{
  "service": "storage",
  "publishedAt": "2026-04-02T08:00:00.000Z",
  "keys": [
    { "key": "thumbnails.enabled", "default": true,   "type": "boolean" },
    { "key": "thumbnails.quality", "default": 82,     "type": "number"  },
    { "key": "bodyLimit",          "default": "10mb",  "type": "string"  }
  ]
}
```

- `keys`：服务明确声明支持动态覆盖的 key，由服务在调用 `cfg.publish(keys)` 时传入
- `default`：来自 `config.js` 的默认值，类型由此推导，portal 可用于显示当前实际值
- 不纳入 schema 的 key（port、redisUrl、密钥等）即使写入 Redis 也不生效，服务不会读取

**实现方式**：`createConfig` 提供 `publish(keys)` 方法，服务在 bootstrap 末尾调用：

```js
const cfg = createConfig(redis, 'storage', config);
await cfg.publish(['thumbnails.enabled', 'thumbnails.quality', 'bodyLimit']);
```

`publish` 内部自动从 `localConfig` 解析每个 key 的默认值和类型，写入 `SYSTEM:CONFIG:SCHEMA:{service}`。

---

## 三、服务结构元信息（可观测性）

### 背景

RediSearch 索引结构定义在代码里（`logic/search.js`），不看代码无法知道当前索引了哪些字段。为了让 portal/system 能直接展示各服务的结构信息，约定服务启动完成后将自身结构写入 Redis。

### 数据结构

```
SYSTEM:META:{serviceName}  →  String（JSON）
```

### 写入时机

**bootstrap 阶段**，在所有索引创建完成后写入，每次启动覆盖更新。

### 格式

```json
{
  "service": "commodity",
  "indexedAt": "2026-04-02T08:00:00.000Z",
  "redisearch": [
    {
      "index": "idx:commodity",
      "prefix": "COMMODITY:PRODUCT:",
      "fields": ["sku", "name_zh", "erp_name", "category", "status", "price"]
    },
    {
      "index": "idx:commodity_qr",
      "prefix": "COMMODITY:QR:",
      "fields": ["booth", "status", "createdAt"]
    }
  ]
}
```

- `indexedAt`：本次启动写入时间，可用于判断信息是否陈旧
- `redisearch`：该服务创建的所有 RediSearch 索引，没有则为空数组
- 不用于运行时读取，仅供 portal/system 展示

### 无 RediSearch 的服务

没有 RediSearch 索引的服务仍需写入，`redisearch` 字段为空数组，表示"已登记、无索引"：

```json
{
  "service": "storage",
  "indexedAt": "2026-04-02T08:00:00.000Z",
  "redisearch": []
}
```

### RPC 接口（待实现）

| 方法 | 参数 | 说明 |
|------|------|------|
| `setting.service.meta.get` | `{ service: string }` | 获取某服务的结构元信息 |
| `setting.service.meta.list` | 无 | 列出所有已登记服务的元信息 |

---

## 四、三层配置的对比

| | Router 全局配置 | 微服务配置 | 服务结构元信息 |
|---|---|---|---|
| Redis 类型 | String（JSON） | Hash | String（JSON） |
| 变更粒度 | 整体替换 | 单字段 | 整体替换 |
| 典型用途 | 复杂嵌套策略 | 标量参数开关 | 索引结构可观测 |
| 写入时机 | 管理员操作 | 管理员操作 | 服务启动自动写入 |
| 生效方式 | 即时 | 重启（当前阶段） | 只读，不影响运行 |
| 管理入口 | `setting.*` RPC | `setting.config.*` RPC | `setting.service.meta.*` RPC |

微服务配置附带 schema 可观测性：`SYSTEM:CONFIG:SCHEMA:{service}` 记录该服务声明支持的 key 列表，由 `cfg.publish()` 在 bootstrap 写入，供 portal 渲染结构化编辑界面。

---

## 五、待落地事项

1. ✅ `core/lib/config.js` — 标准读取工具函数（含 `publish`）
2. ✅ `setting.config.*` RPC — administrator 服务实现
3. `setting.config.schema` RPC — administrator 服务实现
4. `setting.service.meta.*` RPC — administrator 服务实现
5. 各微服务 bootstrap 写入 `SYSTEM:META:{service}`（渐进式，优先有 RediSearch 的服务）
6. portal/system 配置管理 UI — 读取 schema 渲染结构化表单，支持编辑
7. 各微服务按需接入动态读取 + `cfg.publish()`（渐进式，优先 storage）
