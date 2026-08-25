# Changelog

SOLO 各发布版本的变更记录。**消费者升级前读这个。**
格式参考 [Keep a Changelog](https://keepachangelog.com/)。**每打一个 tag,加一条**(发版流程见 [`../runbook/release-and-branching.md`](../runbook/release-and-branching.md))。
>
> **约定(必填字段)**:每个版本条目结尾写一行 **`下游 action：<无 | 具体要做什么 + 迁移指南链接>`**。`deploy/scaffold/upgrade.sh` 升级时会自动扫描比消费者当前版本新的所有条目,把非「无」的 `下游 action` / `BREAKING` 弹成红色 ACTION REQUIRED 横幅——覆盖 bundle 是静默的,这行是给下游的合同,别省。

---

## [Unreleased]

> main 上已合入、尚未打 tag 的改动（下一发布点 = 从 main 打下一个 `v1.x`）。

### Added — extension-kit 补上 MV3 的三处**运行时**基建

> 来源：[`docs/feedback/done/extension-kit-mv3-runtime-gaps.md`](../feedback/done/extension-kit-mv3-runtime-gaps.md)
> （steward 2026-08-16→08-26 十天连续开发的回流）。kit 随 v1.2.1 到达时只覆盖了
> **传输层**（rpc / queue / session / endpoints / image），而一个真实插件的另一半
> ——**扩展内部的消息通道**——三家各写各的。
>
> 只加不破：既有 5 个模块与 sample 的主路径一字未动，`upgrade.sh` 整目录覆盖照旧。

- **`lib/messaging.js`（新）**：通道瞬时错误的**统一判据** + `sendToTab`（带退避重试与
  可选补注入）/ `callBackground`（永不抛，归一成 `{ok,error}`）/ `serveMessages`
  （替你守住 `return true`）。
  Chrome 对"通道没接住"有**四种**措辞，最常见的那种**没有 `is`**——各项目照着自己踩到的
  那一次抄正则，必然各漏各的。steward 就漏了第一种：一场 57 步演示的第 5 步把一个本该被
  重试吃掉的抖动**升级成整场失败**，而现场表现指向完全错误的方向。
  🔴 **本文件是 kit 里唯一不用 import/export 的**：同一份文件还要被 manifest 当
  **classic script** 注入进 content script（那边不认 module 语法，写个 `export`
  就是整节注入**静默作废**）。真 Chrome 里验过两种上下文都求值。
- **`lint-injection.js`（新）**：交叉检查 manifest 各节的 `js` 注入清单 ↔ 代码里的
  `self.<全局>` 引用（含顺序），顺带核对清单里的文件是否存在。
  它抓的两类问题**纯静态可查却只在运行时炸**，steward 为此排查过两次真机，其中一次的
  错误文案还写着"多半是页面改版"，把人指向完全相反的方向。
- **`sample/content/`（新）**：最小的 content script 组，示范「顺序注入 + `self.Xxx`
  全局共享」这个事实标准；`sample/background.js` 改用 `serveMessages` + `sendToTab`，
  `popup.js` 改用 `callBackground`。
- **门禁**：kit 单测 50 → **102 用例 / 7 套**；真浏览器 e2e 18 → **24 用例**（新增
  `content.spec.js`，守住 classic script 注入形态——jest 结构上够不到，那边永远是
  module 上下文）。**kit 此前从未进过 CI**，现已接进 `static` job（同步 → lint → jest）。
- **文档**：kit README 新增 §4.6（消息通道与 content script 契约）与 §4.7（长大之后
  怎么拆：三条纪律 + 那个 `node --check` 查不出来的模块级 `let` 静默坑）；
  `e2e/README.md` 补「装扩展的 playwright 必须串行跑」。

### Fixed — e2e 假 Router 停服时挂死到用例超时

- `helpers/fake-router.js` 的 `close()` 补 `closeAllConnections()`：`server.close()` 只
  停止接受新连接、**等已有 keep-alive 连接自己结束**，而 Chrome 会把它们留着。
  症状是 fixture **拆解**阶段挂死到 60s 超时，而报错指向那条被测用例、跟它毫无关系。
  此前没显形，是因为还没有用例用浏览器去 GET 这个服务。

> **下游 action：无**（纯新增；升级后 `client/extension/kit/` 会多出 `messaging.js`，
> 想用就按 kit README §4.6 接，不接则行为完全不变）。

---

## [v1.2.5] — 2026-08-25

> **patch 步进**：v1.2.4 把 `npm ci` 那堵墙推倒之后的连锁收口。CI 从「4 个 job 全挂在
> 第一步」修到 **7/7 全绿——自公开发布以来第一次**；同时修好脚手架停栈时的孤儿 Redis
> 与冷启动误杀整栈两处消费者可见缺陷。
>
> **这一版的主题是「每一层都是上一层的遮羞布」**：dev.sh 遮住了生产（v1.2.3）、
> node_modules 遮住了锁文件（v1.2.4）、本地手跑遮住了 CI、`npm ci` 的失败遮住了 e2e、
> e2e 跑不到又遮住了 UI 漂移。每修好一层，下一层才露出来，本版一次收口五层。
>
> 门禁：GitHub Actions **7/7 全绿**（static / unit+redis / full-stack e2e 66 套 /
> ui-e2e mesh-backed / ui-e2e mobile / portal tsc / frontend bundles）；本地 CI 白名单
> 130 套 2108 测试绿、e2e 66/66、UI 稳定核心 49 passed 0 failed；三个锁文件各自用
> 隔离 `npm ci` 验过；全新脚手架端到端实跑（建项目 → 起栈 → 上传取回 → 停栈无残留）。

### Fixed — CI 剩余两道闸（v1.2.4 把 `npm ci` 修通后才露出来）

> v1.2.4 修好 `npm ci` 之后，CI 第一次跑到了后面的步骤，于是暴露出两处**一直存在、
> 但被 npm ci 的失败挡在前面从没执行过**的问题。**消费者零影响**（只动 devDependency
> 与 lock，bundle 与运行时代码未变），故不单独发版，随下一个 tag 一起走。

- **`core/orchestrator` 的 jest 版本离群导致 static 门禁必挂**：它声明 `^29.7.0`，
  而 api 根与其余五个声明 jest 的服务都是 `^30.2.0`。版本不兼容 ⇒ npm 无法提升，
  只能在 `core/orchestrator/node_modules/` 里嵌一份 jest 29 —— 而 autocheck 的红线
  恰恰是「服务目录下不许有自己的 node_modules」。对齐到 `^30.2.0` 后嵌套树消失
  （lock 少了 57 个重复包），per-service autocheck 15/15 通过，全量测试仍 130 套全绿。
- **`e2e/package-lock.json` 同样陈旧**：`Missing: @emnapi/core@1.11.3 from lock file`
  等一串，两个 e2e job 都挂在 `install e2e deps`。重生成并按 §6.1 隔离验过
  （e2e 305 包、e2e/ui 4 包）。

> **下游 action：无**（仅 CI 与本仓开发依赖）。

### Fixed — 🔴 `deploy/scaffold/run.sh` 停栈时清理半途夭折，Redis 变孤儿（macOS bash 3.2）

> 全新脚手架项目里 **`SVC_PORTS` 恒为空**（还没有任何私有 app），而 macOS 自带的
> **bash 3.2** 在 `set -u` 下把空数组的裸 `"${arr[@]}"` 判成 unbound variable 当场退出
> （bash 4.4+ 才放行）。cleanup 是 EXIT trap，于是**每一次停栈、以及每一条 fail fast
> 路径**都死在端口清扫那行，后面的 Redis 关闭永远执行不到。
>
> 实测（2026-08-25，全新脚手架 + `deploy/run.sh --plain --no-ssl`）：Ctrl-C 之后服务与
> 前端端口都释放了，**Redis 独独留下**，屏幕上只有一句读不懂的
> `run.sh: line 210: SVC_PORTS[@]: unbound variable`。留下的孤儿 Redis 正是全局
> 红线记的那个坑——下次起栈发现端口有人应答就直接挂上去，密码/数据全错位。

- 两处裸展开改为 `${arr[@]+"${arr[@]}"}`（`CHILD_PIDS` 与 `SOLO_PORTS`/`SVC_PORTS`），
  bash 3.2 与 4.x 语义一致。修后实测：run.sh 自己起的 Redis 会被正确关闭，五个端口全释放。

### Fixed — 前端绑定确认窗口只有 5s，冷启动会误杀整栈

> `fe_confirm_bound` 等 serve 绑定端口的窗口是 25×0.2s = 5s。整栈冷启动时 redis-stack
> 与十几个服务同时抢 CPU，serve 慢过这个窗口就被判成「前端没能在端口 X 上起来」并
> `exit 1` **打死整栈**——而它其实马上就绑上了。实测同一份代码：机器闲时 400ms 通过，
> 冷启动那次超时；紧接着第二次跑（Redis 已在跑、负载低）同一条路径直接过。

- 窗口放宽到 100×0.2s = 20s（只延长失败路径耗时，成功路径依旧秒过）。
- 顺带把「进程已经死了」与「进程还活着但没绑上」分成两条错误信息：前者指向 serve 日志
  （解压坏/依赖缺失），后者指向负载或端口被抢——此前两种病共用一句话，会把人引向一个空日志。

### Fixed — e2e suite 100 的 `user.register` 调法过时，7 个用例全红

> `user.register` 的 `salt` / `hash` 都是必填（`core/user/handlers/introspection.js` 里
> 两个都 `required: true`，router GUIDE §2b 也写明「注册必须客户端自带」），而
> `suites/100-delivery.e2e.test.js` 只传了 `{name, email}` ⇒
> `[-32602] missing mandatory field 'salt'`，整套 7 个用例全挂。
> **这处漂移在 v1.2.2 及更早就存在**（`git show v1.2.2:` 同一行一模一样），一直没人发现，
> 因为 CI 的 `npm ci` 从没成功过、e2e 根本跑不到。修后本地全量 e2e：**66/66 套、346 通过、0 失败**。

### Fixed — e2e suite 95 依赖一个 gitignore 的本地产物，全新 checkout 必红

> `suites/95-mock-listener-pipeline` 读 `deploy/mock/keys.env` 拿 ingress API key，而那个
> 文件在 `.gitignore` 里——它是本地跑过 dev 栈才会生成的产物。开发机上它恰好存在 ⇒ 本套
> 一路绿；**任何全新 checkout（CI 就是）永远没有它** ⇒ `apiKey` 为 undefined，本套当场红。
>
> harness 其实早就做对了：`harness/setup.js` 用 `MOCK_KEYS_FILE` 把 key bootstrap 进
> **每轮独立的** `logDir/mock-keys.env`，刻意不碰 dev 栈共用的那份（那个 key 注册在 dev 的
> Redis 里）。是 suite 读错了文件。

- suite 改为优先读 harness 的 per-run 文件（`readCtx().logDir`），手工 dev 栈那份降为兜底。
- **复现方式值得记一笔**：本机全量 e2e 一直是绿的，是在 `git worktree` + `npm ci` 的
  **干净树**上才复现出来的——「本机能跑」的另一种形态，与本版另外几条同源。

### Fixed — ui-e2e 的 mesh 步骤漏了 `working-directory`，CI 里跑的是个不存在的路径

> `ci.yml` 顶层设了 `defaults.run.working-directory: api`，ui-e2e job 里每一步都显式
> 覆盖过（`api` / `e2e` / `e2e/ui` / `portal/system` / `portal/operator`），**唯独
> 「bring up mesh」这步漏了** ⇒ CI 里实际执行的是 `api/e2e/ui/scripts/meshup.js`，
> 这个路径根本不存在。node 立刻以 `Cannot find module` 退出、错误进了后台日志，
> 而下面那个 180 秒的等待循环注定等不到 readiness，最后报出来的是一句含糊的
> `mesh failed to start`——**指向"mesh 起不来"，而真相是脚本压根没被执行**。
>
> 因此这个 job 从来没有真正跑过一次 UI e2e。本地怎么跑都对（在仓库根跑），只在 CI 里挂；
> 复现只要一行：`cd api && node e2e/ui/scripts/meshup.js`。

- 该步补上 `working-directory: .`。同时扫了一遍全文件，没有其它 `run:` 步骤有同类遗漏
  （另外 3 处引用非 api 路径的都是 `uses: actions/upload-artifact`，其 `path:` 相对仓库根
  解析，不受 `defaults.run` 影响）。

### Fixed — UI e2e 的 10 个用例：portal 改版后 spec 没跟上（**首次真的跑起来才暴露**）

> mesh 一能起来，UI 用例第一次真跑，10 个当场红。**本地同样红**——不是 CI 特有，
> 是两个多月里 portal 改版、spec 没跟的累积漂移（README 记的上一次基线是 2026-06-30 的
> 「49 passed / 0 failed」，此后没人能跑到）。逐个定位后**全部是测试侧问题，零产品缺陷**，
> 与 2026-06-30 那次 triage 的结论一致。修完：**49 passed / 1 skipped / 0 failed（15.6s）**。

- **`bot-accounts`（6 个）— `isVisible()` 在被裁剪的元素上返回 true 这个陷阱。**
  动作按钮住进了「点选卡片才展开」的抽屉（收起时 `max-h-0 + overflow-hidden`）。
  被裁掉的子元素**仍然有布局盒子**，所以 `isVisible()` 照样是 true ⇒ 「不可见才展开」
  的写法永远不触发；随后点击落在被裁剪的按钮上，命中测试返回卡片，报
  `<div data-test=bot-card> intercepts pointer events` 一路重试到 30s 超时。
  判据改用卡片的 `selected` 类；行定位从 `xpath=..`（假设了早就变了的层级）
  换成 `[data-test="bot-card"]:has(...)`。**6 失败/3.1 分钟 → 7 通过/11.4 秒。**
- **`sentinel-provisioning`（2 个）** — 同款 `xpath=..` 假设；且动作已收进每张卡片的
  「⋯」下拉菜单。改走菜单，并给触发器补 `data-test="sentinel-menu"`。
  另注意 `data-test="sentinel-name"` 是**表单里的 input**，不是列表项名字（列表用
  `title={sentinel.name}`）——这处混淆值得记一笔。
- **`sentinel-autorun-emit`（1 个）** — 表单改成了三个标签页（Basic / Context & Prompt /
  AI & Action），每页内容是条件渲染，不切过去元素根本不在 DOM 里；同时重构中丢了
  `ctx-autorun` / `ctx-emit` 两个 testid。补回 testid + spec 先切标签页；
  菜单项文本带 emoji 前缀（`✏️ EDIT`），`/^EDIT$/` 这种锚定写法也一并放宽。
- **`profile-watchers`（1 个）** — watcher 列表抽成 `SentinelCard` 组件时丢了
  `data-test="watcher-row"`，断言变成「element(s) not found」，看着像 sentinel 没挂上
  profile。补回钩子。
- 三处 portal 改动**只是加 `data-test` 属性**，零行为变更（`portal/system` 与
  `portal/operator` 的 `tsc --noEmit` 均通过）。README §Page objects 本来就要求
  「新界面 → 加 testid + page object」，这批是把重构时掉的钩子补回去。

> **下游 action：无**（测试与 testid 属性，运行时行为不变）。

---

## [v1.2.4] — 2026-08-25

> **patch 步进**：修一处**从首次公开发布起就存在**的构建期缺陷——两个 `package-lock.json`
> 与 workspace 清单不同步，`npm ci` 整个拒绝安装。后果有两层：① 干净环境下 `init.sh`
> 建不出新项目；② **solo 自己的 CI 一直是红的**，7 个 job 里 4 个第一步就挂在 `npm ci`。
> 同批拔掉 `init.sh` 里最后一处 `@solana/web3.js` 残留。
>
> 门禁：CI 白名单 **130 套 / 2108 全绿**（2103 passed / 5 skipped）；static 全闸绿；
> `build.sh` 产物正常；两个 lock **各自用隔离目录的真 `npm ci` 验过**（api 树 578 包、
> 根树 385 包）。

### Fixed — 🔴 `package-lock.json` 与 workspace 清单不同步，`npm ci` 直接拒绝安装

> ```
> npm error `npm ci` can only install packages when your package.json
>           and package-lock.json ... are in sync.
> npm error Missing: mcp@0.1.0 from lock file
> ```
> `api/package-lock.json` 里**没有 `core/mcp`**（v1.1.10 加的服务，lock 从没重生成），
> 却还留着 `core/phaser`（目录早已删除）；根 `package-lock.json` 更旧，缺 5 个 workspace。
> 两个 lock 自 `40c818a`（首次公开发布）以来一次都没更新过。
>
> **根依赖 18 项其实是对得上的**——坏的是 workspace 清单，所以只比对 `dependencies`
> 看不出问题，这也是它藏了这么久的原因。派生方看到的「预检查找不到 dotenv」不是 dotenv
> 的问题：npm ci 在装任何东西之前就整个拒绝了，什么都没装。

- 两个 lock 用 `npm install --package-lock-only` 重生成（不动 `node_modules`）。
- **连带修好 CI**：`ci.yml` 有 4 个 job 第一步是 `npm ci`（`working-directory: api`），
  GitHub Actions 历史上近期每一次运行都失败，失败步骤全是 `Run npm ci` / `install api deps`。
  也就是说 CLAUDE.md §4 记的「P0 CI 已落地」此前名存实亡——jest 与 static gate 在 CI 上
  从来没真跑过，全靠本地手跑兜着。
- **新增发版门禁**：隔离目录跑真 `npm ci` 冒烟，写进 `CLAUDE.md` §6.1。
  ⚠️ 关键是**不能在仓库里跑** `npm ci`——它会先清空 `node_modules`。做法是把所有
  `package.json` + lock 拷进临时目录再跑，验的是锁文件本身，不动工作树。

### Fixed — `init.sh` 生成 Router 密钥仍 require 已移除的 `@solana/web3.js`

> 运行时早已把 Ed25519 换成 tweetnacl + bs58（`api/router/handlers/keypair.js`：
> "it was the last consumer"），但**构建期的 `init.sh` 没被算进那次瘦身**，仍在
> `require('$SOLO_DIR/api/node_modules/@solana/web3.js')`。它在开发机上还能跑，只是因为
> `api/node_modules/` 里躺着一份没人清的孤儿；换台机器、或任何人 `npm ci` 一次，
> 建项目就死在这一步。来源：[`../feedback/done/scaffold-init-stale-solana-dep.md`](../feedback/done/scaffold-init-stale-solana-dep.md)
> （2026-08-20 报告，本轮 triage 时用干净复现收口，并推翻了它对锁文件的判断）。

- `init.sh` 改用 `nacl.sign.keyPair()` + `bs58.encode()`，**不新增任何依赖**（两者本就在
  `api/package.json` 里）。实测等价：公钥 44 字符 base58、secretKey 64 字节
  （32 seed + 32 public），喂给 router 的 `fromSecretKey()` 公钥一致、签名/验签往返通过
  ⇒ **已有项目的 `.keypair` 文件继续可用，不需要轮换密钥**。
- `deploy/scaffold/package.json` 删掉 `@solana/web3.js`（新项目不再白装 14MB）；
  `run.sh` 里提到它的注释一并更正。
- 本机 `api/node_modules` 用 `npm prune` 清掉 164 个不在 lock 里的孤儿包
  （`@solana/` 整棵 14MB 消失，顶层 445 → 405）；清理后全量回归验证如上。

> **下游 action：** 已有项目**无动作**——本版只改构建期路径（`init.sh` / lock / CI），
> 运行时代码零改动，`.keypair` 与已生成项目完全不受影响。**新建项目**受益：干净环境下
> `npm ci` + `init.sh` 现在能一次跑通。若你的派生项目也维护自己的 lock，建议照
> `CLAUDE.md` §6.1 那道隔离 `npm ci` 自查一次——同一个坑（新增 workspace 忘了重生成 lock）
> 在任何 npm workspaces 仓库里都会复现，且只在干净环境暴露。

---

## [v1.2.3] — 2026-08-25

> **patch 步进**：一条线——storage 的默认字节后端从「一个没人启动的独立进程」改成
> **storage 进程内挂载**，顺带补上它连带的密钥与可观测性缺口。派生项目
> （steward，v1.2.1，N100 常驻栈）实测：`storage.asset.upload` **100% ECONNREFUSED**。
>
> 门禁：主 CI 白名单 **130 套 / 2108 测试全绿**（2103 passed / 5 skipped，18.8s；
> 本轮 agent 的 LIVE Gemini 套也过了）；static 全闸绿（autocheck storage + `--lib` +
> doc-drift + error-codes）；`deploy/build.sh` 5.3M 产物已含三处改动。

### Fixed — 🔴 provider=local 的字节后端从来没有任何生产启动脚本拉起

> `STORAGE_PROVIDER` 默认 `local`，它把字节全部转发给 `oss/local-oss-server.js`——一个
> **独立进程**，默认 `http://localhost:8755`。而启动它的只有 `deploy/dev.sh`：
> **`deploy/scaffold/run.sh` 里一行都没有**。于是凡是走 `run.sh` 起的栈（= 所有生产部署）
> 上传路径**必然坏**，且坏得极隐蔽：服务活着、`ping` 通、`storage.asset.list` 也通
> （只读 Redis 元数据），只有 `upload` 挂——而它可能是部署几天后才第一次被调用。
> 「测试全绿但生产 100% 坏」的标准形态：测试环境恰好覆盖了缺失的那一步。
> 来源与实测台账：[`../feedback/done/storage-local-oss-server-never-started.md`](../feedback/done/storage-local-oss-server-never-started.md)。

- **改成进程内挂载**：`provider=local` 时 storage 在**自己的端口**上挂载对象存储
  （`app.use('/_oss', ossApp)`，见 `api/apps/storage/index.js`），endpoint 默认派生为
  `http://127.0.0.1:<storage 端口>/_oss`。**默认值指向的东西，由默认路径负责拉起**——
  不再需要第二个进程、第二个端口、第二份守护。
- **顺带消灭 8755 这一整类跨栈事故**：一机多栈时两个栈共用同一个默认端口 **且共用同一个
  默认密钥**，所以后起的栈不是「起不来」，而是 driver 认证成功、**把自己的资产静默写进
  另一个栈的目录**（`redis-port-ownership` 同一病理，且这次连归属校验都没有）。挂载后
  端口随各栈自己的 `SOLO_PORT_BASE` 天然隔离，无从相撞。
- `local-oss-server.js` 改用 `req.url` 而非 `req.originalUrl` 解析 bucket/key——挂载时
  express 只从 `req.url` 剥掉挂载前缀，用 `originalUrl` 会把 `_oss` 当成 bucket 而 404
  `NoSuchBucket`。顶层挂载时两者相同，**对独立进程模式行为不变**。
- `deploy/dev.sh` 不再起独立 8755：**让 dev 跑与生产完全同一条路径**——这个 bug 的根因
  正是 dev 与生产走了两条路，只有 dev 那条被测过。
- 独立进程模式**保留**（`node deploy/local-oss.js` + `LOCAL_OSS_ENDPOINT`）：设了这个变量
  就等于声明「对象存储在别处跑」，进程内挂载自动让位。`LOCAL_OSS_IN_PROCESS` 可强制两向。

### Security — `LOCAL_OSS_SECRET` 的默认值是开源仓库里的公开常量

> 把 local 扶正为生产后端之后，`'solo-local-oss-dev-secret'` 这个写死在公开仓库里的默认值
> 就从「dev 便利」变成了**真实洞**：它同时是签名 URL 的 HMAC 密钥**和** Bearer 令牌，
> 任何人都能伪造资产 URL 读私有字节，拿 Bearer 还能 `GET /<bucket>?list` 列桶、
> `POST /<bucket>?delete` 批量删对象。原反馈没提这条，是本轮 triage 时发现的。

- `deploy/scaffold/init.sh` 为**每个新项目**生成随机 `LOCAL_OSS_SECRET`（24 字节 hex，
  照 `JWT_SECRET`/`GATEWAY_SECRET_KEY` 的成例；纯 hex 天生避开 `# $ 空格 反引号`）。
- 仍在用默认值时：启动 `warn` 点名；**`STORAGE_ACCESS=private` 直接 fail fast**——
  private 档的全部安全承诺就是「签名不可伪造」，密钥公开时这句话是假的，不能让它默默运行。
  dev（public 档）照旧可跑，不打断本地开发。

### Fixed — ECONNREFUSED 的 `message` 是空字符串，host:port 一个字都不露

> 原反馈判为「Router 吞掉了 axios 的原始 message」，建议改 Router。**核实后不是**：默认
> endpoint 写的是 `localhost`，Node 的 happy-eyeballs 对双栈主机并发拨 `::1` 与 `127.0.0.1`，
> 两条都被拒时抛的是 **`AggregateError`，其 `message` 天生为空**（真实信息在 `.errors[]` 里）。
> 实测复现：`localhost` → `{code:'ECONNREFUSED', message:''}`；`127.0.0.1` →
> `connect ECONNREFUSED 127.0.0.1:8755`。**Router 无需改动**（红线保护区未触碰）。

- 所有默认 endpoint 从 `localhost` 改为 `127.0.0.1`（含 `oss/index.js` 的兜底）。
- `driver-local.js` 的两处传输错误统一包一层，把 `<METHOD> <URL>` 与 `.errors[]` 展开进
  message——排查从「第 N 轮」变成第一分钟。

### Changed — 其余对齐

- `publicRead` 由 `STORAGE_ACCESS` 推导（此前 `createLocalOssServer` 默认 `false` 而
  `STORAGE_ACCESS` 默认 `public`，两个默认值自相矛盾：发出去的是无签名 URL，服务器却拒绝
  无签名 GET）。`LOCAL_OSS_PUBLIC_READ` 仍可显式覆盖。
- `deploy/dashboard_all.sh` 的 Local OSS 行改为反映真实位置（进程内 / 外部 endpoint）。
- 文档：`api/apps/storage/README.md`（provider 表、env 表、Local OSS server 一节）、
  `deploy/local-oss.js` 头注（它不再是「dev 专用、生产别用」）、`deploy/w3os/README.md`。

> **下游 action：** 升级后**通常什么都不用做**——不设 `LOCAL_OSS_*` 的项目会自动改用进程内
> 挂载，上传从此可用（此前是坏的）。三种情况要动手：
> ① **手动起过独立 local-oss 且用了非默认 root** 的项目（如 steward 的 `deploy/oss_data/`）：
> 进程内挂载默认读 `UPLOAD_DIR`，**老对象在旧 root 里会找不到**——二选一，把
> `LOCAL_OSS_ROOT` 指向旧 root（推荐），或继续跑独立进程并设 `LOCAL_OSS_ENDPOINT`
> （设了就不挂载）；随后可以把那个手工进程/临时 unit 撤掉。
> ② **对外暴露过 8755** 的反代（Caddy/nginx）：字节 URL 变成 `<storage 端口>/_oss/...`，
> 反代规则要跟着改（URL 是每次现算的，存量资产元数据不受影响）。
> ③ **`.env` 里没有 `LOCAL_OSS_SECRET`** 的既有项目：现在跑的是公开默认密钥，
> 补一行 `LOCAL_OSS_SECRET='<openssl rand -hex 24>'`（换密钥会让**存量签名 URL 立即失效**，
> 字节本身不受影响；`STORAGE_ACCESS=private` 的项目升级后不补就直接起不来，这是有意的）。

---

## [v1.2.2] — 2026-08-24

> **patch 步进**：只加不破的修补与增量，无新交付物。四条代码线：① `api/library/env.js`
> 把「自己读 .env 的脚本」收敛成一份实现（框架级，随 bundle/脚手架下发）；② gateway SMTP
> 透传 nodemailer 选项，换邮箱厂商不再写 adapter；③ jsonlogic `resolveParams` 数组塌陷修复
> （带数组参数的 action 此前根本传不进去）；④ portal/mobile 子路径构建适配。
> 另有 SMTP LIVE 测试、`upgrade.sh` 哨兵修复与一批规划/runbook 文档。
>
> 门禁（runbook §3）：主 CI 白名单 **130 套 / 2108 测试**，绿 129 / 2102（唯一红的是
> `agent.decide` 的 LIVE Gemini 活体测试已知波动项，与 v1.2.0/v1.2.1 同一组、与本版无关）；
> static 全闸绿（autocheck per-service ×15 + `--lib` + doc-drift + error-codes）；
> `deploy/build.sh` 5.3M 产物。

### Added — gateway SMTP 出站路径的 LIVE 测试（`core/gateway/tests/smtp-live.test.js`）

> 补的是一处**零覆盖**：既有的套覆盖了 SMTP 的外围——`25-gateway` 验账号 CRUD 与密码加密落库、
> `63-gateway` 把 host 指向 `127.0.0.1:1` 验连不上时的结构化错误、`returns-contract` 验返回契约
> （走 mock）——但 `logic/email.js` 的 `sendSmtp()` 与 `logic/smtp.js` 的 `getTransporter()`
> **从来没有对着一台真 SMTP 服务器执行过**。而这条路径的失败是**静默**的：`resolveChannel()`
> 在 `EMAIL_SMTP_HOST` 为空时回落 mock，mock 同样返回 `{success:true}`，于是只断言 `success`
> 的验收会永远绿着、而一封信都没发出去。

- 两级门（照 `core/agent/tests/decide.test.js:127` 的 LIVE 惯例）：有 `EMAIL_SMTP_HOST/USER/PASS`
  才跑连接与认证；**再有 `EMAIL_LIVE_TO` 才真投递**——不会因为环境里恰好有凭据就往谁的信箱塞信。
- 四条断言：`resolveChannel` 必须是 `smtp`（防静默回落）· env 路 `verify()` 通过 ·
  **实体路**「加密落库的密码解出来还能真连上」（`smtp.create` → `smtp.test`，这是 25-gateway
  与本套之间此前没人验的接缝：加密往返坏了，两边各自的测试仍然全绿）· 投递后
  `provider === 'smtp'`。
- 凭据缺席时留一条**可见的 skip 记录**，免得「全绿」被读成「发信验过了」。
- 已进 `jest.ci.config.js` 白名单：CI 没有凭据 → 整套 skip，只起解析防腐的作用，不会发信。

- **实测接通**（2026-08-20，Gmail + 应用专用密码，经 Clash 代理出境）：认证约 12–17s、
  带投递的完整档约 44–50s，比同仓任何一套慢一个量级，`TIMEOUT` 因此设 45s。首次接通踩的坑
  已写进文件头：应用专用密码**全小写**，Google 展示字体里 `l`/`I`/`1` 几乎同形，读错一个字母
  的表现是 `535-5.7.8 BadCredentials`——**和"密码失效/被风控"完全同一个症状**，无从区分。

> **下游 action：无**（纯测试新增，不影响任何运行代码）。

### Fixed — `upgrade.sh` 的「下游 action：无」哨兵漏判全角标点，会弹**假的** ACTION REQUIRED

> `deploy/scaffold/upgrade.sh` 升级后会扫 CHANGELOG，把比消费者旧版本新的每条非「无」的
> `下游 action` 弹成红色 ACTION REQUIRED。判「无」的正则是
> `：[[:space:]]*无([[:space:]]|[[:punct:]]|$)`——要求「无」是个**词**，这样
> `无法自动迁移…` / `无需改代码，但要重启…` 这类**真动作**不会被当成「无」漏掉，方向是对的。
> 问题在终止符集合不全：**awk 的 `[[:punct:]]` 只认 ASCII**，`zh_CN.UTF-8` / `en_US.UTF-8` / `C`
> 三种 locale 下都不命中「。」。于是一条老老实实的 **「下游 action：无。」会被判成真有动作**，
> 给下游弹一条不存在的 ACTION REQUIRED——横幅喊狼来了几次，真有破坏性变更时就没人看了。
> （2026-08-20 写 v1.2.1 的 CHANGELOG 条目时实测撞上。）

- 全角标点改为**逐个显式列出**：`。，、；：！？（）「」【】《》…`，并把正则提到 `BEGIN` 里
  的 `NONE` 变量，让那段判据带得动注释。
- **用交替 `(。|，|…)` 而不是字符组 `[。，…]`**：mawk（Debian/Ubuntu 默认 awk）是**字节序**引擎，
  多字节字符放进字符组会退化成「字节集合」，可能误命中别的汉字；交替是序列匹配，两种引擎语义一致。
- 方向保持不变（**宁可多弹、不可漏弹**）：`无法` / `无需` / `无须` / `无论` 开头的真动作仍照弹。
- 验证：15 条正反用例矩阵 × `zh_CN.UTF-8` / `en_US.UTF-8` / `C` 三种 locale **全对**；再用补丁后的
  awk 块实扫构造的 CHANGELOG fixture 与真实 CHANGELOG，结果符合预期。

> **下游 action：无**（下次 `upgrade.sh` 生效；此前那条假横幅本就不该出现，忽略即可）。

### Added — `api/library/env.js`：「自己读 .env 的脚本」收敛成一份实现

> 一份 .env 有三类消费者（dotenv / shell `source` / 自写正则的脚本），第③类每出现一次就
> 重踩引号坑：`KEY='abc'` 用裸正则取到的是**带引号的** `'abc'`，拿去认证就是 401，而报错
> 完全不指向引号。仓库实测两处（`upgrade.sh:356` 的 grep|cut、e2e harness 的正则+trim），
> 都在 `deploy/scaffold/` 里、随项目下发给每个消费者。

- 契约只有一条：**输出与 `dotenv.parse()` 逐字节一致**（连怪癖一起照抄：裸值 `#` 截断、
  只有双引号展开 `\n`、引号未闭合原样保留）。零依赖（e2e 是独立 npm 项目，包不了 dotenv）；
  带 CLI `node api/library/env.js <file> <KEY>` 供 shell 调用方。
- 两处调用点已改走它；测试 66 条（42 手写边界 + 300 份随机语料与 dotenv 逐用例差分 +
  变异测试堵盲区）。
- 顺带补脚手架邮件配置缺口：`init.sh` 的 .env 模版补 `EMAIL_SMTP_OPTIONS` /
  `EMAIL_API_PROVIDER` + 四厂商 host/port 速查；示例一律单引号（裸值被 shell source
  剥掉双引号后不再是合法 JSON）。

> **下游 action：无**（`upgrade.sh` 升级自动获得；项目里自写正则解析 .env 的脚本**建议**
> 改走 `api/library/env.js` 的 CLI，非强制）。

### Added — gateway SMTP 透传 nodemailer 选项，换邮箱厂商不再需要写 adapter

> SMTP 是标准协议，换厂商只改 host/port/secure，属配置不该落代码。真正的缺口是字段面太窄：
> `createTransport` 此前写死 4 个字段，`requireTLS` / `tls.*` / `pool` / 各类 timeout
> 一个都传不进去。

- `logic/smtp.js` 新增 `buildTransportOptions()`，**env 路**（`EMAIL_SMTP_OPTIONS`，JSON、
  解析失败当场抛）与**实体路**（`gateway.smtp` 实体的 `options` 字段）都接上。
- 🔴 合并方向是安全边界：`options` 先铺底、显式字段后盖——options 劫持不了
  host/port/secure/auth。
- README 补 `EMAIL_SMTP_*` 全组 + 换厂商判据表（Gmail 应用专用密码 / 163·QQ 授权码 /
  Outlook 仅 OAuth2、暂未支持）。

> **下游 action：无**（不配 `options` 行为不变）。

### Fixed — jsonlogic `resolveParams` 数组塌陷；fulfillment `instance.list` 补 `sourceId` 声明

> steward 反馈（DOM 提取链路，2026-08-22 triage）落地：数组此前走 `Object.entries` 塌成
> `{"0":...,"1":...}`——**任何带数组参数的 action（如 `agent.chat` 的 `messages`）都传不
> 进去**；现数组保持身份逐元素递归，并补 `@attention`（字符串不做插值，引用上下文只能整
> 字段 `{"var":"path"}`）。`fulfillment.instance.list` 声明 `sourceId` 精确过滤——客户端
> 幂等探测入口（`instance.create` 不按 sourceId 去重，先 list 后建）。

- 新增 runbook `docs/runbook/browser-extension-ai-extraction.md`（插件 + Fulfillment + AI
  的 DOM 提取端到端配方），extension-kit README / docs 索引 / protocol/zh/extraction.md
  挂指针。
- 遗留三条框架级登记 BACKLOG（instance.create 无 sourceId 幂等、agent 文本方法 4000 字符
  上限、`pending_callbacks` 死字段）。

> **下游 action：无**（随 bundle 下发；此前数组参数根本传不进去，无人依赖塌陷形态）。

### Fixed — portal 与 mobile 子路径构建（BASE_URL 路由与 config.js 存根）

> portal（operator/system）路由 basename 与 rpc 基址跟随 Vite `BASE_URL`，mobile 补
> `public/config.js` 存根——部署在子路径（如 `/portal/`）下不再路由 404 / 打错 Router。

> **下游 action：无**（根路径部署行为不变）。

### Added — 规划/反馈文档：v2 bridge 交互模式规格 + 对外推送面（WS 门铃）语义拍板

> ① `docs/planning/v2-bridge-interaction.md`（草案）：主箱—子箱协同运行模式——下行
> **存档确认制**（回执 = 已存档、幂等键去重）、**定期拉取**（统计采集兼航线心跳）、门铃
> 三通道，失败语义与撤除保证；`VERSION.v2.md` 同步落地试验田三条采纳（同机跨网格里程碑、
> 握手带版本、§3.6 A 组 #1/#4 背书）。② WS 门铃 triage：notify-only + 可见性默认全关、
> 按流 env 白名单，登记 BACKLOG §3（实现属 router 待授权批次）。

> **下游 action：无**（纯规划/反馈文档，bridge 未动工）。

---

## [v1.2.1] — 2026-08-20

> **patch 步进**：没有新交付物，全是只加不破的修补与文档。`api/` 的运行代码零改动
> （仅两处注释里的文档路径跟着归档动作改了），既有服务、方法、前端一个字节都没动。
> 两条主线：① 契约文档包补上「划分」这一层——下发第 4 份 authoring 契约，回答「该写哪些
> 服务」而不只是「怎么写一个服务」；② 一轮 e2e 体系审计，修掉一处**静默**的服务清单漂移
> （`mcp` 自 v1.1.x 就在 `services.json` 里，却从未被 e2e full 档拉起，它的 e2e 覆盖一直是零），
> 并把这类漂移收进 CI 守门——下次再漏就是红的，不用等下一次人工审计。
>
> 门禁（runbook §3）：主 CI 白名单 **127 套 / 2018 测试**，绿 126 / 2016（仅剩 2 例是
> `agent.decide` 的 LIVE Gemini 活体测试因外部模型漂移失败，与 v1.1.16/17 · v1.2.0 同一组、
> 与本版无关）；static 全闸绿（autocheck per-service ×15 + `--lib` + doc-drift + error-codes
> + lockfile hygiene）；`deploy/build.sh` 5.3M 产物。

### Added — 契约文档包补上「划分」这一层：`docs/authoring/modeling.md`

> 缺口：下发包此前只回答「怎么写一个服务」，不回答「该写哪些服务」。`docs/README.md` 自己
> 划的界就是「补的是语法/契约」，守门 skill 也写明只在 `creating OR modifying a microservice
> under api/apps/` 时触发——即**已经决定要建这个服务之后**。于是从业务需求到服务/实体划分
> 这一步，框架不下发任何东西。这一层没有门禁兜底：**autocheck 校验的是 wire 契约、不是设计，
> 一套划分错误的服务可以全绿通过**，对「AI 照着 skill 写」的场景尤其危险。

- **新增 `deploy/scaffold/docs/authoring/modeling.md`**（下发第 4 份 authoring 契约）。内容全部
  收敛成**可判定的判据**，不写「视情况而定」：§0 core 能力对照表（多数需求不必新建服务）；
  §2.1 实体三问（能否单独创建 / 单独删除 / 单独列表——三个「否」就是字段不是实体）；
  §2.2 用框架红线「服务间禁止直接互调」反推服务边界（典型用例跨服务往返 ≥2 次且总是同一批
  服务 ⇒ 应合并）；§2.3 单独摘除测试（能从 `services.json` 删掉而其余照常 ⇒ 可独立成服务）；
  §4 体检信号附 Solo 自身 13 服务实测基线（实体数 0–4、中位 1；方法数 3–54）。
- **接线 8 处**（漏一处就静默不下发/不同步）：`init.sh` 与 `upgrade.sh` 的 `_doc` 下发循环、
  两者的清单注释与报告文案、`docs/README.md` 索引表、`scaffold/README.md` 契约包章节、
  `SETUP.template.md`、`check-doc-drift.js` 的存在性校验（CI 现强制它必须在）。
- **守门 skill 的阅读顺序加了第 0 步**：边界未定时先读 modeling.md；改存量服务可跳过。

> 验证：`init.sh` 与 `upgrade.sh` 两条路径均**端到端实跑**（新建项目下发 + 存量项目删档后重下发），
> 模板变量渲染零残留；`check-doc-drift.js` 绿。
>
> **下游 action：无**（升级后 `docs/authoring/` 会多出 `modeling.md`，建新服务前建议先读；
> 既有服务不受影响，无迁移动作）。

### Fixed — `mcp` 在 e2e 目录里缺席；catalog ↔ `services.json` 现由 CI 守门

> 现象不是报错，是**沉默**：`e2e/harness/catalog.js` 的 `SERVICES` 是 `services.json` 的一份
> 手抄副本（e2e 侧以它为端口权威，`harness/setup.js` 按它给每个服务设 `PORT` env）。两边靠
> 人手同步，漏一个不会有任何提示——那个服务只是**在 full 档里从不被拉起**，于是它的 e2e
> 覆盖静默为零。`mcp` 就这样漏了一整条 v1.1.x 线。

- **`e2e/harness/catalog.js` 补 `mcp`**（`core/mcp/index.js` : 8091）并列进 `PROFILES.full`。
- **`deploy/check-doc-drift.js` 新增第 7 条守门**（CI static 闸）：`services.json` 的每个服务
  都必须在 catalog 的 `SERVICES` 里、**端口与 `path` 一致**、且（`router` 除外）**必须进
  `PROFILES.full`**——「列进 SERVICES 但没进 full 档」等于没跑，也算红。比对前会还原
  `E2E_PORT_OFFSET`。catalog 允许**多出** `collection` / `market`（仅供内部测试、不在
  `services.json`）。
- **`.github/workflows/ci.yml`** 的 e2e job 名与顶部说明数字对齐现状（54 → **66** 套、
  13 → **15** 服务）。
- **`e2e/README.md` 标明它写于规划期**：正文的「尚未实现」与 §14 的「17 套」是 2026-06-03
  首次落地快照，**当前覆盖以 `e2e/suites/` 目录与 CI 的 e2e job 为准**；顺带记下用例序号
  重号（`54 / 66 / 67 / 69 / 70` 各两套）是**刻意不改**的——每个文件自洽、文件间不共享状态，
  重排只换来阅读顺序，却要打断 git 的文件历史追踪。
- 审计全文收进 `docs/feedback/e2e-audit-service-drift-and-suite-hygiene.md`。

> **下游 action：无**（`e2e/` 与 `deploy/check-doc-drift.js` 都是 SOLO 自身的门禁，不随脚手架下发）。

### Added — 脚手架文档两处补充：客户端插件指针 + 「要不要拆文件」的判据

- **`docs/README.md` 加 `client/` 浏览器插件的指针**：数据要从网页里取、动作要落回网页上时
  走这条路——`client/extension-kit/`（[Solo]，随升级刷新）+ `client/extension/`（[Project]，
  永不被覆盖），`extension-kit/sample/` 是可直接跑起来的完整扩展。并点明
  **`client/plugin/` 是桌面客户端的视图插件，与浏览器扩展是两回事**（名字太像，已经有人认错）。
  `authoring/modeling.md` 的 §0 能力对照表同步加一行。
- **`authoring/modeling.md` 澄清「服务体量 ≠ 单文件体量」**，并新增 **★ 要不要拆文件：看变更
  频率，不看行数**：行数是现象不是判据，两条 `git log` 现查命令（近 60 次提交里被改过几次 /
  最后一次改动）才是。拆分的收益**全部落在未来的改动上**，所以变更频率是收益的分母，分母
  接近零、再长的文件也不值得拆。附 `orchestrator` 实例（最厚的 `runner.js` 806 行，近 60 次
  提交里只被改过 1 次）——结论是**机会性重构**：真需要动时顺手拆，别专门开一刀。

> **下游 action：无**（升级后 `docs/` 里这两份会多出上述内容；既有服务不受影响）。

### Removed — `client/desktop/public/static/table.png`（1.17MB 业务遗留物）

2026-05-07 从 yaki 拷 client 目录时一起带进来的采购订单扫描件，与 SOLO 框架无关：全仓库零
引用，却因为在 `public/` 下每次构建都被原样拷进 `dist/`；图上还有真实商业信息与个人手机号，
而本仓库已公开发布。删除后 `public/` 随之为空（Vite 的 `public/` 是可选目录，构建不受影响）。

> ⚠️ **历史里那份 blob 仍在**（含已推送到 GitHub 的 `40c818a`），本次只移除工作区文件、未改写历史。
>
> **下游 action：无**（仓库内一份零引用的遗留图片，不在任何下发产物里）。

---

## [v1.2.0] — 2026-08-20

> **本版是这条线上第一次 minor 步进**（v1.1.0 → v1.1.17 一路都是补丁）。理由是多了一个
> **新的交付物**而不只是修补：`client/extension-kit/`——浏览器插件的框架侧半边。
> 此前 SOLO 只覆盖服务端（`api/`）与自有前端（`portal/` · `client/mobile`）；插件是三个派生
> 项目各自手搓、且已经抄出矛盾的一块，现在收进框架。**仍然只加不破**：既有服务、方法、
> 前端一个字节都没动，`api/` 零改动。
>
> 门禁：主 CI 白名单 **127 套 / 2018 测试**，绿 126 / 2016（仅剩 2 例是 `agent.decide` 的
> LIVE Gemini 活体测试因外部模型漂移失败，与 v1.1.16/17 同一组、与本版无关）；
> kit 单元 **59/59**；插件 E2E **20/20**（真 Chrome，连跑两轮稳定）；`deploy/build.sh` 5.3M 产物。

### Added — 浏览器插件 kit（`client/extension-kit/`）+ 客户端所有权边界

> 来源：实扫三个派生项目各自手搓的 MV3 插件（wavely `erp/client/plugin/` v1.2.9 ·
> steward `client/plugin/` · trend `collector/extension/`）。**`wavely/lib/rpc.js` 与
> `steward/lib/rpc.js` 逐行 diff：逻辑差异 0 处**，实质差异只有 `deviceId` 一个字符串；
> `endpoints.js`、`mock/serve.sh` 同样是复制品。与 v1.1.16 收编 `run.sh` 前端注册表同构。
>
> 更麻烦的是**修复不回流**：steward 的 `endpoints.js` 记着一条 🔴（"wavely 踩过默认值漂移，
> 症状是登录成功但什么都读不到"），**而 wavely 自己的文件里没有这条**——抄的人拿到了教训，
> 被抄的人还在原地等着回归。

- **`client/extension-kit/`（新增，[Solo] 所有，形态对齐 `api/library/`+`api/sample/`）**：`lib/` 收：`rpc`（网络层失败归一化 -32099 + 退避重试 +
  会话失效重登）· `endpoints`（地址单一真源，不猜尾斜杠）· `session`（token 存 local/session
  的策略收口）· `image`（分块 base64 + 逐级降质，对齐 `storage.asset.upload` 的 5MB 上限）·
  `storage`（chrome.storage 适配 + 串行化读改写）。ESM、零依赖、零构建。
- **`queue`（全新，三家一个都没有）**：持久化发送队列，**熬过 MV3 service worker 休眠**。
  实扫三家 `chrome.alarms` 引用数全为 0；trend 的采集是 `for` 循环里串行 3N 次 await，
  **worker 一睡就断在中间且无队列 = 永久静默丢数据**。语义为 **at-least-once**：条目只有
  确认成功才出队，故 `idemKey` 必填（对应 ingress 的 `(source, request_id)` 与实体业务键）；
  溢出 / 永久失败 / 重试用尽**一律进死信，不静默丢**。
- **`sample/`（新增）**：最小可加载扩展（配 Router → 登录 → 采当前页 → 入队上报），同时充当
  README 接法的**可执行版**、E2E fixture、派生项目的起点。已在真 Chrome 里实跑验证
  （playwright + `channel: 'chromium'`：SW 起来、kit 接线、入队去重、落盘、idemKey 守卫全通）。
- 🔴 **`sync.sh`：kit 必须复制进扩展根内部，不能 import 出去**。Chrome 扩展的根是一棵封闭的树，
  `import '../../extension-kit/lib/rpc.js'` 越界**加载不到**，且失败形态极坏——**service worker
  注册得起来、不报任何错、URL 看着正常，但模块从未求值，所有调用石沉大海**（2026-08-20 实测）。
  `upgrade.sh` 对有 `manifest.json` 的 `client/extension/` 自动刷新其 `kit/` 子目录，
  框架修复照样到达，而项目的 manifest / adapter / 选择器永不被动。
  （软链实测可行但未采用：Windows / `zip -y` / 商店打包下会断，断掉正好是上面那个静默症状。）
- 🔴 **所有权边界（本次的关键决定）**：`client/extension-kit/` 进 `upgrade.sh` 整目录覆盖清单；
  **`client/extension/`（项目自己的浏览器扩展）**维持 [Project] 所有、永不覆盖——等同
  `api/library/`+`api/sample/` 与 `api/apps/` 的分工。**边界必须在第一版就对**：`portal/operator/`
  正是反例（scaffold 拷一次、永不再同步，v1.1.17 的下游 action ② 就是在还这笔债）。
  `init.sh` 同步下发。
- 🔴 **顺带纠正一处长期歧义**：`client/plugin/` 是**桌面客户端**的 React 视图插件
  （`{id, name, icon, entry: "View.tsx"}`，由 `client/desktop` 以 `@plugins/…` import），
  **与浏览器扩展无关**。此前脚手架只给了一个含义模糊的空 `client/plugin/` 占位符，导致
  wavely / steward 把 MV3 扩展放了进去、trend 另起 `collector/extension/`——三家三个落点。
  `README.client.md` 现已把三者写清楚，浏览器扩展的正式位置是 `client/extension/`。
- 🔴 **`rpc.attempt()`（新增）+ 队列尊重 `retry_after`：把「重试」收敛成只有一层**。
  此前队列的 `send` 走 `rpc.call`，而两者各有一张退避表，**会相乘**——实测一个条目跑满队列的
  6 次尝试要发 **36 次 fetch、耗时 135 秒**（`-32029` 场景 22.5s/6 次，Router 连不上 36.9s/18 次）。
  135 秒全程占着 service worker（MV3 的 worker 本就朝不保夕），`drain()` 期间整条队列被它堵着，
  而那 36 次多数打在一个**已经在限流**的端点上，只会让限流档位更深。
  `attempt` = 一次逻辑尝试：**不做瞬态退避**，但保留网络层快速重试（抖动时端点并没在限流）
  与会话失效 reauth（否则 token 一过期队列里每条都白撞一轮）。改后同场景 **6 次 fetch / 0 秒**。
  判据写进文档：**调用方自己有没有重试机制——有就用 `attempt`，没有才用 `call`**。
  另：`RpcError` 现在带 `data`，队列据此尊重 Router `-32029` 下发的 `data.retry_after`
  （秒，下限 1s 上限 1h）——服务端知道自己的窗口，本地退避表只是猜。
  队列默认退避同步调成 **5s → 20s → 80s → 5.3m → 16m（封顶）**（原 30s 起、2 倍）：失败现在
  会瞬间落到队列这一层，而人点一下「采集」走的是同一条路，一次网络抖动不该让他静默等半分钟；
  倍率改用 4 是为了在 5 秒起步的同时把总窗口留到约 23 分钟（2 倍只剩 2.6 分钟就判死信）。
- 回归两层：`tests/` **59 用例**（jest，纯逻辑，独立 config——kit 是 ESM 需
  `--experimental-vm-modules`，不并进主 gate 以免给 127 套既有 CJS 用例挂实验标志）；
  `e2e/` **20 用例**（playwright，真 Chrome 装 sample 扩展，自带假 Router 故**不需要活栈**）。
  E2E 覆盖的是单元测试结构上够不到的那层：kit 在真 MV3 service worker 里是否求值、队列是否
  真的落盘、**CDP 强杀 worker 后条目是否仍在并能被唤醒补投**、真 `crypto.subtle` 上的挑战响应。

> **下游 action**：无（纯新增，不动任何既有行为）。已有插件的三家可按
> `client/extension-kit/README.md` §6 迁移——`createRpc` 相对原版只有一处变化：重登钩子从写死的
> "拿存着的密码再登一次"改成可注入的 `reauth`，用 `createPasswordAuth()` 即逐字等价。
> trend 迁移后**顺带获得它现在完全没有的队列**；三家可顺手把扩展从 `client/plugin/`
> 挪到 `client/extension/`（两者 upgrade 都不碰，挪不挪都不影响升级，只是名正言顺）。

> **有意留白**：① passport 设备线——三家都在用内部员工账号 + 明文密码存
> `chrome.storage.local` 才能自动重登，而 `user.passport.device.issue`/`verify`（设备令牌换
> 24h 会话、可按人吊销、`$owner` 自动行隔离）本就是为外部客户端设计的，**实扫三家对
> `user.passport.*` 的引用数是 0**——不是选错了，是没人知道这条路；② schema / 枚举下发
> （`ingress.dataSchema` 现在只在服务端拒绝、客户端看不见；wavely 把 catalog 的
> `ColorwayKey` 枚举抄了一份在插件里，服务端加一个色值它就静默旧了）。两项都要新增 RPC 方法，
> 而方法一旦发布撤不回来（runbook §5），等第二个实例出现、形状清楚了再定。

---

## [v1.1.17] — 2026-08-19

> colony 的五篇 feedback triage（08-17 ~ 08-19）。主线接着 v1.1.16 那条缝：
> **「返回成功」不等于「事情做成了」**——token 轮转从没被触发、附带参数被静默丢弃、
> 注册出一个永远登不进去的账号、权限不足显示成「还没有数据」。
> hermetic CI 白名单 **127 套 / 2018 测试**，绿 126 套 / 2016（仅剩 2 例是 `agent.decide` 的
> LIVE Gemini 活体测试因外部模型行为漂移失败——模型返回了闭集外的 `defer`，与 v1.1.16 记录的
> 是同一组，与本版改动无关）。

### 🔴 BREAKING — `user.register` 现在强制要求 `salt` + `hash`

> 来源：colony，`docs/feedback/done/operator-onboarding-three-silent-traps.md` §一。
> 此前缺省时**服务端随机生成**一个谁都不知道的凭证，`register` 照常返回 `{ success: true, uid }`，
> 而该账号**永远无法登录**（无改密/重置入口），只在第一次登录时以「密码错」的形态暴露。
> 自省声明里根本没有这两个参数，「照声明写」必踩——只有散文 GUIDE §2b 警告过。

- 缺任一 → `-32602`，报错指向 router GUIDE §2b；introspection 补齐两个参数的声明（`required: true`）。
- **下游影响**：仓内两个真实调用方（portal/system 建号弹窗、scaffold e2e harness）本就传了
  salt+hash，不受影响。**自建的建号脚本若依赖旧的静默兜底，会从「静默产出废账号」变成显式报错**
  ——这正是意图。

### Added — relay 内建轮转心跳（根治「稀疏调用方 token 静默过期」）

> 来源：colony，`docs/feedback/done/nexus-relay-lazy-rotation-sparse-callers.md`（ant 与 nexus 两次实测）。
> 轮转是**惰性**的：只在 `call()`/`getToken()` 走到 `getValidToken()` 时才检查。事件驱动的服务
> 可以静默几小时到几天，轮转窗口（到期前 2h）内一次调用都没有 → token 静默过期。
> 这与 events.md §0.5 讲的「permit 漏 `user.token.refresh`」是**两个不同的故障**：那个是轮转被拒，
> 这个是轮转根本没被触发，permit 配得再全也一样死。

- `createRelay` 新增 `rotationHeartbeatMs`（默认 10min，`0` 关闭）+ `stopHeartbeat()`；
  无 token 时静默（provisioning 前是正常态）、不发业务 RPC、不需要额外 permit。
- `nexus.sentinel.create`/`enable` 在共享 relay 无可用 token 时返回 `warning`（不阻止创建）。
- `NEXUS:DLQ` 补 `MAXLEN ~` 上限（`NEXUS_DLQ_MAXLEN`，默认 1000），对齐 notification/orchestrator。

### Added — `fulfillment.instance.transition` 接受 `meta` 作为 `metaUpdate` 的别名

> 来源：colony，`docs/feedback/done/fulfillment-transition-metaupdate-naming-trap.md`。
> create/update 收 `meta`、transition 收 `metaUpdate`，而 Router 对未声明参数既不拒也不记日志
> ——写错名字的字段**无声无息地消失**，colony 的镜像因此丢了一天多的数据，账面全绿。

- 两名并存时 `metaUpdate` 优先；introspection 与 GUIDE 同步标注。
- ⚠️ 仍未解决的更大问题：**未声明参数一律静默透传**（建议改成 warn 档，落点在 router 保护区，待授权）。

### Fixed — operator portal 不再把「权限不足」渲染成「还没有数据」

> 来源：colony，`docs/feedback/done/operator-onboarding-three-silent-traps.md` §二、§三。

- `utils/rpc.ts` 改抛保留 code 的 `RpcError`；新增 `LoadError` 组件，**Forbidden 与其他失败分开措辞**；
  六处渲染点接上（fulfillment ×2 / GenericList / AssetList / Dashboard 两个面板）。
- 登录被拒文案点名 `categories.POWER`（并说明「不是 ROLE」），user GUIDE 新增建号三步配方。

### Docs

- nexus 投递 payload 的三层嵌套形状（`context.md` §6 重写 + nexus GUIDE）——原示例是错的。
- events.md §6.5「流是投递通道，不是审计账本」；§0.5 补「permit 配齐 ≠ 轮转被触发」。
- passport.md §3.6 补三条只存在于代码里的契约（`$owner.value` 才是判定主体 / 无上下文 = 不过滤 /
  单租户下必须造他人数据反证才算验收），并加回归测试锁定。

> **下游 action**：① 自建建号脚本检查是否传了 `salt`/`hash`（见上方 BREAKING）；
> ② `portal/operator/` 是 init.sh 一次性拷贝、`upgrade.sh` **永不覆盖**，上面那组前端修复
> **不会随升级到达存量项目**，需自行回填（`utils/rpc.ts` + 新增 `components/ui/LoadError.tsx` +
> 六处渲染点 + 两条 i18n）；③ 升级后可删掉为绕过 relay 惰性轮转而自建的 timer / schedule 心跳。

---

## [v1.1.16] — 2026-08-16

> 六篇派生项目 feedback 的集中收口（2026-08-14 与 08-16 两轮 triage），
> 主线仍是「看起来正常」与「真的正常」之间的缝：行隔离声明了没人执行、fail-fast 报假原因、
> 探测看不到声明、submit 的报错把人引向错误方向。全部只加不破。
> hermetic CI 白名单 **126 套 / 1983 测试**，绿 125 套 / 1981（仅剩 2 例是 `agent.decide`
> 的 LIVE Gemini 活体测试因外部模型行为漂移失败——在无本地改动的基线上复跑同样失败，
> 与本版改动无关）；`deploy/build.sh` 端到端跑过（5.3M 产物，grep 确认
> requestContext/ownerScope/enroll 均落进 bundle）。

### Added — 🔴 行隔离 `$owner` 从「强制声明」补齐为「自动执行」（Entity Factory）

> 来源：colony 实测，`docs/feedback/done/passport-owner-isolation-declared-not-enforced.md`。
> 三道发证关卡强硬拒绝没有 `ownerField` 的外部角色，但 `$owner` 下发后**没有任何一环消费它**
> ——服务不自己读，passport 外部主体就能读全表，零告警。

- `library/entity.js` 新增导出 **`requestContext(req)`**（walContext store 收口：uid/trace/depth
  + `owner` = `req.constraints.$owner`）；工厂据此在数据层自动执行：create 盖 owner 章（覆盖
  客户端伪造）、get/update/delete/destroy 越权 → NOT_FOUND（不泄露存在性，与 collection 手工
  实现同语义）、list/multiGet/cursor 过滤、update 不能改走 owner 字段。
- 14 个用 walContext 的服务 + `api/sample` 全部改为 `walContext.run(requestContext(req), …)`。
  内部/admin/bot 会话无 `$owner` → 行为与从前完全一致；**fail-closed**：外部会话只能看到盖了
  自己章的行（enforcement 之前的存量行对外部会话不可见——这是设计）。
- 新增 autocheck 规则 `owner-context`（WARN）：`walContext.run` 手写 store 字面量即告警。
- 文档同步：passport.md §3.6/§3.7（言明执行位置 + 「v1.1.15 及更早没有执行环节」的版本边界）、
  user GUIDE、scaffold `docs/authoring/service.md` §2 + 自查第 8 条、solo-service SKILL.md。
- 回归：新增 `library/tests/entity-owner-scope.test.js`（13 用例）入 CI 白名单。

> 下游 action：**把各自有服务 `walContext.run` 的手写 store 换成 `requestContext(req)`**
> （autocheck 会 WARN 提示）。换完后 passport 外部会话将只看到盖了自己章的行——存量行没有
> owner 字段会从外部视角消失；单用户/想让外部看全表的场景，给角色去掉 external scope 或给
> 存量行补 owner 字段。内部/admin 调用零变化。

### Fixed/Added — fulfillment `profile.submit` 契约纠偏 + `enroll` 追溯治理

> 来源：colony，`docs/feedback/done/fulfillment-profile-submit-contract-and-enroll-gap.md`。

- submit 撞已存在 id：捕获工厂通用 "already exists"，翻译成通道契约报错（点名「submit 是在
  审核通道里**创建**」、报出对方所在通道、指路 enroll）；`config.js` 英中描述、introspection
  注释同步改写。
- **Added `submit { id, enroll: true }`**（handler 层 admin 门）：把既有可信直建 profile 转入
  PENDING_REVIEW——重 lint（坏的拒收、原样保持可用）、清 approvals/approvedDigest、实例经
  现有激活闸立即冻结。记 `enrolledBy` 而非 `submittedBy`（否则「审批人 ≠ 投稿人」让单管理员
  系统 enroll 后无人能批）。GUIDE.md 配方二补第 4 步。
- 回归：新增 `apps/fulfillment/tests/profile-lanes.test.js`（7 用例）入 CI 白名单。

> 下游 action：无（submit 正常路径行为不变；新报错只出现在此前必然失败的调用上）。

### Fixed — scaffold `run.sh` 端口探测的 lsof 硬依赖（缺失时守卫**反向失效**）

> 来源：overview 迁 N100 实测，`docs/feedback/done/run-sh-lsof-hard-dependency.md`。Debian 最小安装
> 无 lsof：fe_assert_port_free 静默放行、fe_confirm_bound 把起得好好的前端 exit 1 打死，
> 报错与事实相反、还指向空日志。

- 启动前置检查：lsof 与 ss 都没有 → 报真实原因 + 安装命令后拒绝启动。
- 全脚本探测收口成三个函数（`port_in_use` / `listener_pids` / `listener_desc`），lsof → ss
  自动回退；cleanup 清扫、两个 fe 守卫、dashboard 四处绿点全部换用。
- fe_confirm_bound 失败分支区分「没人监听」与「有人监听但确认不了归属」（ss 无权限场景），
  不再统一报「前端没起来」。

> 下游 action：无（macOS 与已装 lsof 的机器行为不变；未装 lsof 的 Linux 从「误杀栈」变成
> 「正常工作」）。改过 `deploy/run.sh` 的项目随 DIVERGED 流程手动 merge。

### Added — scaffold `run.sh` 自有前端注册表（四个项目各抄一段的终结）

> 来源：colony，`docs/feedback/done/run-sh-no-derived-frontend-registry.md`。runner/finance/trend/
> colony 各在只读区抄了一段几乎相同的启动代码，全是 upgrade 的必然牺牲品。

- `.env` 声明即接入：`FRONTEND_<NAME>_DIR` + `FRONTEND_<NAME>_PORT`，run.sh 扫描并经新函数
  `serve_src_frontend` 启动（缺 dist 自动 npm install+build、端口守卫同款、进 dashboard）。
- 逃生舱 `deploy/frontends.local.sh`（存在才 source，不随 bundle 下发、upgrade 永不覆盖）。
- config.js 注入收编成 `write_fe_config`，tarball 前端与源码前端共用——注入项以后增删，
  自有前端自动跟上。`init.sh` 生成的 `.env` 模板带注释示例。

> 下游 action：**四个有自有前端的项目**升级后把 DIVERGED 的前端段删掉、换成 `.env` 两行声明
> （runner 顺带获得它此前缺失的端口守卫；finance 的定制签名挪 `frontends.local.sh`）。

### Fixed — `init.sh` 三处端口扫描只有前端一处能被调用方覆盖

> 来源：steward 脚手架实测，`docs/feedback/done/scaffold-port-scan-blind-to-declarations.md`。
> 探测看不到「已声明未启动」，更看不到「整栈迁走后本机遗留声明」的永久盲区。

- `SOLO_PORT_BASE` / `REDIS_PORT` 补上与 `FE_PORT_BASE` 同款环境变量覆盖（没传行为不变）。
- 三处分配的提醒统一措辞并收进结尾 Next steps 第 2 步（一行列出全部分配结果 + 台账核对指引）；
  扫描前加 lsof 缺失警告（缺了会把所有端口判成空闲）。

> 下游 action：无（存量项目不受影响；新建项目可一条命令传齐三个号段）。

### Added — per-app env + `bindAddr()` 监听网卡控制 + redis 模块第三档（2026-08-14 批）

> 来源：runner 部署 N100 实测，`docs/feedback/done/run-sh-no-per-app-env.md`（详细 triage 在文内）。

- `deploy/services.json` 支持 per-app `env`（如 `{ "env": { "BIND_ADDR": "0.0.0.0" } }`），
  「哪个服务对外」变成声明在项目里、跟着 git 走的事实。
- `library/ports.js` 新增 `bindAddr(name)`（`<NAME>_BIND_ADDR` > `BIND_ADDR` > `undefined`，
  两个都不设时与不传 host 完全等价 = 零行为变化）；15 个服务 + sample 的 `app.listen` 接上；
  新增 autocheck 规则 `bind-address`（WARN）。
- `run.sh` redis 分支第三档：落到 plain `redis-server` 时自动找 `rejson.so`/`redisearch.so`
  并 `--loadmodule`（Debian 12 官方源的模块随包装但默认不加载）；安装提示按平台分。

> 下游 action：无强制（全部 opt-in）。要锁监听网卡的部署在 `.env` 或 services.json 里声明；
> runner 的私有服务可换用 `bindAddr()` 但注意默认值方向（详见 feedback 文内动作项）。

---

## [v1.1.15] — 2026-08-08

> 五批派生项目实战反馈的集中收口，同一条主线：**"看起来正常"与"真的正常"之间的缝**——
> 事件跨栈误投但 HTTP 200、fail fast 却误杀先起的栈、升级自检唯一漏检的门户、
> 分页误报指向不存在的数字、新脚手架端口默认相撞。全部只加不破,详情见下方五节。
> hermetic CI 白名单 **123 套 / 1939 测试**全绿,真实 `deploy/build.sh` 端到端验证过产物。

### Fixed — bundle 内置服务吃继承的 `ROUTER_URL`/`PORT` → 事件误投给别家 Router、静默丢弃（🔴 数据丢失级）

> 来源：trend/overview 同机并跑的实测 + 08-08 源码核实，`docs/feedback/done/inherited-router-url-silent-misdelivery.md`。两个正交缺陷，各自都足以致静默失败，这次一起修。

- **根治**：`deploy/gen-entry.js` 在 `global.__SOLO_PORTS__` 填完、任何服务 `config.js` 加载前 `delete process.env.PORT; delete process.env.ROUTER_URL;`。bundle 是**一个进程托管多个服务**，这两个变量是"单进程单身份"语义（`PORT`=我自己的监听端口，`ROUTER_URL`=独立私有 app 进程该去哪找 Router），对 bundle 内置服务毫无意义、继承下来还很危险：14 个 core/apps 的 `config.js` 仍是 `process.env.ROUTER_URL || urlFor(...)`（环境变量优先，`ports.js` 头部注释明明写着 `urlFor` 刻意不读环境），一个从别的 Solo 栈残留 `export` 下来的 `ROUTER_URL`，会让本项目的事件全部悄悄投给别人的 Router——对方不认来源、`blocked` 丢弃，日志打在**对方**项目里，本项目从 HTTP 200 到审计 `accepted` 全程"正常"。`PORT` 泄漏更糟：`portFor()` 对 `process.env.PORT` 是有意优先（独立进程需要它钉住监听口），bundle 里十几个服务会全挤到同一个端口，只有第一个绑上的能用。**一处改动**（entry 是每次 build 都会重新生成的单一入口）保护全部现在和未来的 config.js，且不影响 `run.sh` 私有 app 段（它显式给每个子进程传这两个变量，语义合法、不受影响）。
- **防御层**：`deploy/scaffold/run.sh` 加载 `.env` 后追加 `unset PORT ROUTER_URL ADMINISTRATOR_SERVICE_URL`——不能替代上面的根治（这里清理的是 shell 本身的继承源头，gen-entry.js 清理的是 bundle 进程实际读到的值），但双保险成本几乎为零。
- **独立缺陷，价值不依赖上一条**：`core/ingress/logic/ingest.js` 的 `emit()` 此前把 `relay.call('event.emit', ...)` 的返回值直接丢了——Router 其实**如实**返回了 `{written, blocked, deduped}`（`router/handlers/events.js:228`，blocked 分支也确实打了日志），只是没人读。现在 `handle()` 检查 `stats.written`，非法/未交付时：**释放 dedup 声明**（否则外部发送方的重试会撞上"重复"，把一次可恢复的失败变成永久丢失）、记审计 `outcome:'delivery_failed'`、返回 `{ok:false}` + HTTP 语义 502（而不是无条件记 `accepted`、写 30 天去重键）。哪怕没有 ①的跨栈场景，只要本项目自己的 stream 忘了进 Router registry，同样的静默丢失照样会发生——①只是把它放大到了跨项目。
- **顺带**：`ingress.source.test`（admin 手动测试 wiring 的 RPC）现在把 `written`/`blocked` 直接放进返回——管理员排查"事件怎么没显示"时，不用再去猜、去翻可能是别的项目的 Router 日志。
- 回归：`core/ingress` 新增 3 个用例（Router 拒收后 502+释放去重键+不记 accepted；relay 返回值缺失时同样按未交付处理，做过失活测试——去掉检查后两个新用例当场红；test-fire 透出 blocked 统计）；`returns-contract.test.js` 的共享 fake relay 之前只返回 `{ok:true}`（没有 written 字段），按真实 Router 返回形状补全，否则新的强校验会把它也判成"未交付"——这正是假实现语义漂移的同一类陷阱，改完复核了它模拟的 4 个 ingest 路径依旧准确反映真实行为。`gen-entry.js` 改动用真实 `deploy/build.sh` 端到端跑过一次（5.3M 产物、生成的 entry 语法检查通过、`grep` 确认两处修复都落进了最终 bundle）。CI 白名单 123 套 / 1939 测试全绿。

> 下游 action：**无强制**（bundle 内置服务的 `ROUTER_URL`/`PORT` 继承是从未被利用的能力，清理它不改变任何正常配置下的行为；`ingress.ingest` 新增的 502 路径是 additive 的失败态，此前这类请求会被误判为成功，现在会如实报告——**如果你的监控/告警只看 HTTP 200，升级后请确认它也认 `ok:false` 这个字段**，`ingress.ingest` 的传输层本来就一直是"HTTP 200 + 内部 `ok` 字段"而非用 HTTP 状态区分成败）。**改过 `deploy/run.sh` 的项目**：新增的 `unset` 一行随 DIVERGED 流程走，需要手动 merge。

### Fixed — scaffold `run.sh`：v1.1.14 fail fast 的退出路径反咬一口（同机多栈误杀）+ 两处启动阻断

> 本节起，以下几节全部来自 2026-08-06 两个派生项目（finance、trend）升 v1.1.14 的同日实测反馈：
> `docs/feedback/done/scaffold-startup-guards-fallout.md` + `patch-upgrade-consumer-gaps.md` + `autocheck-hardcoded-page-regex.md`。

- **`cleanup()` 端口清扫加进程组判据**。"保险起见"的端口清扫对两份 services.json 里所有端口无条件 `kill -9`，这在 v1.1.14 之前只在 Ctrl+C 时跑（杀的确实是自己）；v1.1.14 加了 fail fast 后，**每条 `exit 1` 路径都经 EXIT trap 走这段清扫**——端口撞车时"第二个实例没抢到任何东西，却把先起的栈连根拔了"（finance/trend 双双实测复现），恰好发生在守卫要保护的同机多栈场景。现清扫前比对 `pgid`，只杀自己这一支（子进程不 `setsid`，pgid 继承自 run.sh，判据成立；保留"抓自己 detach 掉的孙子进程"原意）。
- **`cleanup()` 保留真实退出码**。原结尾无条件 `exit 0` 把 fail fast 的 `exit 1` 吃掉，`start-all.command` 这类按退出码判断的启动器会把"拒绝启动"读成"起好了"。顺带加了 trap 防重入。
- **`serve_frontend` 的 `$SYSTEM_DESCRIPTION` 裸引用**（v1.1.13 引入）：`set -u` 下 unbound variable，而 `init.sh` 生成的 `.env` 里没有这个变量——**全新派生项目跑 stock `run.sh` 起不来任何前端**（此前没暴露是因为在用的派生项目 run.sh 都定制过、走 DIVERGED 分支，新 stock 从没被真正执行过）。改 `${SYSTEM_DESCRIPTION:-}`；`init.sh` 的 `.env` 模板补上 `SYSTEM_DISPLAY_NAME`/`SYSTEM_DESCRIPTION` 注释位（原来这个 v1.1.13 能力对消费者基本隐形）。
- **端口守卫抽成可复用函数** `fe_assert_port_free` / `fe_confirm_bound`：派生项目常有不走 `serve_frontend` 的自有前端（finance 两个 Vite 应用、trend 一个单页），此前它们仍是"serve 静默换随机口"的重灾区；抽成函数后在项目自己的启动段里调用即可获得同等保护（两个项目各自独立提出并已在本地落地同款改法）。

### Added — `init.sh` 给三个前端端口补上自动避让（此前只有核心服务 + Redis 有）

- `init.sh` 早就用 `lsof` 探测给 Solo 内部服务段（8400+）和 Redis 端口自动挑空闲值，唯独 `PORTAL_OPERATOR_PORT`/`PORTAL_SYSTEM_PORT`/`CLIENT_MOBILE_PORT` 三个前端端口是硬编码 `3600`/`3650`/`3700`——同机脚手架出两个新项目默认就撞车（真实踩过：多个派生项目共用 3650/3700，叠加 `run.sh` 升级前"端口被占只 warn 不报错"的旧行为，静默失效能拖几个月没人发现）。现补上同款探测：探测到冲突整个三元组一起 `+150` 重试（保留项目内部 operator/system/mobile 间隔 50 的既有约定，重试永不与上一次失败区间重叠）。本机实测：4 个常驻栈正占着 3600/3650/3700/3800/3850/3900/3950，新脚手架自动跳到 4050/4100/4150。
- **仅影响 `init.sh`（新建项目）**，不改变 `upgrade.sh` 行为——`.env` 是 `[Project]` 所有，升级从不touch，存量项目端口不受影响。**局限未变**：`lsof` 只看"此刻正在跑的"，看不到"隔壁项目声明了但没启动"的情况；跨项目端口台账（如本机维护的 `overview/mind/ref/ports.md`）仍是唯一能兜住这条缝的地方，`init.sh` 这次只是把"两个全新项目默认值直接相撞"这个最常见的子情形也顺手挡掉。

### Fixed — scaffold `upgrade.sh`：它保证的是「产物就位」，不是「栈还能跑」——三个消费者侧盲点

- **`docs/README.md` 改标记块覆盖**。原来与三份 authoring 契约一起整份无条件覆盖，但 README 是索引、天然被项目扩展，项目自己加的章节会被静默抹掉（trend 丢过一整节集成文档索引）。模板加 `<!-- solo:begin/end -->` 标记，升级只替换标记块内的 Solo 区、块外原样保留；无标记的存量 README（≤v1.1.14 模板或整个重写过的）不覆盖，新模板 staged 成 `docs/README.md.solo-<ver>.new` 等人合并（与 deploy 脚本 DIVERGED 策略一致）。三份 `authoring/*.md` 契约维持无条件整份覆盖不变——那是对的。
- **升级后自检补 operator 扫描**。`run.sh` 按 `.solo-version` 拼名找 `operator.v<ver>.tar.gz`，而 upgrade 明确不碰 operator（source-distributed，项目所有）——两条规则各自都对，叠起来 = **每次升级后 operator 门户静默掉线**（只在 run.sh 里留一行 warn），它恰恰还是自检唯一跳过的前端。现自检发现失配即标 ACTION 并附可直接复制的重建三行命令；**不做**"自动拷 Solo 的 tarball"（trend 逐文件 diff 出 7 个定制文件，自动拷会静默抹掉定制且 `git status` 干净、无从发现——两个项目一个零改动一个有改动，说明两种情况都常见，判定不了就不代做）。
- **`Next:` 补「跑一遍项目自己的测试」**。升级后的常规验证（重启/health/看端口）对"产物就位但项目代码不兼容"（如 fake redis 缺新命令）全部会绿，只有项目自己的测试能兜住；runbook 里写了但实操走的是脚本结尾的 `Next:`。顺带修一处潜伏 crash：自检里 `ls ... | xargs` 流水线在 tarball 缺失时非零退出，`set -o pipefail` 下会让自检中途静默退出。

### Fixed — autocheck「硬编码分页数字」正则少右边界，报出不存在的数字

- `config-check.js` 的 `(\d{2,4})` 无右边界，`DEDUP_SCAN_LIMIT = 10000` 被匹配掉前 4 位报成「硬编码分页数字 1000」——报警指向**不存在的数字**，排查者得读完代码才能确认是误报（trend 三个服务 7 处全是这种）。两个捕获组补 `(?!\d)`；实测右边界后真警告（`LIMIT = 100`）仍命中。
- 加 `// SAFE:` 单行豁免，与同目录 `pagination-safety.js` 既有约定一致——「确实是大数字、但确实不是分页」（全量扫描上限等）从此有正规消音方式，不必改常量名迁就检查器。

### Changed — `api/sample` fake redis 补齐游标读路径 + 声明为"随版本更新的模板"

- sample 的 mock 此前有 `incr`/`zAdd`/`zRem`/`zCard`/`sCard` 但缺 `zRange`/`zScore`——派生项目照新 sample 写 cursor 模式的 hermetic 测试仍会撞墙。补齐两者，`zRange` 按真 Redis 语义实现（REV 下入参 `(max,min)`、`+inf`/`-inf`/`"(n"` 开区间边界），并加 cursor 翻页用例钉住语义（假实现语义错了比没有更危险——hermetic 全绿、错误假设藏到真 Redis 才炸，同 v1.1.14 SCAN 批次坑的教训）。
- mock 上方加显式提示：**命令集跟着 `api/library/entity.js` 的依赖走，抄出去之后每次升级要回来对一次差**。v1.1.13 的下游 action 原文「无强制」已补正为「运行时无强制，hermetic 测试有强制」（见该条目）。

> 下游 action：**改过 `deploy/run.sh` 的项目要手动 merge 新 stock**（升级时按 DIVERGED 流程落 `.new`；finance/trend 已自行打过 pgid/unbound 补丁的，merge 时以新 stock 为准对齐）。**手写 fake redis 的服务测试补 `incr`/`zAdd`/`zRem`**（v1.1.13 起就需要，见该条目补正；照新版 `api/sample/tests/item.test.js` 对齐最快）。docs/README.md 无标记的项目首次升级会看到 staged 的 `.new`——把项目章节挪到其 `solo:end` 之后合并一次，之后升级只动标记块。operator 有 tarball 的项目每次升级后按自检 ACTION 重建/拷贝一次。**`init.sh` 前端端口自动避让**对存量项目无动作——只影响新建脚手架，`.env` 是 `[Project]` 所有，`upgrade.sh` 从不改。

---

## [v1.1.14] — 2026-08-05

> 发布产物已按 runbook §3 从本版 build：`api/publish/solo.js`（5.3M）+ `portal/publish/{operator,system}.v1.1.14.tar.gz` + `client/publish/mobile.v1.1.14.tar.gz`（build 脚本自动清掉了之前滞留的 v1.1.12 tarball）。产物目录全部 gitignore、不随 tag 入库——消费者从归档取，或由 `upgrade.sh` 从 solo 工作树 cp，所以**本机要先 build 再 upgrade 派生项目**，否则 upgrade 报 `MISSING ... rerun with FRONTEND_BUILD=force`。

> Redis 性能局限系统排查收尾:user/orchestrator/nexus 三个核心服务的 KEYS/全量拉取反模式修复 + 死信队列裁剪 + node-redis v5 SCAN 迭代器批次坑(顺带修了 storage 那轮审计后 e2e 才暴露的问题),以及针对这个批次坑本身的检测手段补齐(autocheck 新规则 + api/library 检查入口 + fake redis 共享 SCAN 批次原语 + 真实 Redis 契约测试 + 两条确定性回归用例)。**同批还有 scaffold `run.sh` 的两处启动期资源冲突 fail fast**（同机多栈撞 Redis / 前端端口的静默接管,来自派生项目实测反馈）。全部只加不破,hermetic CI 123 套/1935 测试 + e2e full profile 66 套件/346 测试全绿。

### Fixed — 四处活跃的 KEYS/全量拉取反模式（Redis 性能局限系统排查的后续）

> 顺着 entity.js/storage 那轮审计继续排查"还有哪些已知 Redis 性能局限出现在现有代码里",这次覆盖 `redis.KEYS`(阻塞、扫的是整个 keyspace 不是只扫匹配项)、`SMEMBERS` 全量拉取 + 逐条 GET(N+1 往返)、以及死信队列无界增长三类。全部改动**接口/返回形状不变**,`orchestrator.run.list` 新增的 `limit`/`offset` 是纯加法(不传 = 原样返回全部,行为不变)。

- **`user.account.list` 的用户名模糊搜索**(`core/user/logic/user.js`):原来是 `KEYS('user:name:*关键字*')`(两头通配符,KEYS 最坏情况)+ 逐条 `redis.get()` 顺序循环(真·N+1,一次搜索= 一次 Redis 往返每个用户)。改成 `SCAN`(非阻塞、游标式)+ 一次批量 `MGET` 解析匹配项。非关键字的标准列表路径同理,`SMEMBERS` 换成 `SSCAN`,逐条 GET 换成分块 `MGET`。`user.account.status`(stats)同步改造。
- **`orchestrator.run.list`**(`core/orchestrator/logic/run.js`):原来 `SMEMBERS` 全量 run id + 逐条 `JSON.GET`(N+1)+ 内存排序,而且**函数签名压根没有分页参数**——调用方永远拿到全部 run 历史。run 是每次工作流执行都会新增的记录,是这几个例子里最活跃、最会无限增长的业务数据。改成 `SSCAN` + 分块批量 `JSON.MGET`,新增可选 `limit`/`offset`(不传 = 原样返回全部,现有调用方例如 stall scanner 的 `list({status:'RUNNING'})` 零变化)。
- **`nexus.schedule.list`**(`core/nexus/logic/schedule.js`):`create()`/`update()`/`del()` 其实早就在维护一个按 `fire_at` 打分的 ZSET(`NEXUS:SCHEDULE`,调度器自己要用来找到期任务),但 `list()` 却单独用 `KEYS` 扫了一遍——直接复用这个已有的 ZSET 就够了,顺带把 `list()` 自己再排一次序的代码也省了(`ZRANGE` 已经是 `fire_at` 升序)。
- **`ORCHESTRATOR:RUNQ:DEADLETTER` 无界增长**(`core/orchestrator/logic/worker.js`):`lPush` 写入从来没配对 `LTRIM`,工作流永久失败的记录会一直堆着。补了 `ORCHESTRATOR_DLQ_MAXLEN`(默认 1000,镜像 notification 的 `DLQ_MAXLEN`)。**注意方向**:orchestrator 这里是 `lPush`(新的在头部),不是 notification 的 `rPush`(新的在尾部)——`LTRIM` 的窗口是 `0..MAXLEN-1`,不是照抄 notification 的 `-MAXLEN..-1`,抄错了会把最新的记录丢掉、留下最老的。
- **⚠️ 排查过程中发现的一个通用坑,记一笔**:node-redis v4 的 `scanIterator`/`sScanIterator` 逐条 `yield` 单个成员,但 v5(本项目在用)**逐批 `yield` 一整个 SCAN 批次(数组)**——`for await (const x of redis.sScanIterator(...))` 里的 `x` 在 v5 下是个数组,不是单个值。这个坑仓库里 `core/nexus/logic/events.js` 之前已经踩过并留了归一化写法(`Array.isArray(x) ? push(...x) : push(x)`),这次三处新写的 SCAN 代码起初都漏了这一步——**hermetic 单测全绿(因为自己写的 fake redis 想当然按"单值"实现,复现了同一个错误假设),只有跑真实 Redis 的 e2e 在数据量大到产生多个 SCAN 批次时才暴露**。已按 `events.js` 的写法统一改过来,e2e full profile 66 套件全绿后才确认。
- 回归:hermetic CI 白名单 122 套/1928 测试全绿;e2e full profile(整栈 15 服务真实起,`E2E_PORT_OFFSET` 避开本机其他项目的端口占用后)**66 套件/346 测试全绿**(6 skipped,非 hermetic 的 agent LLM 用例)。

> 下游 action:无(接口/返回形状均未变化,`orchestrator.run.list` 新增参数是可选加法)。

### Added — 补上 SCAN 批次坑的检测与回归（上一条 Fixed 里那个"hermetic 全绿但 e2e 才暴露"的坑，这次把检测手段也补上）

> 上一条 Fixed 里的 v5 批次坑修完之后，顺着复盘"这个坑为什么 hermetic 测试全程没报警"，发现三层防线都有缺口：静态检查扫不到 `api/library`、所有手写 fake redis 的 SCAN mock 都是错的、错的假设本身也从没被验证过跟真实 Redis 一致。三层都补了。

- **autocheck 新增 `redis-scan-normalize` 规则**（`autocheck/static/redis-scan-normalize.js`）：检测 `for await (const x of redis.xScanIterator(...))` 循环体内是否有 `Array.isArray(x)` 归一化，正则风格跟已有的「内存击穿预警」（`pagination-safety.js`）一致。
- **`checker.js` 新增 `--lib` 模式**（`node autocheck/checker.js library --lib`）：`api/library/` 没有 `index.js`/`handlers/`/`logic/` 服务脚手架，此前 `structure.check` 会把它当"纯文档/设计阶段服务"直接跳过——entity.js 的全量拉取反模式、这次的 SCAN 批次坑，都曾在这里潜伏而没被任何 CI 检查扫到（per-service 循环从没把 `api/library` 当参数传过）。`--lib` 跳过服务脚手架校验，只跑 redis 反模式规则子集，已接入 `.github/workflows/ci.yml` 的 static job。顺带给 `pagination-safety.js`/`redis-keys.js` 加了"没有 `logic/` 子目录时退化扫描目录自身"的兼容逻辑，并给 `api/library/category.js`/`config.js`/`entity.js` 里 4 处已经权衡过、之前没打豁免注释的 `sMembers`/`hGetAll` 全量拉取补上 `// SAFE:` 标注（有界配置数据 / entity.js 向后兼容旧路径 / 一次性迁移脚本，均非新问题，只是没消音）。
- **6 处手写 fake redis 的 `sScanIterator`/`scanIterator` 全部是"单值 yield"的错误假设**（`core/user/tests/returns-contract.test.js`、`core/nexus/tests/events.test.js`+`returns-contract.test.js`、`core/orchestrator/tests/human-in-loop.test.js`+`returns-contract.test.js`+`tests/utils/fake-redis.js`）——包括上一条 Fixed 里"已经修好"的 orchestrator 共享 mock：它这轮只是补齐了之前缺失的 `sScanIterator` 方法，但补的还是单值语义。结果是消费方代码里的 `Array.isArray` 归一化分支，从没被任何 hermetic 测试真正走到过。新增共享生成器 `library/tests/utils/redis-scan-sim.js`（`scanBatches(items, {COUNT})`，按 COUNT 切块、逐批 yield 数组），6 处 mock 的 `xScanIterator` 方法体改成委托给它，其余方法不动（没有做整体 fake redis 对象合并——风险大、6 个 mock 各自还有很多领域特有方法，只抽了这次真正出问题的 SCAN 批次原语）。已抽取的 storage/approval/gateway 三个共享 mock 没有实现 scanIterator 系列，不在这次范围内。
- **新增契约测试**（`library/tests/redis-scan-contract.test.js`，真实 Redis）：验证"node-redis v5 逐批 yield 数组"这个假设本身，而不是只信注释。**顺带发现一个反直觉的真实 Redis 行为**：集合成员数在 `set-max-listpack-entries`（默认 128）以内时是紧凑编码，`SSCAN` 会无视 `COUNT` 提示、一次性整坨返回——37 个成员 + `COUNT:5` 时 `yields.length` 恒为 1；超过阈值转 hashtable 编码后 `SCAN` 才是真正的增量游标扫描。这也解释了当初这个坑为什么连 e2e 都不容易稳定复现：数据量不够大根本触发不了多批次。
- **两个确定性回归用例**：`core/orchestrator/tests/run.test.js`（run 数超过 `COUNT:200`）+ `core/user/tests/returns-contract.test.js`（用户数超过 `CHUNK:200`），把"多批次也不丢数据"从"靠 e2e 数据量凑巧撞上"变成钉死的断言。两条用例都验证过辨别力（临时去掉生产代码里的 `Array.isArray` 归一化，用例会红；改完立即还原）。
- 回归:hermetic CI 白名单 **123 套/1935 测试**全绿（新增 `redis-scan-contract.test.js` + 2 个确定性回归用例）;`autocheck --static` 全服务 + 新 `--lib` 模式跑过，无新增警告。

> 下游 action:无(全部是框架自身的测试基础设施 / CI 检查规则改动，不影响任何运行时接口或返回形状)。

### Fixed — storage.asset.list()/delete() 的同类"全量拉取"问题

> entity.js 游标分页（v1.1.13）落地后顺着"lib 部分还有没有类似问题"查了一遍：`api/library/` 其余几处全量拉取（category/config 的分类与配置项）数据集本身设计上就有界，不算问题；`api/library/process.js` 的 `redis.keys()` 更差但零消费者、是颗没踩上的雷；真正活跃的同类问题在 `api/apps/storage/logic/asset.js`，而且比 entity.js 那个更容易踩上——非 admin 调用方（即普通用户列自己的文件）或任何带 keyword 的调用，都会 `zRange(key,0,-1)` 全量拉取 + 逐条 `Promise.all` 单独 `get`，`delete()` 的 sha256 引用计数检查也是顺序扫全量。

- **`list()` 非 admin/无 keyword 路径**：新增按 owner 与可见性（public/internal）维护的 ZSET 索引（`upload()` 起自动双写），查询时用 `ZUNIONSTORE` 把"自己的 + 对这个调用方可见的"合并到一个临时 key（精确基数当场就是 `total`，无需二次计数），再有界 `ZRANGE ... LIMIT` 取那一页——耗时/内存从跟"仓库总文件数"成正比，变成跟"这个人能看到的量 + 页大小"成正比。**未跑迁移脚本时自动降级回原来的全量扫描**（不是 entity.js 那种直接拒绝——storage 这条是所有非 admin 调用方已经在用的默认路径，硬拒会让升级当场炸；降级只是没提速，结果永远正确）。
- **`list()` 带 keyword 时**：字段值上没有二级索引这一根本限制没变（跟 `library/search.js` 文档写明的"仅适合小数据集"是同一个取舍，这次不解决，本期只按体量分块流式扫描——一次 `MGET` 200 条而不是逐条 `Promise.all`，峰值内存和往返次数不再跟总量成正比，但最坏情况（关键字命中率低）总工作量还是 O(仓库总量)，真正解决要接 RediSearch（`api/library/indexer.js` 已经有，只在 `api/sample/` 里演示过，未接入任何真实服务）。
- **`delete()` 的 sha256 引用计数**：改成 `upload()` 时维护的计数器（`INCR`/`DECR`），O(1) 判断能不能真删字节，不再对每次删除都顺序扫全量找有没有别的记录引用同一份内容。同理，某个 sha256 还没建过计数器（迁移前的存量内容）时**安全降级**回原来的全量扫描，绝不会因为计数器缺失就误删仍被引用的字节。
- 新增迁移脚本 `deploy/migrate-storage-index.js`（一次性、幂等，回填 owner/可见性索引 + sha256 引用计数）；已用真实 Redis 冒烟验证（跨 owner 共享内容的引用计数、缺 visibility 字段的存量行正确归类）。
- 回归：`asset-authz.test.js` 新增 5 个用例（迁移后快路径与降级路径结果一致、跨 owner 引用计数删除、缺计数器的降级删除）；storage 两个 hermetic 测试文件共用的 fake redis 抽到 `tests/utils/fake-redis.js`（此前两处重复维护）。CI 白名单 122 套 / 1928 测试全绿；`autocheck --static` 对 storage 单独跑过，无新增警告。

> 下游 action：**建议但不强制**——不跑迁移脚本，`list()`/`delete()` 行为跟今天完全一样（只是还没提速）；数据量已经大或预计会大的部署，跑一次 `node deploy/migrate-storage-index.js` 即可切到快路径，可反复跑。

### Fixed — `deploy/scaffold/run.sh` 两处启动期资源冲突从"静默接管"改成 fail fast

> 来源：派生项目实测反馈 `docs/feedback/done/redis-port-ownership.md`（overview / trend 同机并跑）。同一种病的两处形态：**启动期检查证明力不够，撞车时静默继续**。只改 scaffold 的 `run.sh`，bundle 与服务代码零改动。

- **Redis 归属校验**（`else` 分支）：原判据 `redis-cli -p $PORT ping` 只能证明"这个端口上有个 redis 在应答"，证明不了它是谁起的。多个 Solo 栈同机并跑、端口撞车时，**后起的栈会静默挂到先起者的实例上**，数据写进人家的 `deploy/redis_data`；换个启动顺序就从另一个目录加载 rdb，上一轮的数据看起来"消失"了（其实还在原目录的 rdb 里）——**不是报错，是数据看着丢了**。而且 `ping` 对 `NOAUTH` 同样返回退出码 0（实测），带密码的别家实例也会被判成 "already running"，随后业务服务报鉴权错误，**看着像密码配错，不像端口撞车**。现在改用 `CONFIG GET dir` 校验归属（一次覆盖"不是我的目录"和"没权限读→返回空"两层），不匹配就打印占用方的绝对路径并 `exit 1`。⚠️ 校验 gate 在本机 host（`127.0.0.1`/`localhost`/`::1`/空）——判据一直只用 `-p`、把 URL 里的 host 丢了，不 gate 会让"用外部 redis"的部署因本地同号端口有人占（如 brew 的 redis-stack 占着 6379）而误报退出。
- **前端端口冲突**（`serve_frontend`）：此前**没有任何端口检查**，而 `serve` 在端口被占时会自己换一个随机端口并报告成功（14.2.4 实测：占住 39117，日志里写的是 `Accepting connections at :51410`；源码是 listen 前 `isPortReachable` 探一下、可达就无条件 `startServer({port:0})`，`--no-port-switching` 只在 arg 表里声明、**代码里从没被消费**，是个死 flag）。叠上 `run.sh` 照旧打印配置的端口、dashboard 的 `lsof` 探到的是占用方的监听 → 三层假绿，前端连续数月没起来过也没人发现。现在 spawn 前 `lsof` 探端口、被占直接 `exit 1` 并报出占用方；spawn 后再确认监听者的 pid 就是我们那个子进程（覆盖竞态和 serve 自己起不来两种情形）。
- 两处的 `x=$(cmd | tail -1)` 都带 `|| true`：`run.sh` 是 `set -euo pipefail`，`lsof` 在端口空闲时返回 1、pipefail 下会让赋值语句直接触发 `set -e`——正常路径反而静默退出（本轮 harness 实测抓到，已修）。
- 验证：`bash -n` 通过；用抽取真实 `run.sh` 代码段的 harness 实跑 7 种情形全对——redis 4 种（本项目实例通过 / 别家目录拒绝 / 带密码无凭证拒绝 / 远端 host 跳过校验）+ 前端 3 种（端口空闲起来且 pid 匹配 / 端口被占 fail fast / serve 二进制缺失 fail fast）。

> 下游 action：**改过 `deploy/run.sh` 的项目要手动 merge**。`upgrade.sh` 的 divergence 检测不会覆盖被定制的 `run.sh`，新 stock 落成 `deploy/run.sh.solo-<ver>.new` 并标 `DIVERGED`（`FORCE_SCRIPTS=1` 才强覆盖）。另：升级后启动会**更严**——本机多栈共用一个 Redis 端口的项目（数据实际写在别家 `redis_data` 里的那种）会在启动时 `exit 1` 而不再静默接管，**先换端口 + 迁数据再升级**；前端端口被别家占着的同理。迁移说明见 `docs/feedback/done/redis-port-ownership.md`「处理结论」。

---

## [v1.1.13] — 2026-07-31

> entity.js 游标分页（大集合有界翻页，opt-in）+ portal 品牌可配置 + permit 编辑器黑屏修复 + 错误日志读序修复 + gateway 出站缺口两轮补齐。全部"只加不破"，CI 白名单 122 套 / 1923 测试全绿。

### Added — entity.js 游标分页（大集合的有界翻页）

- Entity Factory 的默认 `list({limit,offset})` 是 `sMembers` 全量拉取 + `mGet` 全量 + 全量排序后才切片——耗时/内存跟总数据量成正比，跟页大小无关（autocheck 的「内存击穿预警」规则只扫服务自己的 `logic/`，扫不到 `api/library/`，这个反模式一直没被抓出来）。新增 `list({cursor})` 作为**加法式、opt-in** 的替代路径：`create()` 起维护一个按插入序打分（非 `createdAt`——避免同毫秒创建撞分导致翻页边界抖动）的 ZSET，`list({cursor})` 用有界的 `ZRANGE ... BYSCORE REV LIMIT` 只读需要的那一页，不碰无关数据。`cursor: null` 取第一页，之后传上一页返回的 `nextCursor`；**不传 `cursor` 的现有全部调用方零变化**，仍走原来的 offset 路径（未改动一行）。
- **cursor 模式没有 `total`**：keyset 分页天生不知道"共多少页"，硬凑等于又做一次全量计数，违背这个特性存在的意义。UI 要保留"第 X 页共 Y 页"数字分页就用 offset；接受"加载更多"式体验再切 cursor。
- **存量数据需要迁移**：cursor 模式要求排序 ZSET 与旧 SET 索引条目数一致，不一致直接 `INVALID_PARAMS`（不做静默降级到慢路径——那样"cursor 到底有没有真的变快"会完全不可见）。新增一次性、幂等的迁移入口：每个 entity 实例的 `migrateCursorIndex()` 方法，以及可直接跑的 CLI `deploy/migrate-cursor-index.js <serviceName> <entityName> [json]`。全新服务/全新实体不需要迁移（`create()` 已自动双写两个索引）。
- 回归：`entity-cursor-pagination.test.js`（9 用例，真实 Redis）+ 全 CI 白名单 122 套/1923 测试绿（新增两个 Redis 命令依赖后，approval/collection/gateway 等服务的 hermetic fake redis 补了 `incr`/`zAdd`/`zRem`）。

> 下游 action：**运行时无强制**（不传 `cursor` 行为完全不变，`migrateCursorIndex()` 不跑也不影响现有 offset 调用）。**但 hermetic 测试有强制**：`create()`/`delete()` 现在**无条件**双写游标 ZSET（跟调用方传不传 `cursor` 无关），任何手写 fake redis 的服务测试必须补 `incr` / `zAdd` / `zRem`，否则升级后第一次跑测试就是 `TypeError: redis.incr is not a function`——照抄过 `api/sample/tests/item.test.js` 旧版 mock 的项目全部受影响（生产不受影响，真 Redis 什么都有；正因如此只有项目自己的测试能暴露它，升级后务必跑一遍）。要写 cursor 模式的测试还需 `zRange`（注意 REV 下入参是 `(max, min)`）与 `zScore`，对齐新版 sample mock 即可。*（此段 2026-08-06 补正：原文只写「无强制」，trend 升级实测 6 套件/39 测试当场红，见 `docs/feedback/done/patch-upgrade-consumer-gaps.md` §一。）*
> 想在数据量大的实体上用 cursor 分页：① 跑一次 `node deploy/migrate-cursor-index.js <service> <entity>`（RedisJSON 实体加第三个参数 `json`）补历史索引；② 调用侧把 `{limit,offset}` 换成 `{cursor}` 循环取 `nextCursor` 直到为 `null`；③ 若 UI 依赖"第 X 页共 Y 页"，cursor 模式没有这个数字，需要改造成"加载更多"。

### Added — portal 品牌名 / 系统说明可从 `.env` 配置

- system、operator 两个门户的侧边栏标题、登录页标题、登录页"GATEWAY CONFIGURATION"标签不再硬编码 `SYSTEM`/`SOLO`，改读部署时注入的 `window.__SOLO_SYSTEM_NAME__`（源头是 `.env` 的 `SYSTEM_DISPLAY_NAME`，走跟 `__SOLO_ROUTER__` 一样的 `config.js` 运行时注入通道，未配置时显示原文案，行为不变）。多实例同时打开时终于能一眼分清是哪个部署。
- system 门户 Overview 页统计卡片上方新增说明卡片，展示 `SYSTEM_DESCRIPTION`（同一套注入通道），未配置时显示通用兜底文案。
- 下游 action：无（默认值即现行为）。想要自定义，在项目 `.env` 加 `SYSTEM_DISPLAY_NAME` / `SYSTEM_DESCRIPTION` 两行，`run.sh` 部署时自动带上。

### Fixed — permit 编辑器黑屏 + 错误日志读序

- **portal/system `PermitEditorModal` 崩溃**：某用户的 permit 缺 `services` 字段（如 `{allow_all:true}`，绕开 `user.permit.update` 校验的手工/历史数据）时，关闭"Administrator Access"开关会渲染出对 `permit.services` 未加保护的取值，抛 `TypeError`；应用没有任何 React Error Boundary，未捕获异常直接卸载整棵组件树 → 黑屏。已在状态初始化处统一规范化 `services` 字段，堵死所有下游用法。用 headless chromium 复现过"改前必崩、改后不崩"两种状态。
- **`administrator` 的 `admin.log.error` 读序**：`ERROR:QUEUE:*` 只涨不消（`rPush` 无 `LTRIM`/TTL），而默认 `lRange(0, limit-1)` 拿到的是最旧的记录，不是最新的——队列越涨（哪怕只是网络抖动噪音），越新的真实错误越难被默认视图看到。改为从队尾按位置取「最新 N 条」再反转，`listAll` 的跨服务聚合视图也按 `stamp` 重新排序。
- 下游 action：无（两处都是纯行为修复，接口/参数不变）。

### Fixed — gateway 出站通道（详情台账 [`gateway-gaps.md`](./gateway-gaps.md)）

> 2026-07-30 gateway 全量读码审计（19 条缺口）后的首轮补齐：**11 条已修 + 2 条部分**，全部"只加不破"。hermetic CI 白名单 **119 套 / 1882 测试全绿**（gateway 从 2 套 → 5 套）。全程未碰 `api/router/`。

- **🔴 阿里云短信通道此前根本发不出去**（`logic/sms.js`）。旧代码用 `Authorization: AccessKeyId <id>` + JSON body 打 dysmsapi——**这不是任何签名方案**，每条都 4xx；而 `resolveChannel` 一见 key id 就选 aliyun、不降级 mock，**配了真凭证比不配更糟**。现新增 `logic/providers/aliyun-sign.js` 实现 V3 `ACS3-HMAC-SHA256` 头签名（无新依赖、时间/nonce 可注入）。**顺带修掉一个更隐蔽的**：阿里云业务失败是 HTTP 200 + body `Code: 'isv.*'`，旧代码只看 `res.ok` → **失败当成功上报**；现按 `Code` 判定，非限流类标永久错（`httpStatus:400` → 直接 DLQ），限流类留临时错走退避。
- **Twilio 命名变量映射成位置键**：`sms_template` 新增可选 `variableOrder` → `ContentVariables` 生成 `{"1":…,"2":…}`（Twilio 不认命名键）；twilio 通道的 `phone` 要求 E.164，阿里云仍收国内裸号。
- **email api 通道诚实化**：body 形状 = **Resend 兼容**，登记进 `API_PROVIDERS` 适配器表（`EMAIL_API_PROVIDER` 选，未登记的名字 fail-fast）。README 此前写"走 SendGrid / SES"是**假的**——它们 body 形状不同，只改 `EMAIL_API_URL` 不通。
- **脚手架 `.env` 缺 `GATEWAY_SECRET_KEY`** → 下发项目里 `gateway.smtp.create` 直接抛 `not set`、SMTP 账号功能不可用。`init.sh` 现随机生成并写入，同时补全 `SMS_*` 全部注释位。
- **发前校验取代"打了提供商才知道错"**：模版必填字段（create/update 两侧）+ 收件人格式（`to`/`cc`/`bcc`/`replyTo`/`phone`，复用 `library/validate.js` 的 PATTERNS）→ 一律 `-32602`，正好在 notification 的永久错集合里 → **直接 DLQ，不烧 5 次重试**。不完整模版此前是 `undefined.replace is not a function`，现在点名缺哪个字段。
- **`Date.now()` 清零**：gateway 全面改用 `library/clock.js`（这才写得出"冻结时钟断言签名逐字节确定"的测试）；rmbg 的 multipart boundary 改随机（用时间当 boundary 本就会撞）。

### Added — gateway 投递可观测 + 可靠

- **投递台账**（`gateway.delivery.get/list` + `delivery` 实体）。出站此前是**唯一没有可查记录的核心链路**（只有 md5 哈希目录下的本机 WAL 文件）。每次 send 写一行，`deliveryStatus` = `SENT`/`MOCKED`/`FAILED`（**与 Entity Factory 自己的 `status` 分开命名**，避开 `state↔status` 同名陷阱）。写入**尽力而为**：Redis 挂了只丢 `deliveryId`，不把已被提供商收下的投递变成失败。
- **幂等键**（三个 send 的可选 `idempotencyKey`，24h）。镜像 ingress 的入站去重到出站方向：同 key 回放首次结果（`deduplicated:true`）、不重发、不新增台账行；失败会释放 key（否则一次失败把 key 永久锁死）；并发撞同 key 抛**临时**错。**notification worker 已自动带 key** = `notification:{messageId}:{channel}:{解析后收件人}`——含 channel 与收件人是必须的，只按 messageId 去重会把"一条消息命中两条规则发给两个人"的第二条静默吞掉。
- **投递事件**：流 `EVENT:GATEWAY:DELIVERY`，type `gateway.delivery.sent` / `gateway.delivery.mocked`，经 Router `_event` 夹带发出（无 relay、无 bot token、未改 router 代码），`handlers/events.js` 的 `emits` 从空数组变为如实声明。sentinel 现在能对"什么都没真发出去"做反应。**⚠️ 两条限制**：① `_event` 只能搭成功结果 → `DELIVERY_FAILED` 需 gateway 自持 relay token（与附件同一份基建，台账 G8/G13），当下失败可查性由台账兜住；② Router 有事件注册表闸，**生产默认表（`api/router/config.js`）尚未登记 gateway → 生产上这两个事件目前会被拦下**（dev/e2e 已在各自 fixture 放行、真链路已验证）。等一行授权：`'gateway': { 'EVENT:GATEWAY:DELIVERY': ['*'] }`。
- **邮件补 `cc` / `bcc` / `replyTo`**（两条通道都透传）与**模版纯文本正文** `text`（不给则从 html 派生——此前 text/plain 部分塞的是 HTML 源码）。
- **可选严格变量** `GATEWAY_STRICT_VARIABLES=true`：模版变量漏传直接拒发，取代把字面量 `{{code}}` 发给用户。**默认关**（行为不变），带 OTP 的部署建议开。

> 下游 action：无（全部只加不破，默认值即现行为）。**但两件事要知道**：① 若你已配阿里云短信凭证，此前发送其实一直失败，升级后才真正能发——请先用测试号验证；② 想要投递台账/幂等，分别是新方法 `gateway.delivery.*` 与新可选参数 `idempotencyKey`，不改现有调用。

### Added — 第二轮（2026-07-30 下午）：gateway relay 收官 + approval 规则档 + storage 语义 + 硬化

- **gateway `system.gateway` relay bot（一份基建四个收益）**：`deploy/bot-permits.js` 单一真源加 bot（permit：`storage.asset.get/resolve`），dev/e2e 播种自动跟进；gateway 构造 relay + `gateway.token.set/status/clear`（admin，镜像 notification 体例）。落地：① **邮件附件** `attachments:[{assetId,filename?}]`——只接 storage 引用拒裸 base64，relay 取元数据+URL 流式下载，总量 cap 10MB/10 个（`GATEWAY_ATTACH_MAX_*`），坏引用在写台账/占幂等键**之前** fail-fast；② **失败投递事件** `gateway.delivery.failed`（relay `event.emit`，fire-and-forget、不吞原始错误、无 token 退化为仅台账行）；③ **回执回流** `gateway.delivery.update`（SENT→DELIVERED/BOUNCED/COMPLAINED，DELIVERED→迟到退信；MOCKED/FAILED 终态；gateway 不自建流消费循环——provider webhook 经 ingress → 消费者调本方法，三层分工不串味）；④ **通道探针** `gateway.channel.test`（smtp verify / resend GET domains / aliyun 签名 QuerySmsSignList / twilio GET 账号——全只读不真发，失败报告不抛错，无探针的 provider 诚实 `supported:false`）。
- **Router 默认事件注册表登记 gateway**（`api/router/config.js`，**授权改动**）：`'gateway'`（`_event` 夹带 sent/mocked）+ `'system.gateway'`（relay 失败事件）两行，`EVENT:GATEWAY:DELIVERY` 生产可用；e2e/dev fixture 同步（inject-workflows 走 merge 不再重复）。
- **approval 规则档 + record 过期**（BACKLOG "approval 深挖"；m-of-n 与 gate expiry 经复核**早已存在**，此为真缺口补齐）：① `approval.policy.*`（set/delete admin · list/resolve）——`subjectPattern`（精确或尾部 `*` glob，与事件注册表同方言）→ 默认 `requiredSigners`/`expiresInSec`；**显式参数永远赢，策略只补空白**（gate.open 的 requiredSigners 从"签名默认 1"改为 undefined 检测，行为对既有调用方逐字节不变）；② **record 轨过期**：`request` 加可选 `expiresInSec`（≥60，或策略按 target 补），INIT/DISPATCHED 过期惰性翻 `EXPIRED`（终态 fail-closed，verify/confirm/reject 全拒；不设且无策略 = 永不过期 = 历史行为）；③ approval 全面 clock 化（expiry 测试可冻结时间）。hermetic `policy.test.js` 13 用例入 CI；config description 顺手补齐 gate/policy/token 全部方法（原来只列了 record）。
- **storage visibility 语义修复**（wavely 反馈三条全采纳，零行为变更）：GUIDE.md 新增「visibility 保护的是什么」节（RPC 面 vs 字节面、`STORAGE_ACCESS` 两档后果、"只设 visibility 无效"）；`oss/index.js` 注释纠偏（`|| 'private'` 兜底 ≠ 系统默认）+ **启动期告警**（`access=public` 时 warn 一行，unit 测试的 private 配置不受噪音）。处理结论已回写反馈文档。
- **生产硬化**：① **Redis 口令**——scaffold `init.sh` 生成 `REDIS_PASSWORD` 写 `.env`（REDIS_URL 内嵌 + 独立行），`run.sh` 起 redis 带 `--requirepass`、全部 redis-cli 经 `REDISCLI_AUTH`（不用 `-a` 防 ps 泄露）；无密码 .env 保持旧行为（only-add）。② `.env` 补 `CORS_ORIGINS` 注释位。③ **复核纠偏**：CORS（`library/cors.js`）与 `/metrics`（`library/health.js` + 三服务业务 gauge）**早已落地**，toFix §2 相应条目是 stale——BACKLOG §3 生产硬化行已重写。**仍欠一件**：Router token jti 级反重放（Ed25519 确定性签名 + 毫秒 iat → 无 jti 则同毫秒合法并发与窗口内重放不可区分，需 `router/handlers/forward.js` 加一行随机 jti，**待授权**；现有 iat 新鲜度窗口已把重放压到秒级）。

> 下游 action：无（全部只加不破）。**要知道的三件**：① 新项目 `.env` 自带 Redis 口令，旧项目 upgrade 后不自动加（.env 是项目自有文件）——想启用手动补 `REDIS_PASSWORD` + 改 REDIS_URL；② 附件/失败事件需 `RELAY:TOKEN:gateway`（dev `seed-bots.js` 自动，生产照 bot-permits 播种）；③ approval 无既有策略时行为零变化，建策略即生效。

### Docs / Scaffold
- **GUIDE.md 方法引用全部改用全限定名**。交叉核对 13 份 GUIDE.md 引用的方法名 vs 280 个真实声明方法：无编造方法（零漂移），但有 8 处写成了裸 `entity.action` 简写（planner 3 · fulfillment 2 · approval 1 · user 2）——AI 代理照抄去调会吃 `-32601`。已补全为 `{service}.{entity}.{action}`。
- **下游守门 skill `solo-service` 补两节**（`deploy/scaffold/.claude/skills/`，`upgrade.sh` 会 re-template 下发）：
  - **红线新增「Ship a `GUIDE.md`」**——此前 skill 完全没提 guide，下游照它建的服务能过 autocheck 却没有 GUIDE.md，`system.guide { service }` 静默返回 `available:false`。现写明五个 fleet-standard 系统方法、`guide` 只注册不进 introspection 声明、GUIDE.md 写任务配方而非方法签名、冲突时以自省为准、方法名必须全限定。
  - **新增「Deployment layout」推荐约定**——Solo 下发的 `deploy/` 是扁平且 Solo-owned（upgrade 会覆盖）；仓库有多个对外域名时，推荐「一个站点/子系统一个目录、各自带 `deploy/`，反代配置按域名命名」。明确标注是约定、非 autocheck 门禁。

> 下游 action：无 —— `bash deploy/scaffold/upgrade.sh <proj>` 后自动拿到新 skill；已有服务补 GUIDE.md 是建议项（`guide-check` WARN 级，不阻断）。

---

## [v1.1.12] — 2026-07-24

> 观测性 + 自描述面收尾 + 一个静默排序哑雷修复。纯框架内改动,**零 wire 破坏**。CI 绿色子集 116 套(entity/search 直接相关 4 套 112 测试全绿;唯一红点是 `decide.test.js` 的 `liveGemini` 段——本机有 Gemini key 才跑的真实 LLM 调用,输出不确定,与本次无关)。全程不碰 `api/router/`。

### Fixed
- **entity 列表排序对 ISO / 毫秒时间戳混排健壮**(`api/library/entity.js`)。Entity Factory 的 `list`/`multiGet` 默认按 `createdAt` 数字降序,但 storage/user 等服务把 `createdAt` 存成 ISO-8601 字符串 → `(b.createdAt||0)-(a.createdAt||0)` 得 `NaN` → 比较器 no-op → "newest-first" 静默退化成 Redis SET 的无序。新增非抛错的 `toSortableMs()` 归一(数字原样 / ISO 走 `Date.parse` / 缺失或垃圾→0),两处排序改用之;对既有纯数字数据结果逐字节不变。回归:`entity-list-order.test.js` +3 用例(纯 ISO / ISO+毫秒混排 / 垃圾值垫底),5/5 绿。

### Added
- **14 个服务 GUIDE.md 全覆盖**(fleet-standard `guide` 任务配方)。此前只有 agent/storage 有内容文件,其余 11 个服务(user/planner/fulfillment/approval/orchestrator/nexus/notification/administrator/mcp/gateway/ingress)`guide` 方法虽已接线,但无 GUIDE.md → `system.guide {service}` 返回 `available:false`。本次逐个照真实 introspection/logic 补齐(禁编造),外部 AI 代理现可经 `system.guide {service}` 拿到每个服务的跨方法配方 / 幂等键 / 字段约定。
- **autocheck `guide-check` 门禁**(`api/autocheck/static/guide-check.js`,WARN 级)。查两点:`index.js` 接线了 `'guide'` 方法 + 服务根有 `GUIDE.md`。已挂 PostToolUse 钩子 → 新建服务缺 guide 会当场提示。非阻断(warnings→exit 0)。
- **scaffold `upgrade.sh` 破坏性变更横幅**。升级时扫描 CHANGELOG 里比消费者当前版本新的所有条目,把非「无」的 `下游 action` / `BREAKING` 弹成红色 ACTION REQUIRED——补上"覆盖 bundle 是静默的、下游不知道自己还得改代码"这个通知缺口。

### Docs
- Move B(时间戳格式统一到 `clock.now()` 毫秒)登记为 v2 债,见 `BACKLOG.md §3`——破坏性 wire 变更 + 存量迁移,不在 v1.1.x 翻格式。

> 下游 action：无 —— `bash deploy/scaffold/upgrade.sh <proj>` 后自动生效,无需改消费者代码。

---

## [v1.1.11] — 2026-07-23

> AI 自描述面与需求回流(源起 wavely 反馈)。fleet-standard `guide` 方法 + `system.guide` 匿名第一跳 + `system.report` 闭环增强(去重计数 / triage 状态 / Portal AI Reports 页);并含 `_task` fire-and-forget 丢投修复(router 有限重试退避)与 orchestrator `deprecate`/`restore` 生命周期(新增 `DEPRECATED` 状态)。详见 `CLAUDE.md §4` / git tag `v1.1.11`。
>
> 下游 action：无(只加不破)。
>
> ⓘ 本条目为回填——`v1.1.11` 已打 tag 但当时漏写 CHANGELOG。

---

## [v1.1.10] — 2026-07-03

> 新增 MCP adapter（第 14 个服务，workflow-first）+ v2 出版清单拆分拉回两项落地（AI prompt injection 防御第二轮 · Saga durable 补偿 + 重试上限）+ `agent.decide` risk_tolerance 具名容忍度档 + orchestrator 执行轨迹持久化 + 若干治理/收敛项。**全程不碰 `api/router/`**。CI 子集 **114 套 / 1794 测试**绿；相关 e2e（`72-saga-compensation` / `73-saga-recovery`，含新增的持久化重试上限用例）对真实 17 进程全栈跑通 2 套/7 测；`check-doc-drift` / `check-error-codes` / `build` 均通过。

### Added（MCP adapter — workflow-first，2026-07-03）
> 收 `VERSION.v2.md` D 线判定只加不破、拉回 v1.1.x（见下方 Docs 一条）。
- 新增 `api/core/mcp/`，第 14 个服务，端口 8091（`deploy/services.json` / `CLAUDE.md §2` / `api/monolith-entry.js` 已登记）。`POST /mcp` 实现 MCP JSON-RPC 2.0 的 `initialize`/`tools/list`/`tools/call`（+`notifications/initialized`）：`tools/list` 把 `status:'ACTIVE'` 的 orchestrator workflow 映射成 MCP tool（`input_schema` 转标准 JSON Schema），`tools/call` 转发到 `orchestrator.workflow.run`。
- **鉴权**：adapter 自身不持有服务身份、不做鉴权——外部消费方自带窄 bot session token（`user.bot.create/issue.token`，一消费方一 bot，`permit` 显式枚举方法），`/mcp` 把 `Authorization: Bearer` 原样透传给 `relay.callAs(token, method, params)`，Router `checkAccess` 是唯一执行点（与 nexus 给每个 Sentinel 发独立 bot 身份同一机制）。
- **范围**：workflow-first——其余 RPC 方法汇入同一 `tools/list` 出口（能力表）是后续可加项，这轮未做。
- 验证：`core/mcp/tests/tools.test.js`（8 例，schema 转换 + isError 分支）+ 实机冒烟（5 条 `/mcp` 路径）+ autocheck 静态门通过。

### Added（AI prompt injection 防御 · 第二轮 — 基础检测，2026-07-03）
> 收 `VERSION.v2.md` C 线相邻项 + toFix.md"AI 当执行器"条目续作。
- 新增 `api/library/injection-detect.js`：4 类启发式注入话术模式扫描（ignore-instructions / role-override / role-tag-injection / guardrail-override），共享库，非 ingress-only。
- 接入 `ingress/logic/ingest.js` 的 dataSchema 校验管线——declared `type:'string'` 字段过完白名单后再过这层扫描，命中即走既有 dataSchema 违规同一条路径（`review.push()` 进人工审核队列），零新状态机、零新通道。
- 明确不做（这轮）：语义级检测、`data_fetchers` 等非 ingress 注入面、结构化信任标记。
- 验证：`library/tests/injection-detect.test.js`（10 例）+ `ingress/tests/ingest.test.js`（+2 例：命中→422+审核队列；正常自由文本不误报）。

### Added（Saga durable 补偿 — 跨重启续跑 + 重试上限，2026-07-03）
> 收 `VERSION.v2.md` B 线判定只加不破、拉回 v1.1.x（见下方 Docs 一条）。
- `orchestrator/logic/run.js` 新增 `compensationCheckpoint()`：把补偿游标（`compensationProgress`：按 forStep 键控的 `status/attempts/lastError`）持久化到 run 实体，在每次补偿尝试**前后**都写，故进程中途真崩溃也不丢已完成的尝试计数。
- `logic/runner.js` 的 `runCompensations()` 据此改造：已成功的补偿条目直接跳过（不重复调用下游）；`attempts` 达到 `config.worker.compensationMaxAttempts`（新配置，默认 3，跨重启不清零，`RUN_COMPENSATION_MAX_ATTEMPTS` 可覆盖）后标记 `exhausted`、停止自动重试（`compensation.failed` 仍触发既有 DEAD_LETTER 语义），避免"重启→失败→再重启→再失败"的无声循环。`logic/worker.js` 接线跨轮持久化透传。
- **零破坏边界**：无游标时（同步 RPC 路径 / 异步首轮）行为与改造前逐字节一致。
- 验证：`orchestrator/tests/run.test.js`（+2 例）+ 新文件 `compensation-durable.test.js`（5 例，runner 层 + worker/run 全链路层）+ `e2e/suites/73-saga-recovery.e2e.test.js`（新增 1 例，对真实全栈反复模拟"STALLED→`orchestrator.run.retry`"直到 `exhausted`，已跑通）。

### Added（`agent.decide` risk_tolerance 具名容忍度档，2026-07-03）
- `risk_tolerance`（`permissive`/`balanced`/`strict` → 0.6/0.8/0.95，`decide.js` `RISK_TOLERANCE_LEVELS`）替代硬编码 `confidence_threshold=0.6`，按 Gemini/Qwen 实测置信度聚在 1.0/0.9 标定档位；不传时行为与之前完全一致（只加不破）。`nexus context.autorun.risk_tolerance` 透传到 `agent.decide`。
- `governance.md §3` 双轨审批（orchestrator C1 vs approval 服务）方向拍板为方向 2——orchestrator 继续自建 C1，approval 专注非工作流类敏感变更；核实现状其实早已是方向 1+2 混合（HIGH 风险 workflow 走 `approval.gate.*` 多签，collection 退款走 `approval.record.*`），决策不回退既有路由，只管以后不再把 LOW 风险 C1 并入 approval。
- 顺带核实修正 toFix.md 三条陈旧未同步项（approval 消费者数量 / passport 自助注册状态 / workflow ACTIVE 绕过路径不存在）。
- 验证：`agent/tests/decide.test.js`（+4）+ `nexus/tests/context.test.js`（+1）。

### Added（public 面白名单守门，2026-07-03）
- 新增 `autocheck/static/public-surface-check.js`：把已核实、必要的 14 个 `public:true` 方法钉成显式白名单（按服务分），CI static 门逐服务扫描 introspection，出现白名单外的新 `public:true` 方法直接拦停。不改 `api/router/`（`access.js` 本身仍无机制性上限，红线未授权不动）——服务侧等效防线，非根治。

### Fixed（administrator `setting.config.*` in-handler admin 硬门，2026-07-03）
> 收 `coherence-debt.md` #4 政策落地。
- `get/set/del/list/schema` 五个方法加 `if (!p.isAdmin) throw UNAUTHORIZED()`，对齐同文件 `setting.automation.*` 既有写法——运维面方法不再纯靠 Router permit 下发保护。顺带核实澄清 toFix.md"自锁无门"记录为误诊：`admin.self.lock` 早有 in-handler 门，只是实现方式不同（`identity.js` 独立重读 session 校验，比简单透传更强）。

### Fixed（orchestrator 执行轨迹落盘，2026-07-03）
- 新增 `orchestrator/logic/trace-audit.js`（镜像 `ingress/logic/audit.js`）：`runner.js` 每次跑完 workflow 攒出的完整 step trace 此前只在返回值里，从未落盘（DONE 的 run 一点 trace 都留不下）。按天分区 JSONL，写盘前统一过 `redactSensitive`；同步/异步两条执行路径都覆盖；新增 admin RPC `orchestrator.run.trace`。toFix.md"执行轨迹持久化"条目已关；deprecate/reactivate 独立生命周期状态仍需先拍板，故意留着未动。
- 验证：`trace-audit.test.js`（7 例）。顺带修 `tests/utils/harness.js` 的 `LOG_DIR` 隔离（未修前整套 orchestrator 测试会真的往 repo `logs/` 目录写文件）。

### Docs
- `VERSION.v2.md` 六条主线重新过了一遍"能否只加不破"：A 线多租户开放档**已取消**（用 E 线 SOLO Bridge 联邦隔离替代，非拉回）、多机部署硬化拉回；B 线拆分为 `_task` 丢投窄义修法（真 bug，不分版本，**仍未实现，见 P0**）+ Saga durable 补偿（拉回，已实现于本版）+ 完整 at-least-once（降级为可选，仍留 v2）；C 线 autorun 置信判据重设计整体拉回（`risk_tolerance` 是其先行缓解，完整重设计仍未做）；D 线（passport TOTP / SSE / MCP adapter / 外部 agent SDK / metrics 正式档）全部拉回，MCP adapter 已实现于本版，其余未动。`VERSION.md`/`BACKLOG.md` 同步。新增 [`docs/planning/v1-implementation-plan.md`](./v1-implementation-plan.md)：把 toFix.md 剩余项 + v2 拉回项整理成 P0–P5 优先级清单，供后续推进依据（P1 注入检测 + P2 Saga durable 已从该清单勾掉）。

---

## [v1.1.9] — 2026-07-02

> 架构协调性债清理（[`coherence-debt.md`](./coherence-debt.md) #1 缓存写即 bust · #2 bot 权限图单一真源 · #4 服务内 admin 校验误诊澄清 · #5 端口单一真源 CI 守门）+ actor-claim 最小可行档（预审 + 透传 + 审计，AUDIT C4 / confused deputy 最小面闭合）。**#1 功能面修复触及 `api/router/`**（用户明确授权改动，范围仅限缓存 bust）；其余四项全部服务侧 + CI 守门，不碰 router。CI 子集 **110 套 / 1751 测试**绿；全量 e2e 66 套复跑绿；`check-doc-drift` + `check-error-codes` 守门通过。

### Added（actor-claim 最小可行档 — confused deputy 最小面闭合，2026-07-02）
> 收 CLAUDE.md §4 推进顺序第 4 条（预审 + 透传 + 审计，**暂不上服务凭证签名**）/ toFix §二.事件链 confused deputy（major）/ orchestrator AUDIT C4 最小档。**纯 orchestrator 服务侧，不碰 router**；默认行为零变化（只加不破）。
- **问题**：事件路径的 run 在共享 `system.orchestrator` bot 下执行，H6 足迹预审查的是 **bot 的宽 permit**（trivially pass）；信封里的 `actor` 被 matcher 直接丢弃——谁能往被订阅的流 emit，谁就借到 bot 的权限驱动下游动作。
- **透传**：`matcher.js` 把信封 `actor`（引发者）+ `source`（Router 认证发射者）带进 run-command → run 实体新增 `actor`/`actorSource` 字段（永久归属审计）→ runner `$context.trigger_actor`（只读溯源，禁作鉴权输入）；`run.grant` / `run.retry` 恢复路径全程保留（grant 重入队顺带补上此前会丢的 trace/parentEventId）。
- **opt-in 预审**：workflow 新字段 **`require_actor_permit: true`**（默认 `false` = 现状）→ 事件触发的 run 在 H6 之后加查 **actor 本人 permit 是否覆盖全足迹**（`user.permit.get` 同时解析 user/bot uid）。Fail-closed：actor 缺失或不可解析形态（`sentinel:{id}` / `cron:{id}` / `anonymous`）直接 FORBIDDEN；**刻意不走 NeedsGrant**（运营 grant 补 bot 的权限缺口，不能洗白 actor 的）。字段 ACTIVE 期冻结（同 steps/resolvers）、审中改动作废在途签名闸；introspection 声明↔注册同步（workflow doc/create/update + run doc/enqueue）。
- **审计 + 毗邻修复**：ops 通知（needs_grant / run_failed）payload 带 actor；worker 永久拒绝 / 重试耗尽时 **run 实体同步收尾 `DEADLETTER`**——修掉"被拒 run 滞留 RUNNING → stall 扫描 ~10min 后假报 worker died"的既有噪音。
- **验证**：新 hermetic `orchestrator/tests/actor-precheck.test.js`（11 用例：默认关零影响 / 无 claim 拒 / 前缀形态 fail-closed / 足迹缺口 403 列清单 / 覆盖放行 / bot-uid actor 解析 / sync 跳过 / 瞬时故障可重试）入 CI 白名单 + matcher/worker/run/static-workflow-hardening 扩展（透传 / DEADLETTER 收尾 / 字段冻结 / 闸作废）。CI 子集 **110 套 / 1751 测试**绿；全量 e2e 66 套复跑绿；orchestrator autocheck 静态门过。
- **顺修（e2e 既有笔误，非本改动引入）**：`suites/96-full-pipeline` test-2 的状态白名单把 `RUNNING` 写成小写 `'running'`（初始提交 a977856 即如此；run.js 状态机全大写）——轮询一发现 run 文档即 break，500ms tick 落进 run 执行的短窗口就假红（本轮复跑首次抓现行）。改正大小写。
- **剩（跨信任域档，仍暂缓 = AUDIT C4 原判断）**：X-Actor-Claim 签名头、orchestrator 服务凭证、`library/actor-claim.js`。

### Fixed（Router 配置缓存写即 bust — 架构协调性债 #1 功能面，2026-07-01）
> 收 [`coherence-debt.md §1`](./coherence-debt.md)：Router 把 `_tasks` 白名单 / 限流规则缓存在进程内 60s，但 admin 写路径**不 bust 缓存** → "运行时可 RPC 覆盖"最多陈旧 ≤60s / 竞态（§5.6③ flaky 的根因）。**用户明确授权**改 router。
- `router/handlers/tasks.js` + `ratelimit.js`：各加 `invalidate()`（重置 `CACHED_X`/`LAST_FETCH`），导出。
- `router/handlers/system.js`：`updateTaskWhitelist` / `updateRateLimits` 两个 admin 写路径 `redisClient.set(...)` 后各调一次 `invalidate()`（惰性 require 免循环依赖）→ 配置写**立即生效**。
- **最小影响面**：读路径（`getWhitelist`/`getRules`）一字节未动 + 60s TTL 兜底保留（双保险）；触发面仅 admin 低频写 RPC。`events.js` 无运行时写者、不需要改；`agent/logic/model_config.js` 本轮早先已带 bust（样板）。+2 hermetic（`tasks`/`ratelimit`），CI 子集 109 套/1729 绿、全量 e2e 66 套连绿、零回归。
- **剩（v2）**：四处 copy-paste 缓存收敛成共享 `library/cached-config.js`（DRY + 多机 pub/sub bust）—— 纯一致性、无功能缺口，留破坏性窗口。

### Changed（bot 权限图单一真源 — 架构协调性债 #2，2026-07-01）
> 收 [`coherence-debt.md §2`](./coherence-debt.md)：`system.*` relay-bot 的 `uid → permit` 映射历史上**存在两份**（dev 播种 `deploy/seed-bots.js` + e2e mesh 播种 `e2e/harness/setup.js`），靠注释"镜像 seedBots"手工同步——本轮加 `system.user` 就得两处各写一遍，漏一处即漂。
- 新增 [`deploy/bot-permits.js`](../../deploy/bot-permits.js) 导出 `BOT_PERMITS`（纯数据、零依赖），两处 `require` 同一份。**两处 seeding 流程刻意保留不同**（dev 直写 `RELAY:TOKEN:{svc}` / e2e 走 `{svc}.token.set` RPC），只共享 permit 数据。
- **纯重构、零行为变化**：两份 `BOTS` 经比对逐字节相同（8 bot / 同 permit）；`deepStrictEqual` 对齐重构前快照 + 全量 e2e **66/66 套绿**（bot-relay 三链 nexus 投递 / refund 审批门 / orchestrator 审批实际经 `BOT_PERMITS` 播种通过）。未动 `deploy/scaffold/`（下游模板刻意自包含）。不碰 router。

### Added（端口单一真源 CI 守门 — 架构协调性债 #5，2026-07-01）
> 收 [`coherence-debt.md §5`](./coherence-debt.md)：`deploy/services.json` 是端口运行权威，但各服务 `config.js` 的 `portFor(name, fallback)` 兜底靠手工 + 一句 CLAUDE.md 注释保持一致、无机制防漂移（monolith / 单服务 from-source 启动时兜底是**载荷性**的 → 不是死代码）。
- **没走 coherence-debt 原建议的"让 portFor 读 services.json"**——`library/ports.js` 头注明确其零运行时依赖、刻意不读文件（bundle 由 gen-entry 播 `global.__SOLO_PORTS__`），让它 `fs` 读会破坏下游打包。改为**强制而非合并**：`deploy/check-doc-drift.js` 加一段，对 services.json 每个服务断言其 config.js `portFor('name', N)` 兜底 `N === port`。
- **零运行时改动**（不碰 `ports.js` / 任何 config.js / router），纯加 CI 守门。三态验证：干净 PASS、注入漂移（user 8710→8711）被抓、还原 PASS；顺修 `CLAUDE.md §2` stale 注释（"不完全一致"→"CI 守护 === services.json"）。现状 13 服务兜底本就全对齐（此为**防未来漂移**）。

### Docs
- 新增 [`docs/planning/coherence-debt.md`](./coherence-debt.md)：「架构协调性债」清单（7 条"长歪了"的不一致，带 file:line + 归属标注 🔒/➕/💥），从 BACKLOG §3 索引。**已修 #1（缓存写即 bust）+ #2（bot 图单一真源）+ #5（端口单一真源 CI 守门）**。
- coherence-debt **#4（服务内 admin 校验）经核实为误诊、已澄清·保留不动**：原记作"深浅不一/随机的 8 服务"，按方法归类后是一条一致切分——**数据面信 Router `checkAccess`；运维/基础设施面（relay token / control / schedule / dlq / source / sentinel 管理 / 审批门）在 handler 硬 admin 门**。因 Router 只有两档（public / permit-listed），**结构上表达不了"硬 admin-only、不可委派"**，故删掉 in-handler 层 ≠ 清理而是悄悄放松安全（scoped permit 一旦列了该方法即可达）。连 orchestrator（AUDIT.md 里"故意不做 in-handler permit"的样板）都照样硬门其 ops-plane token/control/run，佐证是**一致而非随机**。唯一可选化妆项（低优、留 v2）：introspection 加机读 `tier:'admin'` 标志（与 #7 同族）。

---

## [v1.1.8] — 2026-07-01

> 测试基础设施硬化 + 收敛收尾。全量 e2e 的三个共享-mesh flaky 机制（BACKLOG §5.6 ①poll 超时 / ②`ERROR:QUEUE` 跨套污染 / ③新发现的 Router taskWhitelist 60s 缓存竞态）**结构性清零** —— 连跑两轮 **66 套/349 测试稳定绿**（耗时 ~303s→~117s，不再空耗超时）。附带收尾：passport `otp.request` per-anchor 请求限流、`storage.asset.get/resolve` 转 permit 门控（**公开方法 19→17**）、passport OTP 生产投递接线（`system.user` relay bot），新增 `agent.model.*` admin RPC + 门户 Models 面板（去掉"模型选择只能 redis-cli"）。CI hermetic **109 套/1727 测试**绿；`check-error-codes` + `check-doc-drift` 守门通过；**全程不碰 router**。

### Fixed / Tests（全量 e2e 共享-mesh 隔离硬化 — BACKLOG §5.6 三机制清零，2026-07-01）
> v1.1.7 立项的既有 flaky 全部结构性修复。三个机制均为**共享-mesh 串行**下的隔离缺陷、与产品代码无因果、不在 CI 阻塞门（CI 走 hermetic 白名单)。修完全量 e2e **66 套/349 测试稳定绿**（连跑复现，耗时从 flaky 时的 ~303s 降到 ~117s——不再空耗超时）。
- **§5.6① 最终一致性轮询超时**：根因是 `jest.config.js` `testTimeout`（60s）**小于**套内最长 poll 预算（90s，`suites/54/101/102/103` 的 `pollOrderState`）——满载下 jest 在 poll 跑满预算前先掐死用例。抬 `testTimeout` 60s → **150s**（对齐套内注释早已假定的值；串行 harness 下对通过用例零成本）；顺修 3 处 stale 注释（"120s"→"150s"）。
- **§5.6② 全局 `ERROR:QUEUE` 跨套污染**（真隔离 bug）：`110-governance` 的 workflow 冷却期错误合法入 `ERROR:QUEUE:orchestrator`，后跑的 `93-service-events` 广口 `assertNoErrors` 撞上。修法 = **每套开跑前抓 `ERROR:QUEUE` 长度基线，`assertNoErrors` 只断"本套新增"delta**（`e2e/lib/verify.js` `captureErrorBaseline` + `assertNoErrors` delta；新 `harness/reset-errors.js` setupFilesAfterEnv 每套 beforeAll 刷新）。非破坏性（不清库 → DLQ 告警扫描器语义不变）、不改 ~20 处调用点。
- **§5.6③ Router taskWhitelist 60s 缓存竞态**（本次新发现）：Router `handlers/tasks.js` 把 `_tasks` 白名单在进程内缓存 60s 且**无写时 bust**；5 个 pipeline 套各自把 `WL_KEY` 改写成自己的窄子集 + 还原，值在套边界翻转 → 缓存偶发读到前值、市场 `_task` 被误判 `BLOCKED`（如 `market.order.pay is not allowed`），订单卡 PLACED。修法 = **把白名单固定为一个联合超集**（新 `e2e/lib/whitelist.js` 单一真源），harness 开机播种、5 套（54/101/102/103/104）统一引用 → 值全程不变、缓存永远命中含市场的白名单。（核实无任何套断言 `_task` 被 BLOCKED，故宽超集不掩盖安全测试。）不碰 router。

