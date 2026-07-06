# AI 工作流协议 (AI Workflow Protocol)

---

> **协议版本**: 1.1.0  
> **状态**: 稳定 (Stable)  
> **作者**: Fuu  
> **许可证**: Apache 2.0

---

## 摘要

本协议定义了 Solo·AI 系统中 AI 驱动工作流的完整生命周期，涵盖工作流定义、参数收集（Focus 状态机）、子任务分发，以及多 Agent 共识步骤（`agent_consensus`）四个核心环节。

多 Agent 共识步骤允许将同一任务同时交给多个 Agent 并行处理：结论一致时自动推进，出现分歧时升级至决策 Agent 或触发人机协同。

## 1. 简介

### 1.1 设计目标

| 目标 | 说明 |
|------|------|
| **声明式定义** | 通过 JSON 描述工作流，无需编码 |
| **AI 意图匹配** | 自然语言触发工作流执行 |
| **渐进式补全** | 多轮对话收集缺失参数 |
| **确定性执行** | 编排器按顺序执行步骤 |
| **多 Agent 共识** | 并行调用多个 Agent，以结论一致性决定自动推进或升级决策 |

### 1.2 核心概念

| 概念 | 描述 |
|------|------|
| **Workflow** | 存储在 Redis 中的命名步骤序列 |
| **Focus 状态** | 前端锁定当前任务，等待参数补全 |
| **Task** | 子服务调用任务，由 Router 分发 |
| **Context ($)** | 贯穿所有步骤的全局状态对象 |
| **agent_consensus** | 并行 Agent 共识步骤：fan-out → 汇聚 → 路由 |
| **Verdict** | Agent 对任务的结论值，用于共识比较的字段 |

### 1.3 执行流程概览

```
用户输入 → 意图匹配 → 工作流命中 → Focus 补全 → 确认执行 → 步骤执行 → 子任务分发
                                                                    ↓
                                                          [agent_consensus step]
                                                          Fan-out → 并行 Agent → 汇聚
                                                          ├── 一致 → 自动推进
                                                          └── 分歧 → 决策 Agent / 人机协同
```

## 2. 工作流定义

### 2.1 数据结构

**Redis Key**: `orchestrator:workflow:{id}`

```json
{
  "id": "meeting_setup_v1",
  "category": "协作类",
  "priority": 80,
  "name": "安排项目会议",
  "desc": "创建日历事件，预订会议室，并通知团队。",
  "tags": ["会议", "日历", "通知"],
  "examples": ["帮我订个会", "约一下明天的同步会"],
  "negative": ["取消会议", "删除日程"],
  "required_inputs": ["roomId", "startTime"],
  "optional_inputs": ["title", "duration"],
  "synonyms": { "roomId": ["会议室", "小红屋"] },
  "defaults": { "duration": 60, "platform": "Zoom" },
  "auto": false,
  "steps": [
    {
      "id": "book_room",
      "service": "asset",
      "method": "asset.unit.reserve",
      "params": { "unitId": "$input.roomId" }
    }
  ]
}
```

### 2.2 字段定义

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 唯一标识符 |
| `category` | string | ✅ | 分类，用于两段式匹配 |
| `name` | string | ✅ | 人类可读名称 |
| `desc` | string | ✅ | 详细描述，用于语义搜索 |
| `examples` | string[] | ❌ | 触发短语示例 |
| `negative` | string[] | ❌ | 反向约束，降低误匹配 |
| `required_inputs` | string[] | ❌ | 必填参数列表 |
| `defaults` | object | ❌ | 默认值 |
| `auto` | boolean | ❌ | 参数完整时自动执行 |
| `steps` | Step[] | ✅ | 步骤列表 |

### 2.3 Step 对象

Step 有两种类型，由 `type` 字段区分：

| `type` 值 | 说明 |
|-----------|------|
| 省略（默认）| **RPC Step**：调用单个 Solo 微服务方法 |
| `"agent_consensus"` | **共识 Step**：并行调用多个 Agent，根据结论一致性路由（见 §7） |

