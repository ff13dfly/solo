# 基于 Solo 搭建新项目

本文档说明如何用 Solo 的单文件 bundle 快速搭建一个新系统（如 Runner）的脚手架。

---

## 核心原则

> **Solo bundle 是端口无关的 service loader——一份 artifact 通吃所有项目。**

| 旧做法 | 本方案 |
|---|---|
| 把 Solo 源码 copy 过去 | 只复制 `solo.{version}.js` 一个文件 |
| 升级 = 重新同步几十个文件 | 升级 = **覆盖**一个 `.js` 文件 |
| 端口、服务列表写死在 bundle | 启动时由 `SOLO_SERVICES_JSON` 决定加载哪些服务、绑哪些端口 |
| 多项目同台必冲突 | 每个项目独立扫端口段，互不打架 |
| 本地 `require` 路径互相依赖 | Solo 内部已 bundle，对外黑盒 |

`api/publish/solo.{version}.js` 是 Solo 发布的**不可变 artifact**。它内部用 `gen-entry.js` 生成的入口：把所有内部 service 注册成一份 REGISTRY（懒加载工厂函数），启动时读取 `SOLO_SERVICES_JSON` 指向的 JSON——按里面的清单决定**激活哪些 service、各绑哪个端口**。同一个 bundle，不同项目传入不同的 JSON，端口、服务子集就完全独立。

升级路径因此只剩一个动作：**`cp` 新的 `solo.{version}.js` 覆盖旧的**（外加 `library/`、`sample/`、`autocheck/` 这三个 Solo 提供给私有 apps 引用的源码目录）。项目本地的 `solo-services.json` / `services.json` / `.env` / `seed.json` 全部**不动**。

---

## 目录结构

```
new-project/
├── .solo-version                Solo bundle 版本标记（如 v1.2.0）
├── .env                         环境变量（REDIS_URL、JWT_SECRET、ROUTER_PUBLIC_KEY...）
├── .keypair                     Router Ed25519 私钥
├── package.json                 项目 identity + npm 依赖（私有 apps 用）
│
├── .claude/
│   └── skills/solo-service/     [Solo] Claude Code 守门技能 —— 建/改服务时自动触发：红线 + 指向 docs/ 与 sample + 收口 autocheck
│
├── docs/                        [Solo] 契约文档包 —— 手册唯一入口；让 AI/人只凭脚手架写 wire 兼容的服务/事件/工作流
│   ├── README.md                手册索引
│   └── authoring/
│       ├── service.md           怎么写 Router 能识别的服务
│       ├── events.md            发/收事件、触发自动化
│       ├── workflows.md         引擎对齐的 workflow 语法参考
│       └── workflow-examples/   可跑示例（sync 单步 / 多步+条件 / 事件触发）
│
├── api/
│   ├── publish/
│   │   └── solo.v1.2.0.js       [Solo] 单文件 bundle，黑盒，升级时整体覆盖
│   │
│   ├── library/                 [Solo] 共享工具库（jsonrpc / logger / ports / ...）
│   ├── autocheck/               [Solo] 静态检查工具，AI 开发时使用
│   ├── sample/                  [Solo] 微服务代码模板，AI 创建新服务时参考
│   ├── seed.json                [Project] 初始 admin 凭证，首次登录后自动销毁
│   │
│   └── apps/                    [Project] 私有微服务
│       └── <your-service>/
│
├── portal/                     面向内部运营人员的管理台
│   ├── operator/               [Project] 运维台源码（Vite/React）—— 后台改动大，团队直接改 UI；init 拷贝，升级不覆盖
│   ├── system/                 系统台占位（走 bundle，无源码）
│   └── publish/                [Solo] 前端发布物 operator/system.v{ver}.tar.gz（run.sh 解压并 serve）
│
├── client/                     面向终端用户的外部应用
│   ├── mobile/                 移动端 / PWA 占位（走 bundle，无源码）
│   ├── plugin/                 插件占位（各插件独立开发发布，不经 run.sh）
│   └── publish/                [Solo] 前端发布物 mobile.v{ver}.tar.gz（run.sh 解压并 serve）
│
├── e2e/                        [Project] 测试 —— init 拷贝，升级不覆盖
│   ├── harness/ lib/ suites/   API 全栈 e2e（jest，起 bundle + 私有 apps，跑黑盒）
│   └── ui/                     UI e2e（Playwright，operator 运维台冒烟）
│
└── deploy/
    ├── run.sh                   [Solo→Project] 启动脚本（设 SOLO_SERVICES_JSON 后跑 bundle）
    ├── precheck.sh              [Solo→Project] autocheck 入口
    ├── admin-up.sh              [Solo→Project] admin 快速初始化
    ├── seed-registry.js         [Solo→Project] 启动时把服务注册表写入 Redis（否则方法全 -32601）
    ├── solo-services.json       [Project] Solo 内部 service 列表 + 端口（init.sh 自动扫端口生成）
    ├── services.json            [Project] 私有 apps 列表
    └── seed.json                [Project] Redis 初始数据
```