### Security / Hardening（passport OTP 请求限流 + storage 读收窄 + 生产接线，2026-07-01）
> 承接 v1.1.6/v1.1.7 公开面收敛与 passport 自助的留项（CHANGELOG v1.1.6 §Added 剩余、[`BACKLOG.md §1.4`](./BACKLOG.md)）。
- **`user.passport.otp.request` per-anchor 请求限流**（`api/core/user/logic/passport.js`）：定窗计数（默认 3 次/60s，`PASSPORT_OTP_REQUEST_{MAX,WINDOW_SEC}`）钝化对受害者 anchor 的**投递轰炸** + OTP 窗口 churn；键基于调用方给的 anchor 串（与是否存在无关 → 不破防枚举）；卡死计数器（INCR 后缺 TTL）自修；超预算抛 `RATE_LIMIT_EXCEEDED (-32029)` 带 `retry_after`。放在 closed-gate 之后（禁用 app 不耗额度）。+3 hermetic（`passport-otp.test.js`，15/15）。
- **storage 公开读收窄**（`api/apps/storage/handlers/{introspection,auth}.js`）：`storage.asset.get` / `storage.asset.resolve` 翻 `public:true → false` + 清空服务侧 `publicMethods`。匿名公开资产的既定路径是**独立 `/file/:id` 路由**（自带 visibility 门、302→CDN，不读 RPC `public` 标志），故 RPC 读无合法匿名消费者；对象级授权早已挡匿名读 internal/private，收窄不削弱安全。**公开方法 19 → 17**。`suites/112` 补断言（匿名拒 / admin 抵达 handler → `NOT_FOUND`）；不碰 router。
- **passport OTP 生产投递接线**（`deploy/seed-bots.js` + `e2e/harness/setup.js` 双镜像）：新增 `system.user` relay bot（permit `gateway.email.send`/`gateway.sms.send`）——user 服务的 passport OTP 经 relay 出站发码（user/index.js 早已构造 relay，此前 dormant 因缺 `RELAY:TOKEN:user`）。默认关（issuance=closed）→ 只加不破。

