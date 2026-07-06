# Agent AI 大模型中枢

服务名：`agent` | 端口：`8730`

---

## 服务定位

统一的 AI 能力路由层。接收来自 mobile/operator 等前端的能力请求，按 capability 分发到 Gemini / Qwen / OpenAI 等不同模型，屏蔽底层 Provider 差异。

---

## 模型选择（ADR-006）

三级优先级：

```
params.model（请求级）
  > SYSTEM:CONFIG:AI_MODELS（Redis 运行时配置）
  > 代码内置默认值（HARDCODED_DEFAULTS）
```

运行时配置写入 Redis key `SYSTEM:CONFIG:AI_MODELS`（JSON，TTL 60 秒缓存），可在 `portal/system` 中通过管理接口动态调整各 capability 的模型版本，无需重启服务。

---

## 模型选择策略 (Selection Strategy)

为了平衡成本、精度和响应速度，`agent` 服务采用多模型分发策略。详细的场景映射关系请参考：

👉 **[AI 模型路由与分发策略 (MODEL_STRATEGY.md)](./docs/MODEL_STRATEGY.md)**

---

## 主要 Capability

具体支持的方法和参数请参考：
- [API 定义 (data.md)](./docs/data.md)
- [模型策略 (MODEL_STRATEGY.md)](./docs/MODEL_STRATEGY.md)

---

## 环境变量 (Environment)

配置各 Provider 的 API Key 以启用对应能力：
- `GEMINI_API_KEY`: Google AI Studio
- `DASHSCOPE_API_KEY`: Alibaba Cloud DashScope
- `OPENAI_API_KEY`: OpenAI (or Compatible)
- `BITEXING_API_KEY`: Secondary Channel
