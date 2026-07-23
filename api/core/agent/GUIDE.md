# agent 服务任务配方

> 由 fleet-standard `guide` 方法下发（经 Router：`system.guide { service: "agent" }`）。
> 与服务代码同目录、同 commit 更新。方法签名以 `methods` 自省为准，本文讲流程与语义。

## 这是什么

AI 大模型中枢：系统内所有 LLM 能力（对话、意图识别、图片解析、结构化决策）
收敛到这里，按能力路由到已配置的 provider（Gemini/Qwen/OpenAI…）。
调用方**不需要也不应该**自带 LLM key 直连厂商——统一走这里。

## 常用配方

### 图片 → 结构化产品信息（灌数据场景常用）

`agent.image.parse { image, mode: "product", images?, schema? }`
- `image`：base64。多图产品用 `images` 数组。
- `mode: "product"` 提取结构化产品信息；配 `schema` 可强制输出形状。
- 流程建议：**先** `agent.image.parse` 提字段 → 人工/规则校验 → **再**走
  storage 上传 + 业务实体 create（见 storage 服务的 guide）。

### 结构化决策（代理自动化的安全门）

`agent.decide { instruction, context?, choices?, confidence_threshold? }`
- `choices` 是**闭集反转门**：模型只能从你给的选项里挑，防注入/防发散。
- `context` 只放数据，**永远不要**把待决策文本当指令拼进 `instruction`。
- 低置信度或出集 → 返回 `escalate: true`，此时交人工，不要自动继续。

### 对话与意图

- `agent.chat { ... }`：通用对话（需认证；匿名/访客经 bot 账号走）。
- `agent.purpose { text?, image? }`：意图识别。

## 坑与约定

- **瞬态错误 -32007（RETRY_LATER）**：上游 LLM 限流/超时，退避后重试；
  连续失败再报告，别紧密循环打爆配额。
- LLM 调用**慢且贵**：批量场景控制并发（1-2 路），结果尽量落库复用，别重复解析同一张图。
- `agent.providers` / `agent.model.*` 是管理面（非公开），代理无需关心 provider 拓扑。
- 模型输出是概率性的：凡进业务库的字段，过一遍 schema 校验或人工抽检，
  并在写入时带来源标记（见 Router guide §4）。
