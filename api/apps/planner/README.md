# 日程与待办服务 (Planner)

服务名称: `@solo/planner`
默认端口: `8030`

## 1. 服务定位

个人生产力工具，集成日历管理（Agenda）与项目追踪（Todo）。支持本地优先同步机制，适配桌面端离线编辑后批量同步的场景。

核心能力：
- **日程管理**：基于日期和时间段的日历事件
- **待办项目**：支持 Markdown 内容的长期项目追踪
- **自动关联**：日程标题/内容中的 `#todoId` 标签自动链接到对应待办
- **本地优先同步**：批量同步接口处理 local-id 映射、冲突解决和增量更新

## 2. 方法清单

> **方法清单与参数以 introspection 为准** —— 调 `system.introspect` 或读本服务 `handlers/introspection.js`（声明↔注册由 `deploy/check-doc-drift.js` CI 守护）。

两组实体的人面 CRUD（`agenda.*` / `todo.*`）+ 各自的 `sync` 批量同步。其中 `agenda.update` 会触发 `#todoId` 关联重算（见 §7）；`todo.analyze`（AI 拆解 / 复杂度评估）与 `todo.schedule`（自动排期建议）属未实现方向，见 §3 与 §7。

## 3. 核心能力 (Advanced，未实现/方向)

- **AI 智能分析**：设想调用 `@solo/agent` 对长篇 Markdown 待办做任务拆解与工期预估（`todo.analyze`，当前返回 stub，Phase 2）。
- **自动排期引擎**：设想结合 Agenda 空闲时间与 Todo 优先级，生成每日执行建议（`todo.schedule`，Phase 2）。

## 4. 实体定义

| 实体 | ID 长度 | 关键字段 |
|------|---------|----------|
| Agenda | 8 位 | userId, title, date, startTime, endTime, todoId, status, ext |
| Todo | 8 位 | userId, name, content(Markdown), priority, tags[], relatedAgendas[] |

状态枚举：Agenda 取 `SCHEDULED` / `BUSY` / `DONE` / `CANCELLED`；Todo 取 `PENDING` / `IN_PROGRESS` / `COMPLETED` / `ARCHIVED` / `DELETED`（Todo 软删除走 `DELETED`，见 §7）。

## 5. 同步机制

`sync` 接口的冲突解决策略：

| 情况 | 处理 |
|------|------|
| id 以 `local-` 开头或缺失 | 创建新记录，返回 idMap 映射 |
| id 在 Redis 中存在 | 更新现有记录 |
| 服务端存在但客户端未传 | 删除（视为客户端已移除） |
| 已删除的记录重新出现 | 恢复 |

返回值：`{ success, count, idMap: { 'local-xxx': 'server-id' } }`

## 6. Redis 键模式

```
PLANNER:U:{uid}:AGENDA:{id}   — 日程数据（按用户隔离）
PLANNER:U:{uid}:TODO:{id}     — 待办数据（按用户隔离）
```

## 7. 注意事项

- **用户隔离**：所有数据按 userId 分区存储，不存在跨用户数据访问
- **自动关联**：解析正则 `#([a-zA-Z0-9]{8})`，title 或 content 中出现 todoId 会自动建立链接
- **Agenda 硬删除、Todo 软删除**：日程删除是物理删除，待办是软删除
- **Markdown 支持**：Todo.content 存储原始 Markdown，前端负责渲染
- **todo.analyze 未实现**：当前返回 stub，待 Phase 2 接入 AI 分析

## 8. 未来：直接调度任务（设计预留，尚未实现）

> planner 现状是**纯人面 CRUD**——记录"人计划了什么"，到点**不执行**任何东西，时间字段是显示字符串（`date` / `HH:mm`），无触发能力。
> "按计划执行"的基础设施是 **Nexus 时钟调度器**（`event.md §6.2`：`NEXUS:SCHEDULE` due-zset + `fire_at` 绝对时间戳 + action）。本节记录把 planner 桥接到它的设计前提，避免日后遗忘。

### 8.1 桥接形态

一条 actionable 的 agenda/todo（带时间）→ 后台**创建一条 Nexus schedule**：

```
agenda(date + startTime) ──算出 fire_at(绝对时间戳, 需带时区)──▶
  NEXUS:SCHEDULE { fire_at, recurrence_ms?, action:{kind:'run_command', workflow_id} 或 emit_event, owner: uid }
    ──Nexus tasker 到点──▶ run-queue ──▶ worker ──▶ workflow 执行
```
planner 仍管"人计划什么"，Nexus 管"到点触发什么"，两层不合并。

### 8.2 用户隔离 ✅（已具备）

planner 数据已严格按 uid 分区（`PLANNER:U:{uid}:*`，`getEntity(user)`），见 §7。桥出去的 schedule **带 `owner = uid`**（`NEXUS:SCHEDULE` 实体本就有 `owner` 字段），调度的可见/管理/审计随 uid 走，天然延续隔离。

### 8.3 权限：不是"没问题"，有两层要拍板 ⚠️

1. **谁能建调度（创建闸）**：`nexus.schedule.*` 目前 **admin-only**（`core/nexus/index.js`）。要让 planner 的**普通用户**自助调度，得先决定：放开 per-user 调度（带 owner + 数据级 `constraints` 约束），还是 planner 经一个受控 bot 路径代建——直接对用户放开 schedule 创建是 privilege 决策，不能默认 OK。
2. **到点以谁的身份执行**：调度触发的 workflow 跑在 **bot permit** 下（`system.orchestrator` 或 workflow `run_as`），**不是用户的 permit**。受 **H6 footprint 预审** + **人在环**（permit 不足 → `PAUSED_AWAITING_HUMAN`）兜底。
   - 好处：用户**无法靠"调度一个 workflow"提权**——bot 的最小 permit 划定上限，缺权就停下等人放行。
   - 前提：目标 workflow 须声明 `allowed_triggers:["cron"]`（`event.md §7`），否则定时源会被拒。

> 一句话：**隔离没问题（已按 uid）；权限"没问题"的前提是——创建闸做好 per-user 授权、执行走 bot+H6+人在环，而不是把 admin-only 的 schedule 直接开给用户。**
