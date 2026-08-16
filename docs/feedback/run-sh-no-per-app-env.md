# 反馈：`run.sh` 两处部署级缺口 —— 缺 per-app env（暴露一个服务＝暴露全部）+ operator 默认口令是全权账号

> 来源：runner 派生项目，2026-08-14 把 runner 栈部署到家用 N100（Debian 12）、
> 经自有 VPS 的 Caddy 挂公网 URL 时踩到。
> 依据：**全部本机实测**（solo v1.1.13 的 scaffold `run.sh`）；文中引用的 runner 侧
> 注释与行号来自该项目当前工作树，已逐条核对。
> 涉及：`deploy/scaffold/run.sh` 第 9 节（私有 app 启动循环）与第 9c 节
> （operator 播种）、各私有服务 `index.js` 对 `process.env.BIND_ADDR` 的读取、
> `deploy/services.json` 的 schema。
> 影响面：**任何「同机跑多个私有服务、但只想把其中一部分对外」的部署** ——
> 也就是所有要做远程接入的派生项目。§二之二那条（默认口令）影响面更大：
> **所有 Solo 派生项目，只要有一天被挂到公网。**
>
> 一句话：绑定地址是全局的，而「哪个服务该对外」是 per-service 的决定，
> 两者对不上，结果是**安全边界被迫从应用层挪到机器层的防火墙里**。

---

## 一、🔴 `BIND_ADDR` 是全局的，但暴露意图是 per-service 的

runner 有两个私有服务：`git`(8421) 和 `coder`(8422)。远程接入只需要 `coder`
（终端 WebSocket + 图片上传），`git` **必须**保持不可达 —— `run.sh` 自己的注释
就是这么陈述这个不变量的：

```bash
# coder's unsigned same-host RPCs (git.server.get, git.repo.get/cloneUrl) are
# accepted via git's publicMethods whitelist (handlers/auth.js), NOT a DEBUG
# bypass — and the services bind 127.0.0.1 (index.js), so that surface is
# reachable only from this host.
```
（runner 的 `deploy/run.sh:272-277`，源自 scaffold）

但服务读的是**全局** `process.env.BIND_ADDR`：

```js
const server = app.listen(PORT, process.env.BIND_ADDR || '127.0.0.1', () => {
```
（`api/apps/coder/index.js:140`，`git` 同款）

而 `run.sh` 给每个 app 拼的 env 是写死的两三项，没有任何 per-app 扩展点：

```bash
declare -a _app_env=("PORT=$port" "ROUTER_URL=http://localhost:$ROUTER_PORT")
[ -n "$GIT_SVC_PORT" ] && _app_env+=("GIT_SERVICE_URL=http://127.0.0.1:$GIT_SVC_PORT")
...
env "${_app_env[@]}" node "$ROOT_DIR/api/$path" >> "$log_file" 2>&1 &
```
（`deploy/run.sh:278-283`）

`.env` 是 `set -o allexport` 整份 source 进来的（`run.sh:67-70`），所以往 `.env` 里写
`BIND_ADDR=0.0.0.0` **对所有服务同时生效**。

⇒ 想让 `coder` 被反向代理回源，就必须连 `git` 一起绑 `0.0.0.0`，
**上面那段注释里的不变量当场失效**，而且没有任何地方会提示你这件事发生了。

`services.json` 目前的 schema 只有 `name` / `path` / `port`，没有留口子：

```json
[ { "name": "git",   "path": "apps/git/index.js",   "port": 8421 },
  { "name": "coder", "path": "apps/coder/index.js", "port": 8422 } ]
```

---

## 二、两种绕法，以及为什么第一种不该是标准答案

**绕法 A（先做的，不推荐）：nftables 顶上。** policy drop，只放行 `3680/8600/8422`，
8421 落到默认 drop。实测有效（从另一台机器经 tailscale 探测 8421 与 redis 6386
均为 blocked）。**但它把一个应用层的部署意图（哪个服务对外）挪进了机器层的防火墙规则**：

1. 这份知识**不在项目里** —— 新机器、新运维、半年后的自己，都不知道 8421 为什么必须挡；
2. `nft flush ruleset` 一条命令就静默解除，**不会有任何报错**，服务照常跑；
3. 往 `services.json` 里加服务时，**没有任何东西提醒你回去改防火墙**。

第 3 条尤其糟：新增私有服务是常规动作，而它会默默继承 `BIND_ADDR=0.0.0.0`。

