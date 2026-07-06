# 报表协议 (Report Protocol)

> [!WARNING]
> **实现状态：未实现（设计草案）。** 本文档描述的报表 DSL 执行引擎在当前代码中**没有任何对应实现**（见 `todo.md` P3）。代码里现有的 `system.report` 是一个 AI 反馈收集接口（`api/router/handlers/report.js`），与本协议描述的报表 DSL 无关，请勿混淆。判断“什么已实现”以 `CLAUDE.md` §2 真实服务清单为准。

---

> **协议版本**: 1.0.0  
> **状态**: 草案 (Draft) — 未实现  
> **作者**: Fuu  
> **许可证**: Apache 2.0

---

## 摘要

本协议定义了一种基于 JSON 的报表领域特定语言 (DSL)，实现"Report as Code"的声明式报表配置。

## 1. 简介

### 1.1 目的

本协议旨在解耦报表的定义与执行，使业务人员或 AI Agent 能够在不修改后端代码的情况下创建复杂的业务分析报表。

### 1.2 设计原则

| 原则 | 说明 |
|------|------|
| **Zero-Code** | 新增报表无需编码，仅需配置 |
| **Immutability** | 只读操作，严禁副作用 |
| **Safety** | 内置超时机制与最大深度限制 |

## 2. 术语定义

| 术语 | 定义 |
|------|------|
| **DSL** | Domain Specific Language，领域特定语言 |
| **Pipeline** | 数据处理流水线 |
| **View** | 视图展现配置 |

---

## 3. 报表定义 (Report Definition)

一个完整的报表配置对象 (`ReportDefinition`) 包含以下核心字段：

```typescript
interface ReportDefinition {
  // 基础元数据
  id: string;             // 唯一标识 (e.g., "USER_GROWTH_MONTHLY")
  name: string;           // 展示名称
  version: string;        // 配置版本 (e.g., "1.0")
  accessControl: {
    roles: string[];      // 允许访问的角色 (e.g., ["ROOT", "MANAGER"])
  };
  cacheTTL: number;       // 结果缓存时间 (秒)，0 为不缓存
  
  // 1. 数据摄取层
  source: DataSource;

  // 2. 数据处理层 (ETL)
  pipeline: PipelineOp[];

  // 3. 视图展现层
  view: ViewConfig;
}
```

---

## 3. 动态参数与数据源 (Source & Params)

支持通过 `${params.key}` 语法注入运行时参数。

### 3.1 数据源定义
```json
"source": {
  "service": "user",        // 目标微服务
  "method": "list",         // RPC 方法
  "params": {
    "limit": 5000,
    // 动态注入: 运行时传入 { startDate: 1625097600000 }
    "createdAfter": "${params.startDate}" 
  },
  "path": "items"           // 结果集提取路径 (Optional)
}
```

### 3.2 默认参数策略
如果运行时未提供参数，引擎将抛出 `MISSING_PARAM` 错误，除非配置了 `defaults` (TBD)。

---

## 4. 处理流水线 (Pipeline)

引擎按照数组顺序线性执行算子 (Stream Processing)。

### 4.1 基础算子
*   **Filter (过滤)**
    ```json
    { "op": "filter", "rules": [{ "field": "status", "op": "eq", "value": "active" }] }
    ```
*   **Map (映射/计算)**
    ```json
    { 
      "op": "map", 
      "fields": {
        "month": { "source": "createdAt", "format": "date:YYYY-MM" },
        "total": { "expression": "$price * $quantity" }
      } 
    }
    ```
*   **Sort (排序)** & **Limit (截断)**

### 4.2 聚合算子
*   **Group (分组)**
    ```json
    {
      "op": "group",
      "by": ["month", "type"],
      "metrics": [
        { "type": "count", "as": "count" },
        { "type": "sum", "field": "amount", "as": "sum_amt" }
      ]
    }
    ```

### 4.3 高级算子 (Advanced)
*   **Unwind (展开)**: 将数组字段拆分为多行。
    ```json
    { "op": "unwind", "field": "tags" }
    ```
*   **Lookup (关联)**: *[Experimental]* 跨服务/表关联 (慎用，建议优先在 Source 层解决)。
    ```json
    {
      "op": "lookup",
      "from": "ASSET_CACHE", // 必须是从 Redis 缓存或快照中 Lookup
      "localField": "assetId",
      "foreignField": "id",
      "as": "asset_detail"
    }
    ```

---

## 5. 视图配置 (View)

定义前端 `SummaryCard` 或 `Chart` 组件的渲染方式。

```json
"view": {
  "type": "chart:bar", // bar, line, pie, table, stat
  "config": {
    "xAxis": "month",
    "yAxis": ["count"],
    "colors": ["primary"],
    "title": "Monthly User Growth"
  }
}
```

---

## 6. 异常处理与容错

### 6.1 策略矩阵
| 场景 | 行为 | 返回值 |
|:---|:---|:---|
| **Empty Data** | 立即停止 Pipeline | `{ labels: [], datasets: [] }` |
| **RPC Timeout** | 重试 1 次 -> 失败 | HTT 500 `UPSTREAM_ERROR` |
| **Missing Field** | Prune (自动剔除) | `null` / `undefined` |
| **Calc Error** | 表达式除零等 | `null` |

### 6.2 安全限制
*   **Max Pipeline Depth**: 最大 10 个算子。
*   **Max Execution Time**: 单次分析最大执行时间 5000ms (5秒)。
*   **Memory Limit**: 单次内存占用警告阈值 50MB。

---

## 7. 完整示例

```json
{
  "id": "q4_sales_report",
  "name": "Q4 销售统计",
  "accessControl": { "roles": ["ADMIN", "SALE_MANAGER"] },
  "cacheTTL": 300,
  "source": {
    "service": "order",
    "method": "list",
    "params": { 
      "start": "${params.q4_start}", 
      "end": "${params.q4_end}" 
    }
  },
  "pipeline": [
    { "op": "filter", "rules": [{ "field": "status", "op": "eq", "value": "paid" }] },
    { "op": "map", "fields": { "owner": { "source": "userId", "lookup": "USER_CACHE" } } },
    { "op": "group", "by": ["owner"], "metrics": [{ "type": "sum", "field": "amt", "as": "total" }] },
    { "op": "sort", "field": "total", "order": "desc" },
    { "op": "limit", "value": 10 }
  ],
  "view": {
    "type": "chart:bar",
    "config": { "xAxis": "owner", "yAxis": ["total"] }
  }
}
```
