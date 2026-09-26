# storage 的 `UPLOAD_DIR` 默认值逃出项目根，落进所有项目的公共父目录

- **来源**：catalog，2026-09-22，评估「自己写的 CAS 能不能换成 storage 服务」时实测撞到
- **场景**：派生项目第一次真正用 `storage.asset.upload`。上传成功、`resolve` 正常、
  字节也确实落盘了 —— 只是落在了**项目外面**。
- **依据分类**：以下**全部为本次实测**（catalog 栈，bundle v1.2.14，本机 macOS，
  provider=local 进程内挂载）。末尾「影响面」一节是对同机 12 个仓库的现扫。
- **级别**：无门禁、无报错、无日志告警 —— **静默**。

## 实测现象

```
项目根        /Users/fuu/Desktop/AI/catalog
upload 返回   key: "5b/71/38/f21471ff….png"      ← 布局正确
字节实际落在   /Users/fuu/Desktop/AI/uploads/assets/5b/71/38/f21471ff….png
                                  ^^^^^^^^^^^^^^^^ 项目根的**上一级**
```

`.env` 里没有 `UPLOAD_DIR`（走默认）。上传 13ms、`resolve` 给出可用 URL、
`storage.asset.delete` 也正常删掉 —— **全链路没有任何异常信号**。

## 根因

bundle 里两处同样的算法（`api/publish/solo.v1.2.14.js`，grep `UPLOAD_DIR`）：

```js
UPLOAD_DIR || require("path").join(__dirname, "../../../uploads/assets")
```

打包成单文件 bundle 之后 `__dirname` = `<project>/api/publish`：

```
__dirname        <project>/api/publish
../              <project>/api
../../           <project>            ← 项目根在这一级
../../../        <project 的父目录>    ← 默认值落在这里
```

⇒ **往上多走了一级**。源码树里 storage 服务大概在 `api/apps/storage/logic/` 一类的位置，
那时 `../../../` 正好是项目根；**打包后层级变了，这个相对路径没跟着变**。

## 后果（两个，都不报错）

1. **项目自己的备份备不到它。** 备份脚本按「项目的数据都在项目目录里」写，
   catalog 的 `deploy/backup.sh` 打包的是 `$ROOT/uploads` —— storage 的字节在 `$ROOT/../uploads`，
   整个不在快照里。恢复时 metadata（Redis）还在、`resolve` 照样返回 URL，**只是字节没了**。
2. **同机所有派生项目写同一个目录。** 现扫本机 `~/Desktop/AI/` 下 **12 个仓库都带 bundle**
   （awareness / backup / catalog / colony / finance / ladder / learning / overview /
   runner / steward / trend / wavely），它们的 `../../../uploads/assets` 是同一个路径。
   在 N100 上（项目都在 `/home/web/AI/<project>/`）同理 ⇒ `/home/web/AI/uploads/assets`。
   资产按 sha256 寻址所以不会互相覆盖，但**数据边界没了**：迁一个项目不会带走它的字节，
   删一个项目也不知道哪些字节是它的。

## 建议（按价值排序）

1. **默认值改成项目根**：`../../uploads/assets`。一处两行，对已有部署的影响是
   「下次重启后新资产落到新位置」—— 需要在 CHANGELOG 里标 ACTION REQUIRED，
   并给一句迁移提示（`mv <parent>/uploads/assets/* <project>/uploads/assets/`，
   CAS 布局相同，直接搬即可）。
2. **启动时把解析后的绝对路径打进日志**（一行 info）。这类"配置默认值算错目录"的问题
   只要路径出现在启动日志里就会被当场发现；现在它一个字都不打。
3. **退一步：如果共享父目录是有意设计**，那也该在 `.env` 模板的 storage 那一节写明
   「默认落在项目的父目录，各项目共享」——现在那几行注释只讲 provider 与密钥，
   一个字都没提落盘位置，读的人只会默认它在项目里。

## 派生项目侧的处理

catalog 已在 `.env` 里显式指定 `UPLOAD_DIR='<项目>/uploads/assets'`（不改只读区），
并把依据写在那几行注释里。

## 处理结论

**2026-09-26 · 部分落地（v1.2.16：只告警、不改行为）；默认值的改动与存量迁移待定，本篇留在顶层。**

### 核实：根因属实，影响比原文写的大；原文给的修法有一处不对