**绕法 B（已改成这个，推荐）：根本不设 `BIND_ADDR`，让 VPN 层做转发。**
我们的场景里对外通路本来就经 tailscale，于是：

```bash
sudo tailscale serve --bg --yes --tcp 8422 tcp://127.0.0.1:8422
```

实测绑定（`ss -lntp`）：

```
127.0.0.1:8421         git   —— OS 层面就够不到
127.0.0.1:8422         coder
100.64.251.83:8422     tailscaled 的转发器（tailnet 地址，不是 0.0.0.0）
```

`--tcp` 是 raw TCP 转发、不解析 HTTP，所以 WebSocket 不受影响（终端会话已端到端
验证）。配置存在 tailscaled 状态里、重启自动恢复，不需要额外守护进程，
上游反代的回源地址也不用改。

**这个绕法让 `run.sh:272` 那段注释重新成立** —— 服务确实只绑 127.0.0.1。
但它依赖「对外通路恰好是 tailscale」这个前提；换成别的形态（同机 nginx、
云厂商 LB、Docker 网络）就还是得回到全局 `BIND_ADDR`。所以下面的建议照旧成立：
**框架应该让「哪个服务对外」可以在项目里声明**，而不是让每个派生项目各自发明绕法。

---

## 三、建议（按价值排序）

1. **让 `services.json` 支持 per-app env**，`run.sh` 拼 `_app_env` 时合并进去：
   ```json
   { "name": "coder", "path": "apps/coder/index.js", "port": 8422,
     "env": { "BIND_ADDR": "0.0.0.0" } }
   ```
   改动很小（读 json 时多取一个字段、循环里多 append 几项），却让**「哪个服务对外」
   变成声明在项目里、跟着 git 走的事实**，而不是某台机器上的防火墙规则。
   顺带解决同类需求：给单个服务调 `LOG_LEVEL`、给某个服务单独设超时等。

2. 次选：约定 `<SVCNAME>_BIND_ADDR` 覆盖全局（如 `CODER_BIND_ADDR=0.0.0.0`），
   `run.sh` 拼 env 时查一次。不用动 `services.json` 的 schema，但可发现性差 ——
   `.env` 里多一个键，没读过 run.sh 的人不知道它存在。

3. 无论选哪个，**`run.sh:272` 那段注释要改**。它现在把「services bind 127.0.0.1」
   当成一个**不变量**在陈述，而这个不变量能被 `.env` 里一行静默推翻。
   注释应改为「除非 `BIND_ADDR` 被覆盖 —— 覆盖时 git 的免签面会一并暴露，
   必须另行约束」。

4. **文档里给出「不改绑定」的推荐路径**：远程接入场景优先用 VPN 层转发
   （`tailscale serve --tcp <port> tcp://127.0.0.1:<port>`，见 §二绕法 B），
   而不是全局 `BIND_ADDR`。这条不需要改任何代码，但能让派生项目**默认落在
   安全的那一侧** —— 我们就是先做错、后改对的，中间那段时间 git 的免签面
   完全靠一条防火墙规则挡着。

---

## 二之二、🔴 第 9c 节播种的 operator 是 `allow_all` + 默认口令 `operator`

同一次部署踩到，但它比上面那条更危险，因为**不需要任何特殊部署形态就存在**：

```bash
_OP_USER="${OPERATOR_USER:-operator}"
_OP_PASS="${OPERATOR_PASSWORD:-operator}"
```
（`run.sh` 第 9c 节）

播种时 permit 直接写死为全权：

```js
u.permit = { allow_all: true, services: {} };
```

于是**任何一个没有显式设 `OPERATOR_PASSWORD` 的 Solo 栈，都存在
`operator`/`operator` 的全权账号**。本地只监听局域网时这是可接受的开发便利；
但一旦这个栈被挂到公网（我们正是这么做的），它就是一个**任何人都能登录的
全权入口**。对 runner 这种带 `coder.*`（PTY/远程 shell）的派生项目，
后果直接是主机沦陷。

实测（solo v1.1.13，经公网 URL）：

```
user.login.request/verify  operator/operator  → 拿到 session token
带该 token 调 coder.session.list               → 有权限（allow_all）
```

