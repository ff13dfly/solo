# 反馈：storage 的默认字节后端（local-oss-server）没有任何启动脚本拉起 —— 生产栈上 `storage.asset.upload` 必然 ECONNREFUSED

> 来源：steward 派生项目（Solo v1.2.1，部署在 N100 常驻栈），2026-08-25 给浏览器插件
> 接「采集到的商品主图 → storage 入库」这条链路时撞到。
>
> **依据分三类，请按类采信**：
> - **自查实测（本次）**：线上 steward 栈（`deploy/run.sh --plain --no-ssl` 起、
>   systemd 常驻 46 小时）上，`storage.asset.upload` **100% 失败**，Router 返回
>   `{"code":"ECONNREFUSED","message":""}`；同一 token、同一 Router、同一服务的
>   `storage.asset.list` **成功**；`user.account.list`、`scout.capture.list`、`ping`
>   全部成功。手动起 local-oss-server 于 8755 之后，同一条 upload 调用**立刻成功**
>   （图片与纯文本两种载荷都验过）。
> - **源码核对**：`api/apps/storage/oss/index.js:54`、
>   `api/apps/storage/oss/local-oss-server.js:2-9`（头注）、bundle 内
>   `solo.v1.2.1.js:122375-122398`（config 默认值）。
> - **判断**：§4 的三个修法是设计意见，不是运行结果。
>
> 涉及：`deploy/run.sh`（缺启动）、`api/apps/storage/oss/local-oss-server.js`（头注已
> 写明该由谁启动）、`api/apps/storage/oss/index.js`（默认 endpoint）、
> `deploy/scaffold/`（新项目同样缺）。
>
> 一句话：storage 的默认 provider 是 `local`，它把字节全部转发给一个**独立进程**
> local-oss-server（`http://localhost:8755`）；该进程头注写着「Start it from
> deploy/dev.sh」，但 **`deploy/run.sh` 里没有任何一行启动它** —— 于是凡是走
> `run.sh` 起的栈（= 所有生产部署），上传路径是**必然坏的**，而且坏得很隐蔽。

---

## 一、【实测现象】只有写字节的方法挂，读元数据的方法全通

线上 steward 栈（Router 8520，storage core 8529），用 admin token 经 Router 调：

| 方法 | 结果 |
|---|---|
| `storage.asset.list` | ✓ ok |
| `storage.asset.upload`（image/png，70B） | ✕ `[ECONNREFUSED]` |
| `storage.asset.upload`（text/plain，5B） | ✕ `[ECONNREFUSED]` |
| `user.account.list` / `scout.capture.list` / `ping` | ✓ ok |

storage 服务本身是活的：`curl 127.0.0.1:8529/jsonrpc -d '{"method":"ping"}'` →
`{"status":"ok","uptime":168182,"version":"0.1.0"}`。`localhost` / `127.0.0.1` / `[::1]`
三种写法连 8529 都是 200（排除了 IPv6/DNS 解析方向）。

**分界线非常干净**：`list` 只读 Redis 元数据 → 通；`upload` 要 `store.put()` → 挂。

## 二、【根因】默认 provider 指向一个没人启动的独立进程

`api/apps/storage/oss/index.js:54`（bundle `solo.v1.2.1.js:122379-122396` 同）：

```js
storage: {
    provider: process.env.STORAGE_PROVIDER || 'local',   // ← 默认 local
    local: {
        endpoint: process.env.LOCAL_OSS_ENDPOINT || 'http://localhost:8755',   // ← 默认 8755
        ...
    },
}
```

而 `local-oss-server.js` 的头注（`:2-9`）自己写明了它的身份与启动约定：

> `@why` … It is **NOT a Solo microservice** — it has no Router auth, no introspection,
> no services.json entry. **Start it from `deploy/dev.sh`** (like Redis on 6699) or boot
> it in-process for jest.

