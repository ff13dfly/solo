---
description: Rules and cadence triggers for periodic security re-evaluation of SOLO architecture.
---

# 安全性定期重新评估规则 (Security Cadence & Periodic Re-evaluation Rule)

## 1. 核心目标
保持 SOLO 框架在架构演进和业务迭代过程中的高安全基准（维持 OWASP Top 10 及 OWASP LLM 标杆级 A 级标准），防范新增接口、权限调整或工作流变更引入新的安全敞口。

## 2. 触发式复评条件 (Event-Driven Triggers)
当满足以下任一条件时，Agent **必须主动提醒用户** 并建议发起针对性安全复评（调用 `security-audit` skill 或执行全量回归）：
1. **网络与网关鉴权边界变更**：
   - 修改了 `api/router/handlers/auth.js`、`forward.js`、`ratelimit.js`、`service.js`。
   - 调整了网关暴露端口、CORS 规则或微服务端口绑定（`ports.js`）。
2. **执行引擎与工作流变更**：
   - 变动了 `api/core/orchestrator/logic/runner.js`、动态路径提取（`setPath`）、或新增 resolver。
   - 变更了 `api/library/jsonlogic.js` 规则算子白名单或守卫逻辑。
3. **AI / Agent 决策边界变动**：
   - 调整了 `api/core/agent/logic/decide.js` 的 Inverted Gate 门控规则或 choices 闭集约束。
   - 扩展了 `api/core/mcp` 的工具映射能力或暴露了新的业务接口。
4. **存储与静态文件协议变动**：
   - 调整了 OSS 预签名鉴权、直链 MIME 映射或静态资源 CSP/nosniff 响应头。
5. **底层依赖升级**：
   - 升级了 `express`、`tweetnacl`、`json-logic-js`、`redis` 等底层核心依赖包。

## 3. 定期巡检节奏 (Periodic Cadence)
- **巡检周期**：每 30 天或在每个 Milestone 版本发布前，执行一次系统安全复评。
- **巡检标准流程**：
  1. 运行 CI 全量安全套件：`REDIS_URL=redis://localhost:6699 npm run test:ci --prefix api`（要求 100% 保持全绿通过）。
  2. 对照 [`docs/security/SECURITY_EVALUATION_REPORT.md`](../../docs/security/SECURITY_EVALUATION_REPORT.md) 中固化的基准防线（Z-Handshake、Inverted Gate、CSP头、原型链阻断、Fail-Closed逻辑）核验是否产生隐式降级。
  3. 任何新发现的安全弱项，须依规沉淀至 `docs/feedback/`，修复后回填并归档至 `docs/feedback/done/`。