**还有一个让人以为改好了、其实没改的坑**：播种逻辑只在账号不存在时
`user.register`，账号已存在时只覆盖 permit、**不动密码**。所以事后往 `.env` 里
补 `OPERATOR_PASSWORD` 是无效的 —— 必须连带删掉 Redis 里的
`user:name:<name>` 与 `user:<uid>` 再重启才会重新播种。我们就是这么处置的。

**建议**（按价值排序）：

1. **不要给默认口令一个可用的值。** `OPERATOR_PASSWORD` 未设时，改为
   **随机生成一次并打印在启动日志里**（现在那行 `ops login ready: ... / ...`
   本来就在打印口令，改成打印随机值即可，零额外交互成本）。
   这样「开发便利」保留了，「全网可猜的默认口令」消失了。
2. 次选：未设时**仍然播种但不给 `allow_all`**，或干脆不播种、让 UI 走
   「paste a token」——现在那条 else 分支已经是这么提示的。
3. 无论选哪个，**播种逻辑应支持改密**：检测到 `.env` 里的口令与已存账号不一致时
   更新 salt/hash，而不是静默跳过。现在的行为会让人以为改了、其实没改。
4. 文档里点名：**挂公网前必须设 `OPERATOR_PASSWORD`**。

---

## 四、附带一条（同一次部署踩到，独立问题）

**Debian 12 上 `redis-stack-server` 分支形同虚设。** Redis 官方源
（`packages.redis.io/deb bookworm`）现在提供的是 `redis-server` 8.x，
**模块 `.so` 随包装到 `/usr/lib/redis/modules/`（rejson / redisearch /
redistimeseries / redisbloom 都在），但默认不加载** —— 而 `run.sh` 是用自己的参数起
redis、不读 `/etc/redis/redis.conf`：

```bash
"$REDIS_BIN" --port "$REDIS_PORT" --daemonize yes --dir ... --logfile ... --save ...
```
（`run.sh:178`）

于是 `command -v redis-stack-server` 找不到 → 落到 plain `redis-server` 分支 →
`run.sh` 打的那句 warning（`v1.1 services needing RedisJSON will fail on JSON.SET`）
成真。实测：`JSON.SET` 报 `ERR unknown command`，`MODULE LIST` 为空
（runner，Debian 12.15 / redis 8.10.0）。

**建议**：redis 分支再加一档 —— 找到 `redis-server` 时，若
`/usr/lib/redis/modules/rejson.so` 存在就自动附加 `--loadmodule`，
并把 warning 降级。这样 Linux 上不再需要额外安装物。
本地我是用一个 `/usr/local/bin/redis-stack-server` shim 绕过去的
（`exec /usr/bin/redis-server --loadmodule ... "$@"`，参数 last-wins 所以透传安全）。

---

## 处理结论

**triage 2026-08-14（solo 侧，逐条核实后）：§一 采纳并扩大范围、§二之二 退回 runner、§四 采纳。**

### 先纠正三处归因（不影响诉求成立，但影响修哪儿）

本文 §一引用的 `process.env.BIND_ADDR`、`run.sh:272-277` 的注释、`_app_env` 数组、
`GIT_SERVICE_URL`、§二之二的 9c 播种段——**在 scaffold 里都不存在**。
`BIND_ADDR` 在整个 solo 仓库（api/ + deploy/ 全量 grep）**零命中**；scaffold 的
`run.sh` §9 原本就只有一行 `PORT=… ROUTER_URL=… node …`。这些是 **runner 自己
`deploy/run.sh` 的内容**——该文件已深度 DIVERGED（自加了日志轮转、per-app env 拼装、
operator 播种）。实测部分（tailscale serve / `ss -lntp` / `JSON.SET` 报错 /
operator 登录）都可信，问题出在把本地改动当成了框架现状。

### §一 采纳，而且真实情况比本文描述的更严重

本文的模型是「全局 `BIND_ADDR` 压过 per-service 意图」。实际是：**框架层压根没有绑定
地址控制**——solo 的 16 个服务（含 router、user、storage）全部 `app.listen(PORT, cb)`
不传 host，Node 默认绑 `::`/0.0.0.0。runner 的私有服务因为自己写了 `'127.0.0.1'` 默认值，
反而比框架自带的服务更安全。已做：

- `api/library/ports.js` 新增 `bindAddr(name)`：`<NAME>_BIND_ADDR` > `BIND_ADDR` > `undefined`。
  **返回 undefined 是刻意的**——`listen(port, undefined, cb)` 与 `listen(port, cb)` 完全
  等价（已实测），所以对存量部署零行为变化，是 opt-in 上锁而非静默改默认值。
  改默认为 127.0.0.1 会切断所有「反代/容器网络/LB 从别的主机回源」的既有部署。