问题就在这里：**`deploy/dev.sh` 起了它，`deploy/run.sh` 没有。**
steward 侧实测 `grep -in "oss\|8755" deploy/run.sh` 唯一命中是一条 Redis 文档链接。
生产部署一律走 `run.sh`，所以：

- **开发/测试通过**（dev.sh 起了 8755，jest 走 in-process）
- **生产必坏**（8755 无人监听，upload 必 ECONNREFUSED）

这是一个「测试全绿但生产 100% 坏」的形态——测试环境恰好覆盖了缺失的那一步。

## 三、【为什么难查】三层误导

1. **错误码指向下游不可达，但服务本身活着**。`ECONNREFUSED` 让人先怀疑
   storage 服务没起 / 端口没开 / Router 服务发现坏了 —— 逐个查完都是好的
   （8529 在监听、ping ok、active_services 里 URL 正确、list 方法能通）。
2. **`message` 是空字符串**。Router 透传的 error 是 `{"message":"","code":"ECONNREFUSED"}`,
   **不含被拒的 host:port** —— 真正的线索（8755）一个字都没露出来。若能带上
   `connect ECONNREFUSED 127.0.0.1:8755`，排查会在第一分钟结束而不是第 N 轮。
3. **`list` 能通**，强烈暗示「storage 是好的」，把注意力从「字节后端」引开。

## 四、【建议】按价值排序

1. **`deploy/run.sh` 在 provider=local 时启动 local-oss-server**（与 dev.sh 对齐）。
   这是根治：默认配置就该是自洽的——默认值指向的东西，默认脚本就该负责拉起。
   端口/root/secret 已经全是可配的（`LOCAL_OSS_*`），加一段守卫即可。
   ⚠️ **注意 8755 是所有 Solo 栈的共用默认端口**（同 8686 SSL 代理的处境）：一机多栈时
   要么各栈用不同端口（`LOCAL_OSS_ENDPOINT`），要么共用一个实例但 root 分桶——
   建议 run.sh 按栈派生端口，别让第二个栈起来时静默撞上第一个栈的实例（那会
   导致 A 栈的资产写进 B 栈的目录，且**完全不报错**）。
2. **把被拒的 host:port 带进 error message**。Router 转发失败时保留 axios 的原始
   `ECONNREFUSED 127.0.0.1:8755`。空 message 是本次排查里最贵的一段。
3. **storage 启动时自检一次字节后端**（provider=local 时 HEAD 一下 endpoint），
   不通就在启动日志里 `warn` 点名：「local-oss-server 不可达，upload 将全部失败」。
   现在的形态是**启动一切正常、直到第一次 upload 才炸**，而那可能是几天后。
4. 次要：`deploy/scaffold/` 里同步，新项目不再继承这个缺口；文档（storage 的
   GUIDE.md）里把「local provider 需要一个独立进程」写在最显眼处。

## 五、【派生项目当前的处置】

steward 侧暂时手动起了一个 local-oss-server（8755，root 指向
`deploy/oss_data/`），验证 upload 立刻通过。**未固化为 systemd unit** ——
因为这属于框架该管的事，等本反馈 triage 后按上游方案对齐，避免留下一个
升级时会分叉的本地补丁。

## 六、处理结论

**已落地 v1.2.3（2026-08-25）**，四条建议全部采纳，但**根治方式与 §四.1 提的不同**，
另有一处根因纠正和一个反馈没发现的安全洞。

### 采纳，但换了修法：不是让 run.sh 起进程，而是让 storage 进程内挂载

§四.1 提的是「`run.sh` 在 provider=local 时启动 local-oss-server」。核实时发现两个障碍：

1. **派生项目手上根本没有能启动它的东西**——`deploy/local-oss.js` 不在 `init.sh` 的拷贝
   清单里，`local-oss-server.js` 只存在于 bundle 内部。所以「run.sh 加一段守卫即可」不成立，
   还得先下发一个启动器。