> `[Solo]` 标记的文件升级时由 Solo 一并提供；`[Project]` 标记的归项目所有，升级**不覆盖**。

---

## 一键初始化

在 Solo 源码目录执行：

```bash
bash deploy/scaffold/init.sh <project-name>
# 例：bash deploy/scaffold/init.sh runner
```

`init.sh` 自动：

| 步骤 | 产物 |
|------|------|
| 构建 Solo bundle | `api/publish/solo.v{version}.js` |
| 扫一段空闲端口区给 Solo 内部 service | `deploy/solo-services.json` |
| 扫一个空闲 Redis 端口 | 写入 `.env` |
| 生成 Router Ed25519 密钥对 | `.keypair` + `ROUTER_PUBLIC_KEY` 写入 `.env` |
| 生成初始 admin 密码 | `api/seed.json` + 明文写入 `SETUP.md` |
| 生成随机 `JWT_SECRET` | 写入 `.env` |
| 复制 `library/` / `autocheck/` / `sample/` | `api/` 下对应目录 |
| 复制契约文档包 | `docs/`（`README.md` 索引 + `authoring/{service,events,workflows}.md` + `workflow-examples/`；详见下方「契约文档包」） |
| 复制守门 skill | `.claude/skills/solo-service/`（建/改服务的 Claude Code 技能，收口 `autocheck`；详见下方「契约文档包」） |
| 复制 `portal/operator` 源码（Vite/React） | `portal/operator/`（团队直接改 UI；`cd portal/operator && npm install`） |
| 构建 + 复制前端 bundle（operator/system/mobile） | `portal/publish/*.tar.gz` + `client/publish/*.tar.gz`（版本钉 `.solo-version`；详见下方「前端 bundle 分发」） |
| 复制 e2e API harness + 示例 suite | `e2e/`（jest；`cd e2e && npm install && npm test`，需先 `deploy/run.sh`） |
| 复制 e2e/ui Playwright starter | `e2e/ui/`（operator 运维台冒烟；需起栈 + serve `portal/operator`） |
| 复制 `run.sh` / `precheck.sh` / `admin-up.sh` / `seed-registry.js` / `services.json`(空模板) / `seed.json` | `deploy/` 下 |

完成后：

```bash
cd <new-dir>
# 1. 确认 .env，起后端
bash deploy/run.sh
#    → 用 SETUP.md 里的密码登录，调用 admin.password.reset，删除 SETUP.md

# 2. 运维台（源码已下发，团队直接改）
cd portal/operator && npm install && npm run dev    # 开发；npm run build 出 dist

# 3. e2e
cd e2e && npm install && npm test                   # API 全栈（jest）；后端需先在跑
cd e2e/ui && npm install && npx playwright install chromium && npm test   # UI（Playwright operator）；需 serve portal/operator
```

---

## 升级已有项目

`init.sh` 只建**新**项目（目标目录已存在会报错）。升级一个**已派生**的项目用 `upgrade.sh`：

