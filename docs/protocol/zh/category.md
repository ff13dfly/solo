# 联邦分类协议 (Federated Category Protocol)

---

> **协议版本**: 1.0.0  
> **状态**: 稳定 (Stable)  
> **作者**: Fuu  
> **许可证**: Apache 2.0

---

## 摘要

本协议定义了微服务分类的联邦注册与全局发现机制，采用"本地所有权，全局发现"模式。

## 1. 简介

### 1.1 目的

本协议旨在解决微服务架构中分类信息的统一管理问题，实现跨服务的分类共享与发现。

### 1.2 设计原则

| 原则 | 说明 |
|------|------|
| **本地所有权** | 分类由所属服务管理 |
| **全局发现** | Router 作为元数据中心 |
| **运行时创建** | 分类在运行时动态注册 |
| **大小写规范** | Key 统一存储为大写 |

## 2. 术语定义

| 术语 | 定义 |
|------|------|
| **Category** | 分类维度（如客户等级、行业类型） |
| **Router** | 中央路由器，管理全局元数据 |
| **RediSearch** | Redis 全文搜索模块 |

---

## 3. 核心设计理念
本协议采用 **"Local Ownership, Global Discovery" (本地所有权，全局发现)** 模式。
*   **注册**：微服务启动时**仅注册服务本身**，不携带分类信息。
*   **创建**：分类信息在**运行时 (Runtime)** 由管理员动态创建。
*   **发现**：Router 作为动态元数据中心，保证全局 Key 的唯一性。
*   **Key 规范**：为了保证唯一性，所有 Key 在存储和比较时均**忽略大小写**，并统一转换为**大写 (UPPERCASE)** 存储。例如 `role` 和 `Role` 会被视为同一个 Key `ROLE`。

---

## 2. 通信协议 (Communication Protocol)

### 2.1 服务启动 (Handshake)
微服务启动并向 Router 握手时，**不再**提交 `categories` 字段。保持握手包的轻量级。

**请求 (Service -> Router)**:
`POST /jsonrpc`
```json
{
  "jsonrpc": "2.0",
  "method": "system.register",
  "params": {
    "service": "crm",
    "url": "http://crm-service:3000/jsonrpc",
    "methods": [ ... ]
  },
  "id": 1
}
```

### 2.2 动态创建与自动预置 (Dynamic Creation & Auto Provisioning)
分类的生命周期通常始于管理员操作，但也支持服务启动时的自动预置。

#### A. 管理员动态创建 (Admin Manual)
1.  **管理员操作**: 在管理后台点击"新建分类"。
2.  **原子预留**: 调用 `system.category.reserve`。
3.  **结果处理**: 成功则创建，失败则报错。

#### B. 服务启动自动预置 (Startup Auto-Provisioning)
适用于系统核心分类（如“用户角色”、“基础标签”）。
1.  **配置定义**: 在 `config.js` 的 `seeds.categories` 中定义默认分类结构。
2.  **启动检查**: 服务启动时（Listen 端口前），检查 Redis 中是否存在该 Key。
3.  **自动创建**: 若不存在，则自动写入默认配置，并向 Router 尝试 Reserve（这一步通常是隐式的，因为直接写入了 Redis，Router 最终会通过 Redis 共享感知到）。

**注意**: 自动预置应仅在 `Key` 不存在时执行，避免覆盖运行时修改。

### 2.3 客户端/其他服务查询
**请求**: `system.category.locate({ key: "LEVEL" })`

**响应**:
```json
{
  "key": "LEVEL",
  "ownerService": "crm",
  "endpoint": "http://crm-service:3000/jsonrpc", 
  "searchIndex": "idx:crm"  // 约定: idx:{serviceName}
}
```
*   `searchIndex` 采用固定约定 `idx:{serviceName}`，Router 无需额外配置。

### 2.4 软删除与名称重用 (Soft Delete & Reuse)

