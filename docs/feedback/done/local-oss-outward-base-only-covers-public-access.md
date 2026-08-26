# 反馈：`LOCAL_OSS_PUBLIC_BASE` 只覆盖 public 分支 —— private 模式的签名 URL 永远指向 loopback

> 来源：steward 派生项目，2026-08-26。起因是给 N100 上并存的 5 个 Solo 栈建一个统一的
> 对外资产入口（`oss.w3os.net/{SHORT}/{KEY}`），落地时发现只有 public 的栈接得进来。
> 依据分两类，别混：
> **① 实测**——public 分支：steward `.env` 加 `LOCAL_OSS_PUBLIC_BASE`，重启栈后
> `storage.asset.multi` 直接返回 `https://oss.w3os.net/t/29/ff/…jpg`，公网取回
> `200 image/jpeg 283840 bytes`；191 个历史资产全部生效、零迁移。
> **② 代码核对（solo 仓 HEAD，未实测）**——private 分支的行为，行号见下。
> 涉及：`api/apps/storage/oss/driver-local.js:83`（publicBase）· `:87`（objectUrl）·
> `:170-176`（presignGet）· `:191-194`（publicUrl）；
> `api/apps/storage/oss/index.js:105-110`（resolveUrl 的分支）；
> `api/apps/storage/config.js:150 / 153 / 158-160`。
>
> 一句话：storage 把「**我自己怎么访问对象存储**」和「**我告诉别人怎么访问**」共用了一个
> `endpoint`，只在 public 那条分支上开了个 `publicBase` 的口子 —— 于是
> **private 模式在「storage 与浏览器不同机」的部署里根本不可用，而且没有开关能救**。

---

## 一、public 分支：开关存在，效果很好（① 实测）

storage 默认返回的是 `http://127.0.0.1:8529/_oss/solo/<key>` —— 那是它**自己进程视角**的地址。
原样交给浏览器，浏览器会去连**访问者自己的机器**：症状是整列破图，而 Network 面板里
那个失败地址长得像"服务器地址"，很容易被读成「图没上传成功」。

设 `LOCAL_OSS_PUBLIC_BASE='https://oss.w3os.net/t'` 之后一切正常，而且——

**URL 不存库**。`asset.get` 返回的是 `{id, originalName, mimeType, sha256, size, key, path, …}`，
没有 url 字段；URL 是 resolve 时用 publicBase 现拼的（`driver-local.js:191-194`）。
所以改配置对**历史资产立刻全部生效，零迁移**。这个设计是对的，值得在文档里写明——
我们动手前专门核了一遍，就是怕要写数据迁移脚本。

## 二、private 分支：同一个开关够不着（② 代码核对，未实测）

`oss/index.js:105-110`：

```js
driver.resolveUrl = (key, opts = {}) => {
    if (driver.access === 'public' && driver.capabilities().publicUrl) {
        return driver.publicUrl(key, opts);      // ← 吃 publicBase
    }
    return driver.presignGet(key, opts);         // ← 用 objectUrl
};
```

而 `driver-local.js`：

```js
const origin     = endpoint.replace(/\/$/, '');                       // :82
const publicBase = (cfg.publicBase || `${origin}/${bucket}`)…;        // :83
const objectUrl  = (key) => `${origin}/${bucket}/${encKey(key)}`;     // :87

presignGet(key) { … return `${objectUrl(key)}?Expires=…&Signature=…` }  // :170-176
publicUrl(key)  { … return `${publicBase}/${encKey(key)}${q}` }         // :191-194
```

⇒ `STORAGE_ACCESS=private` 时，交给浏览器的签名 URL 是
`http://127.0.0.1:<port>/_oss/solo/<key>?Expires=…&Signature=…`。
**只要 storage 和浏览器不在同一台机器上，这个 URL 就是死的**，而 `LOCAL_OSS_PUBLIC_BASE`
在这条分支上完全不参与。

### 为什么不能用 `LOCAL_OSS_ENDPOINT` 绕过

它是同一个 `origin`，而 `origin` 还是 storage **自己**做 GET/PUT/HEAD/DELETE 的地址
（`driver-local.js:94 / 111 / 119 / 125 / 130 / 140` 全部经 `objectUrl`）。把它设成公网地址等于：

- 服务端每次读写自己的对象存储都绕一圈公网 + TLS + 反代；
- 且 `config.js:158-160` 的 `inProcess: !process.env.LOCAL_OSS_ENDPOINT` 会翻面——
  **一设它就不再自己起 OSS server**，得另外跑一个独立的 local-oss 进程。

所以这不是"配置姿势不对"，是**这条路上没有门**。

