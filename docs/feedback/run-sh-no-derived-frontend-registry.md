# 反馈：`run.sh` 预期了"派生项目自有前端"却没给注册口子，四个项目各抄了一段几乎相同的代码

> 来源：colony 派生项目，2026-08-15 给 ant 引擎加控制台前端（`client/ant`，Vite+React）时撞到。
> 依据：**colony 一侧全部本机实测**（solo v1.1.15）；runner / finance / trend 三家的现状是
> **读它们仓库里的 `deploy/run.sh` 得到的**（引用，非我实测其运行时行为）。
> 涉及：`deploy/run.sh` 第 10 节（Frontend servers）、`deploy/upgrade.sh` 的覆盖行为。
> 影响面：**任何有自有前端的派生项目**——从现状看这不是少数派，是多数派。
>
> 一句话：bundle 自己在注释里写明"派生项目常有不走 serve_frontend 的前端"，还专门把端口守卫
> 抽成函数供它们复用，却没有让它们**登记**的地方 ⇒ 只能改只读区，而 `upgrade.sh` 会覆盖它。

---

## 一、现状：框架预期到了，但只给了一半

`run.sh` 里这段注释是 bundle 自己写的（v1.1.15，第 338-341 行）：

```sh
# ── 前端端口守卫(独立函数,供派生项目自有前端复用)────────────────────────
# 派生项目常有不走 serve_frontend 的前端(自有 Vite 应用直接 serve dist/ 等)。
# 抽成函数后它们在自己的启动段里调这两个,就能获得与 tarball 前端同等的保护;
# 否则那些前端仍是"端口被占 → serve 静默换随机口"的重灾区(finance/trend 均实测)。
```

`fe_assert_port_free` / `fe_confirm_bound` 确实抽出来了，**但"它们自己的启动段"只能写在
`run.sh` 里面**——而 `serve_frontend` 的调用点是硬编码的三行（第 422-424 行）：

```sh
serve_frontend "operator" "$ROOT_DIR/portal/publish/operator.${SOLO_VER}.tar.gz" "${PORTAL_OPERATOR_PORT:-}"
serve_frontend "system"   "$ROOT_DIR/portal/publish/system.${SOLO_VER}.tar.gz"   "${PORTAL_SYSTEM_PORT:-}"
serve_frontend "mobile"   "$ROOT_DIR/client/publish/mobile.${SOLO_VER}.tar.gz"   "${CLIENT_MOBILE_PORT:-}"
```

没有第四个位置可放，也没有"扫描某目录 / 读某个 env 前缀"的机制。

## 二、后果：四家各抄一段，且都是 `upgrade.sh` 的必然牺牲品

| 项目 | 自有前端 | 位置 |
|---|---|---|
| runner | `portal/runner` @3680 | `deploy/run.sh:405-429` |
| finance | monitor @3760、insight @3810 | `deploy/run.sh:376-433`（还顺手改了 `serve_frontend` 签名，加了第 4 个参数 `srcdist`）|
| trend | `client/scope` @3950 | `deploy/run.sh:673-680` |
| colony | `client/ant` @3790 | 本次新增 |

四段代码结构一致：判断目录存在 → 缺 dist 就 `npm install && npm run build` → 写 `config.js` →
`fe_assert_port_free` → `serve dist -p <port> -s` → 塞进 `CHILD_PIDS`/`FE_*` 数组。
差异只在目录名、端口变量名、以及**要不要复用端口守卫**（runner 那段就没调，等于没有保护）。

**它们全都活在只读区**。`deploy/upgrade.sh` 覆盖 `run.sh` 之后：

- 轻则前端静默消失（端口没人监听，`.env` 里的变量成了死配置）；
- 重则像 finance 那样连 `serve_frontend` 的签名改动一起丢掉，operator portal 退回 tarball 版，
  **本项目定制的 UI 一起消失**，而 run.sh 照常打印"启动成功"。

这也是每次升级 bundle 时 `DIVERGED` 提示的常客——但提示只说"文件被改过"，
不会告诉你**改的是一段没有它前端就起不来的必需代码**。

## 三、建议（按价值排序）

**① `.env` 驱动的注册表（最小改动，向后兼容）**

约定一个前缀，`run.sh` 扫出来循环处理即可：

```sh
# .env
FRONTEND_ANT_DIR=client/ant
FRONTEND_ANT_PORT=3790
FRONTEND_SCOPE_DIR=client/scope
FRONTEND_SCOPE_PORT=3950
```

