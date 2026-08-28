# 提案：部署面「体检」开箱即用 —— SOLO 该自带检查自己不变量的能力，而不是指望通用监控

> 来源：runner 会话，2026-08-28。用户在 N100 孤儿进程事故（另见
> `bundle-require-boots-full-fleet.md`）后提出：是否该有一个部署服务器的监控功能，
> 由 SOLO 集成、开箱即用。本文是对这个问题的展开与取舍建议。
> 依据分类：
> - **本次实测**：N100 五个栈（runner/overview/colony/trend/steward）systemd unit
>   全绿、四个 Router `ping` 全 ok——同一时刻机器上有一个烧了 3 天 5 小时 100% CPU、
>   与 steward 共享生产 Redis 的孤儿 bundle 进程。现有的全部「健康信号」对它零感知。
> - **引用（跨项目运维记录，非本次实测）**：同型事故此前至少四起——
>   ① overview 两个前端端口被静默挤占、几个月没真正起来过（2026-07-29 发现）；
>   ② runner operator portal 3600 被 2026-08-01 遗留的孤儿 `serve` 占住，
>   此后每次重启静默漂到随机端口半个月（52794/53018/…）；
>   ③ steward 迁移后线上「剧本消失」——代码 md5 一致、方法目录齐全，
>   唯独数据不在，表象指向插件坏了（2026-08-25）；
>   ④ 部署后 tag / package.json / 线上 ping version 三处不对齐反复发生，
>   已成为派生项目 CLAUDE.md 里的固定校验条款。
>
> 一句话：这些事故的共性是**都发生在「栈自己报 ok」的视野之外**——孤儿进程在 unit
> 外面、端口漂移在「声明 vs 实际绑定」的落差里、版本漂移在「仓库 vs 产物 vs 线上」的
> 落差里。这些落差全是 SOLO 自己的契约，通用监控工具（netdata/node_exporter）
> 根本不知道该查什么；反过来，CPU/内存曲线那种通用监控 SOLO 也不该重造。

---

## 一、要做什么：一个 `doctor` 入口，查五类 SOLO 专属不变量

形态建议：`deploy/doctor.sh`（或 Router 方法 `system.doctor`），scaffold 自带、
零配置可跑，输出逐项 ✓/✗ 与一行修复指引。检查项按历史事故排：

1. **端口归属**：`BUILT_IN_DEFAULTS` + 本栈 `.env` 声明的每个端口，趴着的进程
   是否属于本栈（pgid / systemd unit 归属核对）。——当场能抓出本次的孤儿 bundle、
   2026-08-01 的孤儿 `serve` 这一类「不属于任何栈但占着 SOLO 端口」的东西。
2. **声明 vs 实际绑定**：每个服务/前端声明的端口是否真的在监听、监听者是不是
   本栈进程。`fe_confirm_bound` 已为前端做了这件事（v1.1.14），泛化到服务端口
   并收进同一入口。——覆盖 overview 前端静默漂移那型。
3. **版本三处对齐**：bundle 文件名版本 vs `package.json.version` vs 线上 `ping`
   返回的 version。——把派生项目手工执行的固定条款变成一条命令。
4. **Redis 归属与认证**：v1.1.14 已有的 `CONFIG GET dir` 归属检查、requirepass
   是否生效，收进同一入口；顺带报 key 前缀分布摘要（`SERVICE:*` 计数）——
   steward「数据没跟着代码走」那型事故的判据（`--scan --pattern`）就地给出。
5. **宿主一行摘要**：load / 磁盘 / 内存可用，超阈值标黄。只此一行，
   不做曲线、不做告警——那是通用监控的领域。

## 二、配套：`ping` 返回丰富化

Router `ping` 现在只回 `{status, service}`。加上 `version` / `pid` / `uptime`
三个字段，第 3 项的「三处对齐」就完全可脚本化，跨机核对不再需要登录目标机。
（runner 的本机 agent `/ping` 已实践 `agent/version/authed` 三字段判活，模式可抄。）

## 三、明确不做什么（这个提案的边界）

- **不做通用指标监控**：CPU/内存历史曲线、告警通道、面板——netdata/node_exporter/
  systemd 已有生态，SOLO 重造是负资产。SOLO 的独特价值在「知道自己的契约」。
