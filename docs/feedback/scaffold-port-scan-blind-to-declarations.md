# 反馈：`init.sh` 的端口分配有三处，只有前端那处能被调用方覆盖——另外两处照样把别家的号段判成空闲

> 来源：用 `deploy/scaffold/init.sh` 新建派生项目 `steward`，2026-08-15 实测。
> 依据：**全部本机实测**（solo 当前工作树 v1.1.15，macOS）。行号取自
> `deploy/scaffold/init.sh`：`SOLO_PORT_BASE`（292）、`FE_PORT_BASE`（335）、`REDIS_PORT`（351）。
> 涉及：`deploy/scaffold/init.sh` 的三段端口扫描。
> 影响面：**同一台机上已有 ≥2 个派生项目时的每一次 scaffold**，且随「把栈迁到别的机器」
> 这件事的普及而恶化（见二-②）。
>
> 一句话：318-334 那段注释已经把问题分析得完全正确、并给前端加了 `FE_PORT_BASE` 出口，
> **但同一份文件里另外两处同构的扫描没有拿到同款出口**——于是调用方即使手里有正确答案，
> 也只能在 init 跑完之后回头改产物。

---

## 一、实测现象

本机（macOS，7 个 Solo 派生项目）跑：

```bash
FE_PORT_BASE=3730 bash deploy/scaffold/init.sh steward
```

三处分配的结果：

| 分配项 | init.sh 选的 | 那是谁的 | 结果 |
|---|---|---|---|
| 前端三件套 | 3730 / 3780 / 3830 | 无人 | ✅ 对——因为**调用方传了 `FE_PORT_BASE`** |
| Solo 内部段（13 个） | **8465–8477** | **colony** | ❌ 撞 |
| Redis | **6383** | **trend** | ❌ 撞 |

两处撞的都不是巧合，而是同一个成因：colony 和 trend 已于 2026-08-14 整栈迁到另一台机器
（N100），**本机不再有监听**，但它们的 `deploy/solo-services.json` 与 `.env` 还在本机的
仓库里、号段仍归它们所有（将来在 Mac 上起调试实例还会用）。`lsof` 探不到已经不在跑的东西。

产物层面要在 init 之后手改两个文件才对：`deploy/solo-services.json` 的 13 个 port、
`.env` 的 `REDIS_URL`。**改的是 `[Project]` 文件，不产生升级期的 `DIVERGED` 技术债**——
但它是一步「跑完之后记得回头改」，而这类步骤的历史通过率不高。

## 二、根因

### ① 三处同构的扫描，只有一处开了口子

```bash
SOLO_PORT_BASE=8400                     # 292 —— 写死，无覆盖
while :; do ... lsof -i:"$((SOLO_PORT_BASE + i))" ... done

FE_PORT_BASE=${FE_PORT_BASE:-3600}      # 335 —— 有覆盖 ✅
while :; do ... lsof -i:"$((FE_PORT_BASE + _off))" ... done

REDIS_PORT=6380                          # 351 —— 写死，无覆盖
while lsof -i:"$REDIS_PORT" ...; do REDIS_PORT=$((REDIS_PORT + 1)); done
```

318-334 的注释把道理讲得很透，值得原样引回来：

> This probe only sees "is anyone listening right now" — it has no way to see a sibling
> project's declared-but-not-yet-started port (its .env exists but the stack isn't up).
> Port allocation across projects on one machine needs a global view this script
> structurally can't have; the port ledger (overview/mind/ref/ports.md) is that global
> view. So: allow the caller to hand in the answer directly.

**这段推理对三处扫描一字不差地成立**，但结论（"allow the caller to hand in the answer"）
只落实到了其中一处。看得出来是当时为解决 3650/3700 那次具体撞车而加的，没有回头扫同款。

### ② 迁移让「声明但没在跑」从边缘情况变成常态

原注释设想的失效场景是「兄弟项目此刻没启动」——偶发、且下次启动就会暴露。
现在多了一种**永久**形态：**栈迁到别的机器后，本机那份声明会一直在，而端口一直空**。

本机 7 个派生项目里已经有 2 个（colony、trend）处于这个状态，占比 29%，
且这个方向是单调的——「派生项目部署到自己的小主机 + systemd 常驻」正在成为标准形态
（同 `run-sh-lsof-hard-dependency.md` 里记的那条趋势）。
所以探测式分配的命中率只会继续降。

### ③ 静默是这个问题的主要成本

init.sh 对三处都打了 `log_info`，其中前端那条还专门写了「does NOT check other projects'
.env declarations; cross-check your port ledger」。但：

- 另外两条没有这句提醒（"auto-selected, contiguous free range" / "auto-selected, not
  currently in use" 读起来像是"已经确认没问题"）；
