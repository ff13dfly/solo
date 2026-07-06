# SOLO 文档地图

> SOLO 是**纯框架**(无业务层)。判断某能力"算不算缺失",只看 [`CLAUDE.md §2 真实服务清单`](../CLAUDE.md)（13 服务）+ 代码——docs 里大量出现的 commodity / sale / crm / erp / supply 等是举例/愿景,**代码里不存在**。
>
> ⚠️ **区分"已实现"与"设想"**:`reference/overview.md` 与部分 `protocol/` 文档带产品愿景色彩。冲突时以 CLAUDE.md + 代码为准。

## 目录结构

| 目录 | 是什么 | 何时看 |
|------|--------|--------|
| **[`planning/`](./planning/)** | 活的状态台账(随开发滚动) | 想知道"走到哪、还欠啥" |
| **[`protocol/zh/`](./protocol/zh/)** | 正式协议规范(中文) | 实现 / 对接某子系统前 |
| **[`runbook/`](./runbook/)** | 操作手册 | 要把某流程跑起来 |
| **[`reference/`](./reference/)** | 系统总览 / 技术说明(相对静态,愿景重) | 第一次了解全局 |
| `private.md` | 个人笔记(非项目文档) | — |

### planning/ —— 状态台账（随开发滚动）

- [`VERSION.md`](./planning/VERSION.md) —— v1.1 封板验收边界(权威版本规格)
- [`BACKLOG.md`](./planning/BACKLOG.md) —— 框架级滚动待办(唯一集中入口)
- [`toFix.md`](./planning/toFix.md) —— API 待修详情(BACKLOG「API 待修」的 drill-down)
- [`security.md`](./planning/security.md) —— 安全待修 + 已修台账
- [`CHANGELOG.md`](./planning/CHANGELOG.md) —— 各发布版本变更(消费者升级前读;每个 tag 一条)

> 编排实现差距另见代码旁的 [`api/core/orchestrator/AUDIT.md`](../api/core/orchestrator/AUDIT.md)(就近维护,不集中到此)。

### protocol/zh/ —— 协议规范

索引见 [`protocol/zh/index.md`](./protocol/zh/index.md)。实现状态以代码为准,大致分两层:

- **支撑当前 13 服务 / v1.1 治理线**(实现度高):context · event · fulfillment · governance · workflow · approval · passport · security · config · memory · authority(结论:不建独立服务)
- **能力 / 业务协议**(实现程度参差,部分为愿景):category · process · report · qr · vision · extraction
- ai-test —— AI 测试方法论(meta)

### runbook/ —— 操作手册

- [`bot-bootstrap.md`](./runbook/bot-bootstrap.md) —— 系统 bot 账号初始化
- [`nexus-agent-bootstrap.md`](./runbook/nexus-agent-bootstrap.md) —— 注册 AI agent(Sentinel)
- [`test-handoff.md`](./runbook/test-handoff.md) —— 跨机器测试协作单
- [`upgrade-v1.0-to-v1.1.md`](./runbook/upgrade-v1.0-to-v1.1.md) —— 消费项目从 SOLO v1.0 升 v1.1(seed-registry / redis-stack / 破坏点)
- [`release-and-branching.md`](./runbook/release-and-branching.md) —— 发版 / 分支 / cherry-pick / 兼容纪律(有消费者后怎么不混乱)

### reference/ —— 总览

- [`overview.md`](./reference/overview.md) —— 系统总览(⚠️ 愿景重)
- [`tech-spec.md`](./reference/tech-spec.md) —— 技术说明