### Added（AI 模型选择 admin RPC + 门户面板 — 去 redis-cli-only，2026-07-01）
> 关掉 [`BACKLOG.md §2 Tier3`](./BACKLOG.md) 的"模型选择只能 `redis-cli`"（`SYSTEM:CONFIG:AI_MODELS` 无 RPC/portal 写路径）。
- **`agent.model.list` / `agent.model.set` / `agent.model.reset`**（`api/core/agent/logic/model_config.js` + introspection ↔ index 同步注册，autocheck --static 过）：per-capability 模型覆盖读/写/清；`set` 校验 capability ∈ 已声明键（挡拼错 key）、写后 bust 进程内缓存 → 立即生效（非 60s TTL 后）；admin-only（`public:false`，Router permit 门）。+8 hermetic（`agent/tests/model-config.test.js`）。
- **门户 Models 面板**（`portal/system/src/pages/Settings/ModelPanel.tsx` + Settings 导航）：per-capability effective/default/override 表 + 就地编辑/Save/Reset，内联反馈（无系统弹窗，遵 CLAUDE.md §8）。portal tsc 绿。

### CI
- CI hermetic 白名单增 3 套（`apps/collection/tests/logic.test.js`、`apps/market/tests/logic.test.js`、`agent/tests/model-config.test.js`；均实跑绿）→ **109 套/1727 测试**。planner 的 logic 走 entity factory（需 RedisJSON fat-mock）、已有 returns-contract + e2e 22/59 冗余覆盖 → 暂缓（[`BACKLOG.md §5.4`](./BACKLOG.md)）。

