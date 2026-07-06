# AI 测试协议 (AI Test Protocol) — stub

> [!WARNING]
> **状态:🟡 设计草案,主体未实现 —— 本文已从 867 行原始设计砍成 stub(2026-06)。**
> 原稿设计了一个 `tester` 微服务(`tester.*` / `AI_test.js` / `api/tester/`)+ system.md 自动生成 + portal 测试面板 + "Prompt-to-Workflow 终极愿景"。**那套从未实现,方向也不采用(勿照此另起服务)。** 需要旧稿见 git 历史。

---

## 问题(真实、至今未覆盖)

评估 AI 的 **"自然语言 → 意图 / 参数" 准确率**(`agent.purpose` / `agent.focus` 到底认得准不准)。

⚠️ 注意:client/mobile 的 route-mocked e2e(`e2e/ui/tests/mobile/`)**故意 mock 掉 AI** 以求确定性 —— 它测的是客户端渲染 / Focus 状态机,**不测 AI 的真实准确率**。所以这条质量线**没有系统化评估**。

## 已有的真实载体(若推进,基于这些,别另起 tester 服务)

| 载体 | 是什么 | 状态 |
|------|--------|------|
| `api/autonomous/workflow-auditor/` | 离线仿真 / 评估雏形(`simulate.js` + `cases/*.json`) | 雏形,未接真实流程(CLAUDE.md §3) |
| `agent.case.generate` | 后端真方法(qwen `generateCases`,生成测试用例) | ✅ 已实现 |

> portal/system 曾有 `AISupport` 页(`/ai`:用例生成 + Focus 模拟器 + 准确率),但自本仓库早期版本(2026-05-07)起从未维护、已漂移,**已于 2026-06 移除**。若重做 eval,基于上表,不必复活该页。

## 方向(若推进)

做成一条**评估 / 基准线**(eval/benchmark,非 pass/fail 单测),基于 `workflow-auditor` + `agent.case.generate`,而**不是** tester 微服务。优先级与归属见 [`../planning/BACKLOG.md`](../planning/BACKLOG.md)。
