# 反馈：`run.sh` 用 `redis-cli ping` 当"我的 Redis 在跑"的判据，端口撞车会静默接管别家实例

> 来源：overview / trend 两个派生栈同机并跑，2026-08-05 发现。
> 场景：本机同时跑 5+ 个 Solo 栈（ladder · overview · runner · trend · wavely · finance），
> 各自 `.env` 独立且 gitignore，端口分配没有全局视角。
> 依据：全部为本机实测（非推演），复现命令与响应见第一、三节。
> 涉及：`deploy/scaffold/run.sh`（反馈提交时的 `:157`，当时 main 在 tag v1.1.13 之后；
> 派生项目 `deploy/run.sh` 同段）。
>
> **状态：已上收**（2026-08-05，见「处理结论」）。上游 triage 时复核了全部实测项，
> 其中两条结论被证伪并已在正文改正（§二末段的「带密码会硬失败」、§六第 1 条的
> 「只打一行 warn」），改正处标了「triage 复核」。

## 一、实测现象：一个实例，两家的数据，落在其中一家的目录里

overview 与 trend 的 `.env` 都声明了 6381（trend 用 `/2` 分库）：

```
overview/.env   REDIS_URL=redis://127.0.0.1:6381
trend/.env      REDIS_URL=redis://127.0.0.1:6381/2
```

两个栈都起着，本机只有**一个** 6381 实例：

```
$ redis-cli -p 6381 config get dir
/Users/fuu/Desktop/AI/overview/deploy/redis_data     ← overview 起的

$ redis-cli -p 6381 -n 0 dbsize     → 68      (overview)
$ redis-cli -p 6381 -n 2 dbsize     → 2226    (trend)

$ ls trend/deploy/redis_data/
ls: 不存在                                            ← trend 从未起过自己的实例
```

**trend 的 2226 个键、3.7MB 数据，全部持久化在 overview 仓库的 `dump.rdb` 里。**
trend 的 `run.sh` 从头到尾没报过一句警告——它认为"Redis 已经在跑了"。

## 二、根因：`ping` 的退出码只能证明"这个端口上有个 redis 进程"

`deploy/scaffold/run.sh:157`：

```bash
if ! redis-cli -p "$REDIS_PORT" ping &>/dev/null 2>&1; then
    ...启动自己的实例（--dir "$SCRIPT_DIR/redis_data"）...
    REDIS_STARTED_BY_US=1
else
    log_info "Redis already running on port $REDIS_PORT"    # ← 直接拿来用
fi
```

这个判据缺两层校验：

**(1) 不校验归属。** 端口上应答的实例可能是任何一个派生栈起的，`--dir` 指向的是
**它**的 `deploy/redis_data`。后起的栈把数据写进先起者的目录，且这件事**取决于启动顺序**——
换个顺序重启，新实例从另一个目录加载 rdb，上一轮的数据就"消失"了（其实还在原目录的
rdb 里）。这是最阴的形态：不是报错，是数据看起来丢了。

**(2) 不校验鉴权——`redis-cli ping` 对 `NOAUTH` 也返回退出码 0。** 实测：

```
$ redis-cli -p 6382 ping          # 6382 是另一个栈的实例，配了 requirepass
NOAUTH Authentication required.
$ echo $?
0                                  ← 退出码 0，if 分支判定为"已在跑"
```

所以带密码的项目撞上别家实例时，`run.sh` 同样判定"already running"，随后业务服务
连接失败，报出来的是鉴权错误——**看起来像密码配错，不像端口撞车**。

顺带说明：`REDIS_STARTED_BY_US` 的保护是单向且正确的（cleanup 不会误杀别人的实例），
但反过来没有保护——**先起的那家 Ctrl+C 时会 `shutdown nosave`，把后挂上来的那家一起带走**；
同理任何一方 `FLUSHALL` 都是跨项目连坐。

**为什么潜伏得久**（⚠️ triage 复核后改正）：原稿写「只有被占实例带密码、自己不带时才会
硬失败（自己去启动 → `Address already in use` → 循环 20 次后 `log_error` 退出）」——**这条
是错的**，与本节 (2) 自相矛盾：`ping` 对 NOAUTH 返回 0，脚本永远进 `else` 分支，压根不会
去启动自己的实例。带密码撞车的真实症状就是 (2) 描述的那个：静默接管 + 业务侧鉴权失败。

正确的结论是：**redis 撞 redis 一律静默，不分有无密码**——比原稿说的更普遍，不存在"专挑
dev 配置"。真正会走到 `Address already in use` 硬失败的只有「端口上根本不是 redis」，
因为那时 `ping` 的退出码才非零（实测）：

```
$ redis-cli -p <某个 http 端口> ping   → Error: Protocol error, got "H" as reply type byte   exit=1
$ redis-cli -p <空端口> ping            → Could not connect ... Connection refused            exit=1
```