### Deferred（评估后不做，记录理由）
- **nexus 写侧 §2.5**：`notification.send` 走 Sentinel 自身 token（`relay.callAs`）需给**每个** Sentinel bot 的 permit **加** `notification.send` → 反最小权限，且既有设计明注"投递不计、共享 `system.nexus`"；autorun **结构化产出已做**（走 `agent.decide` 契约，非裸 chat）；tool-call 产出 + nexus 自动发证（需 guard-railed 非-admin `user.bot.*`，安全高危）= v2 尺寸。
- **orchestrator M6 前端冲突提示**：引擎侧乐观 CAS + `expected_version` 已防丢更新（并发编辑得 `Version conflict` 而非静默覆盖），前端仅缺"提示刷新"UX、散落 7+ section 组件、无 CI 运行时覆盖 → 低 ROI，暂缓。

---

## [v1.1.7] — 2026-07-01

> 公开面收敛收官：passport 身份线（device/bot/upgrade）+ 二次收窄 6 法 + `user.profile` 转 permit 门控（tier 改随 `login.verify` 下发）。公开方法从 ~20 收到 19（仅剩有意公开的 `storage.asset.get/resolve` 读路径）。收敛专项 e2e（111/112/113）+ router 契约 40/40 + CI hermetic 106/1697 全绿。全量 e2e 的既有**共享-mesh flaky**（最终一致性轮询超时 + 全局 `ERROR:QUEUE` 跨套污染）经查证**与本次改动无因果、不在 CI 阻塞门**，立项 [`BACKLOG.md §5`](./BACKLOG.md) 待硬化。

