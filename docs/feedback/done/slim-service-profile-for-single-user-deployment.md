# 反馈：缺一个「单机单用户精简档」——派生项目想发个人版，却只能起全套 12 个 core 服务

- **来源**：steward，2026-10-13。准备发布「个人版」（每个用户在自己电脑上跑一整套 Steward，配 WorkBuddy 连接器），
  评估 `deploy/personal/` 一键启动的门槛时撞到。设计背景见 steward 仓
  `docs/strategy/workbuddy-connector.md` §11。
- **依据分类**：**源码引用**（grep，**未跑过**）：下表「谁在调谁」。**本次实测**：无——精简集还没在隔离环境起过。
  所以下面的「可删 / 存疑」都是**待 Solo 侧确认的假设**，不是结论。
- **涉及**：`deploy/run.sh`（读 `solo-services.json`）、`deploy/gen-entry.js`（懒加载注册表）、
  `api/router/config.js`（引用 administrator 等服务地址）、`api/router/handlers/manifest.js`、
  `api/core/user/logic/passport.js`（OTP 才用 gateway）、`api/core/nexus/logic/{stream,sentinel}.js`（引用 notification / agent）。
- **影响面**：任何想把 Solo 栈装进**个人电脑**的派生项目。线上（多租户、办公室服务器）不受影响。

> 一句话：**Solo 的 bundle 本来就是「全部打进去、按 `SOLO_SERVICES_JSON` 懒启动」，精简的机制已经有了；
> 缺的是「哪几个服务是最小可运行集、少起哪些会影响什么」这份权威答案**——现在每个派生项目只能自己猜。

---

## 一、现象

steward 的个人版引导（`deploy/personal/bootstrap.sh`）直接沿用线上的 `solo-services.json`，起 12 个 core 服务
（router / administrator / user / agent / nexus / notification / gateway / ingress / orchestrator / storage / fulfillment / approval），
外加 3 个 steward 私有应用和 Redis Stack。个人用户机器上是 16 个 Node 进程 + 1 个 Redis，门槛和内存占用都偏高；
而 steward 实际只用到其中一小部分。

## 二、steward 侧的依赖盘点（grep 结果，待你确认）

| 服务 | steward 是否调用 | 备注 | 我的判断 |
|---|---|---|---|
| router、user | 是 | 登录（挑战-响应）、`user.token.refresh`、权限 | 必留 |
| nexus | 是 | hive 定时靠 `nexus.schedule`（`api/apps/hive/index.js:52`） | 必留 |
| storage | 是 | `storage.asset.multi/resolve`（`api/library/auth.js`、steward `index.js:45`），插件与 monitor 上传 | 留 |
| agent | 是，可选 | `agent.decide` = 「自动分析」；个人版自带模型 Key | 留；不配 Key 可不起 |
| administrator | 未直接调用 | 但 `api/router/config.js:8` 有它的地址 | **存疑，要实测不起会不会挂** |
| gateway | 否 | 仅 `user/logic/passport.js` 发邮件/短信 OTP 时用；steward 不走 OTP | 可删（需确认 user 启动不依赖） |
| notification | 否 | nexus stream/sentinel 引用，疑似软依赖 | 可删（需确认缺它时 nexus 是否降级而非报错） |
| ingress、orchestrator、approval、fulfillment | 否 | steward 服务端无调用；monitor 里的 `fulfillment.*` 只是 i18n 文案 | 可删 |

按此表，12 个可降到 **4～6 个**。

## 三、希望 Solo 侧做的事（由你定取舍）

1. **确认最小可运行集**：`router + user + nexus + storage` 是否够用？`administrator` 能不能不起（Router 启动 / 鉴权路径上是否硬依赖）？
   缺 `notification` / `gateway` 时 `nexus` 与 `user` 是降级还是启动即报错？——这三个是我没法靠读代码下结论的。
