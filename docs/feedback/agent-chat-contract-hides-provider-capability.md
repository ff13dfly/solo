# agent.chat 的方法契约藏住了 provider 的能力：没有 system prompt 的位置，schema 也不可见

- **来源**：awareness，2026-08-29，「AI 三段反馈接入 Solo AI 中枢」落地实测
- **场景**：一个匿名问卷类服务要把「用户记录 → 三段反馈 + 一颗 reflection seed」交给
  LLM。需求有两条硬约束：① 一大段**安全边界** system prompt（不做心理诊断、不贴人格
  标签、必须用不确定表达）；② 输出必须是固定六字段的 JSON。
- **依据分类**：
  - **本次实测**：bundle v1.2.7 代码阅读 + autocheck 门禁 + 端到端调用（见文末「实测状态」）。
  - **引用他项目**：colony 的 `api/apps/ant/logic/decide.js` 及其 permit 记录（走 agent.decide
    的现成范例，本文只引用其结论，未重跑）。

## 实测现象

### ① 契约声明的参数，比 provider 实际支持的少

`agent.chat` 的自省定义（bundle v1.2.7）：

```js
{ name: "agent.chat",
  params: [ { name: "text", type: "string", maxLength: 4e3 },
            { name: "model", type: "string", optional: true, maxLength: 64 } ],
  returns: ["success"], ... }
```

但 `api/core/agent/providers/gemini.js` 的实现是：

```js
async chat({ text, messages, model }) {
  if (messages && Array.isArray(messages)) {
    // role === 'system' → 映射成 Gemini 的 systemInstruction
    ...
    return { success: true, content: response2.text(), metadata: {...} };
  }
  // legacy 路径：PromptBuilder.buildChat(text, ...) → return { success:true, text: ... }
}
```

`messages` **能用、且能正确落到 systemInstruction**，但**契约里一个字都没有**。
调用方只读 `methods` 自省的话，只会得出「agent.chat 没有 system prompt 的位置」，
于是要么把边界约束拼进 4000 字的 `text`（被用户内容稀释，对安全类 prompt 是实质降级），
要么放弃 agent、自己拿 key 直连厂商——**恰恰是 agent guide 明令禁止的那条路**。

同型问题不止 chat：
- `parseText({ text, schema, model })` —— 契约只声明 `{text, model}`，`schema` 不可见
- `decide({ instruction, context, choices, schema, model })` —— 契约同样没有 `schema`

### ② 未声明参数之所以能用，是因为两处「不拦」，而不是因为它被支持

- 分发原样透传：`"agent.chat": (p) => Methods.agent.chat(p)`
- `library/validate.js` 的 `checkParams` **只遍历声明过的 items**，未声明字段既不报错
  也不剥离

⇒ 这是**未文档化的行为**。调用方依赖它，等于把自己钉在「Solo 永远不收紧参数校验」这个
假设上。而收紧参数校验恰恰是个合理的安全加固方向——真做了，所有这么用的服务会**同时**
静默失去 system prompt（走 legacy 路径，仍返回 200 + 内容，只是边界约束没了）。
**这种失败不会报错，只会让输出慢慢变得不合规。**

### ③ 返回字段二选一，且都不保证

bundle 自己的注释写着：

```
// Common across providers: only success + metadata. `text` (qwen, gemini legacy/error)
// and `content` (gemini messages path) are mutually-exclusive-ish and NOT guaranteed.
```

调用方必须写 `result.content || result.text`。这一条契约里有（returns_schema 两个都列了），
算是诚实的，但它和 ①② 叠加后的效果是：**同一个方法，传不同参数走不同 provider 路径，
返回字段名会变**，而这件事只有读 provider 源码才能知道。

### ④ 没有火山方舟 provider

`api/core/agent/providers/` 下是 `bitexing / gemini / mock / openai / qwen / removebg`。
awareness 的既定供应商是火山引擎方舟（OpenAI 兼容的 `/chat/completions`），
目前只能寄望于 `OPENAI_BASE_URL`（config.js 里注释为 "RESERVED: for non-standard endpoints"），
但 `providers/openai.js` 是否对响应形状做了 OpenAI 专有假设，未验证。

### ⑤ 限流单位是「身份」，而服务级 bot 只有一个身份

`agent.chat` 的 `limit: { window: 60, max: 5, by: "user" }`。服务经 relay 调用时全部用
同一个 bot 身份 ⇒ **整个服务共享每分钟 5 次**。20 人日频写入够用，但「同时点重新生成」
这类并发就会互相挤掉。契约里没有任何提示说这个 `by:"user"` 对 bot 调用意味着什么。

## awareness 的临时解法（app 区，已上线验证）

`api/apps/awareness/logic/ai-client.js` 传 `messages` 数组，并在注释里标明这是依赖未声明
行为、`assertShape` 兜底不能删。permit 形状（`deploy/provision-agent-bot.js`）：

```js
{ allow_all: false, services: { user: ['user.token.refresh'], agent: ['agent.chat'] } }
```

`user.token.refresh` 那条引用 colony 的记录：漏了它的症状是「当天全绿，token 轮转窗口
到了才断」。

## 建议（按价值排序）

1. **把 `messages` 补进 `agent.chat` 的契约**，`text` 与 `messages` 二选一（`text` 本就
   没标 required）。这是本文唯一的必要项——它决定「有没有 system prompt 的位置」，
   而那是安全类 prompt 的正确位置，不是风格偏好。
2. **把 `schema` 补进 `agent.text.parse` / `agent.decide` 的契约**。同理，provider 已实现。
3. **契约补全前，先别收紧参数校验**；补全后再收紧，并在 CHANGELOG 里点名这几个方法——
   否则会把现有调用方静默降级（见 ②）。
4. **给 `by:"user"` 的限流补一句 bot 语义说明**，或对 bot 身份单独计额。
5. **加 ark（火山方舟）provider**，或在 config.js 注释里写明 `OPENAI_BASE_URL` 接
   OpenAI 兼容端点的已验证范围。

## 实测状态

- 代码阅读结论（①②③④⑤）：bundle v1.2.7，均已在源码中定位到行。
- `messages` 透传的**端到端验证**：见本文档提交时 awareness 侧的验证记录；
  若该项未完成，①的结论仍为静态推断，triage 时请以实跑结果为准。

## 处理结论

（待 triage）
