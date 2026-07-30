# 反馈:storage 的 `visibility` 只守 RPC 面,字节面由 `STORAGE_ACCESS` 决定——两层组合易被误读为"已私有"

> 来源:wavely(POD)项目实战,2026-07-28。
> 场景:线上测试环境 `erp.wavelymade.com` 批量入库产品图,事后核对资产可达性。
> 依据:全部为**线上实测**(非推演),复现命令与响应见第四节。
> ⚠️ 先说明本反馈**不**主张的事:`api/apps/storage/README.md` 已明确写了
> `access=public` **是默认值**(§31 与环境变量表 `STORAGE_ACCESS | public`),
> 文档没有撒谎。本篇要说的是**另外三处**,以及一个"两层默认值组合"的系统性问题。

## 一、实测现象

以员工账号(非 admin)上传产品图,**不传 `visibility`**(即 `config.js` 的
`defaultVisibility = 'internal'`),然后:

```
storage.asset.resolve { id }  →  { "url": "https://erp.wavelymade.com/oss/solo/95/e0/18/0628e8….jpg" }
curl <该 url>                 →  HTTP 200  image/jpeg  259948 bytes   ← 无任何凭证
```

URL **不带** `?Expires&Signature`,匿名 GET 直接拿到原图。也就是说,标着
`internal` 的资产在字节层是完全公开的。

## 二、根因:两层各自都对,组合起来失真

**第 1 层(RPC 面)——`visibility` 严格生效,无可指摘。**
`logic/asset.js:151` 的 `canRead` + `assertRead` 把住 `resolve`/`get` 等入口:

```js
if (vis === 'public')   return true;
if (vis === 'internal') return !!(ctx && ctx.user);            // 需登录
return !!(ctx.user && meta.owner && ctx.user === meta.owner);  // private:仅 owner
```

匿名去 `resolve` 一个 internal 资产,如实吃 `FORBIDDEN`。**这层是对的。**

**第 2 层(字节面)——与 `visibility` 完全无关,只看 `STORAGE_ACCESS`。**
`oss/index.js:77`:

```js
driver.resolveUrl = (key, opts = {}) => {
    if (driver.access === 'public' && driver.capabilities().publicUrl) return driver.publicUrl(key, opts);
    return driver.presignGet(key, opts);
};
```

`config.js:97` 的 `access: process.env.STORAGE_ACCESS || 'public'` 使**生产路径默认
走上面那条分支**,返回稳定无签名 URL。

**合起来的语义是:`visibility` 管"谁能*问到*这个 URL",不管"拿到 URL 后谁能*下载*"。**
这本身是标准的能力 URL(capability URL)模型,S3 预签名同理,**不是 bug**。
问题是这条边界目前没有任何一处对使用者明说,而字面上 `internal` 三个字
强烈暗示"内部可见"。

## 三、三处建议(按价值排序)

### 建议 1(主要):`apps/storage/GUIDE.md` 应写明 visibility 的语义边界

GUIDE 是 guide 机制的产物、是 **AI 代理与下游开发者的权威入口**(且比 README 更
可能被真正读到)。现在关于 visibility 只有两行:

```
- `visibility`:`public | internal | private`,不传默认 `internal`。
  要给前端 <img> 直接引用的传 `public`。
```

读者(尤其 AI 代理)据此形成的心智模型必然是"internal = 受保护"。建议补一段:

> `visibility` 是 **RPC 面**的读授权,决定谁能通过 `asset.resolve` **取得 URL**;
> 它**不保护字节本身**。URL 拿到后能否下载,由部署侧的 `STORAGE_ACCESS` 决定:
> `public`(默认)= 稳定无签名 URL,知道 URL 即可匿名下载;`private` = 限时签名 URL。
> 真需要字节级隔离,必须部署侧设 `STORAGE_ACCESS=private`,只设 `visibility` 无效。

### 建议 2(次要):`oss/index.js` 的注释与那行 `|| 'private'` 兜底有误导性

```js
driver.access = storageConfig.access || 'private';   // ← 生产路径永远轮不到 'private'
/**
 * Returns a signed, expiring URL by default (closes the unauthenticated-read hole);
 */
```

两处的 "default" 说的不是一回事:注释里的 default 指**函数内的 fallback 分支**,
而系统的实际默认由 `config.js` 填成 `'public'`——`|| 'private'` 只在直接传入
自定义 config 的调用(如测试)里才有意义。只读这个文件的人,会得到与实际部署
相反的结论。建议把注释改成陈述分支条件(而非 "by default"),或在该行旁注一句
"生产默认来自 config.js = public"。

### 建议 3:`provider=local` + `access=public` + `publicRead=true` 时启动期告警

派生项目自建的 local-oss 启动器很容易把第三个开关翻过来。SOLO 侧
`oss/local-oss-server.js:115` 的默认是安全的(`publicRead = false`,无签名 GET → 403),
但 wavely 的 `deploy/local-oss.js` 写成了
`publicRead = process.env.LOCAL_OSS_PUBLIC_READ !== 'false'`(**默认 true**),
线上 `.env` 又两个开关都没设 → 三个默认值叠加成"完全公开",而**没有任何一处会提醒**。

建议 storage 启动时检出这个组合并 `logger.warn` 一行,例如:

> `[storage] access=public + local publicRead=true — 所有资产字节可匿名下载,
> visibility 仅约束 RPC 面。生产环境请设 STORAGE_ACCESS=private。`

这类"三个各自合理的默认值组合出不安全状态"的场景,单点文档很难防住,启动期告警
是成本最低的兜底。

## 四、佐证材料(wavely 侧)

- 复现:见第一节两条命令。资产由 `erp/deploy/staff-batch-intake.js` 上传
  (未传 `visibility`,走 `defaultVisibility=internal`)。
- 线上 `.env` 实测只设了 `LOCAL_OSS_ENDPOINT` / `LOCAL_OSS_PUBLIC_BASE` / `DEBUG=false`,
  **`STORAGE_ACCESS` 与 `LOCAL_OSS_PUBLIC_READ` 均未设**,即全走默认。
- wavely 侧的 `deploy/erp.wavelymade.com/nginx-erp.conf:106` 早已注明
  「local-oss 的 publicRead 默认开(无签名 GET),即知道 key 就能匿名取物;key 是内容
  寻址 hash,不可枚举,测试期可接受」——说明**部署方当时是知情的**,本反馈不是
  追认漏配,而是主张这条知识应由框架侧承载(GUIDE + 告警),而非依赖每个派生项目
  自己在 nginx 注释里重新发现一遍。
- wavely 侧另有一处不一致可作旁证:`portal/operator` 上传传 `visibility: 'public'`,
  而 1688 采集插件与批量入库脚本未传(走 internal)——同一个系统里三条写入路径
  三种取值,恰恰因为"传什么有何后果"没有权威说明。

## 处理结论(solo 侧)

<!-- 待 solo 侧 triage 后补:采纳/驳回理由与落地清单 -->