1.  **软删除**:
    *   管理员删除分类时，CRM 调用 Router: `system.category.delete({ key: "LEVEL" })`
    *   Router **不删除** Hash Field，仅更新 `status` 为 `DELETED`。
2.  **名称重用**:
    *   当新服务尝试 `reserve` 一个已存在的 Key 时，Router 检查 `status`。
    *   若为 `DELETED`，允许覆盖，新 Owner 生效，`status` 重置为 `ACTIVE`。

### 2.5 系统重启与状态恢复 (System Recovery)

1.  **Router 重启**: 直接读取 Redis，瞬间就绪。
2.  **微服务重启**: 分类数据由 Redis 保证，无需重新同步。
3.  **Redis 灾难恢复**: 依赖 AOF/RDB 持久化。

---

## 3. 数据结构 (Data Structures)

### 3.1 Router 端 (Global Registry)
*   **Key**: `SYSTEM:REGISTRY:CATEGORIES`
*   **Type**: `Hash`
*   **Field/Value** (示例):
    ```json
    "LEVEL": {
      "owner": "crm",
      "scope": "GLOBAL",
      "type": "TREE",
      "status": "ACTIVE",
      "desc": "客户等级分类，用于区分服务优先级与权益",  // 维度级语义描述
      "createdAt": 1704614400,
      "updatedAt": 1704700800,
      "createdBy": "admin@crm"
    }
    ```
*   **用途**: `desc` 字段供前端展示 Tooltip 或筛选器标题，帮助用户理解该分类维度的含义。

### 3.2 Service 端 (Business Data)
*   **Key**: `CRM:CONFIG:CATEGORY:LEVEL`
*   **Content**:
    ```json
    [
      { 
        "id": "LVL_01", 
        "label": { "zh": "VIP客户", "en": "VIP Customer" },
        "parentId": null,
        "desc": "年消费超过 100k 的高价值客户，享有 24h 专属客服支持",
        "keywords": [
          { "word": "VIP", "source": "seed" },
          { "word": "高价值", "source": "seed" },
          { "word": "大客户", "source": "ai", "count": 5 }
        ],
        "createdAt": 1704614400
      },
      { 
        "id": "LVL_02", 
        "label": { "zh": "普通用户", "en": "Standard" },
        "parentId": null,
        "desc": "普通注册用户，标准服务SLA",
        "keywords": [
          { "word": "普通", "source": "seed" },
          { "word": "标准", "source": "seed" }
        ],
        "createdAt": 1704614500
      }
    ]
    ```

#### keywords 字段定义

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| `word` | `string` | 关键词 |
| `source` | `enum` | `seed` (人工种子) 或 `ai` (AI 学习) |
| `count` | `number` | 仅 AI 来源时存在，表示成功触发次数 |

**设计原则**:
*   `desc`: 固定的权威语义描述，人工定义，不可被 AI 修改。
*   `keywords`: 动态关键词列表，支持 Phase 3 AI 自动扩充。
*   AI 仅能增加 `source: "ai"` 的关键词，不能删除任何关键词。

### 3.3 实体应用 (Entity Usage)
```json
{
  "id": "uuid-123",
  "name": "Acme Corp",
  "categories": {
      "LEVEL": "LVL_01",
      "INDUSTRY": "IND_002"
  }
}
```

### 3.4 语义增强 (Semantic Enhancement for AI)

*   `label` 给人看，`desc` 给 AI 看。
*   `desc` 可后期向量化（Embedding），实现语义搜索。

### 3.5 流程应用 (Workflow Usage)
Workflows 引用分类时，必须使用 Key-Value 结构，其中 Key 必须是注册表中的 `Category Key`。

```json
{
  "id": "onboarding_employee",
  "name": "Employee Onboarding",
  "category": {
      "TYPE": "HR"
  }
}
```
*   `TYPE`: 注册表中的 Category Key (e.g. `SYSTEM.REGISTRY.CATEGORIES["TYPE"]`)
*   `HR`: 该分类维度下的具体值 (Value ID or Code)

