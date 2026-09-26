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

（待 triage）
