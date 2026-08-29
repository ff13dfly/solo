# agent 的 gemini provider 把所有错误吞成 `success: true`，RETRY_LATER 因此永不触发

- **来源**：awareness，2026-08-29，「AI 三段反馈接入 agent 中枢」端到端联调
- **场景**：`awareness.feedback.generate` 经 relay 调 `agent.chat`，要求返回可解析的
  结构化 JSON。联调中先后撞上三种失败，**三种都表现为同一个症状**。
- **依据分类**：**全部为本次实测**（bundle v1.2.8，本机全栈实跑，Router→relay→agent→
  gemini provider 五跳齐全，错误原文取自 `api/debug/SOLO_BUNDLE_debug.log` 与业务侧
  落库的 `lastError`）。无引用他项目内容。

## 实测现象

`api/core/agent/providers/gemini.js` 的 `chat()` catch 块（bundle v1.2.8）：

```js
} catch (error) {
  logger.error("[Gemini] Chat Error:", error);
  if (/429|Quota|limit/.test(error.message)) {
    return { success: true, text: "⚠️ **API Quota Exceeded** …", metadata: { error: "quota_exceeded" } };
  }
  if (/API key|403/.test(error.message)) {
    return { success: true, text: "⚠️ **Configuration Error** …", metadata: { error: "auth_failed" } };
  }
  return { success: true,
           text: `⚠️ **AI Service Error**\n\nI encountered an issue processing your request: ${error.message.substring(0, 100)}...`,
           metadata: { error: "unknown" } };
}
```

**三条分支全是 `success: true`。** 实测撞到的三种失败：

| 真实故障 | 调用方看到的 |
|---|---|
| `GEMINI_API_KEY` 未配置 | `success:true` + "⚠️ Configuration Error…" |
| 模型 404（见下）| `success:true` + "⚠️ AI Service Error: Error fetching from https://…/v1beta/mod..." |
| `TypeError: fetch failed`（连接层）| `success:true` + "⚠️ AI Service Error: …" |

### 后果一：`withRetryableError` 形同虚设

`logic/index.js` 里 `agent.chat` 明明包了：

```js
chat: async (params) => withRetryableError(async () => { … }, "agent.chat")
```

而 `withRetryableError` 对 `/connection|timeout|fetch|undici/` 的错误会抛
`RETRY_LATER(-32007, { retryable: true, retryAfter: 3000 })`。**但 provider 先把异常
catch 掉并正常返回了**，所以这段重试语义在 gemini 路径上**永远不会执行**。
实测那次 `TypeError: fetch failed` 正是它设计要覆盖的场景，调用方却拿到 `success:true`。

### 后果二：结构化调用方必然误判

任何要求 JSON 输出的调用方，拿到的是一段人类可读的英文 markdown。awareness 侧的报错
因此是「AI 返回不是合法 JSON」——**指向解析层，而真实原因在配置/网络层**。
排查得靠翻 agent 的 stdout 日志，而这一步只有知道要去翻的人才做得到。

### 后果三：真实错误被 `substring(0, 100)` 截断

落库的原文：

```
AI 返回不是合法 JSON：⚠️ **AI Service Error**
I encountered an issue processing your request: [GoogleGenerativeAI Error]: Error fetching
from https://generativelanguage.googleapis.com/v1beta/mod...
```

**关键信息（模型名 + 404 原因）恰好落在第 100 字之后**。同一次故障在 agent 日志里的
完整原文是：`[404 Not Found] models/gemini-1.5-flash is not found for API version v1beta`
——两者对照才知道是模型问题。

## 附带发现：`agent.chat` 的默认模型已被 Google 下线

bundle 模型表里 `agent.chat` → **`gemini-1.5-flash`**，实测该模型已从
`v1beta` 下线，任何不显式传 `model` 的 `agent.chat` 调用都会 404。

`GET /v1beta/models` 实测当前可用（2026-08-29，本 key 视角）：`gemini-2.5-flash`、
`gemini-2.5-flash-lite`、`gemini-2.5-pro`、`gemini-flash-latest`、`gemini-flash-lite-latest` 等。
`agent.decide` 的默认 `gemini-2.5-flash-lite` 仍有效。

⚠️ 另有一次 `gemini-2.5-flash`（思考模型，实测单次 6.0s、739 thoughtsTokenCount）在
agent 里报 `fetch failed`，而同机同模型直连原生端点 6.0s 成功；换 `gemini-2.5-flash-lite`
（4.2s）后未再复现。**只有一次样本，未证实是超时**，也没在 bundle 的 LLM 调用路径上找到
5s 量级的超时配置——此条仅作线索记录，不作结论。