**RPC Step 字段**（`type` 省略时）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 步骤标识，用于 `$step.{id}.result` |
| `type` | string | ❌ | 省略即为 RPC Step |
| `service` | string | ✅ | 目标微服务 |
| `method` | string | ✅ | 调用方法 |
| `params` | object | ✅ | 参数，支持 `$` 变量 |
| `condition` | string | ❌ | 条件表达式 |
| `ignore_error` | boolean | ❌ | 失败时继续 |

`agent_consensus` Step 字段见 §7.2。

### 2.4 变量解析

| 前缀 | 来源 | 示例 |
|------|------|------|
| `$input` | 用户输入 | `$input.startTime` |
| `$config` | defaults + input | `$config.duration` |
| `$step` | 前序 RPC Step 结果 | `$step.book_room.result.id` |
| `$resolved` | Resolver 解析结果 | `$resolved.companyId` |
| `$consensus` | 前序 agent_consensus Step 结果 | `$consensus.multi_audit.decision` |

### 2.5 Resolver (名称解析)

将用户友好的名称转换为系统 ID：

```json
"resolvers": {
  "companyId": {
    "source": "companyName",
    "service": "company",
    "method": "company.info",
    "params": { "name": "$val" },
    "resultPath": "id"
  }
}
```

## 3. Focus 状态机

### 3.1 核心概念

| 概念 | 描述 |
|------|------|
| **Focus 状态** | 前端锁定当前任务，等待数据补全 |
| **单一锁定** | 一次只处理一个 Workflow |
| **摘要卡片** | 实时显示已填/待填字段 |
| **渐进式补全** | 多轮对话收集必填字段 |

> [!IMPORTANT]
> **无状态原则**: `agent.focus` 接口不维护会话状态，所有上下文由客户端传入。

### 3.2 状态流转

```
Idle → [命中 Workflow] → Collecting → [数据完整] → Pending → [确认] → Executing → Idle
                              ↑                         ↓
                              └────── [用户修改] ────────┘
```

### 3.3 API 定义

**Endpoint**: `agent.focus`

**Request**:
```json
{
  "workflow_id": "meeting_setup_v1",
  "current_params": { "duration": 60 },
  "missing_fields": ["roomId", "startTime"],
  "user_input": "用三楼的大厅，明天下午三点"
}
```

**Response**:
```json
{
  "extracted_params": {
    "roomId": "floor3_hall",
    "startTime": "2026-01-10T15:00:00+08:00"
  },
  "confidence": { "roomId": 0.95, "startTime": 0.88 },
  "hint": "好的，三楼大厅已记录！"
}
```

### 3.4 自动执行条件

对于只读操作，可设置 `auto: true` 跳过确认：

| 条件 | 要求 |
|------|------|
| `auto` | `true` |
| 参数 | 完整 |
| 置信度 | ≥ `min_confidence` (默认 0.85) |
| 操作类型 | 只读（禁止写操作） |

### 3.5 循环保护

| 保护机制 | 阈值 | 行为 |
|----------|------|------|
| 最大澄清次数 | 3 | 切换为表单模式 |
| 最大重试次数 | 3 | 保存草稿退出 |
| 会话超时 | 5 分钟 | 自动保存 |

## 4. 任务分发

### 4.1 机制概述

微服务可通过在响应中返回 `_tasks` 字段，指示 Router 调用其他服务：

```
Client → Service A → Router → [分离 _tasks] → Client
                         ↓
                    Service B (异步)
```

### 4.2 响应结构

```json
{
  "result": {
    "data": { ...业务数据... },
    "_tasks": [
      {
        "service": "notification",
        "method": "create",
        "params": { "userId": "u123", "title": "欢迎" }
      }
    ]
  }
}
```

### 4.3 任务字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `service` | string | ✅ | 目标服务 |
| `method` | string | ✅ | 调用方法 |
| `params` | object | ✅ | 参数 |
| `mode` | string | ❌ | `async`(默认) 或 `sync` |

### 4.4 Router 处理逻辑

1. 接收 Service A 响应
2. 提取并移除 `_tasks`
3. 返回"干净"结果给客户端
4. 异步执行任务调用