## 三、建议 1（主要）：`else` 分支加归属校验，把静默接管变成启动即报错

判据用 `CONFIG GET dir`——它同时覆盖上面两层：不是我的目录 → 不匹配；没有权限 →
返回空/错误文本 → 同样不匹配。实测三种情形都判对：

```
$ redis-cli -p 6382 config get dir                          # 有密码，无凭证
(空)                                                          → 判定"不是我的" ✔
$ REDISCLI_AUTH=<pass> redis-cli -p 6382 config get dir      # 有密码，带凭证
/Users/fuu/Desktop/AI/finance/deploy/redis_data              → 判定归属 ✔
$ REDISCLI_AUTH=<pass> redis-cli -p 6381 config get dir      # 无密码实例，多余凭证
/Users/fuu/Desktop/AI/overview/deploy/redis_data             → 判定归属 ✔
```

报错信息里直接给出**占用方的绝对路径**，一眼能看出是哪个项目——比"连接失败"有用得多。

**已落地的版本**（`run.sh:196` 起的 `else` 分支）在原稿补丁之上多了两处，都是 triage 时
实测补的：

1. **只对本机实例校验**（`case "$REDIS_HOST"`）。判据一直只用 `-p`、把 URL 里的 host 丢了：
   `REDIS_URL` 指向远端 redis 时，探的其实是本地同号端口。原稿补丁在这种配置下会误报——
   本机 6379 恰好被 brew 的 redis-stack 占着（`dir=/opt/homebrew/var/db/redis-stack`），
   于是"用外部 redis"的部署会在启动时直接 `exit 1`。所以校验 gate 在 host ∈
   {`127.0.0.1`, `localhost`, `::1`, 空}。
2. **`|| true`**。`run.sh` 开头是 `set -euo pipefail`；`x=$(cmd | tail -1)` 的退出码取自
   管道（pipefail 下取最后一个非零），命令一失败赋值语句就触发 `set -e`，脚本静默退出。
   `REDISCLI_AUTH` 前缀则去掉了——它在 `run.sh:135` 已经 export，重复写没有意义。

四种情形实测（用抽取真实 `run.sh` 那段代码的 harness 跑，非人工推演）：

| 端口 / 归属 | 期望 | 实测 |
|---|---|---|
| 6381，`SCRIPT_DIR`=overview/deploy | 通过 | `✓ Redis already running` |
| 6381，`SCRIPT_DIR`=别家 | 拒绝 | `exit 1`，报出 `它的 dir: .../overview/deploy/redis_data` |
| 6382（带密码，无凭证） | 拒绝 | `exit 1`，报出 `它的 dir: <无权限或无应答>` |
| host=`redis.prod.example` | 跳过校验 | `✓ Redis already running` |

## 四、建议 2：不要用"自动找一个空端口"来解

看起来更省事，但**比撞车更坏**：自动换端口 = 起一个空库，业务侧表现为"数据全没了"，
而真数据还在旧端口的 rdb 里。端口分配是使用方要显式登记的事（我们本机的台账在
`overview/mind/ref/ports.md`），scaffold 该做的是**撞车时立刻响亮失败**，不是替人做决定。

同理不建议 `run.sh` 自动挑 `--port 0` / 随机端口：Solo 栈的 rdb 与端口一一绑定，端口漂移
等于数据漂移。

## 五、建议 3（可选）：给实例打项目标记

`CONFIG GET dir` 已经够用，此条只是让报错更直白：启动后写一个
`SET SOLO:STACK:OWNER "<项目名>"`，校验时连项目名一起报。若认为多一次写入不值，
忽略此条即可。

## 六、这一类的同源问题（同一份 run.sh，同一种病）

派生项目侧已实测到两处形态相同的"静默失败"：

1. **前端端口被占**（⚠️ triage 复核后改正，且实况比原稿更糟）。原稿写「`serve_frontend`
   只打一行 warn，栈照常起来」——`serve_frontend` 里**根本没有端口占用检查**，那唯一的
   `log_warn` 说的是 bundle 缺失。实际链路是三层假绿叠起来的：

   ```
   $ 占住 39117，再 serve -p 39117 -s          （serve 14.2.4，输出重定向到 fe_*.log）
   fe_operator.log:  INFO  Accepting connections at http://localhost:51410   ← 自己换了随机端口
   run.sh 打印:      ✓ operator → http://localhost:39117                    ← 报的是配置的端口
   dashboard:        lsof -i:39117 -sTCP:LISTEN 探到占用方 → [ONLINE]        ← 假绿
   ```

   `serve` 的这个行为不可配：源码 `build/main.js` 是 listen 前 `isPortReachable(port)` 探一下、
   可达就无条件 `startServer({port: 0})`；而 `--no-port-switching` **只在 arg 表里声明、
   代码里从没被消费**（14.2.4 实测：加了 flag 照样换到 51410）——是个死 flag，不能靠它。
   所以只能由 `run.sh` 自己拦：spawn 前 `lsof` 探端口 + spawn 后校验监听者的 pid 就是我们
   那个子进程。这解释了 overview 两个前端连续数月没起来没人发现（2026-07-29）。