### Added（passport 身份线收敛：device → upgrade，权限走 bot account，2026-06-30）
> 落地 [`spec-passport-identity-line.md`](./spec-passport-identity-line.md)：把**匿名 → 访客 → 注册 → 外部**整条身份线收敛到**一套 passport**;权限不再每张 passport 单独配,而是**路由到已配好权限的 bot account**(`role`/`bot` → permit)。纯增量、默认关、不碰 router。
- **Authority 路由**（`api/core/user/logic/passport.js` `resolveAuthority`）：passport 实体可绑 `bot`（bot account id）**或** `role`。bot 路由 = 读 `user:bot:{bot}`.permit（永不 allow_all）+ 注入 `$owner={field:ownerField,value:anchor}` 行隔离 → 不同 passport 绑不同 bot = 不同权限集。fail-closed：解析出的 permit 必须行隔离否则拒签（`-32603`）。
- **device 模式（TOFU，免 OTP）** `user.passport.device.issue`（public）：anchor = 客户端生成的 device id，无 email/手机可发码 → 首次信任直发 deviceToken，路由到 `config.passport.defaultBot`。匿名/访客入口。
- **upgrade** `user.passport.upgrade`（public）：device-anchor → email/手机 anchor，**双重证明**（设备 token + newAnchor OTP），carry `role`/`bot`/`meta` + 记 `upgradedFrom`，退役旧 device passport（吊销其 session）。**匿名→注册不丢身份**;业务行数据 re-own 由应用按 `upgradedFrom` 改 `$owner`。
- **config**：`config.passport` 增 `defaultBot.{default,byApp}`（`PASSPORT_DEFAULT_BOT_BYAPP`）+ `ownerField`（默认 `ownerId`）+ issuance 增 `device` 取值。`verify`/`otpVerify` 改走 `resolveAuthority`（bot 或 role），签名不变。声明↔注册同步（introspection ↔ index）。
- **验证**：e2e `suites/113-passport-identity-line.e2e.test.js`（full profile，**5/5 绿**）——本地写入 bot account 数据(`user.bot.create` seed `system.e2eguestbot` 带 collection permit)：device.issue → verify(会话 permit=bot services + `$owner=deviceAnchor`)→ 调 bot 允许的方法通/不允许的拒 → upgrade(email OTP)→ 新会话仍是同 bot 权限 + `upgradedFrom`、旧 device 退役。hermetic 22/22(passport+otp+introspection 同步)、CI 子集 106 套/1702 绿、doc-drift ✓。
- **留项**：device.issue 的 per-IP 请求级限流（防批量造号，同 otp.request）；mobile/前端接入（匿名 device → 登录 upgrade）。