```bash
cd /path/to/solo
bash deploy/scaffold/upgrade.sh /path/to/<project> --dry-run   # 先预览，不写盘
bash deploy/scaffold/upgrade.sh /path/to/<project>             # 应用
#   FRONTEND_BUILD=auto|force|skip（默认 auto，同 init.sh）
```

它做什么：构建并覆盖 [Solo] 物（`solo.v{ver}.js` + `.solo-version`、整目录覆盖 `library/sample/autocheck`）；把 **system / mobile** 前端 tarball 钉到当前版本并清掉旧版本（`operator` 是**源码分发**，不碰）；补缺失的 `seed-registry.js`；跑**升级后自检**（版本一致、无残留旧 tarball）。

**检测/安全**：只对 Solo 源仓里**真正的脚手架项目**（有 `.solo-version` + `api/publish` + `deploy`）运行；拒绝对 Solo 自身运行。[Project] 文件（`.env` `.keypair` `api/seed.json` `api/apps/` `portal/operator/` `deploy/services.json` `solo-services.json` `e2e/` …）**一律不动**。`run.sh`/`precheck.sh`/`admin-up.sh`/`seed-registry.js` 这类 [Solo→Project] 脚本若被项目改过（与 stock 不一致）**不覆盖**，而是把新 stock 存成 `<name>.solo-v{ver}.new` 供你 diff（用 `--force-scripts` 才强制覆盖）。

> 这是 [`docs/runbook/upgrade-v1.0-to-v1.1.md`](../../docs/runbook/upgrade-v1.0-to-v1.1.md) §1 + 前端步骤的脚本化；§2 里需人判断的接线（改过的 run.sh 合并 seed-registry、redis-stack）仍按 runbook 手动确认。

---

## bundle 启动机制

```
bash deploy/run.sh
    │
    ├─ 读 .solo-version → 定位 api/publish/solo.v{ver}.js
    │
    ├─ 确保 Redis 在跑 → seed-registry.js 写服务注册表到 Redis(active_services)
    │      ↑ 关键：没这步 router 启动只认识 administrator，user.* / planner.* 等全 -32601
    │
    ├─ 设 SOLO_SERVICES_JSON=deploy/solo-services.json
    │      ↓
    │  bundle 启动
    │      ├─ gen-entry.js 生成的入口逻辑：
    │      │      1. 读 SOLO_SERVICES_JSON → 拿到 [{name, port}, ...]
    │      │      2. 设 global.__SOLO_PORTS__ = {name: port, ...}
    │      │      3. 按清单 require 每个 service 的 index.js
    │      │
    │      └─ 每个 service 的 config.js 加载时调用
    │             library/ports.js → portFor(name, fallback)
    │             解析顺序：process.env.PORT > global.__SOLO_PORTS__[name] > fallback
    │
    └─ 按 deploy/services.json 启动每个私有 app（独立 node 进程，传 PORT + ROUTER_URL）
```

### 涉及的代码段（不要隐式处理——明确点名）

**Solo 端：**
- `deploy/gen-entry.js` — build 时生成 `api/_entry.js` 的脚本。负责把每个 service 编译进 bundle 并写入运行时 dispatcher（REGISTRY + SOLO_SERVICES_JSON 读取）。
- `api/library/ports.js` — `portFor(name, fallback)` / `urlFor(name, fallback)`。所有 service 的 `config.js` 通过它读端口/服务 URL，不再 hardcode。
- `deploy/build.sh` — 调用 `gen-entry.js` 生成入口 → esbuild 打包。无 patch、无 trap、无还原。

**项目端：**
- `deploy/solo-services.json` — 项目唯一持有的端口表。形如 `[{name, path, port}]`，`init.sh` 生成，升级不动。
- `deploy/run.sh` — `SOLO_SERVICES_JSON="$SCRIPT_DIR/solo-services.json" node "$SOLO_BUNDLE"` 这一行是关键，把项目的端口表喂给 bundle。

### 单 service / 独立调试模式

