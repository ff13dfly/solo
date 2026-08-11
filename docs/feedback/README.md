# docs/feedback/ — 需求与反馈的沉淀层

两条进入通道，一个沉淀出口：

## 通道 1：运行时自动收集（`system.report`）

外部调用方（AI 代理/脚本）在任务中撞到「系统做不到」时，经 Router 匿名提交
（router GUIDE.md §6 教了它们怎么提）。原始工单存 Redis（`SYSTEM:AI:REPORT`，
1000 条上限裁最旧），同诉求去重累计 `count`——**count 越高 = 越多任务撞过
同一堵墙 = 优先级越高**。

查看与 triage：Portal system console → **AI Reports** 页（或
`system.report.list` / `system.report.update`，admin）。

## 通道 2：人工整理的反馈文档（本目录）

派生项目实战踩出来的系统性反馈，人工写成 markdown 放进来（范例：
[`ai-agent-self-describing-api.md`](./done/ai-agent-self-describing-api.md)，来自
wavely，已落地为 v1.1.11 的 guide 机制）。

## triage 纪律（判断进 git，工单留 Redis）

1. **定期过一遍 AI Reports**（顺手看即可，count 高的优先）。
2. 逐条判定 → `system.report.update` 标状态：
   - `REVIEWED`：看过，暂不做（或已知重复）
   - `RESOLVED`：已解决（能力已加 / 文档已改 / 判定不做）
3. **有价值的（要动手的、或判断过程本身值得记录的）→ 沉淀成本目录一篇 markdown**：
   问题描述、核实过程、采纳/驳回的理由、落地方式。Redis 里只是原始工单，
   会被裁剪；**判断类散文必须进 git**（全局红线）。
4. 落地后在对应 markdown 里补「处理结论」一节（范例见 self-describing 那篇）。

## 目录结构（2026-08-11 起）

- **本目录下的 `.md`**：还没回填「处理结论」（或结论还留了没做完的后续）的反馈，**当前待办**。
- **`done/`**：`处理结论` 已回填（不论最终是"改了代码/文档"还是"看过判定不做"，两者都算
  triage 完成——判据抄自 §「triage 纪律」的 `RESOLVED` 定义）的反馈，全部移到这里。
  移动只是物理归档，**内容和文件名不变**——代码注释、CHANGELOG、其它反馈文档互引时
  仍然按文件名直接定位，只是路径要写 `docs/feedback/done/<name>.md`。
- 新反馈落在本目录顶层（`待 triage` 状态），处理完后 `git mv` 进 `done/`，**同时**
  `grep -rl "docs/feedback/<name>.md" .`（不含 `node_modules`）把仓库里指向它的引用一并
  改成 `done/` 路径——这批引用通常散在触发这条反馈的那段代码注释、`CHANGELOG.md`、
  `BACKLOG.md`、以及其它反馈文档互引里，2026-08-11 那次迁移一次性动了 13 篇文档 + 21 个
  引用点，此后新增的应该逐篇顺手处理，别再攒成一次大迁移。