## 三、建议（按价值排序）

1. **给对外 URL 一个独立的基址，覆盖两条分支**。概念上该切成两件事：
   `endpoint` = 我自己怎么访问（内部、loopback、免 TLS）；
   `outwardBase` = 我告诉别人怎么访问（公网、反代之后）。
   public 已经有 `publicBase` 了，缺的是 private 那条。

   **修起来很轻**：`presign.sign(secret, { method, bucket, key, expires, contentType, process })`
   —— 签名参数里**没有 host**（`:173`、`:186`）。所以换 host 不影响验签。

   ⚠️ 但**不能直接复用 `publicBase`**：它是整段基址、已经把 `/{bucket}` 吃进去了
   （默认值就是 `${origin}/${bucket}`）。签名 URL 的路径形状得保持 `/{bucket}/{key}`，
   所以 private 那条要的是「只替换 scheme+host+mountPath」的那一段，是个**不同的量**。
   建议单开一个（如 `LOCAL_OSS_ORIGIN_PUBLIC` / `outwardOrigin`），别让两者混。

2. **文档里把「URL 不存库」写出来**。这是这块设计最好的性质（改配置即改全量、零迁移），
   但现在只能靠读 driver 才知道。运维在动手前最想确认的就是这一条。

3. `STORAGE_ACCESS=public` 启动时那句警告（`index.js:116` 附近）写得很好——
   建议补一句对称的：private + 跨机部署时对外 URL 不可达，直到 ①。

## 四、我们的处置

steward 是 public，① 的口子够用，所以线上已经跑起来了（`oss.w3os.net/t/*` → N100:8529）。
**没有改任何只读区代码**，只加了一行 `.env` 和一个 VPS 上的 Caddy vhost。
这条反馈是为了后面那些 private 的栈——按现状它们接不进统一入口，
而症状会表现成「图打不开」，排查的人多半会先去怀疑反代和防火墙。

## 五、处理结论

**已采纳，三条建议全部落地（2026-08-26，进 [Unreleased]，随下一个 tag 下发）。**
核实结论：§二的代码核对属实——private 分支的签名 URL 走 `objectUrl`（= endpoint origin），
`publicBase` 只在 public 分支参与；presign canonical 串（`oss/presign.js`）确实不含 host，
换 host 不破坏验签，这让修复保持"轻"。

1. **建议 ①（独立对外基址）**：新增 **`LOCAL_OSS_OUTWARD_ORIGIN`**（config 键
   `storage.local.outwardOrigin`）——注意名字与本文举例的 `LOCAL_OSS_ORIGIN_PUBLIC` 不同。
   语义正如 §三所析：只替换 scheme+host+挂载段，路径形状保持 `/{bucket}/{key}`；
   覆盖**两条分支**（private 的 presignGet/presignPut 直接换 host；public 的 `publicBase`
   缺省值改为 `${outwardOrigin || origin}/${bucket}`，显式 `LOCAL_OSS_PUBLIC_BASE` 仍优先）。
   与 `LOCAL_OSS_ENDPOINT` 互不相干：不改自用访问、不翻 `inProcess`。
   落点：`oss/driver-local.js`（outwardOrigin/outwardUrl）、`oss/index.js`（透传）、
   `config.js`（env 读取）。新增 3 个用例进 CI 白名单套件 `tests/oss-provider.test.js`
   （含"outward URL 经反代改写回真实 origin 后验签取回字节"的全链路），24/24 绿。
2. **建议 ②（URL 不存库写进文档）**：已写进 `README.md`（How files are served 节）与
   `GUIDE.md`（新增「对外 URL 指到哪」节，含破图症状对照）。顺带补上了 README env 表里
   一直缺失的 `LOCAL_OSS_PUBLIC_BASE` 行。
3. **建议 ③（对称告警）**：启动时若 `access=private` 且设了 `publicBase` 而没设
   `outwardOrigin`，告警指明"PUBLIC_BASE 在 private 下不参与，去设 LOCAL_OSS_OUTWARD_ORIGIN"
   ——条件刻意收窄到这个精确组合，private 模式的单测不受噪音。
   （"private + 跨机"本身无法在启动时判定，故不做泛化告警。）

**给 steward（及后续 private 栈）的迁移提示**：升级 bundle 后 `.env` 加一行
`LOCAL_OSS_OUTWARD_ORIGIN='https://oss.w3os.net/<SHORT>'`（= Caddy vhost 映射到该栈
`LOCAL_OSS_ENDPOINT` 的公网段）即可，历史资产零迁移（URL 不存库）。public 栈已有的
`LOCAL_OSS_PUBLIC_BASE` 继续有效，不必改。
