# 反馈：`run.sh` 的前端端口守卫硬依赖 `lsof`，缺了它**报错方向是反的**——把起得好好的前端判成失败

> 来源：overview 派生项目，2026-08-14 把 overview 栈从 VPS 迁到家用 N100（Debian 12）时踩到。
> 依据：**全部本机实测**（N100 上 solo v1.1.14 的 `deploy/run.sh`）。文中 scaffold 的行号
> 取自 `solo` 当前工作树（v1.1.15，`deploy/scaffold/run.sh`），已逐行核对——**这两处代码
> 从 v1.1.14 到 v1.1.15 没有变化**。
> 涉及：`deploy/scaffold/run.sh` 的 `fe_assert_port_free()`（401-410）与
> `fe_confirm_bound()`（415-431），以及 cleanup 的 pgid 清理（186）。
> 影响面：**任何跑在没装 lsof 的 Linux 上的 Solo 栈**。Debian/Ubuntu 的最小安装里
> `lsof` 不是默认包（N100 上实测 `which lsof` 为空、`apt-get install lsof` 是全新下载），
> 而「派生项目部署到自己的小主机 + systemd 常驻」正在成为标准形态。
>
> 一句话：v1.1.x 新加的 fail-fast 守卫用 `lsof` 做判据，但**没有验证 `lsof` 存在**；
> 工具缺失时守卫不是失效而是**反向失效**——该拦的拦不住，不该拦的拦死了。

---

## 一、实测现象

N100（Debian 12，Node 24，Redis 8.10）上 `systemctl start overview` 后，栈起不来，
`Restart=on-failure` 变成重启循环。日志里每一轮都是：

```
✓ Starting Solo bundle (vv1.1.14)...
✓   overview → port 8420 (pid 890067)
✗   operator: 前端没能在端口 3620 上起来
✗     serve 日志：/home/web/AI/overview/api/debug/fe_operator.log
⚠ Stopping all services...
```

按日志指的路去查，**`fe_operator.log` 是空文件**。于是排查方向被引向
「bundle 解压坏了？serve 依赖缺了？端口被谁占了？」——全部查完全是好的：

- `node_modules/.bin/serve` 在（`--omit=dev` 没漏装，`serve` 是 dependencies 不是 devDependencies）
- tarball 解得开，`api/debug/serve/operator/` 内容完整
- 3620 上没有任何别的进程

真实原因是 **这台机上没有 `lsof`**。手动 `apt-get install lsof` 后，同一份代码、同一条
`systemctl start`，三个前端（3620/3670/3720）**一次全起来了**，再没复现过。

### 为什么 runner 在同一台机上没暴露

runner 跑的是 v1.1.13 的 `run.sh`，它的 `lsof` 只用在**软探活**里
（`lsof -i:"$port" -sTCP:LISTEN &>/dev/null && break` 这类，见 scaffold 532-568）：
缺 `lsof` 时条件恒假，最多是 dashboard 少一格绿点，栈照常跑。
**是 v1.1.14 新加的这两个 fail-fast 函数把「可选工具缺失」升级成了「栈起不来」。**

## 二、根因：两个函数，两种反向失效

### ① `fe_assert_port_free()` —— 该拦的拦不住（静默放行）

```bash
holder=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1 || true)
if [ -n "$holder" ]; then ... exit 1; fi
```
（`deploy/scaffold/run.sh:403`）

`lsof` 不存在时 shell 的 `command not found` 走 stderr，被 `2>/dev/null` 吞掉；
stdout 为空 → `holder` 为空 → 判定「端口空闲」→ 放行。

**这个函数存在的唯一理由**，是防住注释里写得很清楚的那个灾难：

> `serve` 在端口被占时会**静默换一个随机端口并报告成功**……后果是 run.sh 照旧打印
> 配置的端口，dashboard 的 lsof 探到的是占用方的监听 → 一路假绿，前端其实几个月
> 没起来过也没人发现。

在缺 `lsof` 的机器上，**这个守卫本身就是静默失效的**——恰好是它要防的那种失效形态。

### ② `fe_confirm_bound()` —— 不该拦的拦死了（硬 exit 1）

```bash
for _ in $(seq 1 25); do
    kill -0 "$pid" 2>/dev/null || break
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$pid"; then
        bound=1; break
    fi
    sleep 0.2
done
if [ $bound -eq 0 ]; then
    log_error "  $name: 前端没能在端口 $port 上起来"
    ...
    exit 1
fi
```
（`deploy/scaffold/run.sh:415-431`）

`lsof` 不存在 → 那个 `if` 永远不成立 → 空转 5 秒 → `bound=0` → **`exit 1` 打死整个栈**。
而此刻 `serve` 进程活得好好的，端口也确实在监听。

三层误导叠加，是排查最花时间的地方：

1. **报错文本与事实相反**：「前端没能在端口 3620 上起来」，而它起来了。
2. **兜底诊断也被同一个缺失打瞎**：424-427 想打印「端口现在的占用方」帮你定位，
   走的还是 `lsof`，于是这行永远不打印——看起来像「端口上什么都没有」，
   进一步坐实了「前端没起来」这个错误结论。
