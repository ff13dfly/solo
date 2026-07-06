# Solo·AI 系统技术说明文档

本记录详细说明了 Solo 系统的核心技术选型、架构设计以及执行逻辑，旨在为开发者和系统管理员提供清晰的技术视图。

> ⚠️ **本文档含产品愿景 / 业务示例，非框架现状——读时按代码核实。** 文中出现的 **Authority / Sale / Asset / ERP、用友(Yongyou) T+ 集成**等是**举例与设想**，框架代码里**不存在**（SOLO 是纯框架、无业务层——见 [`../../CLAUDE.md`](../../CLAUDE.md) §1；authority 已被 ADR 1.4.1 砍掉）。部分技术细节为示意，**实际以代码为准**：
> - 转发签名头实为 **`X-Router-Token`**（Ed25519 压缩载荷）+ `X-Router-Signature`，**不是** `x-solo-signature`（见 CLAUDE.md §7）。
> - QR / 资产解析方法是 **`storage.asset.resolve`**，HTTP 路由是 `/file/:id`，**没有** `asset.resolve` 裸方法或 `/a/{idBase36}` 协议。
> - 测试 / 运行依赖 **`redis-stack-server`**（RedisJSON + RediSearch），非"Tair/Enterprise Edition"。
>
> 真实服务清单见 CLAUDE.md §2 / [`overview.md`](./overview.md)（后者带同款 ⚠️ 标签）。

## 0. 核心设计哲学 (Core Design Philosophy)

### 无状态设计 (Stateless Design)
Solo 系统严格遵循 **无状态微服务 (Stateless Microservices)** 原则。
- **水平扩展性**: 所有的 API 服务进程（如 Authority, Sale）不保存任何本地上下文（Session、缓存等）。这使得可以通过增加或减少服务副本（如使用 PM2 集群或容器化调度）来快速响应负载变化。
- **故障恢复**: 任何一个微服务实例宕机，新的实例启动后可以立即投入使用，不需要进行耗时的状态同步或数据预热。
- **状态集中化**: 系统所有的状态（用户会话、任务进度、业务数据）均集中存储于 **Redis** 中，确保在分布式架构下的数据一致性。
- **Token 驱动**: 客户端请求携带自描述的 Token 或经由 Router 解析的 Session 数据，服务端仅需对单次请求进行处理并返回结果。

## 1. 系统选型 (Technology Stack)

### 1.1 后端核心
- **运行时**: Node.js (LTS)
- **Web 框架**: Express.js (用于 Router 层和各微服务轻量化接入)
- **通信协议**: **JSON-RPC 2.0**。全系统采用逻辑无感、无状态的 RPC 调用，确保微服务间的高效协作。

### 1.2 数据存储与检索
- **核心数据库**: **Redis (Tair/Enterprise Edition)**
  - **选用原因**:
    - **极高的 I/O 性能**: 内存优先的设计确保了系统在处理高并发资产扫描、订单处理时能达到毫秒级的响应。
    - **原生 JSON 支持**: `RedisJSON` 模块允许直接存储和操作 JSON 文档，消除了传统关系型数据库（RDBMS）中复杂的 ORM 映射开销，非常适合快速迭代的微服务模型。
    - **高效搜索引擎**: `RediSearch` 模块提供了强大的索引与全文检索能力，能够替代昂贵且慢速的 SQL `JOIN` 和 `LIKE` 操作，在分布式环境下依然保持 O(log N) 的检索效率。
    - **统一状态管理**: 将消息队列、缓存和持久化存储统一在 Redis 协议下，大幅简化了系统的运维成本和依赖复杂度。
- **集成层**: 深度集成 **用友 (Yongyou) T+ ERP**，通过 OpenAPI 实现业务数据（库存、财务、供应商）的同步。

### 1.3 前端架构
- **框架**: React (TypeScript)
- **构建工具**: Vite
- **样式**: CSS (Vanilla/Tailwind 可选)，注重高性能响应式设计。
- **状态管理**: 响应式 Hook 驱动，结合 RPC 客户端实现数据同步。

---

## 2. 核心架构设计 (Core Architecture)

系统采用 **微服务架构 (Microservices)**，并通过一个核心 **Router (网关)** 进行解耦。

### 2.1 Router (中心网关)
Router 是系统的唯一入口，承担以下职责：
1. **服务发现 (Service Discovery)**: 维护 `SERVICES` 注册表和 `CAPABILITY_MAP` (能力图谱)。
2. **鉴权与权限 (Auth & RBAC)**: 基于 Token 的会话解析，并根据角色（Admin/Operator 等）执行方法级权限过滤。
3. **安全签名**: 使用 **Ed25519 (Base58)** 算法对转发给下游服务的 Payload 进行签名，实现三级安全校验。
4. **频率限制 (Rate Limiting)**: 针对用户或 IP 执行动态限流。

### 2.2 微服务职责划分
- **Authority**: 管理角色、部门、员工及其绑定关系。
- **Sale**: 处理订单生命周期、购物车、基于 RediSearch 的订单检索。
- **Asset**: 通用资产管理（如车辆、单据、设备），支持二维码 (QR) 协议绑定。
- **Storage**: 文件上传、存储映射及 URL 解析。
- **ERP**: 专门对接 T+ 系统的协议适配层。
- **Agent/Workflow**: 执行 AI 驱动的编排逻辑与任务流。

---

## 3. 执行逻辑 (Execution Logic)

### 3.1 请求生命周期 (Request Life Cycle)
当一个 JSON-RPC 请求到达 Router 时，会经历以下阶段：

1. **Phase 1: 解析与初步校验**
   - 提取 Token，解析会话用户。
   - 检查请求格式是否符合 JSON-RPC 2.0 规范。
2. **Phase 2: 权限与路由**
   - **Local Dispatch**: 检查是否为 Router 自身处理的系统方法（如 `system.service.list`）。
   - **Permission Gate**: `checkAccess()`。验证当前用户是否有权调用目标服务的目标方法。
   - **Rate Limit**: 检查是否触发限流。
3. **Phase 3: 转发与执行**
   - **参数校验**: 根据能力图谱动态校验 `params` 的合法性。
   - **Payload 签名**: 注入 `x-solo-signature`。
   - **Upstream Forward**: 将请求转发至目标微服务的内部 URL。
4. **Phase 4: 后置处理**
   - **任务提取**: 如果响应中包含 `_tasks`，则由 Router 异步触发后台任务。
   - **交互审计**: 如果是 AI 相关方法（`agent.*`），记录用户输入 (Prompt) 和输出 (Answer) 到月度分表日志中。

### 3.2 资产与二维码解析逻辑
系统定义了 `/a/{idBase36}` 的通用路由协议：
- **解析层**: 客户端或前端扫描 QR 后，将 ID 发送至 `asset.resolve`。
- **绑定层**: 系统查询资产关联的目标实体（如 `order`, `car`, `user`），并根据 `category` 返回对应的业务视图。

---

## 4. 部署与运维 (Deployment)

- **应用管理**: 使用 **PM2** 进行进程守护和集群模式运行。
- **反向代理**: **Nginx** 负责 SSL 终止、静态资源分发以及 `/` 网关转发。
- **日志体系**: 标准输出 (`stdout`) 实时采集 + Redis 交互审计日志。

---

## 5. 核心原则 (Core Tenets)

1. **JSON 为中心**: 存储用 JSON，传输用 JSON，配置用 JSON。
2. **Redis 优先**: 尽量利用 Redis 的原子操作和高性能模块替代传统的 SQL。
3. **安全透明**: 所有的敏感操作必须经过 Router 签名的 Level 3 校验。
