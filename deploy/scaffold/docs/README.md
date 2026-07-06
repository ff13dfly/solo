# {{PROJECT_NAME}} · 文档 / 契约手册

> 这是 **{{PROJECT_NAME}}**（基于 Solo v{{SOLO_VERSION}} 脚手架）的唯一手册入口。
> 下面三份「编写指南」由 Solo 随脚手架下发、**与执行引擎逐字段对齐**——一个 AI 或人**只凭这里的信息**就能写出 wire 兼容的服务、事件、工作流。
> 它们是版本钉死的（`.solo-version`）契约，`bash deploy/upgrade.sh` 升级时会**整体重下发**——不要手改这三份，会被覆盖。

---

## 编写指南（`docs/authoring/`）

| 你要做的事 | 看哪份 | 一句话 |
|------------|--------|--------|
| 在 `api/apps/` 下**写一个新服务** | [`authoring/service.md`](./authoring/service.md) | Router 能识别/转发的服务长什么样：方法命名、introspection 声明 ↔ index 注册、library factory、权限与约束。 |
| 让服务**发/收事件、做自动化** | [`authoring/events.md`](./authoring/events.md) | `_event`（事实扇出）/ `_tasks`（副作用派发）/ 四种触发源 / 重投幂等。 |
| **写一条编排工作流** | [`authoring/workflows.md`](./authoring/workflows.md) | orchestrator 引擎对齐的 workflow 语法；配套 [`authoring/workflow-examples/`](./authoring/workflow-examples/) 三个可跑示例（sync 单步 / 多步+条件 / 事件触发）。 |

> 方法**词表**（有哪些 `{service}.{entity}.{action}` 可调）在运行时可发现：Router 的能力目录写在 Redis 里。
> 这三份补的是**语法/契约**——词表查得到，但怎么拼成合法请求要看这里。

---

## 配套（不在 docs/，但你会用到）

- **可运行模板**：`api/sample/` —— 一个最小但完整的服务，照着改最快。
- **共享库目录**：`api/library/`（`jsonrpc` / `logger` / `entity` / `permit` / …）—— 别重新发明 library 已经发的轮子。
- **静态自检**：`bash deploy/precheck.sh` —— 写完服务先过 autocheck，红线（声明 ↔ 注册不同步等）当场暴露。

> ⚠️ Solo 源码仓里有更宏大的 `docs/protocol/zh/*` 内部设计草案（含**未实现**的协议）。那是 SOLO 维护者视角、**不随脚手架下发**。
> **{{PROJECT_NAME}} 这边以本 `docs/` + 代码（`api/sample/`、`api/library/`）为准。**
