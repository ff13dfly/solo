# 视觉搜索协议 (Visual Search Protocol)

---

> [!WARNING]
> **实现状态:未实现(设计草案)。** 本文档描述的向量检索(`agent.image.embed`、`commodity.product.searchByImage`、RediSearch VECTOR 索引、`deploy/embed-products.js`)在当前代码中**均无实现**;且 `commodity` 等业务服务不存在(SOLO 是纯框架)。agent 服务真实存在的图像能力是 `agent.image.parse` / `agent.image.classify` 等(见 `api/core/agent/handlers/introspection.js`),但不含向量嵌入。判断以 `CLAUDE.md` §2 为准。

> **协议版本**: 1.0.0
> **状态**: 草案 (Draft)

---

## 1. 目标概述

本协议定义了 Solo·AI 系统中"以图识图"能力的标准接口、数据格式和行为规范。目标是让任意客户端通过上传一张产品照片，在数万级 SKU 库中快速定位匹配产品。

### 核心设计原则

- **向量驱动 (Embedding-First)**：图像通过多模态模型转化为稠密向量，利用余弦相似度进行语义级匹配。
- **索引即存储 (Index-is-Storage)**：向量直接存储在 RediSearch VECTOR 字段中，无需外部向量数据库。
- **分层检索 (Layered Retrieval)**：可选的类目预过滤 + 向量 KNN 搜索 + 参数/OCR 后置重排序，分层提升准确率。
- **读写分离 (Index vs Query)**：向量写入（预处理批量灌入）与向量查询（实时搜索）是两条独立链路。

---

## 2. 核心概念

| 概念 | 说明 |
|------|------|
| **Embedding** | 图像经多模态模型生成的 Float32 稠密向量（视觉指纹） |
| **imgVec** | 产品记录中存储 embedding 的标准字段名 |
| **Similarity Score** | 余弦相似度，范围 0~1，1 为完全一致 |
| **Visual Index** | RediSearch 中的 VECTOR 类型索引字段 |
| **Index Image** | 每个产品用于生成 embedding 的代表性图片（通常为主图） |

---

## 3. Embedding 规范

### 3.1 模型要求

Embedding 模型由 `agent` 服务统一封装，各消费方不直接调用底层 API。

| 参数 | 规范 |
|------|------|
| **接口** | `agent.image.embed`（注:该方法当前不存在） |
| **输入** | Base64 编码的 JPEG 图像（无 data-URL 前缀） |
| **输出** | `{ vector: number[], dim: number }` |
| **维度** | 由模型决定，当前系统中所有向量**必须同维度** |
| **距离度量** | Cosine Similarity（余弦相似度） |

**`agent.image.embed` 接口签名：**

```jsonc
// 请求
{
  "method": "agent.image.embed",
  "params": {
    "image": "<base64>",          // 必填，JPEG base64
    "model": "default"            // 可选，指定 embedding 模型
  }
}

// 响应
{
  "vector": [0.012, -0.034, ...], // Float32 数组
  "dim": 768,                     // 向量维度
  "model": "qwen-vl-embedding"    // 实际使用的模型名
}
```

### 3.2 输入预处理

调用方在发送图片至 `agent.image.embed` 前，**应**进行客户端预处理：

| 步骤 | 规范 |
|------|------|
| 长边限制 | ≤ 1024px（超出则等比缩放） |
| 格式 | JPEG |
| 质量 | 0.8 |
| 去底 | **可选**（搜索时不强制，索引写入时推荐） |
| 最大体积 | ≤ 1MB |

### 3.3 向量一致性约束

> [!IMPORTANT]
> 系统内所有 `imgVec` 字段**必须**由同一模型、同一维度生成。更换模型后，必须重建全量索引。

---

## 4. 写入流程（Index Pipeline）

### 4.1 触发时机

| 场景 | 触发方式 |
|------|----------|
| 新产品创建 | 产品图片上传后，自动触发 embed（异步） |
| 产品图片更新 | 图片变更后，重新 embed 并覆盖 `imgVec` |
| 全量重建 | 手动调用 `commodity.index.rebuild`（更换模型后必需） |
| 批量初始化 | 独立脚本 `deploy/embed-products.js`，支持断点续跑 |