2. **决定交付形态**，三选一，请你判断哪个适合 Solo：
   - **A. 只给文档**：在 README / GUIDE 里写「最小服务集」与各服务缺席时的影响，派生项目自己写精简 `solo-services.json`；
   - **B. 给一份官方 profile**：例如 `deploy/services.minimal.json`（与已有 `services.dev.json` 并列），`upgrade.sh` 一并下发；
   - **C. 服务自述依赖**：每个服务声明「我依赖谁（硬 / 软）」，`run.sh` 起之前校验，缺了硬依赖当场报清楚。
3. **精简后仍需保持**：`run.sh` 不改（steward 把它当 Solo 下发件，改了会标 DIVERGED）；个人版不得带入 dev 削弱项
   （如 `APPROVAL_COOLING_MS_HIGH='0'`）。如果 approval / orchestrator 不起，这条自然消失，但请确认没有别处隐式要求它们在线。

## 四、不在本篇范围

- Redis Stack（RedisJSON）门槛、Node ≥ 20 要求：这是另一类问题（外部依赖，非服务数量），steward 侧自己在引导里体检。
- 把 bundle 本体裁小（7MB，懒加载下运行时无感）：不需要。

## 五、处理结论

**2026-10-13 · 采纳，交付形态 = B + A（官方 profile + 文档），不做 C。**

**核实（本次实测）**：空 Redis（无 RedisJSON）+ `SOLO_SERVICES_JSON` 指向 `router/user/nexus/storage` 四项，跑 `api/publish/solo.js`：
4 个服务全部 `Ready`，Router 起得来、nexus scheduler 起得来。缺 `administrator` 只在 Router 能力自省处报
`Failed to introspect service "administrator"` 警告（`ensureAdministratorService` 只是写注册默认项，不要求进程在线）。
源码核对：`user` 对 gateway 的调用在 `passport.js` OTP 路径，经 relay best-effort，吞错；`nexus` 对 notification 的调用在
`stream.js` 的 sentinel 事件投递（缺了走重试/DLQ，非启动期依赖），`nexus.schedule` 的 `emit_event` 走 `event.emit`、不经 notification。

**回答三问**：
1. 最小可运行集 = `router + user + nexus + storage`（实测）；`administrator` 可不起；缺 `gateway`/`notification` 均不阻断启动，影响面见 `deploy/README.md` 新增表。
2. 选 B+A：新增 `deploy/services.minimal.json`，影响表写进 `deploy/README.md`。**不选 C**：现有缺席全是软降级，硬依赖校验收益小、改动面大。
3. `run.sh` 未改；profile 不含 approval/orchestrator，`APPROVAL_COOLING_MS_HIGH='0'` 这类 dev 削弱项随之不适用。

**未验证 / 后续**：① 仅启动层实测，没跑登录与 `storage.asset.*` 的端到端；② `agent` 未实测（steward 需要时追加一行）；③ `upgrade.sh` / scaffold 是否下发该 profile 尚未做——派生项目目前需自行拷贝，要下发请另开项。

### steward 验证步骤（本次不发 release）

本次只新增 JSON 与文档，无运行时代码改动；现有 v1.3.0 的 `solo.js` 是全量 bundle，由 `SOLO_SERVICES_JSON` 决定起哪些服务，**直接可用**。`upgrade.sh` / scaffold 暂不下发该 profile，故发 release 也送不到 steward——先手动验证：

1. 把 Solo 仓 `deploy/services.minimal.json` 拷成 steward 的 `deploy/solo-services.json`（`run.sh` 不改）。
2. Redis Stack（带 RedisJSON）+ Node ≥ 20，跑 `run.sh`。
3. 验证端到端：挑战-响应登录 + `user.token.refresh`；hive 经 `nexus.schedule` 定时触发；`storage.asset.multi/resolve` 与插件/monitor 上传；需要「自动分析」时追加 `agent` 一行再测 `agent.decide`。
4. 通过后回报：若要让 profile 随 `upgrade.sh` / scaffold 自动下发，再另开一项，连同下发逻辑发 patch 版本。
