# 反馈：require bundle 即启动整个舰队 —— 入口无守卫，`SOLO_SERVICES_JSON` 缺省时全服务上默认端口

> 来源：runner 会话，2026-08-28 排查 N100 负载异常时发现。肇事进程是 2026-08-25
> steward 迁移会话留下的一条调试命令：
> `node -e 'const b = require("./api/publish/solo.v1.2.1.js"); console.log("bundle 导出:", …)'`
> ——本意只是看一眼 bundle 导出什么，结果它活了三天。
> 依据分类：
> - **N100 线上实测**：孤儿进程 100% CPU 连续 3 天 5 小时（`ps` 的 pcpu 是生命周期均值，
>   3d5h 均值 100% = 几乎从头烧到尾）；仅监听 8730（agent）；归属已消亡的
>   ssh session scope（session-1491），不属任何 systemd unit；cwd = `/home/web/AI/steward`。
> - **本机实测复现**（2026-08-28，release/solo.v1.2.1.js，空目录 cwd）：
>   裸 require → **14 个 TCP 监听端口**（8020/8030/8040/8050/8060/8070/8091/8600/8680/
>   8710/8730/8740/8750/8820）全部起来。
> - **100% CPU 空转的具体根因未确证**（见第三节，进程按用户指示先清理了，没来得及采样
>   调用栈）；已用本机复现**排除**两个候选条件。
> 涉及：`deploy/gen-entry.js`（生成的 `_entry.js` 即 bundle 顶层）、`deploy/services.json`
> （默认端口表）。
>
> 一句话：`require(bundle)` 没有任何守卫，顶层直接遍历 factory 启动服务；
> `SOLO_SERVICES_JSON` 缺省时的行为是「warn 一行然后**全量启动 14 个服务上默认端口**」
> ——一条 introspection 调试命令因此变成了一个共享生产 Redis 的影子栈。

---

## 一、实测现象：三层危害递进

1. **require 即启动**。`gen-entry.js` 生成的入口在模块顶层执行
   `for (const s of cfg) { factory() }`（gen-entry.js:120-127），没有
   `require.main === module` 一类的守卫。任何想「看看 bundle 导出什么」的工具
   （调试一行命令、REPL、未来的自动化检查）都必然把服务起起来。

2. **缺省 = 全量默认端口**。`SOLO_SERVICES_JSON` 未设置时只 `console.warn` 一行，
   然后按 `BUILT_IN_DEFAULTS` 全量启动（gen-entry.js:88-91）。本机实测 14 个监听。
   默认端口表里 **router = 8600**（services.json），与 runner 派生项目的生产 Router
   端口相同——N100 那次孤儿的 router 没抢到 8600 只是因为 runner.service 先起、
   端口已占；**若三天窗口内 runner.service 重启过，孤儿会先抢到 8600，
   生产 Router 被静默黑洞**（Solo 的端口占用是绑定失败方静默，另见第 3 条）。

3. **绑定失败零声响 + dotenv 吸入 cwd 的 `.env`**。N100 上 14 个服务只有 agent(8730)
   在监听——其余 13 个撞上已占用端口后**静默消失**，进程整体不退出、不报错，
   外表就是「一个安静的 node 进程」。同时各服务 config.js 里的 `dotenv.config()`
   从 cwd（当时是 steward 项目目录）吸入了生产 `.env`——包括 `REDIS_URL`。
   ⇒ 这个调试进程实际成为**共享 steward 生产 Redis 的第二个消费者**
   （同一批 WAL 流 / 队列 / consumer group），与正式栈并行跑了三天。

## 二、根因引用

- `deploy/gen-entry.js:120-127` —— 顶层 `factory()` 循环，无 require 守卫。
- `deploy/gen-entry.js:88-91` —— `SOLO_SERVICES_JSON` 缺省 → warn + 全量默认端口。
- `deploy/services.json` —— 默认端口表，与派生项目生产端口有真实重叠（8600）。
- 行为在 v1.2.1 release 产物中实测一致（本机复现即用该文件）。

## 三、100% CPU 的空转源：未确证，已排除两个条件

本机复现刻意逼近 N100 条件做了两轮：

| 条件 | 结果 |
|---|---|
| 裸 require，默认 Redis 端口（6699）无监听 | 重连退避正常，CPU ~0.6%，**不空转** |
| 起一个空 redis 在 6699 再 require | 28 秒仅耗 0.63s CPU，**不空转** |