- **不做常驻 agent**：doctor 是按需执行的一条命令（部署后、排查时、或由派生项目
  自己的循环定期调），不引入新的常驻进程——否则监控本身成为下一个要被监控的东西。
- **不替代派生项目的业务监控**：overview 的采集健康、trend 的面板是业务层，
  doctor 只管框架层不变量。

## 四、为什么值得做（成本已经付过一遍了）

上面每一条检查项都对应一次真实排查：孤儿进程查了一轮 `ps`/`ss`/`cgroup`，
端口漂移当年查了几个月才发现，版本对齐写进了每个项目的规矩，数据归属那次
从「插件坏了」一路排到 Redis key 桶。**排查路径都已经趟出来了，doctor 只是把
这些路径固化成命令**——边际成本低，而每一项的第二次发生都在等着它。

---

## 处理结论（solo 侧）

**采纳，2026-08-28 落地为 `deploy/scaffold/doctor.sh`**（init.sh 新脚手架自带 + chmod，
upgrade.sh 进三方对比下发清单；零配置、只读、跑完即走，退出码 0 = 无 ✗）。
五项检查全部实现，与提案的对应：

1. **端口归属** + 2. **声明 vs 实际绑定** → §2 合并做：solo-services.json +
   services.json + .env 前端口（PORTAL_*/CLIENT_*/FRONTEND_*_PORT）逐个核对
   「有没有人听、听的人 cmdline 是否在本项目根下」；栈未运行时降级为 note 不误报。
   实测能当场揪出外来占用（报 pid + 命令行 + 处置指引）。
3. **版本对齐** → §1：`.solo-version` ↔ bundle 文件在位 ↔ api/publish 里最新版本 ↔
   **运行中进程 cmdline 里的版本**（比经 HTTP 问更直接，栈死了也能查）；项目自身
   tag ↔ package.json 只 warn 不定罪（不是每个项目都打 tag）。
4. **Redis 归属与认证** → §4：ping / requirepass 生效性（配了密码但裸连也通 = ✗）/
   `CONFIG GET dir` 归属（与 run.sh v1.1.14 同判据）/ key 前缀分布 top8——steward
   「数据没跟着代码走」的判据就地给出；>80 万 key 自动跳过扫描。
5. **宿主一行** → §5：load / 磁盘 / 内存一行 + 最吃 CPU 进程 ≥90% 标黄。不做曲线、
   不做告警、无常驻——提案的三条边界照单全收。

提案之外补了一节（事故里反复出现但五项没显式覆盖）：**§3 全机 solo bundle 进程清单**
——凡「可执行文件是 node 且 cmdline 含 api/publish/solo.」的进程逐个列出（本栈/别家栈、
CPU、存活时长）；同根 >1 个 = ✗ 孤儿，CPU ≥90% = ⚠ 空转嫌疑。N100 那条
`node -e 'require(bundle)'` 恰好被两个条件同时命中。

**配套 ping 丰富化——落在 HTTP `/health`，不动 router**：`api/library/health.js` 的
`/health` 本就返回 version，本次补 `pid` + `uptime`，全部 14 服务（含 router）经共享库
自动获得；router 端口对外暴露，跨机核对用 `GET <router>/health` 即可。反馈原文提的
JSON-RPC `ping` 方法丰富化要改 `api/router/`（保护区），判定不必要——HTTP 面已覆盖
同一需求；将来确要 RPC 面再按 router 修改保护流程另行审批。

不做：solo 仓库自身（dev.sh 源码栈）不适用此脚本，不另做一份——doctor 的对象是
scaffold 部署形态。

验证（2026-08-28）：`bash -n` + `env -i bash -n`（locale 陷阱）双过；假 consumer 栈
实测四条路径——栈停（全 note 不误报）/ 栈起（版本、端口、归属全 ✓）/ 外来进程占
声明端口（✗ + pid 点名）/ Redis 归属不符（✗ + 同 run.sh 文案）——输出与退出码全部正确。
兄弟反馈 `bundle-require-boots-full-fleet.md` 的入口守卫同日落地，两者合起来是
「不再产生孤儿」+「已有孤儿当场可见」。