- 15 个服务 + `api/sample` 的 `app.listen` 接上它（**`api/router/` 受修改保护，未动，
  待授权**——它是唯一入口，也是最该锁的一个）。
- `deploy/scaffold/run.sh`：`services.json` 支持 per-app `env`（本文建议 1 的原样落地），
  `{ "name": "coder", …, "env": { "BIND_ADDR": "0.0.0.0" } }`。
- `init.sh` 生成的 `.env` 里加了这段的说明与注释掉的示例。
- 新增 autocheck 规则 `bind-address`（WARN）：`app.listen` 没接 `bindAddr` 就提示。
  这样新服务（含各派生项目的）不会再默默回到老写法。
- 文档：`docs/authoring/service.md` §2 + 自查第 7 条、`solo-service` SKILL.md 红线。

本文建议 2（`<SVCNAME>_BIND_ADDR` 约定）与建议 1 **都做了**——前者作用于所有服务
（含 Solo 内置的），后者只作用于 `services.json` 里的私有 app，两者互补。
建议 3（改注释）不适用：那段注释在 runner 自己的 run.sh 里，solo 侧没有对应文本。
建议 4（推荐 VPN 层转发）没有写进框架文档：它对「对外通路恰好是 tailscale」的场景成立，
但现在项目里能直接声明绑定了，这才是通用答案。

### §二之二 退回 runner——不是框架问题

scaffold 的 `run.sh` **没有任何 operator 账号播种**（`OPERATOR_PASSWORD` / `allow_all`
零命中）；`seed.json` 里的 `"operator"` 只是个 category 标签（"运维人员"角色），不是账号。
9c 整段是 runner 自加的，`operator`/`operator` 全权账号也只存在于 runner。
**这条要在 runner 仓库修**，不在 solo。

但其中的通用教训记在这里，作为将来 scaffold 若要加播种逻辑的硬约束：
① 默认口令不能有可用值——未设时随机生成并打印在启动日志，而不是回落到 `operator`；
② 播种只在账号不存在时 register、已存在时不改密码，会造成"以为改了其实没改"，
必须支持改密或至少显式告警。

### §四 采纳

`run.sh` 的 redis 分支加了第三档：落到 `redis-server` 时，依次在
`/usr/lib/redis/modules`、`/usr/local/lib/redis/modules`、`/opt/redis-stack/lib` 找
`rejson.so`，找到就自动 `--loadmodule`（连带 `redisearch.so`），并把 warning 降级成 info。
附带修掉一处本文没点名的 bug：**原来的提示语 `Install: brew install redis-stack` 是
macOS 专属**，Debian 用户照做无效——现在按 `uname -s` 分平台给提示。

实现上有个坑值得记：`"${REDIS_MODULE_ARGS[@]}"` 在**空数组**时会让脚本直接死——
macOS 仍是 bash 3.2，而 `run.sh` 开着 `set -u`，空数组展开报 `unbound variable`
（已实测）。必须写成 `${REDIS_MODULE_ARGS[@]+"${REDIS_MODULE_ARGS[@]}"}`。
没有模块的 macOS 是最常见路径，写错等于所有本机栈起不来。

### 验证

`bash -n` + 用真实 `services.json`（含带空格/`|`/`=` 的 env 值）端到端跑通解析与
env 组装；用改后的完整命令行真起了一次 redis（空模块分支）确认 PING/JSON.SET 正常；
autocheck 全服务通过，CI 绿色子集全绿。

### 给 runner 的动作项（在 runner 仓库做）

1. `deploy/run.sh` 已 DIVERGED，升级到含本次改动的 Solo 版本时会拿到
   `run.sh.solo-<ver>.new`，需手工 merge（per-app env + redis 第三档在新 stock 里）。
2. `coder`/`git` 的 `index.js` 可改用 `library/ports` 的 `bindAddr('coder')`，
   把自建的 `process.env.BIND_ADDR || '127.0.0.1'` 换掉——注意默认值不同：
   框架版默认全网卡（兼容存量），runner 版默认 127.0.0.1。**runner 应显式在 `.env` 里
   写 `BIND_ADDR=127.0.0.1` 保住现有姿态**，否则换过去反而放开了。
3. operator 默认口令（§二之二）在 runner 自己修。