### 4.2 预处理链

```
产品主图（Asset URL）
  → fetch 原始图片
  → (推荐) agent.image.ps 去底标准化
  → 长边 ≤ 1024px, JPEG 0.8
  → agent.image.embed → Float32[]
  → 写入 product.imgVec
  → RediSearch ON JSON 自动索引
```

### 4.3 RediSearch 存储

```
# Schema 新增字段（需重建索引）
$.imgVec  AS  img_vec  VECTOR  FLAT  6
  TYPE FLOAT32
  DIM {维度}
  DISTANCE_METRIC COSINE
```

**索引选型：**

| 方案 | 适用场景 |
|------|----------|
| `FLAT` | SKU < 10 万，精确匹配，索引构建快 |
| `HNSW` | SKU > 10 万，近似匹配，查询更快但索引构建慢 |

当前 Solo 产品规模约 6~10 万，**使用 FLAT**。

---

## 5. 查询流程（Search Pipeline）

### 5.1 接口定义

```jsonc
// 请求
{
  "method": "commodity.product.searchByImage",
  "params": {
    "image": "<base64>",          // 必填，查询图片
    "topK": 10,                   // 可选，返回数量，默认 10
    "threshold": 0.60,            // 可选，最低相似度阈值，默认 0.60
    "categoryId": "PRODUCT_CAT_A" // 可选，类目预过滤
  }
}

// 响应
{
  "items": [
    {
      "id": "kzHUfCsh",
      "sku": "HL-E05L-20W",
      "name": { "zh": "应急球泡灯-20W", "en": "Emergency Bulb 20W" },
      "score": 0.94,
      "assetIds": ["asset-abc"]
    }
  ],
  "total": 3,
  "model": "qwen-vl-embedding",
  "dim": 768
}
```

### 5.2 执行链

```
客户端上传图片
  → commodity.product.searchByImage
    1. 预处理：长边 ≤ 1024px, JPEG 0.8
    2. agent.image.embed → Float32[] queryVec
    3. (可选) 类目预过滤：FT.SEARCH @category:{catId}
    4. KNN 搜索：
       FT.SEARCH idx:commodity
         "*=>[KNN {topK} @img_vec $vec AS score]"
         PARAMS 2 vec <binary_vector>
         SORTBY score ASC
    5. 过滤 score < threshold 的结果
    6. (可选) 参数后置重排序
    7. 返回结果
```

### 5.3 分层检索策略

为提升准确率，系统支持三层可选的检索增强：

**Layer 1：类目预过滤 (Category Pre-filtering)**

利用产品分类索引缩小检索空间——从数万级降至千级。调用方可传入 `categoryId` 参数。若未传入，默认全库搜索。

若调用方不确定类目，可先调用 `agent.image.classify` 获得推荐类目：

```
查询图 → agent.image.classify → categoryId → 作为 searchByImage 参数
```

**Layer 2：向量 KNN (Core)**

核心搜索层，返回 Top-K 候选。

**Layer 3：参数后置重排序 (Parameter Post-ranking)**

在向量返回 Top-K 后，提取候选产品的规格参数（材质、尺寸等），与查询图中 OCR 识别到的文字进行交叉校验，重新排序。此层为**可选增强**，Phase 1 不实现。

---

## 6. 置信度与降级

### 6.1 分数区间

| 区间 | 含义 | 前端行为 |
|------|------|----------|
| `score >= 0.85` | 高置信度 | 直接展示最佳匹配，可自动选中 |
| `0.60 <= score < 0.85` | 中等置信度 | 展示候选列表，提示用户确认 |
| `score < 0.60` | 低置信度 | 不展示，提示"未找到精确匹配" |

### 6.2 降级策略

当视觉搜索无满意结果时（所有结果 `score < 0.60`），前端**应**自动降级到文字搜索：

```
searchByImage → 无结果
  → 提示用户："未找到视觉匹配，请尝试输入关键词"
  → 切换到 commodity.product.list({ keyword })
```

### 6.3 融合搜索（Phase 2）

