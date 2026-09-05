<!-- solo:begin -->
# {{PROJECT_NAME}} · 项目向导

> **每轮 AI 会话自动加载**，管的是"在写第一行服务代码之前就要生效"的那些约束。
> 与 `.claude/skills/solo-service` 分工不同：那个 skill **只在动 `api/apps/` 时触发**，
> 管 wire 契约与代码规范；本文管「这个项目为什么存在、什么值得做、什么不许做」——
> 而后者恰恰拦得住 skill 一条都拦不到的东西（AI 主动提议加功能、一上来先建五张空表、
> 不可再生的数据只躺在 Redis 里没有导出出口）。
>
> **本块（到 `solo:end` 为止）由 Solo 维护，`deploy/upgrade.sh` 会整块重新同步——别在块内写项目内容。**
> 项目自己的内容写在 `solo:end` 之后，升级永远不碰。

## Solo 框架约束

### 只读区 = 治理边界，不只是"改了会被覆盖"

标了 `[Solo]` 的东西（`api/publish/solo.*.js` · `api/library/` · `api/autocheck/` ·
`api/sample/` · `.claude/skills/solo-service/` · `docs/` 契约文档包）**升级时整体覆盖**。

但它真正的作用不是升级机制，是**"标准不由使用方调整"**：一般框架的最佳实践只是文档里的
一句话，改了不会有任何后果；**只读区有后果**，所以它是真的标准，不是建议。
多人 + 各自 AI 的场景下，这是唯一能保证**每个人的 AI 不会各自发明一套约定**的东西。

⇒ **发现"该改的地方在只读区"，不要在本地打补丁**，回写一篇 markdown 到 solo 仓库的
`docs/feedback/`（格式抄目录里已有的：来源 / 依据分类【实测 vs 引用要分开标】/ 实测现象 /
根因引到 `文件:行号` / 建议按价值排序）。这条路是通的——多批下游反馈已被上收成框架能力。
非打不可的本地补丁要标 `[Project]` 注释并记进下面的「本项目的例外」，
否则升级时变成永久 divergence 债。

### 动服务代码前必知

- **只能改 `api/apps/<service>/`。**
- **门禁必须绿**：`node api/autocheck/checker.js api/apps/<service> --static`
  （已挂 PostToolUse 钩子自动跑；报错当场修，别往下堆）。
- **方法命名** `{service}.{entity}.{action}`；外键 `{targetService}Id`；实体嵌套 ≤ 3 层。
- **服务间禁止直接互调 HTTP**——一律走 Router（`relay.call` / `_tasks` / `_event`）。
- **实体走 Entity Factory**（`api/library/entity.js`）：自带 CRUD + 索引 + MULTI/EXEC + WAL。
  ⚠️ 它**只有 id 寻址**：按业务键找记录的二级索引（身份槽 / 幂等槽 / 枚举集合）是**你自己的**，
  **墓碑判定也是你自己的**——`softDelete` 只改 `status`、不通知任何索引，而 `entity.get`
  对软删记录照样返回。每建一个辅助键，当场回答「谁在什么时候删它」。
- **时间字段一律 epoch ms**，走 `api/library/clock.js` 的 `clock.now()`（可注入、测试可冻结）；
  确要存 ISO 就在 `handlers/entities.js` 上标 `format: 'iso'`，变成被声明的例外。
  读混合形态别手写兜底，用 `clock.toMs()` / `clock.toMsOr(v, 0)`。
- **前端不许用 `window.alert/confirm/prompt`**，用页内组件。

### 密钥

`.env` · `.keypair` · `api/seed.json` · `SETUP.md` **永远 gitignore**，提交前核对 `git status`。
任何脚本打印「密码只显示这一次」时**当场写进 `SETUP.md`**，连用途一起写（哪个服务、什么角色、
给谁用、怎么重建）——只记一串密码，三个月后照样不敢用；终端一关就是永久失联。
<!-- solo:end -->

<!-- ↓ 项目自己的内容从这里开始（upgrade.sh 不会动 solo:end 之后的任何东西） -->

## 1. 这个项目是什么（一句话）

<!-- 它服务的是谁、解决什么。写具体，别写"一个管理系统"。 -->

TODO

## 2. 什么值得做 / 什么不做

<!-- 最该写、也最容易被跳过的一段。建议至少覆盖：
     - 哪些事必须先问人，不许 AI 自行决定；
     - 明确**不**要的功能——AI 会主动提议加东西，写下来才拦得住；
     - 哪些数据是**不可再生**的（人工录入、外部一次性拉取）：这类必须有导出出口，
       不能只躺在 Redis 里。 -->

TODO

## 3. 本项目的服务

<!-- `deploy/services.json` 是运行权威；这里写人读的版本：每个服务一句话职责。 -->

TODO

## 4. 本项目的例外与决定

<!-- 与上面 Solo 约束不一致的地方，写在这里并说明理由；
     `[Project]` 补丁、端口分配、部署目标、运维约定也放这。 -->

TODO