2. **前端进程事后死掉**：主 `run.sh` 只 `wait` bundle 那一个 PID（`:480` 起的 plain 分支），
   子进程死活不管；dashboard 模式虽然逐个探 `[ONLINE]/[OFFLINE]`，但没人盯屏就等于没有，
   而且被第 1 条的假绿掩盖 → trend 三个前端 `Gracefully shutting down` 后 3 天多无人察觉
   （2026-08-05，已在 trend 的 `run.sh` 加 120s 前端看门狗，可上收）。

原则成立、已按它落地：**启动期的资源冲突一律 fail fast，不 warn**；运行期的进程消失才用
看门狗兜（第 2 条的看门狗尚未上收，见处理结论）。

## 处理结论

**采纳（2026-08-05）**，落在 `deploy/scaffold/run.sh`，并入**尚未打 tag 的 v1.1.14**
（`package.json` 已是 1.1.14、最新 tag 仍是 v1.1.13、无消费者钉在本版,所以不另起
`v1.1.15`——否则 CHANGELOG 里会多一个从未发布过的悬空版本号，而所有消费者当前 ≤ v1.1.13、
落在 v1.1.14 条目里一样会在 upgrade 时收到下面这份「下游 action」横幅）。两处启动期检查
都改成 fail fast：

| 建议 | 处置 | 位置 |
|---|---|---|
| 1 · redis 归属校验 | **采纳**，加了本机 host gate + `\|\| true`（见 §三） | `run.sh:196` 起的 `else` 分支 |
| 2 · 不自动找空端口 | **采纳**（本来就没做，明确记为不做） | — |
| 3 · `SOLO:STACK:OWNER` 标记 | **不做**：`CONFIG GET dir` 已能报出占用方绝对路径，多一次写入换不到信息量 | — |
| §六 1 · 前端端口冲突 | **采纳**：spawn 前 `lsof` 拦 + spawn 后校验监听 pid | `serve_frontend`（`run.sh:312`） |
| §六 2 · 前端看门狗 | **暂不上收**：属运行期兜底，与本条的启动期 fail fast 不同性质，等 trend 那份跑够时间再说 | — |

三种前端情形实测（同样用抽取真实 `run.sh` 函数的 harness）：端口空闲 → 起来且 `lsof` 里
监听者确实是我们的 pid；端口被占 → `exit 1` 并打印占用方那行 `lsof` 输出；`serve` 二进制
缺失 → `exit 1` 并指向 `fe_*.log`。

**退出码注意**：`run.sh` 的 `trap cleanup EXIT` 末尾是 `exit 0`，所以这两处 `exit 1` 对外
仍表现为退出码 0（既存行为，未改）。人肉看到的是红字 + 栈起不来；靠退出码判断的自动化
（本机 `start-all.command` 是按端口探活，不看退出码）要留意这一点。

### 派生项目迁移提示

- 上游落地的这份**包含** overview 本地补丁的全部功能且多了 host gate / pipefail 两处修正，
  升级后应以上游版为准、删掉本地那段 `⚠️ 本段是对 bundle scaffold 的本地改动` 注释。
- **原稿末段那句「`upgrade.sh` 会覆盖 `run.sh`，升级后要手动带回」不准确**（按当前
  `deploy/scaffold/upgrade.sh:210-229`）：脚本会先 `cmp` 检测 divergence，改过的
  `run.sh` **不会**被覆盖，新 stock 落成 `deploy/run.sh.solo-<ver>.new` 并在报告里标
  `DIVERGED`；只有 `FORCE_SCRIPTS=1` 才强覆盖。所以改过 run.sh 的项目（overview 的 redis
  补丁、trend 的看门狗、wavely 的定制）升级后要**手动 merge 那个 `.new`**，而不是"带回"。
- **overview / trend 有一件事必须在升级前先做**：两家现在共用 6381（trend 走 `/2`），
  trend 的 2000+ 键实际躺在 `overview/deploy/redis_data/dump.rdb` 里。overview 已经打了
  归属校验、trend 还没打，所以**只要启动顺序反过来**（trend 先起 → 建自己的空
  `redis_data`），trend 的数据就"消失"、overview 则直接 `exit 1`。先给 trend 换端口
  （登记进 `overview/mind/ref/ports.md`）并把 `/2` 的数据迁过去，再升级。
