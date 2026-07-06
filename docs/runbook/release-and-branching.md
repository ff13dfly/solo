# Runbook · 发版与分支管理（有消费者后怎么不混乱）

> 适用:SOLO 已经有消费项目（runner / wavely / mso…）在用,而 SOLO 自身还在推进。
> 核心一句话:**把"开发"和"发布"物理分开 —— 消费者钉 tag,不骑 main。**
> 配套:升级见 [`upgrade-v1.0-to-v1.1.md`](./upgrade-v1.0-to-v1.1.md);版本边界见 [`../planning/VERSION.md`](../planning/VERSION.md)。

---

## 0. 为什么会乱（先认清根因）

SOLO 分发的不是 git/npm 依赖,而是**一个 `solo.v{ver}.js` bundle + cp 过去的 `library/sample/autocheck` 源码**。
消费者 `.solo-version` 若指向一个**没有 tag 的 main**,就等于骑一根会动的线 —— 你这边改一下,他们下次 cp 就变了。
**乱的唯一根因 = 没有稳定发布点。** 打 tag + 让消费者钉 tag,80% 的混乱当场消失。

---

## 1. 心智模型

```
 开发线(main)  ───●───●───●───●───►   持续推进(阶段二后 = v2,可破坏)
                  │           │
            tag v1.1.0   tag v1.1.1        ← 发布点(不可变,可复现 build)
                  │
        release/v1.1 ──○──○──►            ← 维护线(只修不破),阶段二才需要
                  │
         消费者 .solo-version = v1.1.x     ← 钉 tag,按 upgrade runbook 升,从不跟 main
```

- **版本号** = `package.json.version` + bundle 文件名 + 消费者 `.solo-version`,三者一致。
- **发布物** = 从 **tag** build 出的 bundle,**归档**(GitHub Release / 对象存储),消费者从这取,不从你工作树 cp。

---

## 2. 分两阶段,别一上来就 git-flow

### 阶段一(现在 → v2 破坏性改动开始前):**trunk + tags,最省**
- main 保持**向后兼容**(只加不破:不删方法/introspection,library API 只加签名)。
- 每个发布点从 main 打 tag:`v1.1.0`、`v1.1.1`…
- **不需要 release 分支。** 纪律就一条:**破坏性改动暂不进 main**(攒着,切 v2 时一起来)。
- 单人 + AI 辅助最适合这档。

### 阶段二(要动 v2 破坏性改动时):**切 release 分支**
- 从 `v1.1.0` tag 拉 `release/v1.1`;
- **main 转 v2**(package.json → `2.0.0-dev`,破坏性随便上);
- v1.1 的 bugfix 在 `release/v1.1` 上做 → tag `v1.1.x` → **cherry-pick 到 main**(防 main 漏修);
- 消费者**永不被动吃 v2**;升 v2 走单独的 v2 升级 runbook。

> VERSION.md §5.3 已经写了这套("封板后 bugfix 走 tag 分支 cherry-pick;main 即 v2")——本文是它的可执行版。

---

## 3. 发一个版本(cut a release)的标准步骤

```bash
SOLO=/path/to/solo; VER=v1.1.0
cd "$SOLO"

# 1) 工作树干净 + 想发的改动都已 commit(CI 各闸绿:static / hermetic / e2e / portal-tsc / frontend-build)
git status --porcelain        # 必须为空
bash deploy/build.sh          # 顺手验证可 build

# 2) package.json version 与要发的 tag 一致
node -e "console.log(require('./package.json').version)"   # 应 = 1.1.0

# 3) 打 tag(从当前已验证的 commit)
git tag -a "$VER" -m "release $VER"
git push origin "$VER"        # tag 推上去 = 发布点公开

# 4) 从 tag build 出可复现 bundle + 前端 bundle,归档(消费者从这取,不从你工作树)
git checkout "$VER"
bash deploy/build.sh            #   api/publish/solo.js → 归档为 solo.${VER}.js
bash deploy/build-frontend.sh  #   portal/publish/*.tar.gz + client/publish/*.tar.gz(钉 ${VER},自动清旧)
#   把 solo.${VER}.js 与三个前端 tarball 一并上传 Release/对象存储
git checkout main

# 5) CHANGELOG 加一条(见 docs/planning/CHANGELOG.md):$VER 带来什么、有无破坏
# 6) 通知消费者:可升级到 $VER(附 CHANGELOG + upgrade runbook)
```

> 消费者升级 = 换 `.solo-version` + cp 新 bundle + cp 前端 tarball + 同步 library/sample/autocheck,见 upgrade runbook。**他们决定何时升,不是你 push 一下他们就变。**

---

## 4. 修复往哪走(防止 main 和 release 漂移)

- **阶段一**:直接在 main 修 → 打新 `v1.1.x` tag。简单。
- **阶段二**:
  - 消费者在 v1.1 撞到的 bug → 在 `release/v1.1` 修 → tag `v1.1.x` → **`git cherry-pick` 到 main**(forward-port,别让 main 漏修)。
  - 只在 main(v2)出现的问题 → 只修 main,不回 release。
  - 每个修复问自己一句:**"这条 release 和 main 都要吗?"** —— 要就 cherry-pick,不要就记下原因。

---

## 5. 兼容纪律(踩了就乱,逐条守)

| 纪律 | 为什么 |
|---|---|
| **release 线(同一大版本内)只修不破** | 消费者 cp bundle + library 源码,破了升级即炸 |
| **library/sample API 只加不改不删** | 消费者 app `require` 它;改签名 = 他们的 app 编译/运行炸 |
| **introspection 方法不删、公开白名单不缩** | 消费者前端/集成方依赖既有方法面 |
| **每个 tag 配 CHANGELOG 一条** | 消费者升级前要知道这次带什么、风险多大 |
| **CI 各闸在发布点必须绿** | release 是生产底座,回归比 main 更不可容忍 |
| **破坏性改动只进 v2(main 阶段二)** | 把"破"集中到一次大版本,而不是散落毒害 release |

---

## 6. 当前状态(阶段一:trunk + tags 已就位)

- **已有 tag(均已推送 origin)**:`v1.1.0` · `v1.1.1` · `v1.1.2`。"无任何 tag、消费者骑 main"的根已拔除。
  - `v1.1.0` — AI 自动化平台 + 治理线(minor 基线)。
  - `v1.1.1` @ `af472ae` — idle event-consumer 空转热修。
  - `v1.1.2` @ `35173dd` — 返回契约线封闭(`returns_schema` 全量 + 契约引擎/守卫 + 两个 bug 修复)。
- **三者一致**:`package.json.version` = bundle 文件名 `solo.v{ver}.js` = 消费者 `.solo-version` = tag。`v1.1.1`/`v1.1.2` 的 bump 见 CHANGELOG 各条目。
- **补丁升级已验证**:`v1.1.1` → `v1.1.2` 用一次性消费者真跑通(8/8 断言),做法见 [`upgrade-patch.md`](./upgrade-patch.md)。同 minor 补丁 = 一条 `deploy/scaffold/upgrade.sh`,零手动步骤。
- **仍待人触发的发布尾步**(§3-4/3-6,需基建/对外权限):从 tag build 的 bundle 归档到 Release/对象存储 + 通知消费者对齐 `.solo-version`。
- **之后**:阶段一(trunk+tags)继续推 v1.1.x;真要动破坏性架构时,再切 `release/v1.1` + main 转 v2。

> ⚠️ **打 tag 是发布声明**(推上去后消费者会依赖它),所以由人触发,不自动。`v1.1.0–v1.1.2` 已按此扣过扳机。
