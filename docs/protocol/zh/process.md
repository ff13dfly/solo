# 业务流程协议 (Process Protocol)

> **协议版本**: 1.1.0
> **状态**: 活跃 (Active)

---

## 摘要

Process 协议定义了业务流程的**数据结构契约**。各微服务自主实现流程定义的存储与查询，前端使用同一套渲染器解析并驱动 UI。

---

## 1. 设计原则

- **协议是契约，实现归服务**：Schema 结构由本协议固定，各服务独立维护自己的 Process 数据
- **前端无感知业务差异**：渲染器只认 Schema，不关心是车辆借还还是展厅流程
- **权限由 Router 把守**：按钮是否显示是业务判断，RPC 是否允许执行由 Router 鉴权——两件事分开
- **状态驱动**：流程 UI 由实体的 `status` 字段决定，而非前端条件判断

---

## 2. 接入方式

### 2.1 Category Meta 声明入口

各服务在分类配置的 `meta` 中声明关联的流程：

```json
{
  "id": "car",
  "label": { "zh": "乘用车", "en": "Car" },
  "meta": {
    "fields": [...],
    "processId": "vehicle_borrow_v1",
    "processService": "asset"
  }
}
```

| 字段 | 说明 |
|------|------|
| `processId` | 流程定义的 ID |
| `processService` | 实现该流程的微服务名，前端据此拼接 RPC 方法 |

### 2.2 前端调用链

```
asset.category.get({ key: 'ASSET_TYPES' })
  → meta.processId = "vehicle_borrow_v1"
  → meta.processService = "asset"
  → callRpc('asset.process.get', { id: 'vehicle_borrow_v1' })
  → 按 item.status 匹配 flow
  → 渲染 actions
  → callRpc(action.rpc, action.params)   ← Router 在此鉴权
```

---

## 3. Process Schema

**Redis 存储键**: `{SERVICE}:PROCESS:{id}`（如 `ASSET:PROCESS:vehicle_borrow_v1`）

```jsonc
{
  "id": "vehicle_borrow_v1",
  "name": "车辆借还流程",
  "version": "1.0.0",
  "flows": {
    "IDLE": {
      "ui": {
        "title": "空闲中",
        "description": "车辆当前空闲，可以借用",
        "actions": [
          {
            "id": "checkout",
            "text": "借用",
            "type": "PRIMARY",
            "rpc": "asset.item.checkout",
            "params": { "id": "$item.id" }
          }
        ]
      }
    },
    "IN_USE": {
      "ui": {
        "title": "使用中",
        "description": "借用人：$item.currentUserName",
        "actions": [
          {
            "id": "checkin",
            "text": "归还",
            "type": "SUCCESS",
            "rpc": "asset.item.checkin",
            "params": { "id": "$item.id" }
          }
        ]
      }
    },
    "MAINTENANCE": {
      "ui": {
        "title": "维修中",
        "description": "该资产暂时不可用",
        "actions": []
      }
    }
  }
}
```

### 3.1 字段说明

**Flow**

| 字段 | 类型 | 说明 |
|------|------|------|
| `flows` | `Record<status, Flow>` | 以 `item.status` 为键，O(1) 匹配当前 flow |

**UI**

| 字段 | 类型 | 说明 |
|------|------|------|
| `ui.title` | string | 状态标题，支持 `$item.xxx` 变量替换 |
| `ui.description` | string | 状态描述，支持 `$item.xxx` 变量替换 |
| `ui.actions` | Action[] | 可操作按钮列表，空数组表示该状态无可用操作 |

**Action**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 动作唯一标识 |
| `text` | string | 按钮文案 |
| `type` | enum | `PRIMARY` / `SUCCESS` / `DANGER` / `GHOST` |
| `rpc` | string | 调用的 RPC 方法，格式：`{service}.{entity}.{method}` |
| `params` | object | RPC 参数，支持 `$item.xxx` / `$user.xxx` 变量替换 |

### 3.2 变量替换规范

渲染器在调用 RPC 前，对 `params` 和 `ui` 中的字符串做变量替换：

| 变量前缀 | 数据来源 |
|---------|---------|
| `$item.xxx` | 实体 get 返回的字段 |
| `$user.xxx` | Router 透传的当前用户信息 |

**安全约束**：`$item` / `$user` 变量替换仅用于**标识符类参数**（`id`、`code`、`targetId`）。身份类参数（`operatorId`、`userId`、`approvedBy`）**禁止**通过变量替换传入——微服务必须从 `req.user` 直接注入，不信任来自 params 的身份字段。

```jsonc
// ✅ 正确：id 作为定位符，操作人由服务端注入
"params": { "id": "$item.id" }
// 微服务内部：const operatorId = req.user.id

// ❌ 错误：身份字段不走变量替换
"params": { "id": "$item.id", "operatorId": "$user.id" }
```

---

## 4. 微服务实现规范

每个需要支持 Process 的微服务，必须实现以下 RPC 方法：

```
{service}.process.get({ id })    → Process Schema
{service}.process.list()         → Process Schema[]
```

流程数据可以：
- **静态硬编码**（在代码中直接返回 JSON 对象，适合不需要运营配置的流程）
- **存 Redis 动态配置**（存 `{SERVICE}:PROCESS:{id}`，适合需要运营修改的流程）

两种实现对前端透明，统一通过 RPC 访问。

---

## 5. 权限控制

Process 协议**不负责**权限判断。权限控制在以下层面独立处理：

**读写权限**

| 操作 | 要求 |
|------|------|
| `process.get` / `process.list` | 公开可读，与 introspection 同级 |
| process 写操作（create / update / delete） | 仅 `allow_all` 用户（管理员）可执行 |

> Process 定义控制了"哪些按钮触发哪些 RPC"，写权限必须严格管控。普通用户若能修改 Process 定义，可将 `action.rpc` 指向任意方法，诱导其他用户触发非预期操作。

**执行权限**

1. **RPC 级**：Router 根据用户 `permit.services` 决定是否允许调用 `action.rpc`
2. **数据级**：微服务 logic 层根据 `permit.constraints` 做二次校验（如：只能归还自己借用的资产）

**前端渲染器不根据权限过滤按钮**——用户点击后若无权限，RPC 返回 403，前端统一处理错误即可。安全边界在 Router 和微服务，不在 UI。如需提前隐藏按钮，由微服务在 `process.get` 响应中根据调用方权限裁剪 actions（可选，非协议强制）。

---

## 6. 前端渲染器规范

实现本协议的渲染器须支持：

1. 以 `item.status` 为键从 `flows` 中取对应 flow，无匹配时展示默认占位 UI
2. 对 `ui.title`、`ui.description`、`action.params` 做 `$item` / `$user` 变量替换
3. 按 `action.type` 渲染对应样式的按钮
4. 点击按钮后调用 `action.rpc`，传入替换后的 `params`
5. 调用成功后刷新实体数据（重新 fetch item）

---

## 附录：相关协议

- [分类协议](./category.md) — `processId` / `processService` 的配置入口
- [QR 解析协议](./qr.md) — 扫码触发点，最终路由到持有流程的实体详情页
- [安全协议](./security.md) — 权限控制的完整规范
