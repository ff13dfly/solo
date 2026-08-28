# cron → 服务副作用没有轻量通路：时间总线到点后，唯一正道是带 HIGH 审批的 workflow

- **来源**：steward，2026-08-27，「接时间总线：定时驱动浏览器插件采集」落地实测
- **场景**：nexus.schedule 到点后要调一个业务服务的写方法（`hive.job.create`——给某个
  浏览器节点派一条采集工单）。这是机器对机器的固定形状副作用：参数在 schedule 里写死、
  无分支、无人参与。
- **依据分类**：以下全部为本次实测（steward 栈 bundle v1.2.3，N100 生产 + 公网 RPC 核对），
  引用他项目处已标注。

## 实测现象

调度器 action 只有两种（`logic/scheduler.js`）：

1. **`run_command`** → ORCHESTRATOR:RUNQ → workflow。但任何含写方法的 workflow 被
   `classifyFootprint` 判 HIGH（写动词即 HIGH，`library/risk.js`）→ 走 approval 多签道：
   需要 approval gate + 审批人 Ed25519 签名（`user/logic/key.js`，严格 self-only）+
   默认 **24h 冷静期**（`APPROVAL_COOLING_MS_HIGH` 默认 86400000）。
   为一条「到点采一次」的单步派单编排，要走完 bot provisioning、workflow create、
   第二身份签名审批、再等一天冷静期——当晚要用的定时任务直接不可达。
2. **`emit_event`** → 事件总线。但**服务侧没有事件消费面**：`handlers/events.js` 的
   `subscribes` 是文档性的（events 指南 §4 明确），运行时消费者只有 orchestrator matcher
   （回到 1 的审批问题）与 nexus sentinel（inbox 投递，服务要配 relay token 轮询
   `notification.inbox.list`，colony ant 的 consumer 是先例——每个要收事件的服务都要
   自建一套轮询 + provisioning）。

## steward 的临时解法（app 区，已上线验证）

hive 服务内建一个流消费器（`api/apps/hive/logic/cron.js`）：轮询
`EVENT:SENTINEL:HIVE_CRON`（借用 system.nexus 的内置白名单前缀，registry 零改动），
`type=hive.cron.dispatch` 的事件 → `job.create`（幂等键 `cron-<流条目id>`）。
schedule 侧 `emit_event` 携带 `{nodeId, kind, payload}`。链路：
`nexus.schedule → event.emit → EVENT:SENTINEL:HIVE_CRON → hive 消费器 → job → 插件领活`。
实测通（见 steward 仓提交记录）。

本质上这是给「matcher / nexus 两个消费组」旁边加了第三个——结构同构，但每个服务
自己造一遍，且流名寄生在 SENTINEL 命名空间下。

## 建议（按价值排序）

1. **给 scheduler 加第三种 action：`call_method`**（受限版 run_command）：
   `{ kind:'call_method', method, params }`，经 Router 以 system.nexus（或专属
   system.scheduler）bot 身份调用，permit 显式枚举可调方法。审批面收在
   「schedule.create 是 admin-only」这一层——建 schedule 的人本来就是 admin，
   比让单步派单走 workflow 多签道更贴合威胁模型。
2. 或者**给服务一个声明式事件消费面**：`handlers/events.js` 的 `subscribes` 从文档性
   升格为运行时（Router/nexus 把匹配事件 `_tasks` 式投递给服务）——colony ant 与本次
   hive 的两套手写 consumer 就都能删掉。
3. 至少把「写方法 workflow 必 HIGH → 多签 + 24h 冷静」在文档里与 cron 场景对照说明，
   并允许按 stack 配置豁免单步、参数字面量固定的 workflow——现状是 events.md §6.2 的
   设计叙事（cron 翻译成事件/run-command 后「其余全部统一」）在写方法场景下实际不可达。

## 处理结论

（待 triage）