```sh
# run.sh —— 放在三行 serve_frontend 之后
for _v in $(compgen -v | grep '^FRONTEND_.*_DIR$'); do
    _name=$(echo "$_v" | sed 's/^FRONTEND_//; s/_DIR$//' | tr 'A-Z' 'a-z')
    serve_src_frontend "$_name" "$ROOT_DIR/${!_v}" "$(eval echo \$FRONTEND_${_name^^}_PORT)"
done
```

`serve_src_frontend` 就是把四家抄的那段收编成一个函数（缺 dist 自动构建、注入 config.js、
端口守卫、登记进 `FE_NAMES`）。派生项目从此**一行代码都不用改 run.sh**。

**② 退一步：至少给一个 hook 文件**

```sh
[ -f "$ROOT_DIR/deploy/frontends.local.sh" ] && . "$ROOT_DIR/deploy/frontends.local.sh"
```

不进只读区、不被 upgrade 覆盖。比 ① 弱（每家仍要自己写 serve 逻辑），但能立刻止血。

**③ 无论选哪个，`config.js` 的注入逻辑要一起收编**

现在 `serve_frontend` 内部写 config.js，自有前端只能把那 5 行复制出来。
一旦 bundle 改了注入内容（比如 v1.1.15 加的 `__SOLO_SYSTEM_DESCRIPTION__`），
四家的副本**不会跟着更新**，症状是新字段在自有前端里永远读不到。

**④ 文档**：`portal/README.md` 与 `client/README.md` 都只讲了 bundle tarball 的形态，
没有一句提到"自有源码前端怎么接进 run.sh"。①/② 落地后补一节。

---

## 处理结论

**triage 2026-08-16：核实属实（注释自认预期、三行硬编码、无注册口子——与当前 scaffold
一致），建议 ①+②+③ 全部落地，④ 的文档落在 .env 模板与 run.sh 注释里。**

已做（`deploy/scaffold/run.sh` + `init.sh`）：

1. **`.env` 注册表**（建议 ①）：`FRONTEND_<NAME>_DIR` + `FRONTEND_<NAME>_PORT` 声明即
   接入。run.sh 在三行 serve_frontend 之后 `compgen -v` 扫描并循环调新函数
   `serve_src_frontend`：目录不存在点名警告跳过、缺 dist 自动 `npm install + npm run build`
   （失败 fail fast 并指向构建日志）、注入 config.js、`fe_assert_port_free` /
   `fe_confirm_bound` 同款守卫、登记进 `FE_NAMES`（进 dashboard）。
   ⚠️ 实现坑：本文示例代码里的 `${_name^^}` 是 bash 4 语法，macOS 的 bash 3.2 直接
   语法错——改用 `tr` + `${!var:-}` 间接展开（bash 3.2 实测通过）。缺 PORT 的 DIR 声明
   会被点名警告，不静默。
2. **hook 文件**（建议 ②）：注册表循环之后 source `deploy/frontends.local.sh`（存在才加载）。
   不随 bundle 下发、upgrade 永不覆盖；文件里可直接用 run.sh 的函数与数组（注释言明）。
   注册表覆盖不了的形态（自定义 serve 命令、finance 那种改 serve_frontend 签名的需求）走它。
3. **config.js 注入收编**（建议 ③）：注入逻辑从 serve_frontend 抽成 `write_fe_config <dir>`，
   tarball 前端与源码前端共用同一份——bundle 以后增删注入项（如 v1.1.15 的
   `__SOLO_SYSTEM_DESCRIPTION__`），自有前端自动跟上，不再有会过期的副本。
4. **文档**（建议 ④）：init.sh 生成的 `.env` 模板带注释示例（含「run.sh 属只读区」的
   为什么）；run.sh 注册表段注释完整交代背景。portal/client README 的正式章节等
   v1.1.16 发版时随 CHANGELOG 一起补。

验证：`bash -n` 双跑通过；注册表循环的变量构造（compgen -v / 间接展开 / 大小写转换 /
缺 PORT 分支）在 bash 3.2 实测；构建-起服务的端到端路径待任一派生项目（colony 的
`client/ant` 是现成对象）升级后实测。

**给四个项目的动作项**：升级拿到新 run.sh 后，把各自 DIVERGED 的前端段删掉、改成 `.env`
两行声明（runner 顺带补上它此前缺失的端口守卫）；finance 的 `srcdist` 签名改动如仍需要，
挪进 `frontends.local.sh`。
