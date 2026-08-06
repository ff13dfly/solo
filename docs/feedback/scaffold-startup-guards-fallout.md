# 反馈：v1.1.14 新增的启动期 fail fast，在它最该保护的场景里反咬一口（附两条同批实测）

> 来源：finance 从 `v1.1.12` 升到 `v1.1.14`，2026-08-06。
> 场景：本机同时跑 5+ 个 Solo 栈（ladder · overview · runner · trend · wavely · finance），
> finance 的 `deploy/run.sh` 是定制版（专属 SSL 端口 8687 + local-oss + 两个项目自有 Vite 前端），
> 升级时按 `upgrade.sh` 的 DIVERGED 提示手工 merge 了新 stock 的三块守卫。
> 依据：三条全部本机实测（非读码推演），复现命令与输出见各节；② 用抽取上游真实代码段的
> harness 跑过对照组。
> 涉及：`deploy/scaffold/run.sh`（v1.1.14 的 `:145-149`、`:333`）、`deploy/scaffold/upgrade.sh`。
>
> **状态：已上收**（2026-08-06，三条全部采纳，见文末「处理结论」；随下一个 v1.1.x 发版下发）。

三条都出自同一次升级，按严重度排：① 是 v1.1.14 自己引入的回归，② 是 v1.1.13 就带进来、
但要到真跑 stock `run.sh` 才会暴露的启动阻断，③ 是两个各自都对的规则叠出来的静默副作用。

---

## ① 🔴 fail fast 走 EXIT trap → `cleanup()` 的端口清扫把**先起那个栈**打死

### 现象（实测）

finance 栈正常在跑，然后手滑再起一次 `bash deploy/run.sh --plain`：

```
测试前：
  8426: 69222    (router)
  8439: 69299    (finance)
  8461: 69301    (insight)
  3610: 69311    (operator 前端)

第二个实例的输出：
  ✓ Redis already running on port 6382          ← 归属校验正确通过（同项目）
  ✓ Starting Solo bundle (vv1.1.14)...
  ✗   operator: 端口 3610 已被占用,拒绝启动(否则 serve 会静默换随机端口)
  ✗     占用方：node    69311  fuu   14u  IPv6  TCP *:3610 (LISTEN)
  ⚠ Stopping all services...                    ← EXIT trap

测试后：
  8426:          ← 空
  8439:          ← 空
  8461:          ← 空
  3610:          ← 空（原栈 run.sh 见 bundle 没了，自己也退出，带走了自己的前端）
```

**第二个实例没抢到任何东西，却把第一个实例连根拔了。**

### 根因

`run.sh:145-149` 的"保险起见"端口清扫，对 `deploy/solo-services.json` + `deploy/services.json`
里的**所有**端口无条件执行，不问监听者是谁：

```bash
# Belt-and-suspenders: free ports in case any child detached
for port in "${SOLO_PORTS[@]}" "${SVC_PORTS[@]}"; do
    l=$(lsof -ti:"$port" 2>/dev/null || true)
    [ -n "$l" ] && kill -9 $l 2>/dev/null || true
done
```

这段代码本身是老的，v1.1.14 之前没显形，是因为**第二个实例根本不会中途退出**——它一路跑到底
（前端静默换随机口），`cleanup` 只在 Ctrl+C 时跑，那时杀的确实就是自己那一支。v1.1.14 加了
`exit 1` 之后，`trap cleanup ... EXIT` 让每一条 fail fast 路径都要过一遍这段清扫，语义就从
"我退出时收拾我自己"变成了"我退出时把这些端口上的人都杀了"。

**同机多栈正是这次守卫的目标场景**，所以撞上的概率不低：端口撞车 → fail fast → 误杀。
而且它比 v1.1.14 之前更糟——以前是"两个栈都活着，只是第二个的前端在随机口上"，现在是
"第二个没起来，第一个也死了"。

顺带一提，`exit 1` 的退出码也被 `cleanup()` 结尾的 `exit 0` 吃掉了，脚本对外返回 0；
`start-all.command` 这类按退出码判断的启动器会把"拒绝启动"读成"起好了"。

### 建议改法

清扫前比对进程组，只杀自己这一支（保留"抓自己 detach 掉的孙子进程"的原意，不误伤别人）：

```bash
_our_pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
for port in "${SOLO_PORTS[@]}" "${SVC_PORTS[@]}"; do
    for l in $(lsof -ti:"$port" 2>/dev/null || true); do
        _pg=$(ps -o pgid= -p "$l" 2>/dev/null | tr -d ' ')
        [ -n "$_our_pgid" ] && [ "$_pg" = "$_our_pgid" ] && kill -9 "$l" 2>/dev/null || true
    done
done
```