`config.js` 里的 `portFor(name, fallback)` 在 `global.__SOLO_PORTS__` 未设置时直接返回 `fallback`。所以单独跑 `node api/router/index.js` 也能工作——绑定到 `config.js` 写的默认端口（8600）。Solo 自己的 `deploy/run.sh`（dev 模式，每个 service 独立进程）就是这种用法，不需要 `SOLO_SERVICES_JSON`。

### 服务注册（为什么 run.sh 要跑 seed-registry）

Router 启动时**只认识 administrator**，其余服务必须登记进 Redis 的 `active_services`，Router 才会把方法路由过去——否则 `user.register`、`planner.*`、你的私有 app 方法全部返回 `-32601 Method not found`。

`deploy/seed-registry.js` 在 bundle 启动前，把 `solo-services.json` + `services.json` 里的每个服务（router 除外）写成 stub（url + 端口，methods 留空）存进 `active_services`。Router boot 时载入这份清单，约 2 秒后自动内省（`methods` RPC）补全每个服务的方法表。`run.sh` 在 Redis 就绪后会自动调它，**幂等**——已在表里的服务跳过。

> 运行期也能手动登记：系统台 `ServiceManagement` 或直接调 `system.service.add { url }`（admin 权限，握手即时生效）。e2e harness 走的就是后者。

```bash
# 1. 在 Solo 源码目录构建新 bundle
cd /path/to/solo
bash deploy/build.sh
#     产物：api/publish/solo.js（含全部 internal services 的 REGISTRY）

# 2. 覆盖到新项目（一份 bundle 通吃，无须每项目重 build）
NEW=/path/to/new-project
NEW_VER=v1.3.0
cp api/publish/solo.js "$NEW/api/publish/solo.${NEW_VER}.js"
echo "$NEW_VER" > "$NEW/.solo-version"

# 3. 同步 Solo 提供给私有 apps 引用的源码目录
cp -r api/library   "$NEW/api/library"
cp -r api/sample    "$NEW/api/sample"
cp -r api/autocheck "$NEW/api/autocheck"

# 4. 重启
cd "$NEW" && bash deploy/run.sh
```

### 覆盖 vs 不覆盖

| 升级时覆盖 | 升级时**不动** |
|---|---|
| `api/publish/solo.v{ver}.js` | `.env` |
| `api/library/` | `deploy/solo-services.json` |
| `api/sample/` | `deploy/services.json` |
| `api/autocheck/` | `deploy/seed.json` |
| `.solo-version` | `api/apps/` |
|  | `.keypair` |
|  | `portal/operator/`（团队改的运维台 UI） |
|  | `e2e/`（项目自己的测试 suite） |

> `solo-services.json` 不动是关键：它是这个项目专属的端口分配，跟其他项目不同。bundle 启动时按这份清单运行——bundle 改版本，清单照旧。
>
> **`portal/operator/` 与 `e2e/` 是 init 一次性下发的源码**，下发后归项目所有，升级**不覆盖**——后台改动大、测试用例项目自写，由 Solo 自动盖回去会冲掉团队的改动。需要参考 Solo 的新版运维台时，手动 diff `portal/operator/` 即可。

### Solo 新增内部 service 怎么办？

例如 v2 加了一个 `analytics` 内部 service。bundle 的 REGISTRY 会包含它，但旧项目的 `solo-services.json` 没列 → bundle 不加载它。如果项目想用新 service，**主动编辑** `deploy/solo-services.json` 加一行 `{"name":"analytics","path":"core/analytics/index.js","port":<挑一个空闲端口>}`，重启即可。不需要 Solo 端做任何 upgrade 脚本，也不会因为 Solo 加 service 就让旧项目莫名启动新进程。

---

## 前端 bundle 分发

三个前端，**两套策略**：

| 前端 | 分发方式 | 升级时 |
|------|---------|--------|
| `portal/operator` | **源码下发**（团队直接改 UI） | 不覆盖；需要时手动 diff Solo 新版 |
| `portal/system` | **预构建 bundle**（`portal/publish/system.v{ver}.tar.gz`） | 覆盖 tarball + 改 `.solo-version` |
| `client/mobile` | **预构建 bundle**（`client/publish/mobile.v{ver}.tar.gz`） | 同上 |

