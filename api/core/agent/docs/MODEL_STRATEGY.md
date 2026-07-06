# AI 模型路由与分发策略 (MODEL_STRATEGY)

本文档定义了 `agent` 服务在处理不同业务场景（Capability）时，底层模型（Provider）的选择策略。

## 策略原则
1.  **精度优先**：对于核心业务（如向量检索、结构化提取），优先选择高维或逻辑能力强的模型。
2.  **成本优化**：在精度相当的情况下，优先选择按 Token 计费且单价更低的模型。
3.  **地缘适配**：针对中文 OCR 或国内特有场景，保留 Qwen 等国内 Provider。

## 场景映射矩阵 (Scenario Matrix)

| 功能 (Capability) | 推荐模型 (Primary Model) | 备选模型 (Fallback) | 理由 (Rationale) |
| :--- | :--- | :--- | :--- |
| **文本对话 (text.chat)** | `gemini-1.5-flash` | `qwen-turbo` | Flash 系列响应极快，长上下文处理能力强。 |
| **语义向量 (embedding)** | **`gemini-embedding-2`** | `multimodal-embedding-v1` | **3072维超高精度，且按Token计费，成本约为阿里的 1/10。** |
| **图片识别 (vision.parse)** | `qwen-vl-plus` | `gemini-2.0-flash` | 千问对中文标签、国内商品细节的识别更加精准。 |
| **图片分类 (classify)** | `qwen-vl-plus` | `gemini-1.5-flash` | 自动识别商品类目，辅助快速入库。 |
| **标签/条码识别 (label)** | `qwen-vl-max` | `gemini-2.0-flash` | 处理复杂、模糊或非标的条码/说明书信息。 |
| **图片生成/修图 (image)** | `gemini-2.5-flash-image` | `wanx2.1-imageedit` | 支持直接生成背景、物体移除，适合电商场景。 |
| **意图识别 (purpose/focus)**| `gemini-1.5-flash` | `qwen-plus` | 将用户自然语言指令（如“查库存”）转为系统动作。 |
| **结构化提取 (parse)** | `gemini-2.0-flash` | `gpt-4o-mini` | 逻辑稳定性极强，严格遵循 JSON Schema。 |
| **文本翻译 (translate)** | `gemini-1.5-flash` | `qwen-turbo` | 跨语言业务数据转换，Gemini 的多语言语感较好。 |
| **语音识别 (audio)** | `gemini-2.0-flash` | `whisper-large` | 实时性好，多语言自动识别。 |

## 开发与运维场景 (DevOps Scenarios)

| 功能 | 推荐模型 | 理由 |
| :--- | :--- | :--- |
| **测试用例生成 (case)** | `gemini-1.5-flash` | 根据工作流 JSON 自动构造模拟业务数据。 |
| **类目属性建议 (suggest)** | `gemini-1.5-flash` | 根据类目路径预测商品属性 Key。 |

## 技术参数参考 (Technical Specs)

*   **Gemini Embedding 2**: 3072 Dimension, Multimodal Support.
*   **Qwen Multimodal Embedding V1**: 1024 Dimension, Fixed price per image.

## 动态调整机制
服务启动后会每 60 秒同步一次 Redis 配置 `SYSTEM:CONFIG:AI_MODELS`。如需临时切换模型（例如某 Provider 宕机），可通过管理后台直接修改 Redis，无需重启 `agent` 服务。

---
*Last Updated: 2026-04-27*
