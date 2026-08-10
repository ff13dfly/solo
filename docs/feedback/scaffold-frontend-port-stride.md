# 反馈：前端端口自动分配的步长是 150，且只看运行时占用——多项目同台会一路飘出号段

> 来源：colony 派生项目（trade 的 ant 引擎迁移），2026-08-09 scaffold 时发现。
> 依据：**本机实测**（solo v1.1.15，同台 6 个 Solo 派生项目）+ 逐行读 `init.sh`。
> 涉及：`deploy/scaffold/init.sh:322-335`（前端三件套端口探测）。
> 参照：同一族问题的前作 [`redis-port-ownership.md`](./redis-port-ownership.md)。
>
> 一句话：**「此刻没人监听」不等于「没人声明」**——Redis 那次已经上收过这条判据，
> 前端端口这里还是老样子；再叠上 150 的步长，扫描会跳过所有实际可用的起点。

---

## 一、实测现象

本机（overview / trend / runner 三个栈常驻在跑，finance / ladder / wavely 已声明但未启动）
scaffold 第七个项目：

```
✓ Frontend ports: operator=4050 system=4100 mobile=4150 (auto-selected, not currently in use)
```

而本机的多项目端口台账（`overview/mind/ref/ports.md`）约定前端在 **36xx–39xx**、
每项目一个起点、三个前端间隔 50。**4050 已经出了号段**，且台账里 3640 / 3690 / 3740
三个端口全部空闲、无人声明——`lsof` 实测三个都没人监听。

也就是说：**有正确答案，扫描却够不着。**

## 二、根因

`init.sh:322-331`：

```bash
FE_PORT_BASE=3600
while :; do
    _fe_conflict=0
    for _off in 0 50 100; do
        lsof -i:"$((FE_PORT_BASE + _off))" &>/dev/null 2>&1 && { _fe_conflict=1; break; }
    done
    [ $_fe_conflict -eq 0 ] && break
    FE_PORT_BASE=$((FE_PORT_BASE + 150))     # ← 步长
    [ $FE_PORT_BASE -gt 5000 ] && log_error "No free frontend port trio found below 5000"
done
```

两个独立的问题叠在一起：

**(a) 步长 150 让候选起点只有 4 个。** 三个前端间隔 50、整组步进 150，所以起点只能是
`3600 / 3750 / 3900 / 4050 / …`。本机 3600 被占（runner）、3750 撞 finance 的 3760、
3900 撞 trend 的 3900 —— 一路跳到 4050。而 3640 / 3690 / 3740 这种「间隔 50 的下一个起点」
它**从不试探**。号段 36xx–39xx 里真正可用的位置，扫描逻辑看不见。

**(b) 判据是 `lsof`，也就是"此刻在监听"。** 没启动的项目（本机的 finance / ladder /
wavely）声明的端口一律视作空闲。于是新项目会选中别人已声明的端口，两边 `.env` 都写着它，
**先起的拿到、后起的静默失败**——`run.sh` 的 `serve_frontend` 遇到端口被占只打一行 warn，
栈照常起来。本机的 overview 就是这么两个前端好几个月没起来过，直到有人去查才发现。

`redis-port-ownership.md` 上收的正是同一条判据的另一面（`redis-cli ping` 的退出码被当成
"我的实例在跑"，导致后起的栈静默接管先起者的实例）。那次在 `run.sh` 加了归属校验；
**`init.sh` 这条分配路径没有对应的修正。**

## 三、建议

按价值排序：

1. **允许显式指定起点**（最有价值，改动最小）：

   ```bash
   FE_PORT_BASE=${FE_PORT_BASE:-3600}
   ```

   加一行默认值语法即可，用法 `FE_PORT_BASE=3640 bash deploy/scaffold/init.sh colony`。

   这条之所以排第一：**端口分配需要全局视角，而 `init.sh` 结构上不可能有**（它只能看到
   自己这台机器此刻的监听状态，看不到别的项目声明了什么）。与其把判据做得更聪明，不如
   把决策权交给确实掌握全局的人/文档。同 `FRONTEND_BUILD` 已有的环境变量约定一致。

2. **步长从 150 改成 50**：让扫描能落在 3640 / 3650 / 3690 这类位置上。
   代价是相邻两个项目的端口会交错（A=3640/3690/3740，B=3650/3700/3750），可读性略差，
   但至少**能找到解**。若嫌交错难看，退一步用步长 10（3600 → 3610 → 3620）也比 150 好——
   本机台账用的正是 10 的间隔（3600 / 3610 / 3620 / 3640…）。

3. **把选中的端口写进日志时标明判据**：现在写的是 `(auto-selected, not currently in use)`，
   建议改成 `(auto-selected by runtime probe — does NOT check other projects' .env declarations)`。
   这句话本身就能让第一次 scaffold 的人意识到要回去核对台账。低成本、纯文案。

4. **（可选，优先级最低）扫描时一并读同级目录其它项目的 `.env`**。能真正解决 (b)，
   但要假设"派生项目都是 Solo 目录的兄弟目录"——这个假设不该由框架来做。
   建议 1 已经覆盖了这个需求的实用部分。

## 四、为什么值得改

Solo 的 scaffold README 明确写着「**多项目同台运行：完全支持**」，而这是本机第 7 个派生
项目。端口分配在这台机器上已经出过两次事（3650/3700 被三个项目共用至今；Redis 6381 被
overview 与 trend 共用，trend 的数据实际持久化在 overview 仓库的 rdb 里，已于 2026-08-05 迁离）。

两次的病根是同一个：**分配那一刻的判据是"运行时占用"，而端口冲突的真正单位是"声明"。**
Redis 那侧已经补了归属校验，前端这侧还差一半。

本次的实际代价很小——手改 `.env` 三行、回台账登记。但那是因为**恰好有人知道台账存在**。
`init.sh` 的输出（`auto-selected, not currently in use`）读起来像是已经处理妥当了，
不知道台账的人不会去改，冲突就留到某天某个前端静默不起来。

---

## 处理结论（solo 侧）

实测属实，已修复（2026-08-10），三条建议里价值最高的两条都落地了：

1. **`FE_PORT_BASE=${FE_PORT_BASE:-3600}`**（建议 1）：允许显式指定起点。
2. **步长从 150 改成 10**（建议 2 的保守版，未采用"改 50"那个折中）：本机台账（`overview/mind/ref/ports.md`）本就用 10 的间隔，直接对齐，且不产生"两个项目端口交错"的可读性代价。
3. **日志文案说明判据**（建议 3）：改成 `(auto-selected by runtime probe — does NOT check other projects' .env declarations; cross-check your port ledger, or pass FE_PORT_BASE=<n> to pick explicitly)`。
4. 建议 4（扫描时读同级目录 `.env`）按反馈自己的判断跳过——不该假设派生项目是 Solo 的兄弟目录，建议 1 已覆盖实用部分。

验证（本机 7 个 Solo 派生项目同台在跑的真实环境下）：不带 `FE_PORT_BASE` 跑一次，落在 3610/3660/3710（3600 被占，10 步长第一次重试即命中空位，不再跳到 4050）；带 `FE_PORT_BASE=3640` 跑一次，3640/3690/3740 三个端口经 `lsof` 核实确有其它栈在监听，扫描正确退避到 3660/3710/3760——env 覆盖与新步长都按预期工作。