### 构建即真相源（不会再发旧版）

bundle 的版本钉在 `.solo-version`（= `package.json` 版本）。为避免"发出去的是某次旧构建留下的 stale tarball"，`init.sh` **默认从当下源码现构建**：

```bash
bash deploy/scaffold/init.sh <project>                  # 默认 auto：缺当前版本 tarball 就自动构建
FRONTEND_BUILD=force bash deploy/scaffold/init.sh <p>    # 强制重新构建三个前端
FRONTEND_BUILD=skip  bash deploy/scaffold/init.sh <p>    # 不构建，只发已存在的当前版本 tarball
```

- `deploy/build-frontend.sh` 打包前会**清掉同名旧版本** tarball（`rm -f <name>.v*.tar.gz`），所以 `publish/` 永远只剩当前版本，不再堆积。
- `init.sh` **只复制当前版本**的 tarball（不再 `*.tar.gz` 全量 glob——那会把旧版本一起带过去）。
- 文档里的 bundle 版本号用 `v{{SOLO_VERSION}}` 占位符，由 init.sh 注入；`deploy/check-doc-drift.js` 守护脚手架 README 不得硬编码 `vX.Y.Z.tar.gz`。

### 升级下游项目的前端

```bash
# 在 Solo 源码目录（自动清旧 + 钉当前版本）
bash deploy/build-frontend.sh

# 复制到下游项目 + 对齐版本，重启
cp portal/publish/system.v{ver}.tar.gz  /path/to/<project>/portal/publish/
cp client/publish/mobile.v{ver}.tar.gz  /path/to/<project>/client/publish/
echo "v{ver}" > /path/to/<project>/.solo-version
cd /path/to/<project> && bash deploy/run.sh
```

> `run.sh` 若发现某前端端口已配置但对应版本 tarball 缺失，会**大声告警并跳过**（提示对齐 `.solo-version`），不再静默不 serve。

### 私有 git 下怎么分发

**这套设计本来就是"发产物、不发 git"**——和后端 `solo.{ver}.js` 同理（见「设计取舍」）。所以 **Solo 仓库保持私有不构成任何障碍**：

- **谁来 scaffold**：`init.sh` 在 Solo 源码树内运行，能 scaffold 的人本就 clone 过这个私有仓库——一次 clone 即可，无需公开。
- **产物怎么到下游**：下游拿到的是**构建好的 artifact**（`solo.js` + `library/sample/autocheck` 源码 + 前端 tarball），由 init.sh 灌入，下游随后 `git init` 成**自己独立的仓库**——它**不从 Solo 的 git 拉任何东西**。离线 `scp`、内网传都行。
- **CI 产出的 `frontend-bundles` 制品**（`.github/workflows/ci.yml` 的 `frontend-build` job）：在私有仓库上**仅组织内成员凭 token 可下载**，定位是「构建验证 + 内部按需取」，**不是公开分发渠道**。
- **若将来要给"无源码访问权"的外部团队**：那才需要带鉴权的发布渠道——私有仓库用 `gh release create`（制品挂在 release 上，组织成员凭 token 取）是最轻量的一档；再重可上私有制品库 / 对象存储签名 URL。在出现这种需求前，不必提前建。

---

## 添加私有微服务

参考 `api/sample/` 骨架，把 `api/apps/<new-service>/` 建好后，在 `deploy/services.json` 加一行：

```json
{ "name": "<new-service>", "path": "apps/<new-service>/index.js", "port": <port> }
```

端口约定：

- Solo 内部：`init.sh` 扫到的连续空闲段（默认从 8400 起，9 个端口）
- 私有 apps：**8900–8999**（与 Solo 段错开，互不撞）

`run.sh` 启动私有 app 时会传 `PORT=<port>` 和 `ROUTER_URL=http://localhost:<router 的实际端口>`，所以你的 app 用 `library/ports.js` 或直接读 `process.env.ROUTER_URL` 都能拿到正确的 router 地址。

---

## 契约文档包（docs/）