已在 finance 的定制 `run.sh` 上落地并复测：第二个实例照常 fail fast，**原栈五个前端 + 后端
pid 一个没变**。（子进程不 setsid，pgid 天然继承自 `run.sh`，判据成立。）

---

## ② `$SYSTEM_DESCRIPTION` 是未定义变量，会在第一个前端启动时打断整个 `run.sh`

`run.sh:19` 是 `set -euo pipefail`（全文无 `set +u`），而 `:333` 是裸引用：

```bash
local sys_name="${SYSTEM_DISPLAY_NAME:-SYSTEM}"   # ← 这行有兜底
...
if [ -n "$SYSTEM_DESCRIPTION" ]; then             # ← 这行没有
```

`init.sh` 生成的 `.env` 里**没有** `SYSTEM_DESCRIPTION`（也没有 `SYSTEM_DISPLAY_NAME`），
`grep -n "SYSTEM_DESCRIPTION\|SYSTEM_DISPLAY_NAME" deploy/scaffold/init.sh` 无命中，而
`PORTAL_OPERATOR_PORT=3600` 是写进去的（`init.sh:341`）→ `serve_frontend` 一定会被调用。

### 实测（抽取上游真实代码段的 harness，两组对照）

把 `run.sh:310-376`（含 `serve_frontend` 整个函数）原样 `source` 进 harness，只补
`log_*` / `ROOT_DIR` / `DEBUG_DIR` / `SSL_ENABLED` 等外部依赖，喂真实的 `system.v1.1.14.tar.gz`：

```
### A. SYSTEM_DESCRIPTION 未定义（= init.sh 生成的 .env 的现状）
serve_frontend.real.sh: line 24: SYSTEM_DESCRIPTION: unbound variable
退出码=1                                    ← serve 都没起就死了

### B. .env 里补了 SYSTEM_DESCRIPTION
✓   system → http://localhost:39512
=== 函数返回了，没有中途死掉 ===
退出码=0
```

也就是说：**`init.sh` 派生出来的全新项目，直接跑 stock `run.sh` 就起不来前端。**
之所以到现在没人报，猜测是几个在用的派生项目 `run.sh` 都被定制过、走 DIVERGED 分支，
新 stock 从没被真正执行过——这轮 finance 手工 merge 时才把这行抄进来撞上。

改法一行：`if [ -n "${SYSTEM_DESCRIPTION:-}" ]; then`。（finance 已按此 merge。）

建议顺带在 `init.sh` 的 `.env` 模板里补上注释掉的 `SYSTEM_DISPLAY_NAME` / `SYSTEM_DESCRIPTION`
两行——v1.1.13 的 CHANGELOG 让下游"在 `.env` 加两行"，但 `.env` 是项目自有文件、`upgrade.sh`
不碰，模板里没有位置的话，这个能力对存量项目基本是隐形的。

---

## ③ `operator` 前端在每次升级后静默掉线

`run.sh:379` 按 `.solo-version` 拼 tarball 名：

```bash
serve_frontend "operator" "$ROOT_DIR/portal/publish/operator.${SOLO_VER}.tar.gz" "${PORTAL_OPERATOR_PORT:-}"
```

而 `upgrade.sh` 明确不碰 operator（"operator is source-distributed → never touched"），
`portal/publish/` 里只剩上一版的 `operator.v1.1.12.tar.gz` → 升级后 operator 门户直接不 serve，
输出里只有一行 warn，夹在其它绿色行中间很容易划过去：

```
⚠   operator: port 3610 set but bundle missing (operator.v1.1.14.tar.gz) — skipping.
```

两条规则各自都对（operator 归项目所有 vs 前端产物按版本钉），叠起来的结果是
**"什么都不做"不等于"维持现状"，而等于"这个门户没了"**。`upgrade.sh` 的 Next steps 里那句
`portal/operator/ ... diff it manually vs Solo if you want the new operator UI` 反而强化了误解：
听上去像"不 diff 就继续用旧 UI"，实际是不处理就没有 UI。

另外 `upgrade.sh` 的升级后自检已经逐个核对了 system / mobile 的 tarball 版本一致性，
**operator 是唯一被跳过的那个**——恰好也是唯一会因为版本不一致而掉线的那个。

### 建议改法（二选一或都做）

