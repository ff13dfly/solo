# planner 服务任务配方

> 由 fleet-standard `guide` 方法下发（经 Router：`system.guide { service: "planner" }`）。
> 与服务代码同目录、同 commit 更新。方法签名与参数约束以 `methods` 自省为准，
> 本文只讲自省说不出的**任务流程与语义**。

## 这是什么

个人生产力服务：管**日程**（agenda，日历时间块）和**待办**（todo，长期项目，Markdown 正文）。
两类实体各自一套人面 CRUD + 一个 Local-First 批量 `sync`。数据按调用会话的用户自动隔离
（`PLANNER:U:{uid}:*`），你**不需要**自己传 userId 来隔离，也读不到别人的记录。

## 配方一：建一条日程

1. `planner.agenda.create { title, date, startTime, endTime, content? }`
   - `date`：`YYYY-MM-DD` 字符串；`startTime` / `endTime`：`HH:mm` 字符串。
   - 这些是**显示字符串**——planner 不解析、不到点触发任何动作（见坑）。
2. 返回一条 Entity 记录 `{ id, status, createdAt, updatedAt, ... }`：`id` 是 **8 位**，
   `status` 默认 `ACTIVE`（Entity 工厂默认，**不是**枚举里的 SCHEDULED/BUSY/DONE/CANCELLED——
   要那些语义状态得自己 `update` 设）。

## 配方二：把日程关联到待办（#todoId 标签）

顺序很重要，**先 todo 后 agenda**：

1. `planner.todo.create { name, content? }` → 拿到 **8 位** `todoId`。
2. 建 agenda 时，在 `title` **或** `content` 里写 `#<todoId>`（正好 8 位字母数字）。
   planner 自动匹配 `#([a-zA-Z0-9]{8})`，把 agenda 的 `todoId` 指向它，并把本 agendaId
   追加进 todo 的 `relatedAgendas`。
   - todo 必须**先存在**：不存在时链接**静默失败**（仅 warn 日志），agenda 照建但不关联。
   - `agenda.create` 即使成功关联，**返回体里不含 `todoId`**（关联是二次 update 写的）——
     要 `agenda.get` 才看得到。
   - `agenda.update` 改了 title/content 会**重算**关联。

## 配方三：批量同步（Local-First，慎用）

`planner.agenda.sync { events: [...] }` / `planner.todo.sync { todos: [...] }` 供离线客户端整批对账：

- 每条：`id` 缺失或以 `local-` 开头 → 新建（`idMap` 回 `local→server` 映射）；
  `id` 已存在 → 更新；服务端已删/丢失但你传了 → 恢复。
- ⚠️ **全量对账**：sync 把你提交的列表当作该用户的**完整清单**——服务端有、而你没传的记录
  会被**删除**。**只能传全量**，传一部分等于删掉其余。这是最容易翻车的地方。
- 幂等：拿到 `idMap` 后必须把本地 id 换成 server id 再用；继续拿 `local-` id 重跑会**再建一份**
  （重复）。sync **不是**按 local-id 幂等的。

## 坑与约定

- **planner 只记录、不执行**：时间字段是纯显示字符串，到点**不触发**任何东西。需要"到点执行"
  是 Nexus 调度器的活，不在 planner（见 README §8）。
- **删除语义不对称**：agenda 是**硬删**（`delete` 返回 `{ success: true }`，物理删）；
  todo 是**软删**（`delete` 返回记录本身，`status=DELETED`，仍在库里）。`DELETED` 是保留状态。
- **时间戳是数字**：`createdAt` / `updatedAt` 是 epoch 毫秒**数字**，不是 ISO 字符串。
- **普通 create 无天然幂等键**：重复 `create` 会产生重复记录，自己去重。
- **限流**：Router 有全局限流（错误码 `-32029`），批量 create / sync 时退避重跑。
- **analyze / schedule 是 stub**：`planner.todo.analyze` / `planner.todo.schedule` 恒返回
  `{ status: 'PENDING' }`（Phase 2 未实现），别依赖其结果。
- 本服务满足不了你的任务时，把缺口提到 `system.report`（用法见 Router guide §6），
  不要静默放弃或绕野路子。