脚手架把"怎么写"所需的全部信息都下发到了项目根的 **`docs/`**，`docs/README.md` 是手册唯一入口。三份指南都与执行引擎**逐字段对齐**，让下游团队或下游仓里的 AI **只凭脚手架交付的信息**就能写出 wire 兼容的产物，无需回读 Solo 源码：

- **`docs/authoring/service.md`** — 在 `api/apps/` 下写一个 Router 能识别/转发的服务：方法命名、introspection 声明 ↔ index 注册、library factory、权限与数据约束。
- **`docs/authoring/events.md`** — 服务级事件与自动化：`_event`（事实扇出）/ `_tasks`（副作用派发）/ 四种触发源 / 重投幂等。
- **`docs/authoring/workflows.md`** — orchestrator workflow 的**声明式 JSON** 语法（逐字段对齐 runner）：按顺序经 Router 调一串 `{service}.{entity}.{action}`，步骤间用 `$input/$config/$step/$context` 变量传值、用 JsonLogic 条件分支；含 step 结构、resolver、input_schema、触发与事件订阅、`create → PENDING_REVIEW → approve → ACTIVE` 生命周期，以及 5 个最常见的坑。
- **`docs/authoring/workflow-examples/`** — 三个可跑 workflow 示例（只用脚手架自带的 `sample` + 核心 `notification`，起栈即可试）：sync 单步、多步链路 + 条件、事件触发。

> **为什么要单独下发**：方法"词汇"（有哪些方法、参数、返回）运行时就能查到——Router 内省后把 capability 目录写进 Redis（`system:capability:list` 全量目录 + `AGENT:CAPABILITY_SNAPSHOT:ZH|EN` 给 AI 的语义快照）。但拼成合法请求 / workflow 的"语法"只在 Solo 源码/协议里。这份契约以前散落在 `api/` 与 `workflows/` 两处，现在**统一收进 `docs/`**，一个入口讲清服务 / 事件 / 工作流三件事。
>
> ⚠️ Solo 仓 `docs/protocol/zh/*` 是更宏大的协议草案，其中 `$resolved`/`$consensus`/字符串 `condition`/`agent_consensus` 等当前引擎并不执行。**以下发的 `docs/authoring/*` 为准。**

### 守门 skill：`.claude/skills/solo-service/`

`docs/` 是**可读**的契约；这个 Claude Code 技能把它变成**被执行**的契约。下游仓里的 AI 一旦动 `api/apps/`，会自动发现并触发 `solo-service`：它先把人指回 `docs/authoring/*` 与 `api/sample/`，列清红线（命名 `{service}.{entity}.{action}`、声明 ↔ 注册同步、禁服务直调、Entity Factory、`clock.js` 不用 `Date.now()`、bundle/`library/` 不可改……），并以一道**硬门禁**收口：

```bash
node api/autocheck/checker.js api/apps/<service> --static   # 必须绿，服务才算写完
bash deploy/precheck.sh                                     # 全量门禁（services.json 里每个服务）
```

`autocheck`（已随脚手架下发，40+ 条静态规则）正是这些红线的执行体，skill 只是把"读契约 → 照 sample 写 → 过 autocheck"这条路固化下来。升级时 `upgrade.sh` 会按版本 re-template 这个 skill（团队自己加的其它 `.claude/skills/` 不受影响）。

---

## 复写 Solo 内置微服务

1. 在 `api/apps/` 新建同名服务，监听**不同端口**。
2. 通过 `administrator` API 注册为覆盖版本，让 router 转发流量到新端口。
3. 选项 A：从 `deploy/solo-services.json` 移除被覆盖的 Solo service → bundle 不再起它。
4. 选项 B：保留它一起运行，靠 router 路由覆盖到新端口。

---

## 多项目同台运行

完全支持。每次 `init.sh` 都会从 8400 起扫一段独立的连续空闲端口，不同项目自然落到不同端口区。Redis 也是独立扫的（从 6380 起）。所以两个甚至更多项目可以在同一台机器上并存，互不干扰。

---

## 本目录结构