### Security / Changed（公开面二次收敛，2026-06-30）
> 延续 passport 收敛思路（人人有会话 → 匿名面收窄到登录/健康/发现 + 有意公开的可见性门控读）。审计全部 ~30 个 public method，**收窄 6 个无合法匿名消费者的方法**：
- **5 个 Phase-3**（service introspection `public:true → false`，不碰 router）：`storage.asset.upload`（匿名写关闭——写需带 owner 会话）、`fulfillment.instance.get` / `fulfillment.instance.list`（业务实例读需会话）、`orchestrator.workflow.snapshot`（能力快照需会话）、`agent.providers`（provider 拓扑不对匿名）。
- **1 个 Phase-2**（router `system.js`，**用户明确授权**）：`agent.chat` 翻 `public:false`——关闭匿名 AI 调用（成本/滥用面）。匿名/访客聊天走 **bot account**（机器主体持 token + agent permit，SOLO 既有机制，无需新代码）；mobile 客户端走登录会话。
- **保持公开**（有意）：`storage.asset.get` / `resolve`——服务内按 visibility 门控（`public` 资产 CDN 式可读、`internal`/`private` 抛 FORBIDDEN）；登录/注册/passport/health/discovery 面。
- **验证**：新增 e2e `suites/112-public-method-convergence.e2e.test.js`（每个收窄方法：匿名 → `AUTH_REQUIRED -32001`；admin 会话 → 抵达 handler，非 denial；`agent.chat` 仅验匿名拒以免触 LLM）；回归 storage 21/60 + fulfillment 23/53 + orchestrator 54 + injection 30 全绿（既有调用者本就带 permit/admin token，无 e2e 匿名调 agent.chat）。

