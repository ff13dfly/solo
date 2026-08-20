# 反馈：SOLO E2E 测试体系审计（服务漂移、序号冲突、文档滞后与 UI 依赖）

> 来源：2026-08-20 对 `e2e/` 全量体系（harness、lib、66 套 suites 及 ui）代码核查与审计。  
> 依据：**全部基于当前代码与 CI 契约实测**。  
> 涉及：`e2e/harness/catalog.js`、`e2e/suites/*.e2e.test.js`、`e2e/README.md`、`e2e/ui/package.json`、`deploy/services.json`。  
> 一句话：SOLO 的 E2E 体系整体设计非常坚实（真实挑战-响应鉴权、四层深度断言、增量基线），但在**服务清单同步、用例序号卫生、文档维护状态与 UI 依赖完整性**上存在若干漂移与修缮点。

---

## 一、🔴 `mcp` 服务在 E2E 目录中遗漏（服务清单漂移）

### 1. 现象与代码位置
- `deploy/services.json`（CI 守护的单一真源）第 43–46 行已明确定义核心服务 `mcp`：
  ```json
  {
    "name": "mcp",
    "path": "core/mcp/index.js",
    "port": 8091
  }
  ```
- 但在 `e2e/harness/catalog.js` 的 `SERVICES` 字典中：
  ```js
  const SERVICES = {
      router:        { path: 'router/index.js',            port: 8600 },
      administrator: { path: 'core/administrator/index.js', port: 8680 },
      user:          { path: 'core/user/index.js',          port: 8710 },
      agent:         { path: 'core/agent/index.js',         port: 8730 },
      nexus:         { path: 'core/nexus/index.js',         port: 8740 },
      notification:  { path: 'core/notification/index.js',  port: 8040 },
      gateway:       { path: 'core/gateway/index.js',       port: 8020 },
      ingress:       { path: 'core/ingress/index.js',       port: 8070 },
      orchestrator:  { path: 'core/orchestrator/index.js',  port: 8820 },
      storage:       { path: 'apps/storage/index.js',       port: 8750 },
      fulfillment:   { path: 'apps/fulfillment/index.js',   port: 8050 },
      planner:       { path: 'apps/planner/index.js',       port: 8030 },
      approval:      { path: 'apps/approval/index.js',       port: 8060 },
      collection:    { path: 'apps/collection/index.js',    port: 8055 },
      market:        { path: 'apps/market/index.js',         port: 8056 },
  };
  ```
  `mcp` 完全未列入 `SERVICES`，且未加入 `PROFILES.full`。

### 2. 影响面
- 运行 `E2E_PROFILE=full jest` 时，`harness/setup.js` 不会拉起 `mcp`，也不会向 Router 注册 `mcp` 服务。
- 缺少针对 MCP 适配器（POST `/mcp` 将 ACTIVE 工作流映射为 tools/list、tools/call）的 E2E 黑盒验证用例。

### 3. 建议
1. 在 `e2e/harness/catalog.js` 中增加 `mcp: { path: 'core/mcp/index.js', port: 8091 }`。
2. 将 `mcp` 加入 `PROFILES.full` 列表。
3. 补充一套 `suites/xx-mcp.e2e.test.js`，验证 MCP 协议端点及 tool 调用转发。

---

## 二、🟡 测试套件文件名序号冲突（5 组重号）

### 1. 现象与代码位置
`e2e/suites/` 下存在 5 组相同序号前缀的测试文件：

| 重复序号 | 文件 A | 文件 B |
|:---|:---|:---|
| **54** | `54-fulfillment-loop.e2e.test.js` | `54-orchestrator-lifecycle.e2e.test.js` |
| **66** | `66-nexus-autorun.e2e.test.js` | `66-nexus-dynamic-streams.e2e.test.js` |
| **67** | `67-nexus-dlq.e2e.test.js` | `67-nexus-sentinel-identity.e2e.test.js` |
| **69** | `69-nexus-emit-loop.e2e.test.js` | `69-roles.e2e.test.js` |
| **70** | `70-operator-seam.e2e.test.js` | `70-operator-tier.e2e.test.js` |

### 2. 影响面
- Jest 虽按 glob `<rootDir>/suites/**/*.e2e.test.js` 匹配执行全部文件，但重号破坏了 README §7.5 中规划的“概念时序 / 分段逻辑”，增加了跨套件定位与日志阅读的心智负担。