- 这三行淹在 20 多行 `✓` 里，而 init.sh 结尾的 "Next steps" 只提了 `Confirm REDIS_URL in .env`
  ——**恰好漏掉了错得更隐蔽的 Solo 内部段**（Redis 撞车起栈时至少还有归属校验会 `exit 1`；
  内部段撞车要等两个栈同时跑才暴露，而那正是「多项目同台」文档承诺不会发生的事）。

## 三、建议（按价值排序）

1. **给另外两处补上同款环境变量出口。**（推荐，成本 2 行，与既有约定完全对称）
   ```bash
   SOLO_PORT_BASE=${SOLO_PORT_BASE:-8400}    # 292
   REDIS_PORT=${REDIS_PORT:-6380}            # 351
   ```
   调用方就能一次把三个答案全给对：
   ```bash
   FE_PORT_BASE=3730 SOLO_PORT_BASE=8520 REDIS_PORT=6385 bash deploy/scaffold/init.sh steward
   ```
   保留扫描作为兜底（没传就还是现在的行为），零破坏性。

2. **把三处的提醒收进结尾的 "Next steps"，而不是散在 20 行 `✓` 中间。**
   ```
   Next steps:
     0. 端口核对（自动扫描只看运行时监听，看不到别家 .env / solo-services.json 的声明）：
        前端 3730/3780/3830 · Solo 内部 8465-8477 · Redis 6383
        → 与你的端口台账对一遍；不对就改 deploy/solo-services.json 与 .env
   ```
   现有的 "Confirm REDIS_URL in .env" 只覆盖了三处里的一处，且没说要确认**什么**。

3. **把「已声明但没在跑」纳入探测**（可选，收益最大但成本也最高）。
   同一棵源码树下的兄弟项目其实是可读的——`init.sh` 已知 `SOLO_DIR`，其父目录就是项目根：
   ```bash
   # 扫兄弟项目的声明（不是运行时占用）
   for f in "$(dirname "$SOLO_DIR")"/*/deploy/solo-services.json; do ... done
   ```
   但这会给 scaffold 引入「所有派生项目都是本机同级目录」的假设，未必成立。
   **所以我把它排在最后**：方案 1 已经能让知道答案的人把答案传进来，那才是这件事的本体。

> 方案 1 与 2 不冲突，一起做最好：1 给出口，2 保证没走出口的人当场看见该核对什么。

## 四、派生项目侧当前的处置

`steward` 在 init 跑完后手改了两个 `[Project]` 文件（`deploy/solo-services.json` → 8520–8532、
`.env` 的 `REDIS_URL` → 6385），**没有改 `deploy/` 下任何 `[Solo→Project]` 脚本**，
因此不产生 `DIVERGED`。若 scaffold 采纳方案 1，派生项目侧无需任何跟进动作，
只是下次建项目能一条命令传对。

## 处理结论

**triage 2026-08-16：核实属实（三处扫描只有 FE 有覆盖口——与当前 init.sh 一致），
建议 1+2 采纳落地，建议 3 同意本文自己的排序：不做（引入目录布局假设，且 1 已把
「知道答案的人传答案」这条正路打通）。**

已做（`deploy/scaffold/init.sh`）：

1. **补齐两处覆盖口**（建议 1）：`SOLO_PORT_BASE=${SOLO_PORT_BASE:-8400}`、
   `REDIS_PORT=${REDIS_PORT:-6380}`，与 FE_PORT_BASE 同款语义（传入值仍作扫描起点，
   被占继续顺延；没传行为不变，零破坏）。两处都加了注释引回 §10 那段推理并点名
   「迁栈后本机遗留声明」这个永久盲区（本文 二-②）。
2. **提醒收进 Next steps**（建议 2）：结尾新增第 2 步「端口核对」，一行列出三处分配结果
   （Solo 内部段 / 前端三件套 / Redis）+ 「探测看不到声明」的原因 + 改哪两个文件；
   原来只说 `Confirm REDIS_URL` 的那条被它替代。三处扫描的 log_info 也统一成
   「runtime probe only — does NOT see declared-but-idle …」措辞（原先另外两条的
   "auto-selected, contiguous free range" 读起来像已确认没问题）。
3. 顺带：三处扫描裸依赖 lsof（同 `run-sh-lsof-hard-dependency.md` 那类反向失效——缺了
   会把所有端口判成空闲），在扫描前加了缺失警告：提示装 lsof 或显式传三个变量。

验证：`bash -n`（现代 bash + bash 3.2）通过；`${VAR:-}` 覆盖语义与 FE 处现行代码同构。

派生项目侧：steward 的两处手改（solo-services.json → 8520-8532、REDIS_URL → 6385）
保持即可，无跟进动作；下次建项目一条命令传齐：
`FE_PORT_BASE=… SOLO_PORT_BASE=… REDIS_PORT=… bash deploy/scaffold/init.sh <name>`。