### Security / Changed（`user.profile` 收窄 → permit 门控，2026-07-01）
> 收敛面第三步（用户拍板「严格门控」）：`user.profile` 此前 `public:true` = 任何人可凭 uid 拉任意用户全量资料（含 email/categories 等 PII）。翻 `public:false` → 读 profile 需显式 permit（读**他人**需授权，无自读豁免）。纯 core/user + portal 改动，不碰 router。
- **`user.profile` → `public:false`**（`api/core/user/handlers/introspection.js`，Phase-3 capMap；不在 Phase-2 systemApi）：匿名 → `AUTH_REQUIRED`；登录无授权（含读自己）→ 拒；有 `user.profile` permit / admin → 通。
- **tier 随登录下发**（`api/core/user/logic/user.js` `login.verify`）：返回体增 `categories`（tier 轴，`categories.POWER` 门户门禁读它）。语义：调用者**无需** permit 即可读**自己**的 tier——把门户登录门禁从"另调 permit 门控的 user.profile"改为"从登录返回直接读"，否则新 operator（空 permit）读不到自己 tier → 谁都进不了运维台。声明同步（introspection `login.verify` returns 增 `categories`）。
- **门户对齐**（`portal/operator/src/pages/Login.tsx`）：删除登录后单独的 `user.profile` 调用，改从 `verifyRes.categories` 读 `POWER`。system 门户走 `admin.login.verify`，不受影响；`EntityResolver` 的 profile 解析属 operator 工具面（需授权，非登录阻塞路径，未动）。
- **验证**：`suites/112` 增 `user.profile`（匿名拒 / admin 抵达 handler → `USER_NOT_FOUND`）；`suites/00-login` 授予自读 permit 后仍证 token 经 Router 解析会话；`suites/70-operator-tier` 改证新契约（`login.verify` 带 tier；新增 harness `loginOnly` 重登录助手）。full profile 实跑：**00+70+112 = 12/12 绿**，hermetic user 41/41。

---

## [v1.1.6] — 2026-06-30

> passport 自助发证 + 公开面收敛（头条）、UI e2e 框架转阻塞门禁、错误处理统一 + 错误码守门、脚手架契约文档收进 `docs/` + 下游守门 skill、部署瘦身 + 内核移除 @solana。全量 e2e 64/64 + CI 子集 106 套/1702 测试绿。

### Added（passport 自助发证 + 公开面收敛，2026-06-30）
> 落地 [`spec-passport-self-issuance.md`](./spec-passport-self-issuance.md) 第一阶段（core/user，纯增量、默认 closed），并据此**收窄一个公开方法**作为收敛验证。
- **自助 OTP 发证**（`api/core/user/logic/passport.js`）：新增 public 方法 `user.passport.otp.request` / `user.passport.otp.verify`——OTP 证明 anchor 归属 → 服务端生成 deviceToken + 绑 `config.passport.defaultRole`（**永不信客户端 role**）。`register`/`otpVerify` 共用 `_provision()` 公因子。**fail-closed**：`config.passport.issuance` per-app 默认 `closed`（= 现状）；`defaultRole` 必须行隔离（$owner），否则发证拒（`-32603`）。防枚举（存在/新 anchor 响应一致）、OTP 哈希+TTL、错码 `maxAttempts` → anchor 锁定。OTP 经 relay best-effort 投递（user 服务接入 relay）：`email` 走 `gateway.email.send`（自由文本），`sms` 走 `gateway.sms.send` **模板契约** `{phone,templateId,variables:{code,ttl}}`（Aliyun/Twilio 拒自由文本，需 `config.passport.otp.smsTemplateId` + 预建模板，未配则 SMS 空转 fail-soft）；`config.passport.otp.echo`（默认 OFF）仅 dev/test 回显码。
- **公开面收敛**（`api/router/logic/system.js` + `api/apps/storage/handlers/introspection.js`）：`storage.asset.multi` 翻 `public:true → false`（两道 gate：system.js Phase 2 + introspection capMap Phase 3）。匿名调用 → `AUTH_REQUIRED`；自助 passport 会话 → 通。证明"passport 模式 → 人人有会话 → 可收窄匿名暴露面"。
- **测试**：hermetic `core/user/tests/passport-otp.test.js`（12 测试，含 SMS 模板形态 + 无模板空转两条，已入白名单）；e2e `suites/111-passport-self-issuance.e2e.test.js`（7 测试，full profile 实跑绿：otp.request→otp.verify→passport.verify→行隔离会话→storage.asset.multi 匿名拒/会话通→fail-closed）。e2e 套 60（storage-ops，持 `storage:['*']`）回归 5/5 绿。
- **接线**：`harness/setup.js` 给 user 服务注入 `PASSPORT_ISSUANCE_BYAPP`/`PASSPORT_DEFAULT_ROLE_BYAPP`/`PASSPORT_OTP_ECHO`（仅 e2e）。
- **剩余**（留后续，spec §9/§10）：`otp.request` 的 per-anchor/IP **请求级**限流（当前已有错码锁定，缺请求限流）、TOTP 第二档、报头硬化、`agent.chat` 是否收窄（产品决定）。
- passport 在 `core/user`（不受 router 保护）；仅 `system.js` 翻 public 属 router 改动，由用户 `/goal` 明确授权"收缩部分 public method"。

### Added / Tests（UI e2e 测试框架，2026-06-30）
> 对照 `septopus/world` 的 Playwright 做法补强既有 `e2e/ui`（不是从零搭——SOLO 多 portal/RPC 结构本就更全），并把 UI e2e 升为**阻塞**门禁。
- **移植 septopus 模式**：`playwright.config.ts` `webServer` 自起两 portal（mesh opt-in `UI_E2E_BOOT_MESH=1`，`meshup.js` 加 HTTP 就绪端点）；`helpers/rpc.ts` RPC-call 录制器（septopus `serverHits` 模式）+ `tests/system/rpc-surface.spec.ts`（**浏览器层证实 passport 收敛**：匿名不发越权 RPC、登录后每条带 Bearer）；`helpers/portals.ts` page-object + 两 portal 登录 `data-testid` 契约（替代 i18n 脆弱选择器）；`global-setup` state origin + project baseURL 可 env 覆盖。
- **进 CI + 转阻塞**：`meshup.js` 播种 operator-POWER 用户；`ci.yml` `ui-e2e` 跑 system+operator 稳定核（`--grep-invert @quarantine`）**阻塞** + 不稳深流程（`--grep @quarantine`）非阻塞步骤;新增 `ui-e2e-mobile`（route-mock）阻塞;移除 job 级 `continue-on-error`。
- **triage 全部 quarantine（0 产品 bug）**：7 个原隔离 spec 逐个 root-cause + 修复 + 解隔离——NexusHub 路由漂移（`/nexus`→`/nexus/sentinels`）、i18n 漂移（断言中文 vs en portal，顺修 `en.ts` 误混的中文 `revokeTitle`）、operator 空 permit（meshup 播种真实 permit；`nexus.sentinel.create` admin-gated 属正确行为 → setup 改用 admin token）、测试间隐藏依赖 + 选择器/幂等健壮性。clean redis 全量跑 **49 passed / 0 failed**，mobile 9/9。

### Changed / Fixed（错误处理统一 + 错误码覆盖率守门，2026-06-30）
> 15 服务后审计"统一错误处理是否漂移"。结论:客户端可见层无漂移(目录单源、抛错→信封 14 服务逐字一致、router 对下游 503 归一化);漂移只在内部表示层,本批消除。**纯增量/只加不破,bundle 运行时对客户端零变化。**
- **统一「服务未就绪」路径**：12 服务 `if (!Methods)` 守卫从 3 种写法（8 个裸 `{error:string}` / 3 个 `INTERNAL_ERROR` / 1 个自定义）→ 全部 `jsonrpc.error(res, jsonrpc.SERVICE_NOT_READY(), null, 503)`；新增 `SERVICE_NOT_READY`(-32006) 进共享目录。
- **解除 `-32099` 三重撞码**：`UPSTREAM_ERROR`(router) 留 -32099 唯一主；`SERVICE_NOT_READY`(admin→目录) -32006；`RETRY_LATER`(agent) -32007。
- **router 访问拒绝码命名 + 单源**：`-32604`（permission-system.md 文档化的访问拒绝码，**故意区别于 -32005**）从散落 12 处 inline 收敛为 router shim 的 `ACCESS_DENIED()` 助手；`access.js` errorCode + `system.js` 9 处手搓信封改走 helper（行为字节级保留，`access.test.js` 18/18）。
- **中央码表 + CI 守门**：`library/jsonrpc.js` 新增 `CODES` 登记表（全系统 18 在用码唯一真源）；新增 `deploy/check-error-codes.js`（断言每码已登记 + 无未登记撞码，正是当年 -32099 偷偷三重撞的那种 → 现变 CI 红线），接进 static gate。
- 验证：CI 子集 **106 套 / 1702 测试绿**；未碰 router 转发/catch 逻辑。**留项**：router ~38 处手搓信封纯风格归一 + `system.js` `-32000` 兜底，behavior-equiv，未碰（protected）。

### Changed（脚手架）
- **契约文档统一收进 `docs/`。** 脚手架下发的三份 authoring 契约此前散落两处（`api/AUTHORING.{service,events}.md` + `workflows/AUTHORING.md` + `workflows/examples/`），下游没有统一手册入口、`docs/` 还是空的。现合并到项目根 **`docs/`**：`docs/README.md`（手册索引 / 唯一入口）+ `docs/authoring/{service,events,workflows}.md` + `docs/authoring/workflow-examples/`。
  - **`init.sh`**：原 step 6a/6b 合为一个 `docs/` 下发步；初始 git commit 纳入整个 `docs/`（此前 `workflows/` 根本没进初始 commit，属顺带修复）。
  - **`upgrade.sh`**：step 3d 改为整体 re-template `docs/`，并**迁移既存项目**——把旧的 `api/AUTHORING.*.md` + `workflows/`（仅 Solo 自己下发的文件）清掉，团队自加的 workflow 文件保留，目录非空则不删。
  - **`check-doc-drift.js`**（CI 守护）：路径迁到 `docs/`，并扩展为校验整包（README 索引 + service/events/workflows 三份 + ≥1 workflow 示例引擎合法）。
  - **`README.md` / `SETUP.template.md`**：目录图 + 「之后/Next」指引同步到 `docs/`；文档内交叉引用（events↔workflows、service↔events）随之改为同目录相对名。
- 纯文档 / 脚手架交付逻辑增量，对 bundle / 消费者运行时**零 wire 影响**。`v1.1.5` 可平滑升级；升级既存项目（如 wavely）`bash deploy/scaffold/upgrade.sh <proj>` 会自动迁移到 `docs/`。

### Added（脚手架）
- **下游守门 skill `.claude/skills/solo-service/`。** 把可读的契约（`docs/authoring/*`）变成**被执行**的契约：下游仓里的 Claude Code 一旦动 `api/apps/` 即自动发现并触发——列清红线（命名 `{service}.{entity}.{action}` / 声明↔注册同步 / 禁服务直调 / Entity Factory / `clock.js` / bundle·`library/` 不可改 / UI 禁 `window.*`），指回 `docs/authoring/*` + `api/sample/`，并以 **`node api/autocheck/checker.js api/apps/<svc> --static` 硬门禁**收口（`autocheck` 的 40+ 条静态规则正是这些红线的执行体，已随脚手架下发）。此前脚手架给下游下发的 `.claude/` = 0，约束只活在散文里。
  - **`init.sh`**：第 6b 步 copy + 模板化 `.claude/skills/`，并纳入初始 git commit（git-add 增 `.claude/`）。
  - **`upgrade.sh`**：第 3e 步按版本 re-template 这个 skill（Solo 自有；团队自加的其它 `.claude/skills/` 不动）。
  - **`check-doc-drift.js`**（CI 守护）：新增 §6——校验 SKILL.md 存在、frontmatter 完整（`name`+`description`），且仍指向 autocheck 门禁与 `docs/authoring`（防重构把守门 skill 掏空成散文）。
  - **`README.md` / `SETUP.template.md`**：目录图 + 指引同步。

### Fixed / Tests（门禁硬化，2026-06-30）
- **`router/tests/validator.test.js` 真 bug 修复 + 提进白名单**（BACKLOG §5.1）。诊断 = 单常量漂移：测试按 100KB OOM 盾写死阈值（string >102400 / object >204800 即拒），但 `config.js:71` 后来把默认放宽到 5MB（对象 10MB）、没回头改测试 → 两条断言恒 fail（**非运行时 bug**，盾在工作只是更松）。判定 5MB 是有意的分层设计（bodyLimit 50MB → binary 字段 10MB 豁免 → string 5MB 粗盾 → 逐字段上限走 schema `maxLength`），测试是过期那边。**修法 test-only**：require 前钉 `MAX_STRING_LENGTH=102400`、用完立即还原 `process.env`（`--runInBand` 同进程，防泄漏到后续套）。**未碰任何 router 生产逻辑**；套转绿 22/22 并入 `jest.ci.config.js`。CI 子集 100 套/1642 → **101 套/1664**（2026-06-30 实跑绿）。

### Changed / Tests（部署瘦身 + 门禁硬化，2026-06-30）
> BACKLOG §4（部署瘦身）+ §5（门禁硬化）的剩余"只加不破"项。CI 子集 1642 → **105 套 / 1690 测试**（实跑绿）。
- **构建时切片 `--services`**（BACKLOG 4.2）：`deploy/build.sh` 接受 `--services a,b,c`，把 services.json 切到子集喂 `gen-entry.js`，esbuild 只打子集；**默认无参=全量**（只加不破），未知名 fail-fast。切片逻辑独立验证(3/13、坏名报错)，默认路径与原先逐字节相同（未跑完整 esbuild）。
- **清死依赖**（BACKLOG 4.3）：`xlsx/jimp/jsqr/jszip/multer` 全仓零 require → 从 `api/package.json` 删 + `npm install --package-lock-only` 同步 lock。
- **死引用清理**（BACKLOG 4.4）：`package.json "start"` `deploy/launcher.js`(不存在)→`node monolith-entry.js`；`monolith-entry.js` 补齐 nexus/notification/ingress/approval（9→13 服务，数组 + dispatch）。
- **内核彻底移除 `@solana/web3.js`**（BACKLOG 4.1，wire 相关）：库侧 `library/auth.js`+`router-auth.js` 的 `new PublicKey(x).toBytes()` → `bs58.decode(x)`+32-byte 护栏；router 侧（用户授权）`router/handlers/keypair.js` 的 `Keypair.generate/fromSecretKey/.publicKey.toBase58()` → `nacl.sign.keyPair`+`bs58.encode`（**薄包装保留原 Keypair 接口、`getKeypair()` 调用方零改、`.keypair` 64-byte 格式不变、无需密钥轮换**）。3 个用 @solana 造测试向量的库测试同步换 tweetnacl/bs58。**已从 `package.json`+lock 删除**（全仓零 require → esbuild 不再打进 bundle，省该依赖体积）。验签等价：keypair+auth 五套 54 测试绿 + 真实使用冒烟全过（keygen→落盘→router 签→下游验→伪造拒→重载持久化）。
- **门禁提升 hermetic 套**（BACKLOG 5.2）：实跑复核后纳入 `orchestrator/run`(5/5) + `administrator/display`(9/9) + `router/keypair`(2/2)；`router/{system,capability}` 实测 fail、`administrator/identity` 单跑挂 → 保持排除。
- **ingress 行为套**（BACKLOG 5.4）：新增 `core/ingress/tests/ingest.test.js`（10 测试，纯依赖注入、零 redis/disk/net）：ingest.handle 五路径 + emit 信封 + 审计 + testFire + dedup NX。
- **判定/改写**：5.5 长链 e2e 抖动 = **by-design 固有异步延迟**（timeout bump 是正确缓解，不改生产代码）；5.3 脚本式测试改写为"被 `node` 主动调用的有意约定，盲改会破 storage `npm test`+文档，不强改"。
- 唯一 wire 相关是 `library/auth.js`/`router-auth.js`（验签等价、52 测试绿）；其余为 build/test/启动脚本，bundle 默认产物不变。

