# 下发文档里的 `deploy/upgrade.sh` 是个不存在的路径：升级入口在 solo 仓，模板却把它写成项目内路径

> 来源：steward，2026-09-21。起因是一次仓库盘点核对文档指针，逐条 `ls` 时发现三份下发文档
> 都把升级入口写成 `bash deploy/upgrade.sh`，而**没有任何 Solo 项目有这个文件**。
> 依据：**全部本次实测**（steward 工作树 + 六个消费项目现扫 + solo 仓源码核对）。
> 涉及：`deploy/scaffold/docs/README.md` · `deploy/scaffold/docs/authoring/service.md` ·
> `deploy/scaffold/docs/authoring/modeling.md` · `deploy/scaffold/.claude/skills/solo-service/SKILL.md`。
>
> 一句话：真正的升级入口是 **`cd <solo 仓> && bash deploy/scaffold/upgrade.sh <项目路径>`**
> （脚本头注自己写着 `Run from INSIDE the Solo source directory`），而下发给每个项目的文档
> 统一写成 `bash deploy/upgrade.sh` —— 一个在消费者仓库里**从未存在过**的相对路径。

---

## 一、实测

```
$ ls ~/Desktop/AI/steward/deploy/upgrade.sh
ls: No such file or directory

$ git -C ~/Desktop/AI/steward log --all --oneline -- deploy/upgrade.sh
（空 —— 从未存在过，不是被删的）

$ for d in overview colony runner finance ladder steward; do ls ~/Desktop/AI/$d/deploy/upgrade.sh; done
（六个项目全部 No such file）

$ ls ~/Desktop/AI/solo/deploy/scaffold/upgrade.sh
-rwxr-xr-x  27730  9月 5 15:22   ← 真身在这里
```

脚本自己的用法头注（`deploy/scaffold/upgrade.sh:5-11`）：

```
Upgrades an EXISTING Solo-scaffolded project's [Solo] artifacts …
Run from INSIDE the Solo source directory.
Usage:
  bash deploy/scaffold/upgrade.sh <project-dir> [--dry-run] [--force-scripts]
```

`docs/runbook/upgrade-patch.md:15-16` 与 `upgrade-v1.0-to-v1.1.md:29` 写的也是这个形态
（`cd /path/to/solo && bash deploy/scaffold/upgrade.sh /path/to/<project>`）——
**runbook 是对的，下发给消费者的文档是错的**。

## 二、错在哪几处（都在 scaffold 下发面）

| 文件 | 原文 | 问题 |
|---|---|---|
| `docs/README.md`（solo 标记块内） | 「`bash deploy/upgrade.sh` 升级时会**整体重下发**」 | 消费者仓库里没有这个路径 |
| `docs/authoring/service.md:14` | 「升级时 `upgrade.sh` 会同步」 | 同上（措辞较含糊，危害小） |
| `docs/authoring/modeling.md:43` | 「改了也会被下次 `upgrade.sh` 覆盖」 | 同上 |
| `.claude/skills/solo-service/SKILL.md:15` | 「`bash deploy/upgrade.sh` and your changes would be lost」 | **这条最要紧**：它是 AI 每次改服务前都会读的 skill，命令给得很具体、照着敲必然失败 |

## 三、为什么值得改（不是措辞洁癖）

1. **它是「只读区」这条纪律的唯一执行手段。** 那四份文档都在用同一句话教育读者
   「别改 `api/library/`，升级会覆盖」——而读者想验证这件事、或想真的升一次 bundle 时，
   拿到的是一个跑不了的命令。**一条无法执行的纪律，执行率取决于读者的信任而不是机制。**
2. **它把「从哪跑」这个关键信息也一起丢了。** 升级是 solo 仓 → 项目目录的**单向**动作，
   写成项目内路径会让人以为该在项目里跑，进而去找为什么脚手架没下发这个文件
   （本次盘点就在这里花了时间：先怀疑被误删、查 git 历史、再扫六个项目，才定位到 solo 仓）。
3. **消费者侧的全局记忆已经跟着错了。** 使用者的跨项目 CLAUDE.md 里写着
   「要用就先 `deploy/upgrade.sh` 升 bundle，别去改只读区的 run.sh」——
   错误指针已经从下发文档传播到了人的判据层。

## 四、建议（按价值排序）

1. **四处统一改成 `cd <solo 仓> && bash deploy/scaffold/upgrade.sh <项目路径>`**，
   并在 `docs/README.md` 的 solo 块里补一句「升级脚本不在本仓，从 solo 仓往这边跑」——
   消费者最需要的恰恰是这句，因为它解释了为什么自己仓库里找不到。
2. **`check-upgrade-path.sh` 顺手加一条断言**：升级后，项目里所有下发文档中出现的
   `upgrade.sh` 路径必须指向一个**在那个上下文里真实存在**的位置。判据零成本
   （grep 出路径 → 在项目目录里 `test -f`），而它挡的正是这一类「文档里的命令跑不了」。
   这道门已经在跑 49 条断言，加这一条不新增注意力去处。
