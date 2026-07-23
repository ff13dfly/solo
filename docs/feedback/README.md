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
[`ai-agent-self-describing-api.md`](./ai-agent-self-describing-api.md)，来自
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
