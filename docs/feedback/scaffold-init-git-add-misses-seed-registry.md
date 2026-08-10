# 反馈：`init.sh` 的 initial commit 漏掉 `deploy/seed-registry.js`，clone 出去的项目起不了服务

> 来源：colony 派生项目（trade 的 ant 引擎迁移），2026-08-09 首次 scaffold 后核对 git 状态时发现。
> 依据：**本机实测**（solo v1.1.15）+ 逐行读 `init.sh`。
> 涉及：`deploy/scaffold/init.sh:478-484`（`git add` 的文件白名单）。
> 影响面：**每一个 scaffold 出来的项目**，无条件。
>
> 一句话：`git add` 用的是逐个文件名列举的白名单，`deploy/` 那行列了 6 个文件、漏了第 7 个；
> 本机能跑（文件在磁盘上），**但 clone 出去就缺**，而缺的正是「不跑它服务方法全 `-32601`」的那个。

---

## 一、实测现象

`init.sh colony` 跑完，报告 `✓ Git repo initialized with initial commit`。随后：

```console
$ git status --short
?? deploy/seed-registry.js

$ git check-ignore -v deploy/seed-registry.js
（无输出 —— 没有任何 ignore 规则匹配它）
```

也就是说它不是被有意排除的，是**没被 add 进去**。

## 二、根因

`init.sh:478-484`：

```bash
git -C "$NEW_DIR" add \
  api/publish/ api/autocheck/ api/library/ api/sample/ api/apps/ \
  docs/ .claude/ \
  deploy/run.sh deploy/precheck.sh deploy/admin-up.sh deploy/services.json deploy/solo-services.json deploy/seed.json \
  portal/ client/ \
  e2e/ \
  package.json .solo-version .gitignore
```

第 481 行手写了 6 个 `deploy/` 下的文件。而 `:277` 复制过来的是 7 个：

```bash
cp "$SCRIPT_DIR/seed-registry.js"      "$NEW_DIR/deploy/seed-registry.js"
```

`:309` 的日志甚至如实列出了全部 7 个（`Copied: deploy/run.sh, deploy/precheck.sh,
deploy/admin-up.sh, deploy/seed-registry.js, deploy/services.json, deploy/seed.json`），
**只有 `git add` 那份清单少一个**。两处清单各写一遍、靠人对齐，漏的就是这么来的。

## 三、后果不小

`seed-registry.js` 不是可选件。scaffold README 自己写着：

> 确保 Redis 在跑 → `seed-registry.js` 写服务注册表到 Redis(active_services)
> ↑ **关键：没这步 router 启动只认识 administrator，`user.*` / `planner.*` 等全 `-32601`**

所以症状是：**scaffold 的机器上一切正常**（文件在磁盘上，`run.sh` 找得到），
**换台机器 clone 就整栈方法找不到**。而 `-32601 Method not found` 读起来像是服务没写对、
或者注册表坏了，不会有人第一时间想到「仓库里少了一个文件」。

`upgrade.sh` 有一条「补缺失的 `seed-registry.js`」——说明这个文件缺失是**已知会发生**的情况。
但它补的是文件系统里的那份，补完仍然不在 git 里，下次 clone 照旧缺。

## 四、建议

1. **把 `deploy/` 那行改成整目录 add**（最小改动，且从形状上根治）：

   ```diff
   -  deploy/run.sh deploy/precheck.sh deploy/admin-up.sh deploy/services.json deploy/solo-services.json deploy/seed.json \
   +  deploy/ \
   ```

   `.gitignore` 已经排除了 `deploy/redis_data/` 之类的运行时产物（若还有遗漏，
   补 ignore 规则比维护 add 白名单可靠——**排除清单是收敛的，包含清单是发散的**）。

2. **如果坚持白名单**，至少让它与 `:309` 的日志共用一个数组变量，别两处手写。
   现在这两份清单没有任何机制保证一致，下次给 `deploy/` 加文件还会漏第二遍。

3. **加一道自检**：commit 后跑一次 `git -C "$NEW_DIR" status --porcelain`，
   有未跟踪文件就 `log_warn` 列出来。零成本，且能兜住将来任何新增的下发文件。

## 五、为什么值得改

这是「白名单式列举」的经典失效：清单和被清单描述的东西各自演化，加东西时漏一个不会报错。
下游项目 trade 踩过同一个形状——`.gitignore` 曾逐个文件名列举数据文件，加新引擎时漏掉了
整套 `ant_*`，后来改成「先全排除、再显式放行」才根治。

而这次的特殊之处在于**失效被推迟到了另一台机器上**：scaffold 的人看不到问题，
clone 的人看到的是一个和文件缺失毫无关联感的错误码。

---

## 处理结论（solo 侧）

实测属实，已修复（2026-08-10），按建议 1 改成整目录 `deploy/` add（不再维护并行清单），另外把建议 3 的自检也加了——`git commit` 后跑一次 `git status --porcelain --untracked-files=all`，非空就 `log_warn` 列出来，兜住将来任何新增的下发文件。建议 2（共用数组变量）随建议 1 的改法一并失去意义，不需要单独做。

验证：完整跑一次 `init.sh`，`git -C <NEW_DIR> status --short` 为空（无遗漏文件），`git ls-files deploy/` 确认 7 个文件（含 `seed-registry.js`）全部入库。