- **根因属实**：`api/apps/storage/config.js:20` 的 `path.join(__dirname, '../../../uploads/assets')`
  按源码深度写（`api/apps/storage/` 往上三级 = 项目根），打包后 `__dirname = api/publish/` 只有两级深，
  于是落到项目的父目录。catalog、steward 装的 v1.2.14 bundle 里都是这一行。
- 🔴 **线上已经真实发生**（2026-09-26 只读查看）：N100 的 `/home/web/AI/uploads/assets` 有
  **1049 个对象（加 `.meta` 共 2098 个文件）、263MB**，写入时间 2026-08 到 2026-09-24，仍在写。
  N100 上 10 个 Solo 项目里**只有 finance** 显式设了（`LOCAL_OSS_ROOT`）。`.meta` 里只有
  `contentType/etag/size`，**看不出每个对象属于哪个项目**，要按项目归属得去各自的 Redis 里对 `STORAGE:` 记录。
  ⇒ 原文后果 1（项目备份备不到它）在线上是现在进行时，不是假设。
- 本机 `~/Desktop/AI/uploads/assets` 目前只剩 catalog 那次测试留下的空目录。
- ⚠️ **原文建议 1 的写法在源码模式下是错的**：改成 `../../uploads/assets`，从源码跑（monolith、单服务、
  jest）会落进 `api/uploads/`。路径必须与运行形态无关——照 `__SOLO_PORTS__` / `__SOLO_GUIDES__` 的现成做法，
  由 `gen-entry.js` 在 bundle 里写入项目根。
- ⚠️ **原文建议 2 的前提不准**：解析后的路径**一直在打**——`storage/index.js` 挂载时的
  `Local OSS mounted in-process at /_oss (… root=<绝对路径> …)`（catalog 的 `api/debug/SOLO_BUNDLE_debug.log` 里就有）。
  缺的不是这一行，是「它在项目外面」这个判断：一个裸路径不会让人觉得哪里不对。
- `api/router/config.js:192` 有同一个错误路径（源码模式下也错，`api/router/` 往上三级已是父目录），
  但那是没人读的死配置，且在 Router 保护区，未动。

### v1.2.16 落地（不改任何行为）

- `deploy/gen-entry.js`：bundle 里新增 `global.__SOLO_ROOT__ = <bundle 所在目录>/../..`。
- `storage/config.js`：`storage.local` 多出 `projectRoot`（bundle 取上面的全局，源码取 `__dirname/../../..`）
  与 `rootFrom`（`LOCAL_OSS_ROOT` / `UPLOAD_DIR` / `default`）。**默认值本身保持不变**，并在旁边写明原因。
- `storage/index.js`：进程内挂载后，若 root 来自默认值且落在项目根之外 ⇒ `logger.warn` 一条，
  说清楚后果与怎么钉住。显式配到项目外的不报（那是有意的选择）。
- `init.sh` 写的 `.env` 在 storage 一节加注释 + 一行注释掉的 `UPLOAD_DIR='<项目>/uploads/assets'`。
- **实测**：用新 bundle 单起 storage（`SOLO_SERVICES_JSON` 只含 storage），默认配置下打出
  `Local OSS root /Users/fuu/Desktop/AI/uploads/assets is OUTSIDE the project (/Users/fuu/Desktop/AI/solo) …`；
  设了 `UPLOAD_DIR`（哪怕在项目外）不打；源码模式下默认值解析到 `<solo>/uploads/assets`、判为项目内、不打。

### 待定（需要拍板，所以没做）

1. **默认值改成 `path.join(projectRoot, 'uploads/assets')`**。这改的是**存储位置**，
   存量栈升级后会切到一个空目录，而 `resolve` 照样返回 URL，但字节已经不在了，这正是最坏的那种静默失败。
   按「改存储位置 = 有人要跟着动」的判据属于 **minor（v1.3.0）**，需要先确认。
   配套要有：启动守卫（旧的父目录非空、新目录为空、又没显式配置 ⇒ 拒绝启动并给出命令）+ 迁移说明。
2. **N100 那 263MB 的归属**：迁移前要先知道哪些项目在往里写。可行的零拷贝做法是 `cp -al`（同一文件系统上的硬链接）
   给每个用到 storage 的项目各建一份目录项，之后再按各自 Redis 里的引用做 GC；也可以先在这些项目的 `.env`
   里把 `UPLOAD_DIR` 显式钉到**现在的共享路径**，行为不变、告警消失，再单独排迁移。
3. **这些项目的备份要不要先把共享目录纳进去**：与上面独立，越早越好。
