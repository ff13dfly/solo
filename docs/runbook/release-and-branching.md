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

- **"无任何 tag、消费者骑 main"的根已拔除。** 发过哪些版**现查,别在这里维护清单**——
  手工副本必然变旧(这段曾停在 `v1.1.2`,而彼时实际已发到 `v1.1.17`,足足差了 15 个):

  ```bash
  git tag | sort -V | tail -5                    # 最近几个发布点
  git describe --tags --abbrev=0                 # 当前最新 tag
  git ls-remote --tags origin | grep -v '\^{}'   # 远端有哪些(本地有、远端没有 = 漏推)
  ```

  逐版本内容看 [`../planning/CHANGELOG.md`](../planning/CHANGELOG.md)(每个 tag 一条,含"下游 action")。
- **minor 与 patch 的判据**:**多了一个新的交付物** → minor(`v1.2.0` = 新增
  `client/extension-kit/` 浏览器插件半边);只加不破的修补 → patch。两者都仍受阶段一纪律约束
  (不删方法、不缩公开面、library API 只加)。破坏性的一律进 v2。
- **三者一致**:`package.json.version` = bundle 文件名 `solo.v{ver}.js` = 消费者 `.solo-version` = tag。
  发版后当场核一遍,对不上就是"忘了部署或忘了打 tag"。
  🔴 **正面规矩(2026-09-04 定,从 solo v1.2.9–11 悬空三版 + colony 0.1.6 无 tag 提炼)**:**版本号只在发版 commit 里动,
  且那个 commit 当场打 tag**——步进与 tag 是同一个动作的两半,不发版就别碰 `package.json.version`,功能提交里不许
  顺手步进(`4cac9f3` 就是把 `chore(release): v1.2.11` 混进 feature 提交、步进完收工,三个号至今靠事后补 tag)。
  已经悬空的号,修法是**在把版本号改成那个值的 commit 上补 tag**(`git log -S'"version": "X.Y.Z"' -- package.json` 找到它,
  `git tag -a vX.Y.Z <sha>`),不是在今天的 HEAD 上打——tag 要指向「声明这个版本」的那一刻。
  **为什么值得成规矩**:① `git describe` 能直接答「这个 bug 在哪版之间引入」;② CHANGELOG 每个版本节都对应真实坐标;
  ③ `upgrade.sh` 的 ACTION REQUIRED 横幅按版本号扫 CHANGELOG 节,默认每个节都真发过;④ 消费者 `.solo-version`
  指向的 bundle 只有从 tag 才能复现(`release-bundle.sh`),没 tag 的版本号 = 复现不出来的产物。
- **补丁升级已验证**:`v1.1.1` → `v1.1.2` 用一次性消费者真跑通(8/8 断言),做法见 [`upgrade-patch.md`](./upgrade-patch.md)。同 minor 补丁 = 一条 `deploy/scaffold/upgrade.sh`,零手动步骤。**2026-09-04 起这件事每次 push 都由 CI 做**:`upgrade-path` job 跑 `deploy/check-upgrade-path.sh`(init 一次性消费者 → [Project]/[Solo]/[Solo→Project] 三区放哨兵 → 伪装成上一 patch 版 → upgrade `--dry-run` / 真跑 / 再跑 → 49 条断言 + doctor/precheck ✗ 0),人工那次只剩历史记录价值。
- **仍待人触发的发布尾步**(§3-4/3-6,需基建/对外权限):从 tag build 的 bundle 归档到 Release/对象存储 + 通知消费者对齐 `.solo-version`。
- **之后**:阶段一(trunk+tags)继续推 v1.x;真要动破坏性架构时,再切 `release/v1.x` + main 转 v2。

> ⚠️ **打 tag 是发布声明**(推上去后消费者会依赖它),所以由人触发,不自动。`v1.1.0–v1.1.2` 已按此扣过扳机。