```
scaffold/
├── README.md                  本文档
├── init.sh                    一键初始化脚本（含端口扫描）
├── SETUP.template.md          凭证参考文档模板（占位符 {{...}} 由 init.sh 替换 → 新项目 SETUP.md）
├── services.solo.json         "Solo 内部 service 名单"模板（init.sh 据此生成 solo-services.json；
│                              里面的 port 值仅作为模板，会被实际扫到的空闲端口覆盖）
├── run.sh                     新项目启动脚本（设 SOLO_SERVICES_JSON / dashboard / 优雅退出）
├── precheck.sh                autocheck 静态检查入口（开发期使用）
├── admin-up.sh                admin 账号快速初始化
├── seed-registry.js           启动时把服务注册表写入 Redis（active_services；否则方法全 -32601）
├── package.json               新项目 package.json 模板（含 npm deps）
├── .gitignore                 新项目 .gitignore 模板
├── seed.json                  新项目初始 Redis 数据
├── services.json.example      新项目 deploy/services.json 模板（只列私有 apps，空数组也行）
├── README.portal.md           下发到 portal/ 的子目录说明（{{PROJECT_NAME}} 由 init.sh 替换）
├── README.client.md           下发到 client/ 的子目录说明（同上）
├── e2e/                        API 全栈 e2e harness + 示例 suite，整目录下发到新项目 e2e/
│   ├── harness/ lib/           框架（起 bundle + 私有 apps，跑黑盒断言）
│   ├── suites/00-sample.e2e.test.js   示例用例（项目照此写自己的 suite）
│   ├── jest.config.js
│   └── package.json            name 用 {{PROJECT_NAME}} 占位，init.sh 替换
└── e2e-ui/                     UI e2e Playwright starter，下发到新项目 e2e/ui/
    ├── playwright.config.ts / global-setup.ts   operator 项目 + auth state
    ├── helpers/{api,crypto}.ts                   登录 + 哈希（对齐 portal/operator）
    ├── tests/operator/smoke.spec.ts              运维台冒烟示例
    └── package.json / .env.example / README.md   ({{PROJECT_NAME}} 由 init.sh 替换)
```

### run.sh 启动模式

| 命令 | 行为 |
|------|------|
| `bash deploy/run.sh` | dashboard + SSL proxy（8686→router）默认模式 |
| `bash deploy/run.sh --no-ssl` | dashboard，不起 SSL |
| `bash deploy/run.sh --plain` | 日志流到终端，前台运行 |

`run.sh` 启动前会自动检测 `node_modules`，缺失或过期则 `npm install`，无需手动管理。

---

## 设计取舍

**为什么 bundle 启动时读外部 JSON，而不是 build 时把端口烤进去？**
- 烤进去的 bundle 端口固定，多项目同台必撞。
- 烤进去意味着每个 scaffold 项目都得带着 Solo 源码、重 build 一次——`solo.js` 失去"一份 artifact 通吃"的发行物属性。
- 现在的设计：Solo 端发一份 bundle，消费方各自传 JSON。bundle 真正变成"端口无关、配置驱动"的 loader。

**为什么不用 git submodule / npm workspace 引用 Solo？**
- submodule 要求两个 repo 同时可访问，CI/远程服务器部署时依赖网络。
- npm workspace 会把 Solo 源码全量 copy，更新需要同步大量文件。
- 单文件 bundle 离线分发，远程服务器只需 `scp solo.v1.3.0.js`，AI Agent 可直接接管，无需学习配置。

**为什么 `library/`、`autocheck/`、`sample/` 不进 bundle，而是单独复制？**
- `autocheck` 是开发期工具（静态分析），AI Agent 需要直接读写其规则文件，不是运行时服务。
- `library` 是私有 apps 的 `require` 依赖；私有 apps 不在 bundle 内，所以 library 需要以源文件形式存在。
- `sample` 是 AI 生成新微服务时的代码模板，需要可读可改。
- 三者路径与 Solo 保持一致（`api/library`、`api/sample`、`api/autocheck`），所有相对路径 `require` 拷贝即用，零修改。
