# System Portal

面向系统管理员的基础设施管理与 AI 调试台。

- 本地开发：`http://localhost:9200`
- 仅内网部署，不对外暴露（直连 Router，持有完整业务权限，公网部署攻击面过大）

---

## 登录

与 Operator Portal 相同的挑战-响应登录机制（PBKDF2 + Ed25519）。

登录页同样支持 Router 节点切换，预设与 Operator Portal 一致（Production / Dev Server / Local SSL / Local HTTP），节点配置共享同一 localStorage key（`solomind:router_addresses`）。

需要管理员级别账号权限。

---

## 功能页面

### Overview（服务总览）
- **服务发现**：实时列出所有活跃微服务及其状态
- **实体自省**：交互式展示各服务的 Entity Schema 字段定义
- **能力网格**：可视化 RPC 方法与 AI 增强能力列表

### Dashboard
系统运行状态概览，含关键指标图表。

### AI Support（AI 调试台）
- **用例生成**：调用 `agent.cases` 自动生成标准/口语化/边界测试用例
- **Focus 模拟器**：在 Web 端模拟手机端参数提取交互，验证 Workflow 逻辑
- **准确率报告**：统计意图识别与参数提取的成功率

### Service Management（服务配置）
微服务配置的查看与编辑，子页包括：
- **Service Overview**：服务基本信息
- **Service Panel / Config Editor**：配置项管理
- **Service JSON Editor**：原始 JSON 配置编辑
- **Service Blacklist**：服务黑名单管理

### User Management（用户管理）
系统用户的查看、创建与权限调整。

### Workflow Management（工作流管理）
AI Workflow 的分类与维护。

### Error Logs（错误日志）
微服务错误日志的集中查看与筛选。

---

## 技术栈

- React + TypeScript + Vite + Tailwind CSS
- axios + JSON-RPC 2.0
