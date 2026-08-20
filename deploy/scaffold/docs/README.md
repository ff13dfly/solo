<!-- solo:begin -->
<!-- ⚠️ 上面的标记到下方结束标记之间是 Solo 拥有的区域：upgrade.sh 升级时整块覆盖到新模板。
     项目自己的章节（集成文档索引、架构决策、运维手册…）写在结束标记之后，升级时原样保留。
     两个标记必须独占一行、逐字保留——改动它们会让升级退回「整份 staged 成 .new」的保守路径。 -->
# {{PROJECT_NAME}} · 文档 / 契约手册

> 这是 **{{PROJECT_NAME}}**（基于 Solo v{{SOLO_VERSION}} 脚手架）的唯一手册入口。
> 下面四份「编写指南」由 Solo 随脚手架下发、**与执行引擎逐字段对齐**——一个 AI 或人**只凭这里的信息**就能把业务整理成服务形态，并写出 wire 兼容的服务、事件、工作流。
> 它们是版本钉死的（`.solo-version`）契约，`bash deploy/upgrade.sh` 升级时会**整体重下发**——不要手改这四份，会被覆盖。

---

## 编写指南（`docs/authoring/`）

| 你要做的事 | 看哪份 | 一句话 |
|------------|--------|--------|
| **决定该写哪些服务**（动代码前的第一步） | [`authoring/modeling.md`](./authoring/modeling.md) | 把业务整理成「服务 × 实体」：先查 core 已有什么，再用三个是非题判实体边界与服务边界。**门禁查的是 wire 契约、不是设计，划分错了照样全绿**——所以这一步只能靠判据。 |
| 在 `api/apps/` 下**写一个新服务** | [`authoring/service.md`](./authoring/service.md) | Router 能识别/转发的服务长什么样：方法命名、introspection 声明 ↔ index 注册、library factory、权限与约束。 |
| 让服务**发/收事件、做自动化** | [`authoring/events.md`](./authoring/events.md) | `_event`（事实扇出）/ `_tasks`（副作用派发）/ 四种触发源 / 重投幂等。 |
| **写一条编排工作流** | [`authoring/workflows.md`](./authoring/workflows.md) | orchestrator 引擎对齐的 workflow 语法；配套 [`authoring/workflow-examples/`](./authoring/workflow-examples/) 三个可跑示例（sync 单步 / 多步+条件 / 事件触发）。 |

> 方法**词表**（有哪些 `{service}.{entity}.{action}` 可调）在运行时可发现：Router 的能力目录写在 Redis 里。
> 后三份补的是**语法/契约**——词表查得到，但怎么拼成合法请求要看这里；
> `modeling.md` 补的是更前面那一步的**形态**——语法全对但划分错了，是门禁拦不住的错误。

---

## 配套（不在 docs/，但你会用到）

- **可运行模板**：`api/sample/` —— 一个最小但完整的服务，照着改最快。
- **共享库目录**：`api/library/`（`jsonrpc` / `logger` / `entity` / `permit` / …）—— 别重新发明 library 已经发的轮子。
- **浏览器插件**：`client/README.md` —— 数据要从网页里取、动作要落回网页上时走这条路。
  `client/extension-kit/`（[Solo] 传输/重试/持久化队列/图片规格化/会话，随升级刷新）
  + `client/extension/`（[Project] 你的 manifest / DOM 选择器 / 字段映射，永不被覆盖）；
  `extension-kit/sample/` 是可直接跑起来的完整扩展，抄它起步。
  ⚠️ `client/plugin/` 是**桌面客户端的视图插件**，与浏览器扩展是两回事。
- **静态自检**：`bash deploy/precheck.sh` —— 写完服务先过 autocheck，红线（声明 ↔ 注册不同步等）当场暴露。

> ⚠️ Solo 源码仓里有更宏大的 `docs/protocol/zh/*` 内部设计草案（含**未实现**的协议）。那是 SOLO 维护者视角、**不随脚手架下发**。
> **{{PROJECT_NAME}} 这边以本 `docs/` + 代码（`api/sample/`、`api/library/`）为准。**
<!-- solo:end -->

<!-- ↓ 项目自己的章节从这里开始（upgrade.sh 不会动 solo:end 之后的内容） -->