⇒ 空转不是「连不上 Redis 的裸重试」也不是「连上空库轮询」。剩下的合理怀疑指向
N100 独有的条件：**与正式栈共享同一个有真实数据的 Redis**（双消费者争抢同一
consumer group、或某条毒消息/毒任务被即时重试）——**此为推测，未实测确证**。
若 solo 侧 triage 想复现，方向是：两个 bundle 进程挂同一个非空 Redis 的同名流。

## 四、建议（按价值排序）

1. **缺省时 fail fast，不要全量启动**：`SOLO_SERVICES_JSON` 未设置 →
   `console.error` + `process.exit(1)`；「dev 模式全量起」的便利留给显式开关
   （如 `SOLO_START_ALL=1`）。与已处理的
   `done/inherited-router-url-silent-misdelivery.md` 是同一防御哲学的下一步：
   环境变量缺省不应触发「安静地起一支舰队」这个量级的动作。
2. **把「导出」与「启动」分开**：entry 改为 `module.exports = { REGISTRY, start }`，
   仅 `require.main === module`（或显式调 `start()`）才执行 factory 循环。
   兼容性无破坏：派生项目 run.sh 都是 `node solo.js` 直接跑，`require.main` 成立；
   而 introspection（调试、autocheck、未来的 doctor 工具）从此有了无副作用的路径。
3. **服务端口绑定失败要有声响**：13/14 个服务静默消失是本次「外表无害」的关键。
   前端口已有 `fe_assert_port_free`/`fe_confirm_bound`（v1.1.14 上收），
   同样的 fail-fast 哲学适用于服务端口：绑定失败至少 error 日志，
   全军覆没过半时进程该直接退出。

---

## 处理结论（solo 侧）

**三条建议全部采纳，2026-08-28 落地（`deploy/gen-entry.js` 生成的入口整体重构）。**
核实过程中发现了一层比反馈判断更深的根因，先记它：

**「静默消失」其实是「谎报成功」——吞错点是 Express 5，不是 router。**
Express 5 的 `app.listen` 把成功回调**同时**注册成 server 的 error 处理器
（express 5.2.1 `lib/application.js`：`server.once('error', done)`）。EADDRINUSE 时：
① 错误被这个监听消费，永远到不了 `uncaughtException`（router 的全局 handler 只是
无关旁观者，本反馈第一节把它当吞错点的推断不成立——单服务进程同样吞）；
② 成功回调被以 `done(err)` 调起，而所有服务的回调都不看参数，于是**照常打出
「Service running on port X」**。本机实测：回调触发、`server.address() === null`、
全程无一处报错。N100 那 13 个服务不是安静消失，是逐个打印了成功日志。

三条建议的落法：

1. **缺省 fail fast** ✅ —— `SOLO_SERVICES_JSON` 未设置 → error + `exit 1`；
   全量默认端口的 dev 便利改为显式 `SOLO_START_ALL=1`。扫过仓库：没有任何脚本
   依赖旧缺省（dev.sh 走源码路径、scaffold run.sh 始终显式传入），零破坏。
2. **导出与启动分离** ✅ —— 入口导出 `{ REGISTRY, BUILT_IN_DEFAULTS, start }`，
   仅当 bundle 是进程入口才自动 `start()`（判据用 `require.main.filename ===
   __filename` 而非 `require.main === module`，esbuild 内联层下实测成立）。
   `require(bundle)` 现在零副作用（实测：0 监听、进程自然退出）。
3. **绑定失败有声响** ✅ —— 因上述根因，落点在 net 层：入口起服务前包装
   `net.Server.prototype.listen`，逐 server 挂 error 监听。EADDRINUSE 点名服务 +
   端口 + 排查命令；失败过半（`bindFailed×2 > cfg.length`）进程退出；非绑定类
   错误在无其他监听者时异步重抛，保持原崩溃语义。

验证（全部本机实测,2026-08-28）：缺省拒绝 exit 1 / `SOLO_START_ALL=1` 起满 14 监听 /
双实例并跑第二个 8/14 点名后退出 / `require()` 拿到导出且零监听 / `SOLO_SERVICES_JSON`
子集正常——五档全过；完整 `deploy/build.sh`（含 precheck）+ jest CI 白名单 130 套全绿。

未复现：第三节的 100% CPU 空转根因。修复后 require 路径不再起服务，该场景已不存在；
「双 bundle 挂同一非空 Redis」的猜想留此存档，再露头再追。

配套的体检工具（部署后怎么发现这类孤儿）见同目录
[`deploy-doctor-out-of-the-box.md`](./deploy-doctor-out-of-the-box.md)。
