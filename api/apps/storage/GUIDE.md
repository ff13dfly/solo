# storage 服务任务配方

> 由 fleet-standard `guide` 方法下发（经 Router：`system.guide { service: "storage" }`）。
> 与服务代码同目录、同 commit 更新。方法签名与参数约束以 `methods` 自省为准，
> 本文只讲自省说不出的**任务流程与语义**。

## 这是什么

CAS（内容寻址）文件存储：文件按 SHA-256 去重，同一内容永远得到同一个 asset。
上传返回 `assetId`，其他服务的实体用 `assetIds` 数组（或 `{storage}Id` 外键）挂引用。

## 配方一：上传文件（外部代理灌图的标准路径）

1. `storage.asset.upload { file, filename, mimeType, visibility }`
   - `file`：**base64 字符串**，上限 `maxLength: 5242880`（≈5MB base64，原文件 ~3.7MB）。
     超限先压缩/缩图再传，别硬试。
   - `visibility`：`public | internal | private`，不传默认 `internal`。
     要给前端 `<img>` 直接引用的传 `public`。**语义边界见下方"visibility 保护的是什么"。**
   - 需要已认证会话（记录 owner），匿名上传已关闭。
2. 返回 `{ id, sha256, size, url, ... }` — `id` 即 assetId，拿去挂业务实体。

**幂等性（重要）**：上传天然按内容幂等——同一文件重复 upload 直接命中 sha256
短路，返回**同一个** asset，不产生重复。批量灌数据中断后**直接整批重跑即可**，
无需自己记"哪些传过"。

## 配方一之二：大文件（超过 ~3.7MB）—— 占位资产

`upload` 走 base64 + JSON-RPC + Router，声明上限 `5242880` base64（原文件 ~3.7MB），
还要吃 Router 的 10s 转发超时。**大文件不要硬塞这条路**，改成「自己存字节 + 在 storage 登记指针」：

1. 你的服务自己保存文件并对外提供一个 http(s) URL（分片、断点续传、CDN 都由你决定 ——
   框架刻意不做这套，因为各家需求形态差太远）。
2. `storage.asset.external { url, filename, mimeType, size, visibility }`
   → 返回 `{ id, kind:'external', externalUrl, url, ... }`，`id` 同样是 assetId，
   业务实体照旧用 `assetIds` 挂引用，**下游取数的写法完全不变**。
3. `storage.asset.get/resolve/multi` 对它照常工作，`url` 就是你给的那个地址。

**storage 对这类资产不再保证什么（先看清楚再用）**：

| 事项 | 普通 upload | external 占位 |
|---|---|---|
| 字节存在 storage | ✅ | ❌ 你自己存 |
| **请求时返回数据** | ✅ 对象存储直接给字节 | ❌ **只给指针** —— storage 不代理转发，客户端拿到 URL 后自己去你的服务取 |
| sha256 内容去重 | ✅ 同文件复用同一资产 | ❌ 无 sha256，两次登记 = 两个资产 |
| `size` 可信 | ✅ 实测字节数 | ❌ 你申报的，`sizeVerified:false`，**别拿它计费或做配额** |
| 缩略图 / 图片处理 | ✅ | ❌ 无字节可派生 |
| **字节面访问控制** | storage + `STORAGE_ACCESS` 两层 | ❌ **完全由你负责** —— `visibility` 只挡「谁能拿到这个指针」，URL 一旦发出去，storage 不在字节路径上，管不了 |
| 删除 | 引用计数到 0 才清字节 | 只删记录；**你那份文件要自己删** |

⚠️ **悬空指针**：你把自己那份文件删了，storage 里的记录还在、`resolve` 照样返回那个死链。
storage 无法感知，两边同步是你的责任（删文件时一并 `storage.asset.delete`）。

## 配方二：建"带图实体"的正确顺序

```
先 upload 拿 assetId → 再 create 业务实体挂 assetIds
```

反过来（先 create 占位再补图）会留下无图窗口期，且失败重跑时难以幂等。
业务实体自身的幂等键（如 sku）由业务服务负责，见该服务的 guide。

## 读取与解析

- `storage.asset.resolve { id, size? }` → `{ url }`：assetId 换公开访问 URL
  （可选缩略图尺寸）。渲染用它，别自己拼路径。
- `storage.asset.multi { ids }` → 批量 resolve（需认证）。
- `storage.asset.get { id }` → 原始元数据（无 url 装饰；legacy 记录可能只有
  `id` + `sha256`，其余字段别当必有）。

## visibility 保护的是什么（重要，别误读）

`visibility` 是 **RPC 面**的读授权：决定谁能通过 `storage.asset.resolve` / `get` **取得 URL**
（`public` 任何人 / `internal` 需登录 / `private` 仅 owner）。**它不保护字节本身。**

URL 拿到后能否下载，由**部署侧**的 `STORAGE_ACCESS` 决定：
- `public`（**默认**）= 稳定无签名 URL —— 知道 URL 即可匿名下载，`internal`/`private` 资产也一样；
- `private` = 限时签名 URL（默认 30 分钟过期）。

这是标准的能力 URL（capability URL）模型（同 S3 预签名），不是缺陷；但字面上
`internal` 三个字容易被读成"字节也内部可见"——**不是**。结论：

> **真需要字节级隔离，必须部署侧设 `STORAGE_ACCESS=private`；只设 `visibility` 无效。**
> 反过来，测试期接受"知道 URL 就能下"（key 是内容 hash、不可枚举）也是合理选择——
> 但要**知情地**选，服务启动日志里有对应告警可核对。

## 对外 URL 指到哪（跨机部署必读）

**URL 不存库**：资产行里只有 `{key, sha256, …}`，URL 是 resolve 时按当前配置现拼的。
所以改下面任何一个基址配置，**历史资产全部立刻生效、零迁移**。

local provider 有两个"origin"，服务的自用与对外是分开的：

- `LOCAL_OSS_ENDPOINT` = **我自己**怎么访问对象存储（loopback 是对的；设它还会关掉进程内挂载）；
- `LOCAL_OSS_OUTWARD_ORIGIN` = **我告诉别人**怎么访问（反代的公网 scheme+host+挂载段）。
  设了它，交出去的 URL（private 签名 URL、public 的 `publicBase` 默认值）全部换到这个 host；
  自用访问不受影响。签名串里没有 host，换 host 不破坏验签。
- `LOCAL_OSS_PUBLIC_BASE` = 仅 `public` 模式的无签名 URL 整段基址（**含 bucket 段**）；
  `private` 模式完全不读它——只设它不设 outward，启动日志会告警。

**症状对照**：浏览器整列破图、失败地址是 `http://127.0.0.1:…/_oss/…` ——不是上传失败、
不是反代坏了，是没设 `LOCAL_OSS_OUTWARD_ORIGIN`。
出处：`docs/feedback/done/local-oss-outward-base-only-covers-public-access.md`。

## 坑与约定

- `createdAt` 是 ISO-8601 **字符串**，不是时间戳数字。
- `owner` 可能为 `null`（无主/历史资产），判断属主先判空。
- 删除是真删（metadata + 磁盘文件），没有软删回收站——删前确认。
- 批量操作串行或小并发，Router 有全局限流（错误码 -32029，退避重跑）。
