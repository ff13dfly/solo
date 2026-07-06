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
| [审批协议](./approval) | 审批工作流数据结构与处理 |
| [联邦分类协议](./category) | 微服务分类注册与全局发现 |
| [AI 测试协议](./ai-test) | 🟡 草案·未实现(已砍成 stub)— 评估 AI NL 准确率;真实载体 = `workflow-auditor` + `agent.case.generate`,非 tester 微服务 |
| [报表协议](./report) | 🟡 草案·未实现 — 通用报表 DSL 定义（跨行聚合，与显示协议互补） |
| [显示协议](./display) | 🟡 草案 — operator 自治的实体呈现配置（字段显隐/顺序/格式/单行派生）；呈现不进服务 introspection；③个人覆盖层已落地，②operator 配置层（静态基线 + administrator 覆盖）未实现 |
| [QR 路由协议](./qr) | 物理标签 URL 规范、前缀分配与业务关联流程 |
| [视觉搜索协议](./vision) | 🟡 草案·未实现 — 以图识图：Embedding 生成、向量索引、KNN 查询与置信度分级 |
| [流程协议](./process) | 实体状态机 UI 映射与动态操作按钮 |
| [履约生命周期协议](./fulfillment) | 声明式状态机驱动的业务履约引擎 |
| [信息提取协议](./extraction) | AI 辅助产品信息提取与多语言翻译 |
| [Passport 协议](./passport) | 设备授权与 OTP 验证机制 |
| [Authority 协议](./authority) | 🟢 v1 已实现 — **统一角色 RBAC** `user.role.*`(assign 物化到主体)+ 外部主体可管理实体 `user.passport.*`(含 `app` 维度)+ 铸受限 session + Router 方法墙(零改)+ `collection` 按 `$owner` 行隔离 + `portal/operator` 管理页;通用版 `entity.js` 行隔离待抽 |
| [配置协议](./config) | 微服务配置规范与环境变量管理 |
| [Agent 上下文组装协议](./context) | 🟢 v1 已实现 — 声明式 `guard`(JsonLogic)+ `data_fetchers` + `system_prompt_template`;事件到达后装配 Context Payload,`autorun` 再闭合到 LLM(`agent.chat`)产出回投;人机协同(§10)仍为草案 |
