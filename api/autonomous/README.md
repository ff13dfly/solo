# Solo Autonomous: 自主智能实验室

该目录是 Solo 生态系统中 **“自主性与受控进化”** 核心理念的实验与评估中心。与 `api/autocheck`（侧重代码静态合规性）不同，`api/autonomous` 侧重于系统 **高级角色 (AI Roles)** 的智力表现、安全决策以及自愈进化的评估。

## 核心目标

1.  **角色验证**：确保每个 AI 角色（如审计员、进化规划师）具备符合预期的业务逻辑理解能力。
2.  **基准测试 (Benchmarking)**：当更换底层模型 (LLM) 时，通过可复现的案例确保系统“智力”和“安全性”不下降。
3.  **黑盒模拟**：在不改动生产服务代码的前提下，模拟各种复杂业务场景。

---

## AI 角色图谱 (Role Mapping)

根据 [VERSION.md](../../docs/planning/VERSION.md)（v1.1 受信外部 agent 投稿档）的架构规划，Solo 内置了以下职责分明的 AI 角色：

### 1. 内部护航阵营 (Internal Escort & Evolution)

*   **工作流安全审核 AI (Workflow Auditor)**
    *   **职责**：驻扎在编排层，对外部 AI 提交的 PENDING 链路进行分级审核。
    *   **判定标准**：AUTO_PASS (全读) / ASSISTED_REVIEW (低风险写) / MANUAL_REVIEW (高风险写) / AUTO_REJECT (越权/危险)。
    *   **实验目录**：`./workflow-auditor`

*   **进化报告分析 AI (System Evolution Planner)**
    *   **职责**：夜间分析 `system.report` 收集的各种报错，合并重复问题，提炼为结构化的“系统能力改进任务”。
    *   **目标**：将运行时的感知转化为进化动力。

*   **代码自修复 Agent (Autofix Coding Agent)**
    *   **职责**：执行 Planner 下发的任务，自动化补全 API 的 `returns` schema 或优化描述。
    *   **原则**：纯元数据变更可自动化，业务逻辑变更必须经人类 Review。

*   **动态风控与行为嗅探 AI (Behavioral Risk Analyzer)**
    *   **职责**：离线分析 Router 的 `interaction log`，捕捉“蚂蚁搬家”式的数据窃取或非人类的 API 探测拓扑。

*   **出站语义审查 AI (Semantic DLP Guard)**
    *   **职责**：在 `gateway` 出口对外部 AI 发出的文本进行异步定性，防止敏感机密隐写外泄。

### 2. 外部驱动阵营 (External Business Driven)

*   **员工专属代办助理 (Personal Assistant Agent)**：使用员工子会话 Token，继承权限视野，协助日常业务操作。
*   **读写隔离的专职 Agent**：将数据分析（只读）与通知发送（只写）物理隔离，从架构上消除数据外流风险。

---

## 使用指南

### 如何进行复现测试？

每个角色子目录下都包含 `cases/`（测试用例）和 `simulate.js`（模拟脚本）。

1.  **添加案例**：在对应角色的 `cases/` 下添加新的 `.json` 文件。
2.  **运行模拟**：
    ```bash
    cd api/autonomous/{role-name}
    node simulate.js
    ```

### 依赖说明

为了保持代码库整洁，本目录下的脚本复用了 `api/node_modules` 下的共享依赖（如 `@google/generative-ai`, `dotenv`）。

---

> **注意**：本目录下的代码仅用于测试和智力评估，生产环境的 AI 角色逻辑实现请参考对应的微服务（如 `core/orchestrator` 或 `core/agent`）。