### Docs / 文档对账（2026-06-29，无 wire 影响）
> v1.1.3–1.1.5 落了一批代码，几处"经核实"文档却没跟上、开始与代码相左。一次性对账（含一次 CI 子集实跑取真实计数）。
- **CLAUDE.md 与代码对齐**：§2 approval「暂无消费者」→ **已双轨接通**（orchestrator `approval.gate.*` + collection 退款门）；§2 orchestrator「审核链未建」→ **已建**（C1 闸门 + H6 footprint 预审 + 按风险路由 approval）；§4「当前在备 v1.1.5」→ **v1.1.5 已发版（2026-06-26）、在备 v1.1.6**；§4「CRITICAL/HIGH 0 修复」歧义 → 澄清为 **0 开放待办**（残项 deferred-by-design）；§6 测试计数「67 套/848」→ **实跑 105 套/1690**（2026-06-30，`REDIS_URL=…6379`；含 validator + §5 提升，见下）。校对基准 2026-06-03 → 06-29。
- **VERSION.md §5.2 发版台账**补全 `v1.1.3/1.1.4/1.1.5` + 标注下一发布点 `v1.1.6`。
- **BACKLOG.md**：§0「封板动作」rc1→v1.1.0 过期文案 → 回写已发版 + 在备 v1.1.6；§3「approval 零消费者」→ 已双轨接通；新增 **§5 测试门禁硬化台账**（validator 真 bug〔已修，见上〕+ hermetic 套提升 + 脚本式测试归位 + 薄覆盖 + 长链 e2e 抖动根因）+ **§6 已知桩台账**（`vector.js` / planner Phase-2 / agent provider 局部）。
- **`api/library/vector.js`**：加显式 `UNIMPLEMENTED STUB` 横幅 + 清掉注释里不存在的 Commodity/CRM 业务服务引用（违反 §1「无业务层」）；`library/README.md` 标注为未实现桩。
- **`jest.ci.config.js`** 头注释「Verified green … 59 suites」→ 105 套/1690；移除指向不存在 `todo.md` 的 NEXT，改指 `BACKLOG.md §5`。
- 纯文档/注释为主 + 一处 test-only 修复（见上），零运行时改动。

---

## [v1.1.5] — 2026-06-26

> **审计驱动的修复 + Saga 可靠性收尾 + 把可靠性能力接进运维控制台。** 一轮 e2e 漂移审计(全 62 套)挖出两个活体缺陷并修复;
> 补齐本会话新代码的 e2e 空白;补上 §7.4 approve 期补偿接口存在性预审;清理一处共享 auth 死代码;
> 并把这一版攒的后端可靠性能力(崩溃重驱 / ops 告警 / Saga 补偿结果)露给 `portal/system` 操作员。
> 全部向后兼容,`v1.1.4` 可平滑升级。**注意**:suite 24 的修复让 full-profile CI e2e 从红转绿。

### Fixed
- **`user.token.refresh` 死方法**:`user/index.js` 取 `context.user?.user`,但 `context.user` 是 caller uid **字符串**
  → `callerUid` 恒 `undefined` → `bot.tokenRefresh` 恒抛 `UNAUTHORIZED`(CLAUDE.md §7 的"把 req.user 当对象"坑)。改为 `context.user`。
- **e2e 漂移 suite 24(approval)**:本会话 `127ba5e` 的"confirm 必须 ≠ 所有 prior actor"规则把老的"ADMIN 同时 verify+confirm"打挂
  → full-profile CI e2e 这条一直红。重写为真 3-distinct 链(applicant/admin-verifier/第三方 confirmer)+ 新增 distinct-confirm 禁令断言。

### Added
- **§7.4 approve 期补偿接口存在性预审**(orchestrator):`approve()` 在分流到任一审批 lane **之前**,把每个步骤方法拿去活的
  能力目录(`system:capability:list`)解析——**补偿步骤方法解析不到即拒批**(`-32602`,fail-closed:补偿失败是 fail-unsafe);
  正向/resolver 方法解析不到只 **warn**;目录不可用则跳过。与 H6 的 permit 覆盖预审正交互补。
- **`EVENT:WORKFLOW:STATUS` 增 `compensation_order`**:失败事件带逆序的"被补偿的正向步骤"列表(可观测 + 可测)。
- **运维控制台接通可靠性面**(`portal/system`,Agent Nexus → Control / Event Bus):这些后端能力此前"有后端、没 UI"。
  ① **崩溃重驱按钮**:STALLED run 一键 `orchestrator.run.retry`(Re-drive / RETRY,带确认说明从头重跑+幂等去重);
  ② **ops 告警收件箱**:读 `notification.inbox.list({targetId:'ops'})` 露出 stall scanner 发的 `ops.run_stalled`(带 hint + committedSteps + Re-drive/Dismiss),此前完全不可见;
  ③ **补偿可视化**:`run.fail` 现在把 Saga 回滚结果(`compensation`)落到 run 实体(worker 透传),FAILED 详情展示逆序回滚表(✓ undone / ✗ failed)。i18n(en+zh),遵循设计系统、无 `window.*` 弹窗。

### Changed / Hardened
- **`library/auth`(M3)**:删 write-only 死状态 `ACTIVE_SESSIONS`(握手 session 从不被 middleware 读)+ 补握手单测
  (`auth-handshake.test.js`,此前零覆盖)。AUDIT.md MEDIUM 回写真相:M1/M6 早已修(stale)、M3 本批修、M2 重定性为 v2(仅多进程 + 需 Router 协议改动)。

### Tests(覆盖硬化 — 审计后补)
- 全 62 套 e2e 漂移审计;补齐本会话新代码的真空白:**Saga 逆序补偿**(72,断 `compensation_order`)、**run.checkpoint/committedSteps**(73)、
  **stall scanner + ops 告警**(73,harness 降 `RUN_STALL_SCAN_MS`)、**gateway mock 成功发送**(63)、**Router `event_id` 去重**(新 suite 94)、
  **§7.4**(hermetic 4 + e2e 52)。`token.refresh` 的空测(suite 55)补强为硬断成功路径(回归锁)。e2e 72 加 `run.compensation` 持久化断言。

### Tooling
- **`.claude/skills/run-portal`(可视化验证 skill)**:一条命令把 `portal/system` 登录态跑起来 + 注入安全演示数据(STALLED/FAILED+补偿 run + ops 告警)+ Playwright 截图,用来眼见 portal UI 改动。auth 绕过靠注入 `session:{token}` + localStorage,演示数据全 `vis-` 前缀终态、活 worker 不碰、`--clean` 即清。仅开发工具,不进 bundle。

### 升级 / Notes
- 行为变更:`user.token.refresh` 修复 + §7.4 新增 approve 校验(opt-in:只对声明 `compensate` 的 workflow 生效,且目录不可用时跳过)+ `run.fail` 多落一个 `compensation` 字段(additive);其余是测试覆盖 + UI + 开发工具。`v1.1.4` 可直接平滑升级。

---

## [v1.1.4] — 2026-06-26

> **脚手架下游契约包。** 修复"消费者要用 `library/`(如 category)却不知道已交付、自己重写走偏"的可发现性缺口：
> 库一直随脚手架 cp 交付，但缺"怎么用"的引擎对齐契约。本版补两份蒸馏指南 + 顶层指引 + 升级同步。纯文档/脚手架增量，对 bundle / 消费者运行时**零 wire 影响**。

### Added
- **`api/AUTHORING.service.md`（service 编写契约）**：怎么写一个 wire 兼容的 SOLO 服务——文件布局、library factory 接线、"加一个实体三处同步"红线、命名 + X-Router-Token 契约、参数/返回约定。
  核心是 **§0/§4「先复用别重写」**：逐字给出把 `library/category` 挂成 `{service}.category.*` 的 4 段模板（`logic/category.js` 一行 + introspection 8 方法 + index 派发 + 两个前置）——直接回答"下游重写了 category"的走偏。
- **`api/AUTHORING.events.md`（事件/触发契约）**：`_event`（事实扇出）vs `_tasks`（副作用派发）vs `relay.call`（同步）三路；`_event` 信封"你给什么/Router 盖什么"；`EVENT:*` 命名 + registry 白名单；四种触发源（sync/event/cron/webhook）到达路径；`handlers/events.js` 声明形；三层重投幂等。
- 两份都**蒸馏自真实代码 + 引擎逐字段对齐**（不是 `docs/protocol/zh/*` 内部草案的拷贝），按 `{{PROJECT_NAME}}`/`{{SOLO_VERSION}}` 模板化，落在消费者 `api/` 根（紧挨 `api/sample`/`api/library`）。验证样板 = `api/sample`（已在 CI static 循环，`logic/category.js` 真挂了 `library/category`）。

### Changed
- **`init.sh`**：拷贝两份契约到 `$NEW_DIR/api/`（模板替换）并纳入初始 git commit。
- **`upgrade.sh`**：新增 step 3d 按版本 re-template 三份 authoring 契约（service + events + workflow）——顺带**修复既存缺口**：此前 `workflows/AUTHORING.md` 升级时根本不同步，v1.0→v1.1 升级后会留旧 workflow 语法。
- **`SETUP.template.md`**：「之后/Next」段从只指 workflow，扩为指向四份下游契约（service/events/workflow + `library/README.md` 库目录），并点明"先复用别重写"+ "以这四份 + 代码为准，非 docs/protocol/zh 草案"。

### Notes
- 对消费者**零运行时影响**：纯文档 + 脚手架交付/升级逻辑；不动 bundle、不动任何服务 wire。`v1.1.3` 可直接平滑升级。
- 升级现有项目（如 wavely）：`bash deploy/scaffold/upgrade.sh <proj>` 即同步进 `api/AUTHORING.*.md` + 刷新 `library/`（含 `category.js`）。

---

## [v1.1.3] — 2026-06-26

> **编排可靠性纵深 + 签名审批门退款 + operator 打磨。** orchestrator 拿到 at-least-once 幂等键、
> Saga 同步补偿、崩溃后幂等重驱三件套；approval 升级为 3 个真签名者的 request→verify→confirm 链
> 守住 collection 退款；operator 一轮净减 723 LOC 的去死代码 + Users 页 + 可视化清单编辑器。
> **版本边界说明**：Saga 自动补偿 + at-least-once 幂等原列 VERSION.md §4（v2），因全部是「只加不破」的
> **per-workflow opt-in 增量**（VERSION §2 早已预告"v2 若做也是 opt-in"），提前落地于 v1.1.x；§2/§4 已回写。

### Added
- **orchestrator · at-least-once 幂等键接线**（前置①）：`runner.run` 现在按 (run, step) 注入稳定
  `idempotency_key`（默认 `wf:{workflowId}:{trigger_id||per-run anchor}:{step.id}`，计算一次、跨重试复用），
  作为 param 透传（SOLO 约定：`collection.payment.record`/fulfillment `_tasks` 从 params 读，校验器忽略 extras）。
  优先级：显式 `params.idempotency_key` > step 的 `idempotency_key` 字段（支持 `$`-token 插值）> 引擎默认。
  引擎只**提供**键，去重仍是下游的事。补上了一个真实的二次提交漏洞（in-step 重试 / 事件重投）。
- **orchestrator · Saga 同步补偿**（README §7）：`ignore_error:false` 的 step 失败时，引擎按**逆序**对每个
  「已提交且声明了 `compensate`」的 step 执行补偿。`compensate` 是 **step-id 引用**——目标是普通 step，
  因而已在 H6 footprint 预审 + 签名审批 digest 内（顺带闭合授权缺口），且自动**排除出正向 pass**。
  补偿走与正向同一执行器（带稳定 `idempotency_key`，重投去重）。补偿本身失败 → `compensation_failed` +
  `EVENT:WORKFLOW:DEAD_LETTER`（绝不静默吞错）。`create()` 校验 compensate 必须是真 step-id、非自指、目标不得再声明 compensate（§7.3 无补偿链）。
- **orchestrator · 崩溃恢复（收尾）**：`run.checkpoint`（每步提交记 `committedSteps` + 刷新 `lastActivity`，
  顺带消除慢 run 被误判 STALLED）+ 新 RPC `orchestrator.run.retry`（admin、仅 STALLED、保留 `triggerId`
  的幂等重驱）。崩溃后「发现（STALLED 告警带 committedSteps）→ 一键重驱」成闭环；重驱靠稳定 `idempotency_key`
  让已提交步骤去重（**从头重驱、依赖下游去重**，非 step-cursor 中途续跑）。
- **approval · 签名 3 层审批链守 collection 退款**（治理线，governance.md §3 方向2）：`approval.record.*`
  接受并验证每阶段可选 Ed25519 签名（`user.key.*`），把证据从 server-attested 升级为 3 个不同 actor 签名的
  request→verify→confirm 链（confirm 强制签名者互不相同；无签名仍回退 server-attested，向后兼容）。
  新增 `collection.payment.refund`：fail-closed 门——仅当存在 targeting 该 payment、携完整 3 阶段链、每阶段
  由 3 个不同 actor 签名的 DONE approval 才放行，经 Router relay（`approval.record.get`）核验，无服务直调。
- **operator portal**：Passport 重建为「Users」页（标准全宽面板 + 只读详情查看器，补上 seed 用户无入口的缺口）；
  system DisplayConfigPanel 可视化清单编辑器（Views 勾选 / 字段表 / 拖拽排序 + JSON 逃生舱，无损往返）；
  Execution Trace 从孤儿页迁入 fulfillment 实例（InstanceTraceModal 按 instance 的 trace id 缝合全链）；
  实体头工具栏整合（字段配置齿轮 + 视图切换 + 搜索/筛选 + Add/归档收成紧凑组）。
- **market `order` 实体 + AML pipeline e2e（示例向）**：`market.order.*`（全 `ai:true` 带 `returns_schema`）+
  e2e suite 101 走「ingress 入账 → fulfillment 推进 → nexus AI 判 AML → 推进订单」全链（放行/拦截/升级三 lane）。
  market 是示例 app 服务（非 services.json 13 之一），对消费者无 wire 影响。

### Fixed
- **collection（payment.refund）**：bogus approvalId 触发 `approval.record.get` 抛 NOT_FOUND 被包成
  `-32603 INTERNAL_ERROR` 污染 `ERROR:QUEUE`；改为把 `-32002`/404 映射为 `FORBIDDEN`（客户端错误不入错误队列）。
- **operator（服务切换）**：`GenericEntityPage` 跨默认服务路由复用，`activeEntity` 切换时残留 → 渲染新服务没有的
  实体（如 PLANNER 显示 SHIPMENT tab）；当前选择对服务无效时重新落首个实体；分页 reset 拆进独立 effect。
- **operator（mock 监听器）**：每 30s 的合成心跳喂一个强制 `amount` 的支付 workflow → 每 30s 产一条 FAILED
  orchestrator run；移除合成心跳，`lastFiredAt` 改反映真实投递。
- **operator（渲染/key bug）**：memo 化 `UIProvider` 的 toast + context value（toast 不再重渲所有 `useUI()` 消费者）；
  process-action 编辑器按 `action.id` 加 key（修「删一行清错字段」）；RJSF Add 模态 Rules-of-Hooks 崩溃；`/config.js` 404 dev stub。

### Docs
- 回写发版状态漂移：CHANGELOG 各版「待发布」→ 实际打 tag 日期；VERSION.md §5 封板流程对齐已发的 `v1.1.0–v1.1.2`。
- VERSION.md §2/§4：把 Saga 自动补偿 + at-least-once 幂等从 v2 出版清单回写为「v1.1.x opt-in 提前落地」；
  orchestrator README §7 跨重启恢复一节按 `run.checkpoint`/`run.retry` 落地状态更新。

### 升级 / Notes
- **全部向后兼容，`v1.1.2` 可平滑升级**：`idempotency_key` 是注入 param（下游忽略 extras）；`compensate` 是
  opt-in（无声明的 workflow 行为不变）；`run.retry`/`checkpoint` 是新增 RPC（introspection 只加不删）；
  `refund` 是新方法；operator 纯前端无 wire；market 是示例 app 无 wire。
- **崩溃恢复语义**：是「STALLED → `run.retry` 从头幂等重驱」，**非 step-cursor 续跑**——非幂等下游的 workflow
  重驱仍可能重复副作用（at-least-once 固有契约，与整机一致，非本版新引入）。详见 orchestrator README §7。
- 验证：CI hermetic 84 套/1132 测试绿；orchestrator static（`run.retry` 声明↔注册同步）+ doc-drift 绿；
  全栈 e2e 新增 suite 71（签名退款 11 例）/72（Saga 补偿）/73（崩溃恢复幂等重驱），均隔离栈跑通。

---

## [v1.1.2] — 2026-06-20

> **返回契约线封闭**:全 14 服务「声明 vs 真实返回」对齐 + 机器可校验 + fulfillment 取数守卫。编排/AI/状态机现在按声明取数,不会再静默拿到 `undefined` 走错分支。

### Added
- **`library/contract.js`(返回契约引擎)**:`returns_schema`(带类型/必填/pattern 的规则项数组)与遗留 `returns`(扁平键名提示)并存;`checkReturn` 子集语义校验真实返回、`lintReturnContract` 良构校验、`checkPickPath` 核验 fulfillment 的 `pick` 点路径。**不动 `api/router/`**(`returns_schema` 是独立新字段,router/capability/manifest 仍只读 `returns`)。
- **全量补齐 `returns_schema`**:234 个方法补上类型化返回声明(条件键标 optional、provider 分歧已标注、裸数组诚实留白),修正 **67 条「声明谎言」**(声明了实际不返回的字段)。纯声明层,无 wire / 行为变更。
- **`fulfillment/logic/lint.js`(profile 链路守卫)**:把 profile `meta_fields[].source.pick` 核到真实跨服务 introspection 索引——挡住 `status`↔`state` 错字段、标量再下钻、未背靠的 condition / params var,杜绝 JsonLogic 静默走错分支。
- **CI 守卫**:14 服务各一套 `returns-contract.test.js`(hermetic)+ 全仓良构扫描 + `ai:true` 覆盖闸 + nexus 回归哨;新增无契约方法 / profile pick 错字段都会红。

### Fixed
- **planner(todo.sync)**:`logic/todo.js` 用了 `jsonrpc.INVALID_PARAMS` 却没 `require` jsonrpc → 命中即 `ReferenceError` 崩溃。补上 import。
- **collection(payment.list)**:声明的过滤参数是 `status`,逻辑层却按 `state` 过滤,导致按状态筛选恒为死过滤(永远命不中)。声明与逻辑统一为 `state`。

### 升级 / Notes
- 行为变更仅限上述两个 bug 修复 + 新增 CI 守卫;`returns_schema` 是新增字段,对现有消费者完全向后兼容,v1.1.1 可直接平滑升级。
- 剩余 ~47 条非阻塞契约债(同族信封不一致 / provider 分歧 / 裸数组 / 整洁度)已登记在 [`return-contract-debt.md`](./return-contract-debt.md),默认进 v2,不阻塞本版。

---

## [v1.1.1] — 2026-06-16

> **热修(hotfix)**:空闲时 orchestrator 事件匹配器空转,把一个 CPU 核烧满。

### Fixed
- **orchestrator(matcher)**:当项目未注册任何「订阅事件的 ACTIVE workflow」时,消费循环在到达**限速的 `xReadGroup BLOCK`** 之前就经 `consumeOnce` 提前返回,使 loop 以事件循环极限速度空转 —— 每秒约 2000 次 `SMEMBERS ORCHESTRATOR:WORKFLOW_INDEX` + `GET ORCHESTRATOR:CONTROL:PAUSED`,稳定吃满一个 CPU 核(实测某下游项目 12h 累计烧掉 ~195min CPU、主机持续发热)。根因:`xReadGroup` 的 `BLOCK` 是该循环唯一的"刹车",而无订阅流时根本走不到它。修复:无订阅流时按 `blockMs` 节流,空闲 orchestrator 每 `blockMs`(默认 5s)一拍而非死转。
- **nexus(stream consumer)**:同类形状的**纵深防御** —— 正常配置下 nexus 始终持有默认生命周期流(`EVENT:WORKFLOW:STATUS/RESULT`),不会空转;但若默认流被配空 / 订阅被全部移除,`consumeOnce` 现也按 `blockMs` 节流,杜绝同款 spin。

### 升级 / Notes
- 若你曾用运行时暂停临时止血(`redis-cli SET ORCHESTRATOR:CONTROL:PAUSED 1`):升级到本版并重启后,记得 `redis-cli DEL ORCHESTRATOR:CONTROL:PAUSED` 恢复自动化 —— 暂停标志可能已被 Redis RDB 持久化,否则 orchestrator 会以暂停态(事件触发/队列不自动跑)启动。
- 行为变更仅限"空闲节流",无 API / 数据 / 协议变化;v1.1.0 可直接平滑升级。

---

## [v1.1.0] — 2026-06-14

> **AI 自动化平台档**:在 v1.0 纯框架底座上做实 AI 自动化 + 治理线。版本边界见 [`VERSION.md`](./VERSION.md)。

### Added
- **治理线**:分层审批(C1 快速档 + approval 多签 + 风险路由 + 冷却期)· 密码加密 Ed25519 签名审批人 · 审批可视化(footprint/订阅/schema/diff,防盲签)· 外部投稿面(窄 bot + 配额 + snapshot 裁剪)。
- **nexus**:Sentinel 事件订阅式 AI 反应体 —— 动态订阅流 / autorun(agent.decide)/ emit-event 动作闭环 / per-Sentinel 身份与最小权限 / 环路·深度刹车。
- **fulfillment**:声明式状态机履约引擎(JsonLogic + `_tasks` + 幂等键 + 事件联动)。
- **生产硬化包**:`library/{cors,health,risk,walarchiver,validate,permit}` · `/health`+`/readyz` 探针 · DLQ 告警 · Redis 硬化。
- **脚手架**:`seed-registry`(服务注册)· `e2e`(API jest)+ `e2e/ui`(Playwright operator)分发 · operator 源码下发 · `SETUP.template`。
- **client/mobile**:语音输入(Qwen ASR)· 读 auto-run · STM/LTM 记忆;route-mocked e2e(view-list / memory / focus-card)。

### Fixed
- **build**:`esbuild --external:proxy-agent`(storage 入 bundle 后构建断裂)。
- **scaffold**:服务注册缺失致开箱 `-32601`;`SETUP.md` 模板缺失且被自身 `.gitignore` 误伤。

### 兼容 / Notes
- 本版假设:**单信任域 + 单机部署**(多机硬化 = v2)。
- 升级:[`../runbook/upgrade-v1.0-to-v1.1.md`](../runbook/upgrade-v1.0-to-v1.1.md)(重点:seed-registry / redis-stack / 破坏点排查)。

---

## [v1.0.0]

纯框架底座:统一网关 · 实体工厂 · 权限 · 审计 · 工作流编排 · AI 能力收敛。消费者首版基线。