3. **它把你指向一个空日志**：`serve 日志：.../fe_operator.log` 是空的，
   因为 `serve` 根本没出错。真正的原因（缺 lsof）在输出里一个字都没有。

### ③ 顺带：cleanup 的 pgid 清理也会静默降级

```bash
for l in $(lsof -ti:"$port" 2>/dev/null || true); do
```
（`deploy/scaffold/run.sh:186`）

缺 `lsof` 时这个循环体一次都不执行。它的职责是「只杀本进程组的残留监听者」——
静默降级成「不杀」。**这条危害小得多**（`KillMode=control-group` 的 systemd 环境下
本来也轮不到它兜底），但同属一类：把 `lsof` 当成必然存在的东西。

## 三、建议（按价值排序）

1. **加一条启动前置检查，把真实原因说出来。**（推荐，成本近乎零）
   在 run.sh 开头与 `redis-cli` / `node` 同级的位置：
   ```bash
   command -v lsof >/dev/null 2>&1 || { log_error "缺 lsof —— 端口守卫依赖它。Debian/Ubuntu: sudo apt-get install -y lsof"; exit 1; }
   ```
   fail-fast 的全部价值在于**报出真实原因**；现在它 fail 了，但报的是一个假原因，
   等于把 v1.1.14 想解决的那类「症状与根因对不上」的问题，在新位置又造了一个。

2. **或者给两个函数补 `ss` 回退**，让它在没有 lsof 的机器上照常工作。
   Linux 上 `ss`（iproute2）几乎必然存在，macOS 上则必然有 `lsof`，两者合起来覆盖全部部署面：
   ```bash
   _listener_pids() {   # <port> → 监听该端口的 pid，一行一个
       if command -v lsof >/dev/null 2>&1; then
           lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null
       else
           ss -tlnpH "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
       fi
   }
   ```
   两个函数都改成调它。比方案 1 多写十行，但换来「派生项目部署到小主机时不必先记得装 lsof」。

3. **无论选哪个，`fe_confirm_bound` 的失败分支都该能区分「没人监听」和「查不了」。**
   现在这两种情况打印同一句话。哪怕只加一行——探测手段不可用时明说「无法确认端口归属」
   ——也能把排查时间从半小时压到一分钟。

> 方案 1 和 2 不冲突：做了 2 仍值得保留 1 的思路（两种探测手段都没有时明确报错），
> 只是那时它几乎不可能触发。

## 四、派生项目侧当前的处置

overview 选了**在 N100 上装 `lsof`**，没有在本地改 `run.sh`——
所以**这条反馈没有对应的 `[Project]` 本地补丁，也不会产生升级期的 `DIVERGED` 技术债**。
若 scaffold 采纳方案 1 或 2，派生项目侧无需任何跟进动作。

## 处理结论

**triage 2026-08-16：核实属实（三处引用与当前 scaffold 逐行一致），建议 1+2+3 全部采纳
——按本文自己的注记，两个方案不冲突，一起做了。**

已做（`deploy/scaffold/run.sh`）：

1. **启动前置检查**（建议 1）：脚本开头探测 `PORT_TOOL`（lsof → ss 的优先序），两个都
   没有时报**真实原因** + 平台对应的安装命令后 `exit 1`。
2. **统一探测入口 + ss 回退**（建议 2）：新增三个函数，全脚本所有探测点收口——
   - `port_in_use <port>`（占用判断）：fe_assert_port_free、dashboard 的 solo/app/fe/ssl
     四处绿点全部换用；
   - `listener_pids <port>`（归属判断）：fe_confirm_bound、cleanup 的 pgid 清扫（本文 §③）
     换用；ss 分支 `grep -oE 'pid=[0-9]+'` 解析并 sort -u 去重；
   - `listener_desc <port>`（报错时的人读描述）：两个守卫的「占用方」输出换用。
   函数恒返回 0（`set -euo pipefail` 下命令替换赋值不炸），与原 `|| true` 惯例一致。
3. **区分「没人监听」与「查不了归属」**（建议 3）：fe_confirm_bound 失败分支先交叉判断
   `port_in_use && listener_pids 为空`（ss 无权限看别的用户的进程的场景），是则明说
   「有人监听但无法确认归属」并指向端口冲突，而不是那句与事实相反的「前端没起来」。

验证：`bash -n`（现代 bash + macOS bash 3.2 双跑）通过；从改后文件原样抽出函数块实测——
lsof 分支起真实监听验证 in_use/free/pids/desc 四个行为，ss 解析管道用 Debian 实机格式的
canned 输出验证（pid 去重正确）。ss 分支未在真机跑（本机 macOS 无 ss），逻辑与 N100 上
`ss -tlnpH` 实测输出格式一致；下次在 N100 部署时顺手确认一次即可。

派生项目侧：overview 已装 lsof、无本地补丁（见 §四），升级即享受回退，无跟进动作。
另外 `init.sh` 的三处端口扫描同样裸依赖 lsof，已在该文件加缺失警告
（见 `scaffold-port-scan-blind-to-declarations.md` 的结论——两篇同批修）。