2. §四.1 自己的 ⚠️ 说到了点子上：8755 是全 Solo 栈共用默认端口。但情况比反馈写的更糟——
   **两个栈还共用同一个默认密钥**，所以后起的栈不是「起不来」，是 driver 认证成功、
   **把资产静默写进另一个栈的目录**。派生端口只是把这个坑管理起来，没有消除。

改为 **`provider=local` 时 storage 在自己的端口上挂载对象存储**（`/_oss`），endpoint 默认
派生成 `http://127.0.0.1:<storage 端口>/_oss`：没有独立进程、没有独立端口，撞车整类消失，
默认配置自洽。`local-oss-server.js` 只需一行改动（`req.originalUrl` → `req.url`，挂载时
express 只从 `req.url` 剥前缀），独立进程模式保留不变（`LOCAL_OSS_ENDPOINT` 一设就让位）。
`deploy/dev.sh` 也不再起独立 8755——**让 dev 与生产走同一条路径**，因为这个 bug 的根因
恰恰是两条路只测了一条。

### 🔴 纠正 §三.2 / §四.2：空 message 不是 Router 的锅，不用改 Router

反馈判为「Router 透传时丢了被拒的 host:port，建议改 Router 保留 axios 原始 message」。
**实测证明不是**：默认 endpoint 写的是 `localhost`，Node 的 happy-eyeballs 对双栈主机
并发拨 `::1` 与 `127.0.0.1`，两条都被拒时抛的是 **`AggregateError`，其 `message` 天生
是空字符串**，真实信息在 `.errors[]` 里。同一台机器实测：

```
localhost:8755  → AggregateError, code=ECONNREFUSED, message=""
127.0.0.1:8755  → Error,          code=ECONNREFUSED, message="connect ECONNREFUSED 127.0.0.1:8755"
```

所以修法是把默认 endpoint 改成字面 IP（一个词），外加 `driver-local` 把
`<METHOD> <URL>` 和展开的 `.errors[]` 包进 message。**Router 保护区未触碰。**

### 反馈没发现的：默认密钥是开源仓库里的公开常量

`LOCAL_OSS_SECRET` 默认 `'solo-local-oss-dev-secret'`，写死在公开仓库里，而它**同时是**
签名 URL 的 HMAC 密钥和 Bearer 令牌。把 local 扶正为生产后端之后，这等于公开了
「伪造任意资产 URL」+「列桶 / 批量删对象」的能力。处理：`init.sh` 为每个新项目生成随机值；
仍用默认值时启动 warn，**`STORAGE_ACCESS=private` 直接 fail fast**（private 档的全部承诺
就是签名不可伪造，密钥公开时这句话是假的）。

### §四.3 / §四.4

- **启动自检**：比反馈提的更进一步——不是「HEAD 探一下不通就 warn」，而是根本不再有
  「指向一个没人启动的进程」这个状态；挂载失败即服务启动失败，不会留到几天后第一次 upload。
- **scaffold 同步 + 文档**：`init.sh` 生成密钥；`api/apps/storage/README.md` 的 provider 表、
  env 表、Local OSS server 一节全部重写；`deploy/local-oss.js` 头注、`deploy/w3os/README.md`
  一并更正（它们都还写着「dev 专用 / 生产别用」）。

### 派生项目（§五）该做什么

steward 手工起的那个 8755 实例可以撤掉了，但 **root 不一样要注意**：它当时把 root 指向
`deploy/oss_data/`，而进程内挂载默认读 `UPLOAD_DIR`——升级后**那批老对象会找不到**。
二选一：把 `LOCAL_OSS_ROOT` 指向 `deploy/oss_data/`（推荐，零搬运），或继续跑独立进程并
设 `LOCAL_OSS_ENDPOINT`。另外 `.env` 补一行随机 `LOCAL_OSS_SECRET`（换密钥会让存量签名
URL 立即失效，字节不受影响）。完整迁移说明见 CHANGELOG v1.2.3 的「下游 action」。

**未固化为 systemd unit 是对的**——按上游方案对齐后，那个本地补丁本来就不该存在。
