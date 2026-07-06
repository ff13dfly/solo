# Solo Autocheck: 微服务合规性审计中心

`autocheck` 是 Solo 生态系统中用于保障微服务质量的 **自动化审计工具**。它通过静态分析和运行时模拟，确保所有微服务符合 Solo 的工程标准、安全规范以及架构约定。

在每一个微服务上线或发布 PR 前，运行 `autocheck` 是强制性的质量关口。

## 核心功能

1.  **静态代码审计 (Static Audit)**：在不运行服务的情况下，通过 AST 分析和正则扫描检测潜在的工程缺陷。
2.  **运行时模拟 (Runtime Simulation)**：模拟真实的 Redis 环境和 RPC 调用，验证服务的启动稳定性及核心逻辑正确性。
3.  **合规性拦截**：检测是否使用了禁用的 API（如 `console.log`）、是否缺失了必要的内省（Introspection）声明等。

---

## 使用指南

### 1. 静态检测模式 (推荐)
最常用的模式，速度极快，用于快速扫描目录结构、命名规范和代码风险。

```bash
# 检查特定的微服务
node api/autocheck/checker.js api/apps/lucky --static

# 检查当前目录
node api/autocheck/checker.js . --static
```

### 2. 全量检测模式 (含运行时)
需要本地环境中有可用的 Redis。它会尝试启动服务并执行集成测试。

```bash
node api/autocheck/checker.js api/apps/lucky
```

---

## 审计项概览

`autocheck` 目前包含超过 40 项审计规则，涵盖以下领域：

| 领域 | 核心规则示例 |
| :--- | :--- |
| **工程结构** | 必须包含 `index.js`, `config.js`, `handlers/introspection.js` |
| **安全规范** | 必须使用 Ed25519 握手，禁止明文存储敏感信息 |
| **RPC 协议** | 必须遵循 JSON-RPC 2.0，方法名需符合 `service.entity.action` 约定 |
| **数据一致性** | 强制使用 Entity Factory 模式，必须实现逻辑软删除 (`is_deleted`) |
| **性能与稳定** | 检测未清理的定时器、内存泄漏风险、浮动 Promise、未限制的并发 |
| **可观测性** | 禁止使用 `console.log`（必须使用内置 Logger），必须补全 `returns` 描述 |
| **AI 友好性** | 检查 `ai: true` 标记的方法是否具备准确的语义描述和 Schema |

---

## 目录结构说明

```text
api/autocheck/
├── checker.js        # 审计执行入口
├── static/           # 静态审计规则库 (AST/Regex 规则)
└── simulation/       # 运行时模拟引擎 (集成测试框架)
```

## 结果判定

*   ✅ **PASSED**: 所有检查项均通过。
*   ⚠️ **WARNINGS**: 存在不符合非核心约定的地方（如代码风格），建议修复但不阻塞部署。
*   ❌ **ERRORS**: 存在严重违规（如安全漏洞、缺失核心文件），**必须修复后方可部署**。

---

> **注意**：`autocheck` 专注于工程规范。关于 AI 角色（如 Auditor）的逻辑模拟和智力评估，请参考 [api/autonomous/](../autonomous/README.md)。