---

## 4. 层级分类与外部扩展 (Hierarchy & Extensions)

虽然 Router 的全局分类中心是一个扁平的键值注册表，但本协议通过**前缀命名法**与**元数据扩展**原生支持无限极多层分类及外部系统映射。

### 4.1 前缀命名法树形结构 (Prefix Naming Hierarchy)

**核心推荐策略**: 使用 `_` 作为层级分隔符，利用 Key 的前缀表达物理或逻辑的层级包含关系。

**注册示例**:
```json
// 一级大类
{ "key": "COM_HARDWARE", "desc": "五金配件" }
// 二级子类
{ "key": "COM_HARDWARE_SWITCH", "desc": "开关面板" }
// 三级子类
{ "key": "COM_HARDWARE_SWITCH_SMART", "desc": "智能系列" }
```

**对 RediSearch 的极速优势**:
当需要查询某个大类（如“五金配件”）下的所有子孙商品时，利用 RediSearch 的 `TAG` 字段通配符特性，只需执行极度轻量级的前缀匹配查询，**无需进行任何昂贵的递归计算或连表查询**：

`FT.SEARCH idx:commodity "@categories:{COM_HARDWARE*}"` 
*(此语句能瞬间匹配出所有隶属于该前缀分支的叶子节点商品)*

### 4.2 外部系统扩展映射 (External Meta Extensions)

当注册分类（如从 ERP、第三方供应链自动同步）时，可使用新增的 `meta` 字典来存储外部系统专属的原始映射标识。Router 与核心查询机制**不会解析**，但随取随用。

**保留映射示例**:
```json
{
  "key": "COM_HARDWARE",
  "desc": "五金配件",
  "meta": {
    "erpCategoryId": "0101",        // 第三方用友 ERP 的分类内码
    "dingtalkDepartmentId": "D_889" // 第三方企微/钉钉需要联动的部门关联等
  }
}
```

---

## 5. RediSearch 集成

### 4.1 索引创建
```redis
FT.CREATE idx:crm 
    ON JSON 
    PREFIX 1 "CRM:COMPANY:" 
    SCHEMA 
        $.name AS name TEXT 
        $.categories.* AS categories TAG
```

### 4.2 查询示例
`FT.SEARCH idx:crm "@categories:{LVL_01}"`

---

## 5. 错误码规范 (Error Codes)

| 错误码 | 名称 | 描述 |
| :--- | :--- | :--- |
| `-32010` | `CATEGORY_KEY_CONFLICT` | Key 已被其他服务占用 (status=ACTIVE) |
| `-32011` | `CATEGORY_NOT_FOUND` | 查询的 Key 不存在 |
| `-32012` | `CATEGORY_PERMISSION_DENIED` | 非 Owner 尝试修改/删除 |

---

## 6. 事件通知 (Event Notification)

> **在共享 Redis 架构下，此功能为可选扩展。**

由于所有微服务连接同一 Redis 实例，分类变更直接写入 Redis 后**立即生效**。其他服务的下一次读取自然获取最新数据，无需额外通知机制。

**仅当以下场景时考虑启用**：
*   服务启用了本地内存缓存（LRU），需要实时失效。
*   未来扩展为多 Redis 实例架构。

**预留接口** (如需启用):
*   Channel: `system:category:events`
*   Payload: `{ "event": "CREATED|DELETED", "key": "LEVEL", "owner": "crm" }`

---

## 7. 总结
1.  **启动快**: 微服务无需预加载分类。
2.  **灵活性**: 分类按需注册。
3.  **一致性**: Router + Redis 保证全局唯一。
4.  **可审计**: 元数据包含创建/修改时间与操作人。
5.  **可扩展**: 多语言、语义描述、事件广播均已预留。