3. （可选）scaffold 下发一个 `deploy/upgrade.sh` **薄壳**，内容是一句
   「升级从 solo 仓跑：`cd <solo> && bash deploy/scaffold/upgrade.sh $(pwd)`」然后 exit 1。
   这样照着旧文档敲的人会拿到指路，而不是 `No such file`。
   ⚠️ 但这会让「项目里有 upgrade.sh」变成半真，与建议 1 二选一即可，我倾向 1+2。

## 五、处理结论

**2026-09-21 已修**（solo 侧）。

### 核实：全部属实，补两条

- `deploy/upgrade.sh` 在 **solo 仓里也从未存在过**（`git log --all --diff-filter=ADR` 空）；
  脚本自诞生（`8965e18 feat(scaffold): add upgrade.sh…`）就在 `deploy/scaffold/upgrade.sh`。
  ⇒ 不是移动后留下的旧指针，是**从第一天起就写错**。
- 现扫 11 个消费项目：**无一有 `deploy/upgrade.sh`**，其中 10 个的文档里带着这个错误路径
  （ladder 为 0，只因它还钉在 bundle v1.0.0）。

### 漏了第 5 处，而且是最要紧的那处

**`deploy/scaffold/CLAUDE.md:10`** —— 「本块由 Solo 维护，`deploy/upgrade.sh` 会整块重新同步」。
这份下发到**项目根**、**每轮 AI 会话自动加载**；本文点名「最要紧」的 `SKILL.md` 反而只在动
`api/apps/` 时才触发。catalog 的 `CLAUDE.md` 里已经带着这句（实测命中）。

**steward 为什么看不见它**：scaffold 下发项目根 CLAUDE.md 是 `0f8e3a7` 才加的，
steward 自己的 `CLAUDE.md` 没有 `solo:begin` 块 —— 在自己仓库里逐条 `ls`，这一处根本不出现。
⇒ 「在自己项目里扫下发面」有系统性盲区：**扫到的是自己那一版下发的结果，不是当前下发面**。

### 改了什么

- **三处命令形态**改成 `cd <solo 仓> && bash deploy/scaffold/upgrade.sh <项目路径>`：
  `docs/README.md` · `CLAUDE.md` · `.claude/skills/solo-service/SKILL.md`；
  并在 `docs/README.md` 补了建议 1 要的那句：「升级脚本不在本仓……本项目里没有
  `deploy/upgrade.sh`，那不是漏发——派生项目从来就不带升级入口。」
- **裸 `upgrade.sh` 的 4 处不动**（`service.md` · `modeling.md` · `SETUP.template.md` ·
  `README.client.md`）：它们是名词引用（「会被 upgrade.sh 覆盖」），没有假路径、照不着敲。
  把完整命令塞进每一处只是噪音，权威定义放 `docs/README.md` 一处即可。
- **建议 2 已落地**：`check-upgrade-path.sh` 新增第 7 段。判据比原提议稍宽一点、因而零误报：
  路径在**文档自己所在目录**或项目根下存在即可（Quick start 通常就地起跑）；只在 solo 仓存在的，
  **同一行必须写明 `cd <solo …>`**。只抓 `bash <path>` 命令形态，所以解释性提及不会误伤。
- **建议 3 不做**（作者自己也倾向不做）。

### 这道门首跑就抓出同构的两处，都已修

1. **`e2e-ui/README.md:11`** 的 `bash ../deploy/run.sh` —— 那份文档下发到 `e2e/ui/`，
   往上是**两层**。已改 `../../`；同一段第 15 行 `cd ../portal/operator` 少同一层，一并修
   （断言抓不到它，不是 `bash` 形态）。
2. **`README.portal.md:47` / `README.client.md:57`** 的 `bash deploy/build-frontend.sh` ——
   这个脚本在 solo 仓里**存在**，但不在 scaffold 下发清单里（下发的只有 admin-up/doctor/
   precheck/run/seed-registry/migrate-cursor-index）。与 upgrade.sh 完全同构，且旁边的注释
   已经写着「在 Solo 源码目录重新构建」——**上下文对了，命令行本身仍然跑不了**。已改成
   `cd <solo 仓> && bash deploy/build-frontend.sh`。

⇒ 印证了建议 2 的判断：这**不是一次性笔误，是下发面固有的一类**。

### 验证

`bash deploy/check-upgrade-path.sh` → **73 passed, 0 failed**，第 7 段 18 条文档命令断言全绿。
顺带把 `docs/runbook/release-and-branching.md:132` 里写死的「49 条断言」改成不写死数字
（条数随规则增减，写死必旧；`CHANGELOG.md` 里那个 49 是发版当时的历史记录，不动）。