### 3. 建议
- 重新编排重号文件的序号（例如将 lifecycle、dynamic-streams、sentinel-identity、roles、operator-tier 调整为未占用的序号，如 74–78 或更贴近其主题的独立编号）。

---

## 三、🟡 `e2e/README.md` 文档与实现状态漂移

### 1. 现象与代码位置
- `e2e/README.md:4` 标称：
  > `本文只规划与给骨架，尚未实现。校对基准 2026-06-03...`
- `e2e/README.md:412` 的 §14 执行记录仍保留初期的统计：
  > `Test Suites: 17 passed, 17 total`

### 2. 实际情况
- E2E 测试早已完整落地，目前已有 66 套测试文件，覆盖了从基础登录（`00-login`）到深度全链路（`100-delivery`、`101-aml-pipeline`、`110-governance-approval`、`113-passport-identity-line` 等）。
- 滞后的文档描述会使新进入的开发者误判 E2E 的可用性与覆盖广度。

### 3. 建议
- 校对更新 `e2e/README.md`，删除“尚未实现”的历史陈旧标记，更新用例数量与最新的覆盖范围。

---

## 四、🟡 `e2e/ui` 缺少 typescript 开发依赖

### 1. 现象与代码位置
- `e2e/ui/tsconfig.json` 存在并配置了 TypeScript 编译规则。
- 但 `e2e/ui/package.json` 中的 `devDependencies` 仅包含 `@playwright/test`：
  ```json
  "devDependencies": {
    "@playwright/test": "^1.49.0"
  }
  ```
- 当在 `e2e/ui` 目录下执行 `npx tsc --noEmit` 进行类型检查时，由于缺少本地 `typescript` 包而无法直接校验。

### 2. 建议
- 在 `e2e/ui/package.json` 的 `devDependencies` 中补齐 `"typescript": "^5.0.0"`。

---

## 五、🟢 审计确认健全的设计与实现

在本次审计中，以下核心机制经实测和代码核验，表现良好且符合架构约定：

1. **真实 SHA-256 挑战-响应鉴权**：
   - `harness/identity.js` 严格按照 `user.login.request` → SHA256(challenge + hash) → `user.login.verify` 取得真实 Session，完全符合 SOLO 去除 Ed25519 用户签名的正确设计。
2. **四层深度断言（Verify Layer）**：
   - `assertResult`、`assertRecord`、`assertWal`、`assertNoErrors`、`snapshotKeyspace/diffKeyspace` 体系完整。
   - `captureErrorBaseline`（增量基线）成功解决了共享 Mesh 下各套件间 `ERROR:QUEUE` 噪声误报的问题。
3. **环境与端口隔离**：
   - 提供了 `E2E_PORT_OFFSET` 支持与 dev 栈并存；`LOG_DIR` 支持隔离 WAL 输出；通过 `SHUTDOWN NOSAVE` 协议可靠关停 `redis-stack` 容器子进程。
4. **危险操作防御**：
   - `admin.self.lock` 与 `admin.password.reset` 在共享套件中显式使用 `test.skip` 排除，有效防止测试套件自身破坏运行栈。

---

## 处理结论（solo 侧）

**triage 2026-08-20。四条指控经逐条核实全部属实**（§二的 5 组重号独立重算与文中列表逐字一致；
§五 抽查三条也属实：`identity.js` 确做 `sha256(challenge+hash)`、7 个断言函数全在 `e2e/lib/verify.js`、
`admin.self.lock`/`password.reset` 确以 `test.skip` 排除并带原因注释）。核实中补了两处本文没写到的：

### 补充一：§一 的根因是门禁盲区，不是「漏了一行」

`deploy/check-doc-drift.js` 对 `catalog` **零命中**，CI 也没有任何地方校验
`e2e/harness/catalog.js ↔ deploy/services.json`。CI 守了 `CLAUDE.md §2`、`config.js portFor`、
`introspection ↔ index 注册`——唯独 e2e 的服务清单没人管，所以 `mcp` 才会一直缺而无人发现。
**只补一行 mcp 解决这一次，下次新增服务同样静默漏掉。**

### 补充二：§四 的建议不完整，照做等于装一个没人跑的包