## 5. 多 Agent 共识步骤 (agent_consensus)

### 5.1 Step 字段

```json
{
  "id": "multi_audit",
  "type": "agent_consensus",
  "agents": ["bot:security_auditor", "bot:compliance_reviewer", "bot:perf_analyzer"],
  "timeout": 300,
  "verdict_field": "verdict",
  "on_agree":    { "next_step": "auto_approve" },
  "on_disagree": {
    "escalate_to":  "bot:decision_maker",
    "notify_human": "operator:workflow_manager"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 步骤标识，用于 `$consensus.{id}` |
| `type` | string | ✅ | 固定值 `"agent_consensus"` |
| `agents` | string[] | ✅ | 参与共识的 Agent `role_id` 列表，至少 2 个 |
| `timeout` | number | ❌ | 等待所有 Agent 报到的秒数，默认 300；超时视为分歧 |
| `verdict_field` | string | ✅ | 从每个 Agent 结果中取出用于比较的字段名 |
| `on_agree` | object | ✅ | 共识达成时的路由；`next_step` 为目标 step id，省略则结束工作流 |
| `on_disagree` | object | ✅ | 存在分歧时的路由；`escalate_to` 与 `notify_human` 至少填一个 |

`on_disagree` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `escalate_to` | string | 决策 Agent 的 `role_id`，收到所有原始 verdicts 后给出最终裁决 |
| `notify_human` | string | Authority role；走 [上下文协议 §10](./context) 人机协同机制 |

两者可同时填写，决策 AI 与人类同步收到分歧通知，先给出结论者生效。

### 5.2 执行流程

```
orchestrator 执行到 agent_consensus step
        ↓
① Fan-out：经 Nexus 向每个 Agent 发布独立事件
   EVENT:CONSENSUS:REQUEST:{execution_id}:{step_id}
   每个 Agent 各自组装 context、独立处理
        ↓
② 汇聚：Agent 处理完后调用
   orchestrator.consensus.submit({ execution_id, step_id, verdict, reason, data })
   结果写入 Redis Hash ORCHESTRATOR:CONSENSUS:{execution_id}:{step_id}
        ↓
③ orchestrator 检测到 HLEN == agents.length（或 timeout 触发）
        ↓
④ 共识判断：提取所有结果的 verdict_field 值
   ├── 全部相同 → on_agree：继续 next_step；$consensus.{id} 写入结果
   └── 有差异   → on_disagree：
         ├── escalate_to 不为空 → 触发决策 Agent，携带所有 verdicts
         └── notify_human 不为空 → 发起人机协同会话
