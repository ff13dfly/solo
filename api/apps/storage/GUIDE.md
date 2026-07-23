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
     要给前端 `<img>` 直接引用的传 `public`。
   - 需要已认证会话（记录 owner），匿名上传已关闭。
2. 返回 `{ id, sha256, size, url, ... }` — `id` 即 assetId，拿去挂业务实体。

**幂等性（重要）**：上传天然按内容幂等——同一文件重复 upload 直接命中 sha256
短路，返回**同一个** asset，不产生重复。批量灌数据中断后**直接整批重跑即可**，
无需自己记"哪些传过"。

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

## 坑与约定

- `createdAt` 是 ISO-8601 **字符串**，不是时间戳数字。
- `owner` 可能为 `null`（无主/历史资产），判断属主先判空。
- 删除是真删（metadata + 磁盘文件），没有软删回收站——删前确认。
- 批量操作串行或小并发，Router 有全局限流（错误码 -32029，退避重跑）。