CI 的 `portal-tsc` job 只对 `portal/system` + `portal/operator` 跑 `tsc --noEmit`（这两个确实装了
`typescript ~5.9.3`）；`e2e/ui` 的 CI 只跑 `npx playwright test`，**从不跑 tsc**，而 Playwright 自带
TS 转译，`.spec.ts` 照跑不误——**当前没有任何实际故障**。`e2e/ui` 也没有 `typecheck` script。
所以只加 `devDependencies.typescript` 之后没有任何东西会去跑它。这实质是**「要不要给 e2e/ui 上
类型门禁」的决策**（要做就得 devDep + script + CI job 三件套），不是「补个依赖」的修补。

### 逐条处理

- ✅ **§三 采纳（先做，成本最低）**：`e2e/README.md` 文首删去「尚未实现」——顺带修掉一处本文没
  发现的**内部矛盾**：文首说「尚未实现」而 §14 开头写着「已实现并跑通」，文档自己打自己。
  现文首说明「写于规划期、系统此后已完整落地（66 套，`00-login` → `113-passport-identity-line`）」，
  并指明 §9/§13/§14 是当时的规划与首次落地状态、当前覆盖以 `e2e/suites/` 与 CI 为准；
  §14 标题改为「首次落地记录（2026-06-03 快照 — 不是当前状态）」并加时效声明。
  **刻意没有编造新的执行数字**——本轮没有跑全量 66 套，执行结果的权威是 CI。
- ✅ **§一 采纳并治本**：`catalog.js` 的 `SERVICES` 补 `mcp: { path: 'core/mcp/index.js', port: 8091 }`
  + `PROFILES.full` 加 `mcp`；**同时给 `check-doc-drift.js` 新增第 7 节守护**——services.json 的每个
  服务必须在 SERVICES 里且 path/port 一致、除 router 外必须进 `PROFILES.full`（允许 catalog 多出
  仅供内部测试的 collection/market）。实现坑：`catalog.js` 在 require 时会 `svc.port += PORT_OFFSET`，
  比对前必须用导出的 `PORT_OFFSET` 还原，否则设了 `E2E_PORT_OFFSET` 就误报。
  本文建议 3（补 `xx-mcp.e2e.test.js`）**未做**：那是新增测试，得先定 MCP 的 E2E 要覆盖到什么程度。
- ❌ **§二 判定不做**：重排 5 组重号要改 5 个文件名，会打断 git 的文件历史追踪，还要同步改 §7.5 的
  时序表，而收益只有阅读顺序——Jest 按 glob 收集，重号不影响执行，且每个文件自洽、文件间不共享
  状态。改为在 `README §7.5` 写明「编号只表达大致概念时序、不保证唯一，定位用文件名主题词」。
- ⏸ **§四 暂缓**：等「要不要给 e2e/ui 上类型门禁」这个决策，见补充二。**本篇因此留在待办目录**。

### 顺带修掉（本文未提及的同类漂移）

`.github/workflows/ci.yml` 的 e2e job 名写着 `54 suites`（实际 66）、步骤名写着
`Router + 13 services`（full 档实际 15 个服务）——同一类「标签滞后于实际」，一并改正。

### 验证

- `check-doc-drift.js` 绿；新增的第 7 节做了**三个负测试**（抽掉 SERVICES 里的 mcp / 只抽掉
  `PROFILES.full` 里的 mcp / 把端口改成 8092），三次都按预期报出对应错误，还原后复绿。
- **`mcp` 真的能被 harness 拉起**：`E2E_PROFILE=full E2E_PORT_OFFSET=1200` 独立 redis 实跑
  `suites/00-login`，全栈 15 服务启动无一失败，teardown 日志含 `mcp (pid …) stopped.`，套件 2/2 绿。
  （**未跑全量 66 套**——本轮只验证「加 mcp 不破坏整栈启动」这一个风险点。）

### 归属提醒（未执行，待定）

本篇是**对 solo 自身 e2e 体系的内部代码审计**，而 `docs/feedback/` 的两条通道是「运行时
`system.report` 收集」与「**派生项目实战**踩出来的反馈」——两条都不是。更贴切的位置是
`docs/planning/toFix.md`。**未擅自移动**，留待决定；若保留在此，建议文首注明这是内部审计。