未来可支持"视觉 + 文字"融合检索：

```
searchByImage + keyword
  → 向量 KNN 结果 ∩ 文字检索结果
  → 加权排序后返回
```

---

## 7. 跨服务职责划分

| 服务 | 职责 |
|------|------|
| **agent** | 提供 `agent.image.embed`（向量化）、`agent.image.classify`（辅助类目识别） |
| **commodity** | 存储 `imgVec` 字段、维护 RediSearch VECTOR 索引、暴露 `searchByImage` 接口 |
| **storage** | 提供原始图片的 URL/Base64 获取 |

```
调用方（任意客户端/服务）
    │
    ▼
commodity.product.searchByImage
    │
    ├── agent.image.embed（向量化查询图）
    ├── RediSearch KNN（检索）
    └── 返回匹配产品列表
```

> [!NOTE]
> 调用方**不应**直接调用 `agent.image.embed` 后自行拼接 KNN 查询。`commodity.product.searchByImage` 是唯一的搜索入口，确保预处理、阈值过滤和结果格式的一致性。

---

## 8. 安全与限制

| 约束 | 规范 |
|------|------|
| 查询图片体积 | ≤ 1MB |
| embedding 频率 | 单用户 ≤ 10 次/分钟 |
| 原始查询图 | **不持久存储**，仅在请求生命周期内存在 |
| 索引图来源 | 只索引 Storage 服务中的受管图片，不索引外部 URL |
| 向量数据 | 不对外暴露原始 `imgVec` 值，`searchByImage` 只返回产品信息和分数 |

---

## 9. 批量预处理规范

### 9.1 初始化脚本

```
deploy/embed-products.js

功能：
  1. 遍历所有 COMMODITY:PRODUCT:* 记录
  2. 跳过已有 imgVec 的记录（断点续跑）
  3. 获取第一张有效 assetId → fetch 图片
  4. agent.image.embed → 写入 imgVec
  5. 限速：≤ 5 QPS（避免 embedding API 超限）
  6. 进度日志：每 100 条输出一次

运行方式：
  node deploy/embed-products.js [--force]  # --force 重新处理已有 imgVec 的记录
```

### 9.2 增量更新

产品图片更新时，由 commodity 服务内部在 `product.update` 后异步触发 re-embed：

```
product.update({ id, assetIds })
  → 检测 assetIds 变更
  → _tasks: [{ service: 'commodity', method: 'commodity.internal.reembed', params: { id } }]
```

---

## 附录 A. 与相关协议的关系

| 协议 | 关系 |
|------|------|
| **Extraction Protocol** | 互补：extraction 从图中提取文字信息，visual search 用图匹配已有产品 |
| **Process Protocol** | 无直接关系 |
| **QR Protocol** | 消费方：QR 扫码端是视觉搜索的主要调用者之一 |
| **Category Protocol** | 辅助：类目预过滤依赖分类体系 |

## 附录 B. 应用场景目录

| 场景 | 客户端 | 优先级 |
|------|--------|--------|
| QR 标签扫描 → 快速绑定 | `client/qr` | P0 |
| B2B 以图找商品 | `client/b2b` | P1 |
| 展厅机器人视觉识别 | `client/showroom` | P2 |
| 同系列关联推荐 | `client/series` | P2 |
| Operator 图片上传后自动索引 | `portal/operator` | P1（写入侧） |
| Desktop AI 助手以图识物 | `client/desktop` | P2 |
| 供应商以图对货 | `client/order` | P3 |

## 附录 C. Embedding 模型选型参考

| 模型 | 维度 | 优势 | 劣势 |
|------|------|------|------|
| 阿里 Qwen VL Embedding | 768 | 已有 API Key，同平台接入成本低 | 需确认是否支持图像输入 |
| Jina AI Embeddings | 768 | 免费额度，REST 接口简单 | 第三方依赖 |
| Google `multimodalembedding@001` | 1408 | 高维高精度 | 需开通 Vertex AI，区域限制 |

> [!NOTE]
> 最终模型选定后，需更新本协议第 3 节的维度参数，并在全量重建索引后方可上线。