```

### 5.3 Agent 结果提交 API

**Endpoint**: `orchestrator.consensus.submit`

```json
{
  "execution_id": "exec_abc123",
  "step_id":      "multi_audit",
  "verdict":      "HIGH",
  "reason":       "步骤 3 调用了未授权的外部服务",
  "data":         { "risk_items": ["step3_external_call"] }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `execution_id` | string | ✅ | 工作流执行实例 ID |
| `step_id` | string | ✅ | `agent_consensus` step 的 id |
| `verdict` | any | ✅ | 与 `verdict_field` 对应的结论值 |
| `reason` | string | ❌ | 结论说明，会携带进升级事件的 context |
| `data` | object | ❌ | 附加结构化数据，供决策 Agent 参考 |

调用方为 Agent 自身，需在其 `authority_role.allow_methods` 中包含 `orchestrator.consensus.submit`。

### 5.4 $consensus 变量

`agent_consensus` step 完成后，后续步骤通过 `$consensus` 前缀引用结果：

| 变量 | 说明 |
|------|------|
| `$consensus.{id}.agreed` | boolean，是否达成共识 |
| `$consensus.{id}.verdicts` | 所有 Agent 的结论数组 `[{agent_id, verdict, reason, data}]` |
| `$consensus.{id}.decision` | 最终决定（共识值，或决策 Agent / 人类给出的裁决） |

示例：下游步骤根据共识结论写入结果：

```json
{
  "id": "record_audit_result",
  "service": "orchestrator",
  "method": "orchestrator.workflow.update",
  "params": {
    "workflowId": "$input.workflow_id",
    "risk_level": "$consensus.multi_audit.decision",
    "verdicts":   "$consensus.multi_audit.verdicts"
  },
  "condition": "$consensus.multi_audit.agreed === true"
}
```

### 5.5 决策 Agent

`on_disagree.escalate_to` 触发的决策 Agent 是普通 Nexus Agent，订阅 `EVENT:CONSENSUS:DIVERGED`，通过 `data_fetchers` 拉取所有原始 verdicts：

```json
{
  "role_id": "bot:decision_maker",
  "event_subscriptions": ["EVENT:CONSENSUS:DIVERGED"],
  "context": {
    "system_prompt_template": "以下审核员结论存在分歧，请给出最终裁决：\n\n{{fetch.consensus.verdicts}}",
    "data_fetchers": [
      {
        "key": "consensus",
        "method": "orchestrator.consensus.get",
        "params": {
          "execution_id": "{{event.execution_id}}",
          "step_id":      "{{event.step_id}}"
        }
      }
    ]
  }
}
```

决策 Agent 完成后同样调用 `orchestrator.consensus.submit`，orchestrator 识别为"决策轮"并写入 `$consensus.{id}.decision`，工作流继续推进。

### 5.6 Redis 汇聚结构

```
ORCHESTRATOR:CONSENSUS:{execution_id}:{step_id}  →  Hash
  "bot:security_auditor":    '{"verdict":"HIGH","reason":"..."}'
  "bot:compliance_reviewer": '{"verdict":"PASS","reason":"..."}'
  "bot:perf_analyzer":       '{"verdict":"HIGH","reason":"..."}'
  "_expected":               "3"
  "_status":                 "PENDING"   # PENDING | AGREED | DIVERGED | DECIDED
```

Key TTL 为 `timeout` + 300 秒，到期自动清理。`_status` 由 orchestrator 在各阶段更新，可供外部查询进度。

---

## 6. 安全考虑

### 6.1 权限校验

执行 Workflow 前需校验用户对所有 steps 的权限：

```javascript
for (const step of workflow.steps) {
  if (step.type === 'agent_consensus') {
    // 校验所有参与 Agent 的 role 是否存在且处于活跃状态
    for (const agentRole of step.agents) {
      if (!nexus.isAgentActive(agentRole)) {
        throw { code: -32604, message: `Agent not active: ${agentRole}` };
      }
    }
  } else {
    if (!checkPermission(user.permit, step.service, step.method)) {
      throw { code: -32604, message: `No permission for ${step.method}` };
    }
  }
}
```

### 6.2 任务分发安全

| 风险 | 缓解措施 |
|------|----------|
| 信任模型破坏 | Router 实施 ACL 白名单 |
| 无限循环 | 禁止任务生成子任务；决策 Agent 不可再触发新的 `agent_consensus` |
| 参数篡改 | 目标服务严格校验 |
| 共识结果伪造 | `orchestrator.consensus.submit` 校验 caller 的 `agent_id` 必须在 `step.agents` 列表中 |

## 7. 错误处理

| 场景 | 处理方式 |
|------|----------|
| AI 无法提取参数 | 返回澄清问题 |
| 网络请求失败 | 重试 + 保存草稿 |
| 步骤执行失败 | 根据 `ignore_error` 决定是否继续 |
| 子任务失败 | 记录日志，不影响主响应 |
| `agent_consensus` 超时 | 视为分歧，按 `on_disagree` 处理；已提交的部分结论保留 |
| 决策 Agent 也超时 | 工作流挂起，状态置 `PENDING_HUMAN`，通知 `notify_human` |

## 附录 A. 变更日志

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| 1.1.0 | 2026-05-10 | 新增 §5 多 Agent 共识步骤（agent_consensus） |
| 1.0.0 | 2026-01-19 | 合并 orchestrator, focus, task 三个协议 |

## 附录 B. 相关协议

- [短期记忆协议](./memory) - Focus 的上下文来源
- [安全协议](./security) - 权限校验机制
- [上下文组装协议](./context) - Agent 上下文与人机协同机制
