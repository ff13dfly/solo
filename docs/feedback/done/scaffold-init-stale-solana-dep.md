# 反馈：`scaffold/init.sh` 仍依赖已被移除的 `@solana/web3.js` —— 新克隆的 solo 建不出项目

> 来源：overview 会话，2026-08-20。起因是要给**无终端使用经验的使用者**写「在自己 Mac 上
> 从零建一个 SOLO 项目」的上手文档，评估「让这类使用者自己 clone solo + 跑 `init.sh`」这条路是否可行。
> 依据：**全部为本机静态核对，自查**（solo 仓 HEAD 源码 + `api/package.json` /
> `api/package-lock.json` / `api/node_modules/.package-lock.json` 三方比对）。
> ⚠️ **未执行**「新目录 clone + `npm ci` + 跑 init.sh」的端到端复现——那会清掉本机
> `api/node_modules` 的现状证据。结论是从锁文件推出的，置信度高但请以一次干净复现收口。
> 涉及：`deploy/scaffold/init.sh:112`、`deploy/scaffold/package.json:7`、
> `api/router/handlers/keypair.js:15`。
>
> 一句话：`init.sh` 生成 Router 密钥那步 `require('$SOLO_DIR/api/node_modules/@solana/web3.js')`，
> 但 solo 自己早已把这个依赖换成 tweetnacl+bs58 并从 `api/package.json` 移除。
> 它在开发机上还能跑，**只是因为 `api/node_modules/` 里躺着一份没人清理的残留**——
> 换台机器、或任何人 `npm ci` 一次，`init.sh` 就在这一步崩掉。

---

## 一、三方比对

| 出处 | 有没有 `@solana/web3.js` |
|---|---|
| `api/package.json` `dependencies` | **无**（16 个：ali-oss / axios / bs58 / tweetnacl / …） |
| `api/package-lock.json`（635 个包） | **无**；根 `dependencies` 与 package.json 一致 |
| `api/node_modules/.package-lock.json`（687 个包） | **有**，`@solana/web3.js@1.98.4` |

差的 52 个包正是那棵 @solana 子树。锁文件不含 ⇒ 它不是任何已声明依赖的传递依赖，
而是历史上某次 `npm i` 装进去、后来从 package.json 摘掉却没清 `node_modules` 的**孤儿**。
`npm ci` 按 `package-lock.json` 重建 ⇒ 新树 635 个包，**没有它**。

## 二、根因：调用方没跟上被调用方的瘦身

`api/router/handlers/keypair.js:15` 的注释已经把这件事写清楚了：

```
// Preserve the @solana/web3.js Keypair surface this module used to expose, now backed by
// tweetnacl + bs58 (drops the ~14MB @solana dep from every bundle — it was the last consumer).
```

`it was the last consumer` —— 运行时确实是最后一个消费者了，但**构建期的 `init.sh` 没被算进去**：

```sh
# deploy/scaffold/init.sh:112
const { Keypair } = require('$SOLO_DIR/api/node_modules/@solana/web3.js');
```

两个问题叠在一起：

1. **依赖已删，调用未改** —— 这行还在向一个 solo 已经不再声明的包伸手。
2. **跨目录 reach-in** —— 它绕过 node 的解析，直接拼 `$SOLO_DIR/api/node_modules/...` 这个物理路径。
   正因为绕过了解析，`npm ls` / `depcheck` 这类工具也扫不出这处引用，删依赖时自然漏掉了。

顺带一处同源残留：`deploy/scaffold/package.json:7` 仍给**每个新派生项目**写入
`"@solana/web3.js": "^1.98.4"`。按上面那条注释，运行时已无消费者，等于让每个下游项目
白装 ~14MB。

## 三、症状会长成什么样

失败点在 `init.sh` 相当靠后（复制完 library/docs/portal/e2e 之后才生成密钥），
而脚本是 `set -euo pipefail` ⇒ **半成品目录留在盘上**，且 `init.sh` 对已存在的目标目录
直接 `log_error` 退出。所以第二次重试会撞上「Output directory already exists」，
**报错指向目录冲突，跟真正的根因（缺包）完全没有关联感**。

对新手尤其致命：他看到的最后两句是「目录已存在」，而不是「少了个模块」。

## 四、建议（按价值排序）

1. **`init.sh` 改用 solo 自己的密钥实现**。`api/router/handlers/keypair.js` 已经用
   tweetnacl + bs58 复刻了 Keypair 表面，且注释明确写着 secretKey 是标准 64 字节
   Ed25519（32 seed + 32 public）、与 @solana 布局一致。init 这段只用到
   `Keypair.generate()` → `secretKey` / `publicKey.toBase58()`，直接用 `tweetnacl` 的
   `nacl.sign.keyPair()` + `bs58.encode()` 即可，**不需要新增任何依赖**（两者都已在
   `api/package.json` 里）。
