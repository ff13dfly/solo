# 协议规范

本部分包含 Solo·AI 系统的核心协议规范文档。

## 协议列表

> 先读 **[治理协议总览](./governance)** —— 它把 permit / 审批 / actor-claim / footprint 预审四者如何构成自洽治理体系缝合成一张图,并点明体系级的未决与矛盾。

> **标注约定**：未标记 = 已实现/部分实现；**🟡 草案·未实现** = 仅设计文档，代码中无对应实现（判断以 [`CLAUDE.md`](../../../CLAUDE.md) §2 为准）。

| 协议 | 说明 |
|------|------|
| [治理协议总览](./governance) | permit·审批·actor-claim·footprint 四道关卡的分工、调用链、信任根与设计未决(缝合图) |
| [工作流协议](./workflow) | AI 驱动的工作流定义、参数收集与执行 |
| [事件与触发总线](./event) | `_event` 信封、run-queue、四种触发源(sync/event/cron/webhook)统一执行（nexus 时钟 + orchestrator matcher + router `event.emit`/`_event`） |
| [安全协议](./security) | 零知识认证与细粒度权限控制 |
| [短期记忆协议](./memory) | 客户端上下文记忆管理 |
| [审批协议](./approval) | 🟢 v1 已实现 — 三段式 `approval.record.*`（三方职责分离 + Ed25519 签名验真 + 过期 `EXPIRED`）、`approval.gate.*`（m-of-n 多签闸）与 `approval.policy.*`（subject 模式策略）；系统代理执行（§8）与数值阈值/AI 规则（§9.1）仍为草案 |
| [联邦分类协议](./category) | 微服务分类注册与全局发现 |
| [AI 测试协议](./ai-test) | 🟡 草案·未实现(已砍成 stub)— 评估 AI NL 准确率;真实载体 = `workflow-auditor` + `agent.case.generate`,非 tester 微服务 |
| [报表协议](./report) | 🟡 草案·未实现 — 通用报表 DSL 定义（跨行聚合，与显示协议互补） |
| [显示协议](./display) | 🟢 部分实现 — operator 自治的实体呈现配置（字段显隐/顺序/格式/单行派生）；③个人覆盖层与 ②-B 管理端覆盖层（`setting.display.*`）已落地，②-A 静态基线文件尚未内置 |
| [QR 路由协议](./qr) | 物理标签 URL 规范、前缀分配与业务关联流程 |
| [视觉搜索协议](./vision) | 🟡 草案·未实现 — 以图识图：Embedding 生成、向量索引、KNN 查询与置信度分级 |
| [流程协议](./process) | 实体状态机 UI 映射与动态操作按钮 |
| [履约生命周期协议](./fulfillment) | 🟢 v1.6 已实现 — 声明式状态机、Profile 投稿审批与完整性锁、五项 RPA 协同原语（`stateTtls`/`reap`、`suspend`/`resume`、`evidence`、`token.issue`/`callback`、`idempotent`） |
| [信息提取协议](./extraction) | AI 辅助产品信息提取与多语言翻译 |
| [Passport 协议](./passport) | 🟢 v1 已实现 — 外部主体身份（管理员发证、自助 OTP、设备 TOFU `device.issue`、身份升级 `upgrade`、Bot 权限路由） |
| [Authority 协议](./authority) | 🟢 v1 已实现 — **统一角色 RBAC** `user.role.*` + 外部主体可管理实体 `user.passport.*` + 铸受限 session + Router 方法墙 + **`library/entity.js` 通用 `$owner` 行级隔离** + `portal/operator` 管理页 |
| [配置协议](./config) | 🟢 v1 已实现 — `library/config.js` + `setting.config.*` / `setting.index.schema` / `setting.automation.*` |
| [Agent 上下文组装协议](./context) | 🟢 v1 已实现 — `nexus.sentinel.*` 声明式 `guard`(JsonLogic)+ `data_fetchers` + `prompt`;事件到达后装配 Context Payload,`autorun` 闭合到 `agent.decide` 并支持 `context.emit` 声明式事件回投;人机协同(§10)仍为草案 |
