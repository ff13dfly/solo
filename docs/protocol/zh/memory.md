# 记忆协议 (Memory Protocol)

---

> **协议版本**: 1.1.0  
> **状态**: 稳定 (Stable)  
> **作者**: Fuu  
> **许可证**: Apache 2.0

---

## 摘要

本协议定义了客户端 Agent 框架内的记忆管理机制，用于提升实体识别和意图匹配的准确率。记忆分为两个层级：

- **短期记忆 (Short-Term Memory, STM)**：三种 TTL 淘汰的上下文（操作 / 对话 / 修正），见 §3.1–3.3。
- **长期记忆 (Long-Term Memory, LTM)**：持久层，由短期实体**被重复引用时固化**而来，无 TTL、跨会话存活，见 §3.4。

两个层级统一经 `formatMemoryString()` 注入 `agent.purpose` / `agent.focus`。

## 1. 简介

### 1.1 目的

本协议旨在解决 AI Agent 交互中的 **上下文感知** 问题。通过维护用户的即时操作上下文，Agent 能够更准确地理解指代词（如"它"、"那个"）和隐式引用，从而提供更自然的对话体验。

### 1.2 设计原则

| 原则 | 说明 |
|------|------|
| **连续性假设** | 用户的行为具有连续性，最近操作的实体更可能是下一次操作的目标 |
| **客户端优先** | 记忆状态由客户端维护，降低服务端复杂度 |
| **隐私保护** | 敏感信息在存入记忆前需进行脱敏处理 |
| **分层生命周期** | 短期记忆 (STM) 有 TTL、过期自动清除；长期记忆 (LTM) 无 TTL，靠重复固化与容量上限管理 |
| **重复即固化** | 被重复引用的实体由短期晋升为长期记忆——重复是"值得长期记住"的信号，无需显式标记 |

### 1.3 与相关协议的关系

本协议与 [工作流协议](./workflow) 中的 Focus 状态机协同工作：

```
用户输入 + 记忆上下文 → 意图匹配 → Workflow ID → Focus 状态
```

- **Memory Protocol**: 提供"背景"上下文，帮助识别触发哪个 Workflow
- **Focus State**: 管理"前台"任务，引导用户补全缺失参数

## 2. 术语定义

| 术语 | 定义 |
|------|------|
| **STM** | Short-Term Memory，短期记忆（TTL 淘汰） |
| **LTM** | Long-Term Memory，长期记忆（持久，按重复固化） |
| **LRU** | Least Recently Used，最近最少使用缓存策略 |
| **FIFO** | First In First Out，先进先出队列 |
| **TTL** | Time To Live，生存时间 |

## 3. 记忆层级与上下文类型

本协议定义两个记忆层级：

- **短期记忆 (STM)**：下述三种上下文（§3.1–3.3），均 TTL 淘汰。
- **长期记忆 (LTM)**：持久层（§3.4），由短期实体按重复固化而来。

短期记忆包含三种上下文类型：

### 3.1 操作上下文 (Operational Context)

捕获用户在 UI 中执行的显式操作（搜索、创建）。

#### 3.1.1 触发条件

| 操作类型 | 触发时机 |
|----------|----------|
| 搜索 | 用户从搜索结果或列表中选择一个实体 |
| 创建 | 创建表单成功提交并返回实体 ID |

#### 3.1.2 数据结构