2. **清掉 `deploy/scaffold/package.json` 的 `@solana/web3.js`**，别再让下游白装 14MB。
   （若确认还有下游在用，则相反：把它加回 `api/package.json` 并说明理由——总之两处得对上。）
3. **`init.sh` 开头加前置自检**：把它依赖的外部件（node / lsof / 关键模块可解析性）
   在动盘之前一次性检掉，缺什么就报什么。当前是走到一半才炸，还留下半成品目录。
4. **失败时清理半成品目录**，或至少在 `Output directory already exists` 那句里提示
   「若上次 init 中途失败，请先删除该目录」——现在这句会把人带偏。
5. 更根上的：`api/node_modules/` 里现存 52 个孤儿包，说明本机树与锁文件已经漂了一段时间。
   在 CI 里加一道 `npm ci` 后跑 `init.sh` 的冒烟，这类「只在开发机上能跑」的路径就不会再漏。

## 五、对本次的处理

这次不打本地补丁——overview 侧的做法是绕开：由已有 solo 工作副本的机器跑 `init.sh`
生成项目后整体交付，使用者本机不 clone solo、不跑 init。所以**没有产生
`[Project]` 补丁，也没有升级时的 divergence 债**。

---

**处理结论**：**已落地 v1.2.4（2026-08-25）**，建议 1、2、5 采纳；3、4 记为待办。

### 干净复现做了，结论比本篇记的更严重

本篇 §来源自陈「⚠️ 未执行干净复现，结论是从锁文件推出的，请以一次干净复现收口」——
这次收口了，方法是**把所有 `package.json` 拷进隔离目录跑真 `npm ci`**（不在仓库里跑，
`npm ci` 会先清空 `node_modules`）。结果推翻了本篇 §一「`api/package-lock.json` 与
package.json 一致」这一格：

```
npm error `npm ci` can only install packages when your package.json
          and package-lock.json ... are in sync.
npm error Missing: mcp@0.1.0 from lock file
```

**根依赖 18 项确实对得上，坏的是 workspace 清单**：`core/mcp`（v1.1.10 加的服务）
从没进过 lock，`core/phaser`（目录早删）还留在里面；根 `package-lock.json` 更旧，
缺 5 个 workspace。两个 lock 自 `40c818a`（首次公开发布）起就没重生成过。

⇒ 于是 `npm ci` **在装依赖之前就整个拒绝**。本篇推断的「新树 635 个包、没有 @solana」
那一步压根到不了；派生方看到的「预检查找不到 dotenv」也不是 dotenv 的问题，是
npm ci 拒绝后什么都没装。

### 🔴 连带发现：solo 自己的 CI 一直是红的

`ci.yml` 的 7 个 job 里有 4 个第一步就是 `npm ci`（`working-directory: api`）。查 GitHub
Actions 历史：**近期每一次运行都失败**，失败步骤全是 `Run npm ci` / `install api deps`。
也就是说 CLAUDE.md §4 记的「P0 CI 已落地」名存实亡——jest 与 static gate 在 CI 上
从来没真跑过，全靠本地手跑兜着。本篇 §四.5 说「在 CI 里加一道 npm ci 冒烟」，
其实 CI 早就有这道，只是它一直红着没人看。

### 落地内容

1. **两个 lock 重生成**（`npm install --package-lock-only`，不动 `node_modules`），
   各自用隔离目录的真 `npm ci` 验过：api 树 578 包、根树 385 包，均成功。
2. **`init.sh` 改用 tweetnacl + bs58**（建议 1，不新增依赖）。实测新旧等价：
   公钥 44 字符 base58、secretKey 64 字节，喂给 router 的 `fromSecretKey()` 公钥一致、
   签名/验签往返通过 ⇒ **老项目的 `.keypair` 文件继续可用，不需要轮换密钥**。
3. **`deploy/scaffold/package.json` 删掉 `@solana/web3.js`**（建议 2），
   `run.sh` 里那句提到它的注释一并更正。
4. **本机孤儿树清除**（建议 5 的前半）：`npm prune` 移除 164 个不在 lock 里的包，
   `@solana/` 整棵（14MB）消失，顶层包数 445 → 405。清理后全量回归：CI 白名单
   130 套 / 2108 测试绿、static 全闸绿、`build.sh` 产物正常。
5. **`npm ci` 冒烟固化成发版门禁**（建议 5 的后半），连同「必须在隔离目录跑」的理由
   写进项目 `CLAUDE.md` §6。

### 未做，记为待办

- **建议 3（init.sh 前置自检）**、**建议 4（失败时清理半成品目录 / 改进那句误导性提示）**
  本轮没做。它们与本篇主缺陷正交，属于 init.sh 的健壮性改进，另开一轮。
