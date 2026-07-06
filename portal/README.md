# Portals

该文件夹 (`portal/`) 存放面向**内部运营人员**的管理工具，与 `client/`（面向客户/供应商的外部应用）相对。每个 Portal 都是独立的 SPA，拥有自己的路由、状态管理和构建流程。

共同设计原则：**后端定义，前端即现 (Backend-Defined, Frontend-Rendered)**。

---

## 1. Operator Portal (`portal/operator`) — [README](operator/README.md)

**角色**：日常业务操作的"指挥中心"。

### 核心特性

- **动态路由与导航**：通过 `ServicesProvider` 动态拉取后端服务列表，自动生成侧边栏和路由表；`NON_DISCOVERABLE_SERVICES` 黑名单屏蔽基础设施服务
- **双模式渲染**：注册了专用组件（`ExtensionRegistry.tsx`）则加载富交互界面，否则根据后端 Entity Schema 自动生成通用 CRUD 表格和表单
- **已有专用页面**：`commodity`（商品）、`authority`（权限/人员/部门）、`fulfillment`（履约）、`sale`（销售）、`storage`（资产）

### 技术栈

- React 19 + TypeScript + Vite + **Tailwind CSS**
- TanStack Query（数据缓存与同步）
- React Hook Form + @rjsf/core（表单引擎）
- react-window（长列表虚拟化）
- ECharts（图表）
- axios + JSON-RPC 2.0

---

## 2. System Portal (`portal/system`) — [README](system/README.md)

**角色**：底层基础设施管理与 AI 调试台。

### 已有页面

| 页面 | 功能 |
|------|------|
| `Overview` | 服务发现、实体自省、能力网格 |
| `Dashboard` | 系统状态概览 |
| `ServiceManagement` | 微服务配置管理（含 Settings 子页） |
| `UserManagement` | 系统用户管理 |
| `WorkflowManagement` | Workflow 分类管理 |
| `ErrorLogs` | 错误日志查看 |

### 技术栈

- React + TypeScript + Vite + Tailwind CSS
- axios + JSON-RPC 2.0

---

## 3. 各 Portal 的 README 要求

每个 Portal 子目录须维护一份 `README.md`，内容覆盖以下几点：

1. **定位**：一句话说明这个 Portal 是给谁用的、解决什么问题
2. **访问方式**：本地开发端口、是否仅内网、部署限制及原因
3. **登录说明**：认证方式、账号来源、Router 节点选择方式
4. **功能页面**：列出已有页面及其职责（表格或列表均可）
5. **技术栈**：实际使用的框架和主要依赖

不需要记录：架构设计细节、未来规划、开发规范（这些属于 `CLAUDE.md` 或代码注释的范畴）。

---

## 4. UI 交互规范

为确保**极速响应**与**视觉风格统一**，`portal/` 下开发必须遵循：

- **禁止原生弹窗**：不使用 `window.alert/confirm/prompt`，改用 `useUI()` 钩子
  - 通知：`toast.success/error/info()`
  - 确认：`const isOk = await confirm({ message: "..." })`（基于 Promise，不阻塞渲染）