## awareness 的临时解法（app 区）

- `.env` 显式指定 `AWARENESS_AI_MODEL='gemini-2.5-flash-lite'`，不吃默认模型。
- 业务侧把 AI 返回的原始内容整段落进 `feedback.lastError`（不进用户返回）。
  **能定位到根因全靠这一条**——否则线上只会剩一个 `status:'failed'`。

## 建议（按价值排序）

1. **catch 块改为 rethrow**，让 `withRetryableError` 拿到异常、按设计抛 `-32007`。
   这是唯一的必要项：现在的写法使框架自己的重试语义在最主要的 provider 上失效。
2. **退一步的最小修法**：至少把三条分支改成 `success: false` + `metadata.error`。
   调用方判 `success` 就能分流，不必解析英文文案。
3. **别截断 `error.message`**，或至少留 500 字。100 字对 Google 的错误消息来说，
   刚好切在 URL 中间、切掉原因。
4. **更新 `agent.chat` 的默认模型**（`gemini-1.5-flash` 已下线），并考虑在
   provider 初始化时对默认模型做一次可用性自检。
5. 若「友好错误文案」是为**聊天场景**（终端用户直接看回复）刻意设计的，那它和
   程序化调用的诉求正相反 —— 建议按调用来源区分：relay/bot 调用一律抛异常，
   只有面向人的会话路径才返回文案。同 provider 的 qwen/openai 是否有同样写法，未逐一核对。

## 处理结论（solo 侧）

**建议 1、3、4 采纳并落地（2026-08-30，v1.2.8 后 main，随下个 release 下发）**；
建议 2 被 1 覆盖；建议 5 核实后按 bug 处理、不做分流。

1. **chat catch 改 rethrow**（三条吞错分支整体删除）。核实确认 chat 是 gemini.js 全文件
   **唯一**吞成 `success:true` 的方法——extractProductInfo / parseImage / transcribeAudio /
   parseText / translate / psImage / generateImage / embedding 全部本来就 rethrow。
   修后 `withRetryableError` 的 `RETRY_LATER(-32007)` 在 gemini 路径复活。
2. 截断（建议 3）随吞错分支一并消失，错误按原文上抛。
3. **默认模型（建议 4）**：报告说的「bundle 模型表」实为 `logic/model_config.js` 的
   `HARDCODED_DEFAULTS`（resolve 优先级 params > Redis > hardcoded，中央表才是真源，
   provider 里的 `model || 'gemini-1.5-flash'` 只是兜底）。中央表六个 capability 钉死
   1.5-flash，全换 `gemini-2.5-flash`；provider 兜底七处 1.5-flash + 一处 `gemini-pro` 同换；
   decide 保持 2.5-flash-lite。**「初始化自检」不做**：修完后死模型的暴露方式就是当场
   404 如实上抛（不再伪装成功）——自检要提供的探测能力已由诚实报错承担，不值得加一次
   启动期外呼。
4. **建议 5 的核实结果**：qwen 本来就是正确写法（`_isNetwork` 才 rethrow、其余
   `success:false`）；openai 全部 rethrow；⚠️ 文案在全仓（api + portal + tests）**无任何
   消费者**——「聊天场景刻意设计」不成立，按 bug 处理，无需按调用来源分流。
5. **decide / classifyImage 刻意不动**：它们的 `success:false` 是设计好的 fail-soft
   （logic/index.js 明注 decide 不包 withRetryableError、降级走 `escalate:true` 而非抛错），
   与 chat 的 `success:true` 假成功性质不同。`gemini.decide` docstring 里「non-network」
   与实现矛盾的一句已改准。
6. 「2.5-flash 经 agent 一次 fetch failed」线索：按报告自己的标注（单样本、未证实）不采取
   动作；默认换 2.5-flash 与中央表既有选择一致（image/audio/text.parse/translate 早已运行
   在 2.5-flash 上）。
- **验证**：`node --check` 通过、autocheck static 绿（警告均为既有项）、agent CI 白名单
  5 套 38 测试全绿（临时 redis-stack :6399，跑完即关）。
- **awareness 侧动作**：升级后「显式指定模型防默认 404」的防御可去可留；`lastError`
  整段落库那条**继续保留**——错误原文不再截断后，这条只会更有用。
- 顺手记录：gemini.js 存在两个重名 `classifyImage`（前者为死代码、被后者遮蔽），本轮未动，
  已记 BACKLOG §3「agent provider 能力面」。
