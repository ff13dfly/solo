# Runbook · 同 minor 内打补丁升级(v1.1.x → v1.1.y)

> 适用:`.solo-version` 已在某个 v1.1.x 的消费项目,要升到**同一 minor 的更高补丁**(如 `v1.1.1` → `v1.1.2`)。
> 与 [`upgrade-v1.0-to-v1.1.md`](./upgrade-v1.0-to-v1.1.md)(**跨 minor**,带 seed-registry / redis-stack 等手动步骤)不同:
> **补丁升级零手动步骤 —— 一条 `upgrade.sh` 命令。** 因为同 minor 内守"只加不破"纪律(见 release-and-branching §5)。
> 校对基准:**2026-06-20,已用 `v1.1.1` → `v1.1.2` 在一次性消费者上真实跑通验证(见 §3,8/8 断言通过)。**

---

## 1. 一条命令

```bash
cd /path/to/solo
git checkout v1.1.2                                   # 站在目标 tag 上;upgrade.sh 读 package.json.version 决定升到哪
bash deploy/scaffold/upgrade.sh /path/to/<project> --dry-run   # 先预览(不写盘)
bash deploy/scaffold/upgrade.sh /path/to/<project>            # 确认后实跑
```

`upgrade.sh` 全自动做的事(**[Project] 文件一律不动**):

| 动作 | 细节 |
|------|------|
| 构建 + 覆盖 bundle | `deploy/build.sh` → `api/publish/solo.v{ver}.js`,写 `.solo-version`,**清旧 bundle** |
| 整目录替换源码 | `api/{library,sample,autocheck}`(`rm + cp`,上游删的文件会同步删) |
| 前端 tarball | system / mobile 钉新版 + 清旧;**operator 是源码分发,永不碰** |
| deploy 脚本检测 | `run.sh`/`precheck.sh`/`admin-up.sh`/`seed-registry.js`:**stock 才覆盖**;项目改过的不动,新 stock 存成 `*.solo-v{ver}.new` 供 diff |
| 升级后自检 | 版本号、bundle、前端 tarball 一致性逐项核 |

> ⚠️ **前端**:默认 `FRONTEND_BUILD=auto`(缺当前版 tarball 才构建)。要把 system/mobile 也升到新版,别用 `skip`;用 `auto`/`force` 让它构建出 `system.v{ver}.tar.gz` / `mobile.v{ver}.tar.gz`。

**永不触碰([Project] 所有)**:`.env` · `.keypair` · `api/seed.json` · `api/apps/` · `portal/operator/` · `client/plugin/` · `deploy/services.json` · `deploy/solo-services.json` · `deploy/seed.json` · `e2e/`。

---

## 2. 补丁升级 vs 跨 minor 升级

| | 跨 minor(v1.0 → v1.1) | 补丁(v1.1.x → v1.1.y) |
|---|---|---|
| 手动步骤 | seed-registry 接线、redis-stack 切换(见那篇 §2) | **无** |
| 命令 | `upgrade.sh` + 手动补 | **只 `upgrade.sh`** |
| 风险 | 有破坏点需用 e2e/autocheck 兜底排查 | 向后兼容,只加不破 |
| 升级后必做 | 逐项验证(那篇 §3) | 重启 + 跑一遍自有 e2e 即可 |

---

## 3. v1.1.1 → v1.1.2 实测(本 runbook 的依据)

2026-06-20 用 `init.sh` 派生一个一次性消费者(钉 `v1.1.1`、`FRONTEND_BUILD=skip`),再用 `v1.1.2` 源对它跑 `upgrade.sh`。逐项断言:

| 断言 | 结果 |
|------|------|
| `.solo-version` 由 `v1.1.1` 翻到 `v1.1.2` | ✓ |
| 新 bundle `solo.v1.1.2.js` 落地 | ✓ |
| 旧 bundle `solo.v1.1.1.js` 被清 | ✓ |
| **消费者多拿到 `api/library/contract.js`**(v1.1.2 新增的返回契约引擎)—— lib 文件 29 → 30 | ✓ |
| 消费者 bundle 与「从 `v1.1.2` tag 新建的 artifact」**字节一致** | ✓ |
| `.env` / `.keypair` 等 [Project] 文件零改动 | ✓ |
| stock 的 deploy 脚本被识别为 `unchanged`,不乱覆盖 | ✓ |
| `upgrade.sh` 升级后自检通过 | ✓ |

**结论**:同 minor 补丁升级 = 纯 `upgrade.sh`。消费者获得的是 v1.1.2 的新能力(本例:`library/contract.js` 返回契约引擎 + bundle 内各服务的 `returns_schema` 修正 + `planner.todo.sync`/`collection.payment.list` 两个 bug 修复),**[Project] 侧零改动**。v1.1.2 无破坏性变更,任何 v1.1.x 可直接平滑升级。

---

## 4. 破坏性变更登记(逐版累积)

> 同 minor 内**理应无破坏性变更**(release-and-branching §5 纪律)。若某次补丁仍引入了消费者必须感知的变化,记在这里。

- **v1.1.1 → v1.1.2**:无破坏性变更。纯增量(`returns_schema` 全量补齐 + 契约守卫 + 两个 bug 修复)。详见 [`../planning/CHANGELOG.md`](../planning/CHANGELOG.md) 的 v1.1.2 条目;剩余非阻塞契约债见 [`../planning/return-contract-debt.md`](../planning/return-contract-debt.md)。