```json
{
  "stuff": [
    { "id": "STUFF_001", "name": "物品名称", "stamp": 1704614400 }
  ],
  "warehouse": [
    { "id": "WH_001", "name": "仓库名称", "stamp": 1704614500 }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 实体唯一标识符 |
| `name` | string | 实体可读名称 |
| `stamp` | number | 用户交互时间戳 (Unix 秒) |

#### 3.1.3 存储策略

- **存储方式**: 客户端 LRU 缓存
- **容量限制**: 每类型最多 5 条
- **过期时间**: 5 分钟（滑动窗口）

#### 3.1.4 命中更新策略

当用户再次访问已存在于记忆中的实体时，系统应执行以下操作：

1. **更新时间戳**: 将该实体的 `stamp` 更新为当前时间戳
2. **LRU 排序**: 将该实体移至队列前端（最近使用位置）
3. **TTL 重置**: 重置该实体的 5 分钟 TTL 计时器

这确保了频繁访问的实体始终保持在记忆前端，提高识别准确率。

**实现要点**:
- 检测实体是否已存在于当前类型的记忆列表中
- 若存在，先移除旧记录，再以新时间戳添加到队首
- 若不存在，直接添加到队首

#### 3.1.5 过期延后机制

操作上下文采用**滑动窗口 TTL 策略**：

- 每次实体被访问（搜索、创建、再次点击）时，TTL 计时器重置为 5 分钟
- 而非从首次添加时起固定 5 分钟过期
- 这确保正在活跃操作的实体不会意外过期

**示例时间线**:

```
T0:00 - 用户搜索 "仓库A" → 添加到记忆，过期时间 T0:05
T0:03 - 用户再次点击 "仓库A" → 更新时间戳，过期时间延后至 T0:08
T0:07 - 用户第三次访问 "仓库A" → 过期时间延后至 T0:12
T0:13 - 未再访问，实体从记忆中清除
```

**优势**:
- 避免用户正在操作的实体突然失效
- 自动淘汰不再使用的实体
- 无需手动管理记忆生命周期

### 3.2 对话上下文 (Conversation Context)

维护用户与 Agent 交互的顺序历史。

#### 3.2.1 触发条件

用户发送消息或 Agent 响应时触发。

#### 3.2.2 数据结构

```json
{
  "history": [
    { "role": "user", "content": "查找 Alpha 项目", "stamp": 1704614400 },
    { "role": "agent", "content": "找到 3 个相关项目", "stamp": 1704614401 }
  ]
}
```

#### 3.2.3 存储策略

- **存储方式**: FIFO 队列
- **容量限制**: 最近 5 轮对话
- **过期时间**: 30 分钟 (滑动窗口)

### 3.3 修正上下文 (Correction Context)

保留失败、取消或歧义的意图执行状态。

#### 3.3.1 触发条件

| 事件 | 说明 |
|------|------|
| 歧义 | Agent 请求用户澄清 |
| 失败 | 执行返回需用户干预的错误 |
| 取消 | 用户取消待处理的确认 |

#### 3.3.2 数据结构

```json
{
  "draftIntent": {
    "workflow_id": "send_email_v1",
    "params": { "subject": "会议通知" },
    "missing": ["recipient"],
    "stamp": 1704614400
  }
}
```

#### 3.3.3 存储策略

- **存储方式**: 单槽位
- **过期时间**: 意图成功执行或用户显式取消后立即清除

### 3.4 长期记忆 (Long-Term Memory, LTM)

与上述三种短期上下文不同，LTM 是**持久层**：无 TTL、跨会话存活，只在实体被**重复引用**时由短期晋升而来——重复即"值得长期记住"的信号，而非靠时间或显式标记。

#### 3.4.1 固化（晋升）条件

- 当一个实体**再次进入操作上下文**（即写操作上下文时检测到该 `id` 已存在 = re-reference）时，将其晋升进 LTM。
- 即：**第一次引用进短期，第二次引用即固化进长期。** 重复是唯一的固化信号。

#### 3.4.2 数据结构

```json
{
  "longterm": [
    { "type": "warehouse", "id": "WH_001", "name": "仓库A", "hits": 3, "stamp": 1704614400 }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 实体类型 |
| `id` | string | 实体唯一标识符 |
| `name` | string | 实体可读名称 |
| `hits` | number | 累计固化/再引用次数（每次再晋升 +1） |
| `stamp` | number | 最近一次固化时间戳 |

#### 3.4.3 存储策略

- **存储方式**: 持久列表（按最近固化时间置顶，LRU 切片）
- **容量限制**: 最多 20 条（超出淘汰最旧）
- **过期时间**: **无 TTL** —— TTL 清理任务**不触碰** LTM；仅受容量上限与显式 `clearAll` 影响
- **持久化**: localStorage（`solomind:memory:longterm`），跨会话存活

#### 3.4.4 注入与消费

LTM 与三种 STM 上下文一起，经 `formatMemoryString()` 渲染为 `[Long-Term Memory]` 段（取前 8 条，格式 `type: name (id)`），注入 `agent.purpose` / `agent.focus`。

## 4. API 规范

### 4.1 方法签名

```javascript
agent.purpose(prompt, memory)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | ✅ | 用户输入文本 |
| `memory` | string | ❌ | 格式化后的记忆上下文字符串 |

### 4.2 Memory 参数格式

`memory` 参数接收格式化后的字符串（非 JSON 对象），以便 LLM 直接消费。

**示例**:

```javascript
// 对话上下文
const memory = "User: 查找 Alpha 项目\nAgent: 找到 3 个项目";
agent.purpose("打开第一个", memory);

// 修正上下文
const memory = "Previous: send_email, missing: recipient";
agent.purpose("发给 Bob", memory);
```

### 4.3 设计理由

| 选择 | 理由 |
|------|------|
| 字符串格式 | 允许前端摘要/修剪历史，减少 Token 开销 |
| 前端格式化 | 将后端与特定前端状态结构解耦 |

## 5. 实现指南

### 5.1 前端实现

```typescript
interface MemoryContext {
  operational: Map<string, Entity[]>;  // 短期 · LRU 缓存
  conversation: Message[];              // 短期 · FIFO 队列
  correction: DraftIntent | null;       // 短期 · 单槽位
  longterm: LongTermItem[];             // 长期 · 持久（无 TTL）
}

function formatMemory(ctx: MemoryContext): string {
  const parts: string[] = [];
  
  // 操作上下文（短期）
  if (ctx.operational.size > 0) {
    parts.push(`[Recent Operations]\n${formatOperational(ctx.operational)}`);
  }
  
  // 对话上下文（短期）
  if (ctx.conversation.length > 0) {
    parts.push(`[Conversation History]\n${formatConversation(ctx.conversation)}`);
  }
  
  // 修正上下文（短期）
  if (ctx.correction) {
    parts.push(`[Pending Intent]\n${JSON.stringify(ctx.correction)}`);
  }

  // 长期记忆（持久，取前 8 条）
  if (ctx.longterm.length > 0) {
    const ltm = ctx.longterm.slice(0, 8).map(it => `${it.type}: ${it.name} (${it.id})`).join('\n');
    parts.push(`[Long-Term Memory]\n${ltm}`);
  }
  
  return parts.join('\n\n');
}
```

### 5.2 过期策略

| 上下文类型 | TTL | 清除条件 |
|------------|-----|----------|
| 操作上下文（短期） | 5 分钟 | 超时或显式切换 |
| 对话上下文（短期） | 30 分钟 | 滑动窗口超时 |
| 修正上下文（短期） | 即时 | 意图成功或取消 |
| 长期记忆（LTM） | **无 TTL** | 仅容量淘汰（≤20，LRU）或显式 `clearAll` |

### 5.3 隐私保护

实现者 **必须 (MUST)** 在存入记忆前过滤敏感信息：

- 信用卡号 (符合 Luhn 算法的 13-19 位数字)
- 手机号码 (11 位数字)
- 身份证号 (18 位)
- 密码字段

## 6. 安全考虑

### 6.1 风险矩阵

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Token 开销 | 成本增加 | 限制字符串长度 (≤500 字符) |
| 上下文污染 | 错误匹配 | 激进的 TTL 策略 |
| 数据陈旧 | 404 错误 | 捕获错误后重新搜索 |
| 隐私泄露 | 合规风险 | 强制脱敏处理 |

### 6.2 合规要求

- 记忆数据 **不得 (MUST NOT)** 持久化到服务端
- 用户 **应当 (SHOULD)** 能够随时清除本地记忆

## 7. 参考实现

| 组件 | 文件 | 说明 |
|------|------|------|
| useMemory Hook | `client/mobile/src/hooks/useMemory.ts` | 记忆状态管理 |
| IntentMatcher | `client/mobile/src/services/IntentMatcher.js` | 意图匹配集成 |

## 附录 A. 变更日志

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| 1.1.0 | 2026-06-14 | 升级为「记忆协议（含 STM + LTM）」：新增长期记忆 (LTM) 层（§3.4，重复即固化、无 TTL、跨会话）；回填 `formatMemoryString` 的 `[Long-Term Memory]` 段；修正操作上下文容量（10→5，对齐代码） |
| 1.0.1 | 2026-01-21 | 新增命中更新策略和过期延后机制说明 |
| 1.0.0 | 2026-01-19 | 初始版本 |

## 附录 B. 术语表

| 术语 | 英文 | 说明 |
|------|------|------|
| 短期记忆 | Short-Term Memory | 临时性的上下文存储 |
| 操作上下文 | Operational Context | 用户 UI 操作产生的记忆 |
| 对话上下文 | Conversation Context | 对话历史产生的记忆 |
| 修正上下文 | Correction Context | 意图修正产生的记忆 |
| 长期记忆 | Long-Term Memory | 由短期按重复固化的持久记忆（无 TTL，跨会话） |