- 自检里把 operator 也扫一遍：只要 `portal/publish/operator.v*.tar.gz` 存在但版本 ≠ `.solo-version`，
  就打一条醒目的 ACTION（"operator 门户升级后不会被 serve，从 solo 拷 `operator.v{ver}.tar.gz`
  或重建"），而不是让它落到 `run.sh` 里当一行 warn。
- 或者：既然 `run.sh` 拼名字用的是 `.solo-version`，那"项目没定制过 operator"时其实可以像
  system/mobile 一样直接拷新 tarball。是否定制过是可判定的（跟对应 tag 的 `portal/operator/`
  逐文件比一次）——finance 这次就是比完确认零改动，才放心直接拷了 solo 的
  `operator.v1.1.14.tar.gz`。

---

## 附：升级本身没问题的部分（免得只看到坏消息）

- `upgrade.sh` 对 bundle / `api/{library,sample,autocheck}` / docs / skill / system / mobile 的替换、
  旧版本清理、DIVERGED 检测、CHANGELOG 驱动的 ACTION REQUIRED 横幅，全部按预期工作。
- v1.1.14 的 **Redis 归属校验判得很准**：finance 自己的 6382 实例（带密码、`CONFIG GET dir` 命中
  本项目 `deploy/redis_data`）正常放行，`REDISCLI_AUTH` 这条路子也确实免了 `-a` 泄漏到 `ps`。
- v1.1.14 的**前端端口 fail fast 抓到了真东西**：升级前 finance 机器上并存着两个栈，早起的那个
  5 个前端全被 `serve` 静默换到了随机口 64312–64321——正是这条守卫要治的病，现场抓了个正着。
  问题只出在它的退出路径上（见 ①），守卫本身的判据是对的。
- 建议把 stock `serve_frontend` 里那两段端口检查抽成函数（如 `fe_port_guard` / `fe_bind_check`）。
  派生项目常有不走 `serve_frontend` 的自有前端（finance 有两个 Vite 应用直接 serve `dist/`），
  抽成函数它们才接得上；否则这些前端仍然是"静默换随机口"的重灾区。finance 已这么改。

---

## 处理结论（solo 侧，2026-08-06，三条全部采纳）

上游 triage 复核了全部三条：代码逐行对上（`run.sh:145-149/152/154/333`、`init.sh` 无两个
SYSTEM_* 变量而 `PORTAL_OPERATOR_PORT` 有），trend 同日独立复现 ①（含 pgid 判据有效性
与退出码被吃）进一步佐证。落地全部在 scaffold（`deploy/scaffold/`），bundle 零改动：

- **① 采纳，含建议改法原样上收**：stock `cleanup()` 端口清扫前比对 pgid，只杀自己这一支
  （与 finance 落地版同款）；顺带修了这条反馈顺带提到的**退出码被 `exit 0` 吃掉**（`local rc=$?`
  第一行接住、结尾 `exit "$rc"`）并加 trap 防重入。验证：harness 实测「异组监听者存活 +
  本组监听者被清 + `exit 1` 透传到调用方」三条全过。
- **② 采纳**：`run.sh:333` 改 `${SYSTEM_DESCRIPTION:-}`；`init.sh` 的 `.env` 模板补
  `SYSTEM_DISPLAY_NAME`（预填项目名，取消注释即用）/`SYSTEM_DESCRIPTION` 注释位——
  v1.1.13 那个能力对消费者隐形的问题一并治了。
- **③ 采纳建议之一（自检 ACTION 档）**：`upgrade.sh` 升级后自检补 operator 扫描，
  tarball 版本 ≠ `.solo-version` 即标 ACTION，并附可直接复制的三行重建命令（来自 trend
  验证过的流程）。**建议之二（未定制时自动拷上游 tarball）不做**：trend 同日反馈
  （`patch-upgrade-consumer-gaps.md` §三）逐文件 diff 出 7 个定制文件，证明"定制过"与
  "零改动"两种情况都常见，而 upgrade.sh 里可靠判定"是否定制"需要老版本 tag 的源树，
  判定不了就不代做——拷错的代价（静默抹掉定制、`git status` 干净无从发现）远大于
  多敲三行命令。
- **附带建议采纳**：端口守卫抽成 `fe_assert_port_free` / `fe_confirm_bound`（采 trend 命名），
  派生项目自有前端在启动段直接调用即可。
- 记录进 CHANGELOG `[Unreleased]`，随下一个 v1.1.x tag 经 `upgrade.sh` 下发。finance/trend
  已各自打过本地补丁的 `run.sh`，merge 新 stock 时以 stock 为准对齐即可（语义同款）。
