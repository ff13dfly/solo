# 反馈:面向外部 AI 代理的自描述 API——实测 Gap 与 guide 机制建议

> 来源:wavely(POD)项目实战,2026-07-23。
> 场景:系统部署后,把数据整理类任务交给**外部 AI 代理**(如同事本地的 codex/claude,
> 把一个文件夹的产品图 + 信息灌进 catalog/storage)。诉求:**外部只需告诉 AI
> "先调用这个接口去了解系统",文档由 API 自己给出**——系统升级不影响外部调用方式,
> 也不存在外挂文档过时的问题。
> 依据:wavely 侧已真实走通一遍(73 款产品经 Router 由脚本代理灌入),以下 gap
> 全部是**亲身踩过**的,不是推演。

## 一、SOLO 已有的自描述面(地基是够的)

| 层 | 接口 | 现状 |
|---|---|---|
| 服务发现 | `system.service.list`(public) | 返回全部服务 + description(源自各服务 config.js,随代码走)+ entities schema |
| 能力图 | `system.capability.list`(public) | 语义快照消费口 |
| 单服务 | fleet-standard `methods` / `entities` / `events` | 方法签名、实体 schema、事件面 |

AI 代理靠这三层能"读懂"**有什么方法、字段什么含义**。以下是它读不到的。

## 二、实测的 4 个 Gap

### Gap 1:认证引导不在任何机读面上(第一跳就卡死,最致命)

introspection 能列出 `admin.login.request` / `user.login.verify`,但**挑战-响应的
派生算法完全没有暴露**,实测只能读服务端源码才写得出登录代码。且**两条链路算法不同**,
外部 AI 更不可能猜对:

- **admin(administrator 服务,单管理员)**:
  `loginHash = pbkdf2(password + username, hexParse(salt), iterations, 32, SHA256)`
  → `response = sha256(challenge + loginHash)`
  (源:`api/core/administrator/logic/identity.js` + `portal/system/src/utils/crypto.ts`)
- **普通 user(user 服务)**:
  注册时客户端自带 `salt` + `hash = sha256(password + salt)`(不传则服务端随机生成,
  该账号永远登不上——这本身也是个必须明说的坑);
  登录 `response = sha256(challenge + hash)`,verify 还要 `deviceId`。
  (源:`deploy/scaffold/e2e/harness/identity.js`)
- 登录后统一 `Authorization: Bearer <token>`,这一句同样无处机读。

**建议**:引导文档必须包含两条认证流程 + **可直接拷贝的参考实现代码**(Node 十几行)。
对 AI 代理,带代码的 guide 可靠性比纯文字描述高一个数量级。

### Gap 2:方法清单 ≠ 任务配方

introspection 说得出"有 `storage.asset.upload` 和 `catalog.product.create`",
说不出"建带图产品要**先**传图拿 assetId,**再** create 挂 `assetIds`,并按 sku
查重幂等"。跨方法的任务流程(recipe)没有任何承载处,这层知识目前只存在于人脑/散文档。

### Gap 3:约定与硬限制不在机读面

实测踩过的:上传 `file` 参数 5MB(base64)上限;Router 限流;`status` 是软删保留字
(业务态误用它会在默认 list 里隐形);实体嵌套 ≤3 层;敏感字段只脱 WAL 不脱 API 返回;
建议代理写入带 `ext.source` 标记以便人工复核区分。这些要么在 CLAUDE.md/散文档里,
要么只在源码里——外部 AI 都读不到。

### Gap 4:"从系统读文档"本身防不了过时——住址才是防腐剂

把文档改成 API 下发只是换了读取通道;**真正防过时的是 guide 内容与服务代码住同一目录、
同一次 commit 修改**。机制上应强制:guide 文件放服务源码目录内(如 `GUIDE.md`),
由统一方法原样读出。外挂 wiki/独立文档站一概不要。

## 三、建议的机制(机制归框架,内容归服务)

1. **fleet-standard 第四个系统方法 `guide`**——与 `methods`/`entities`/`events` 并列,
   实现即"读本服务目录下 `GUIDE.md` 原文返回"。文件不存在则返回明确的"本服务未提供
   guide"。bundle 内置服务(storage/agent/…)也各自带 GUIDE.md。
2. **Router 增加匿名第一跳 `system.guide`**——内容:JSON-RPC 信封格式、两条认证流程
   (含参考代码)、错误码约定、"下一步调 `system.service.list` 发现服务,再调各服务
   `guide` 拿任务配方"。这是外部方唯一需要被告知的入口,一句话:"先调
   `system.guide`"。
3. **内容责任在各服务/各派生项目**:框架只提供通道;派生项目在自己的 `apps/<svc>/`
   写 GUIDE.md(升级不覆盖),内容包含该服务的任务配方(Gap 2)与约定限制(Gap 3)。
4. **配套**:`guide` 作为 fleet-standard 方法应默认进 public 面(或至少 ai:true),
   autocheck 的 public-surface 检查需把它列入默认白名单,避免每个项目手工重放。

## 处理结论(solo 侧,2026-07-23,已落地)

核实后采纳。机制按第三节建议实现,两处与建议的偏差:

1. **Gap 3 的 5MB 例子不成立**:`storage.asset.upload` 的 `file` 参数
   `maxLength: 5242880` 本就在 `methods` 自省里机读可见——是消费方式问题。
   其余项(软删保留字/限流/嵌套上限)属实,已写进 Router GUIDE.md §4。
2. **autocheck 无需改白名单**:`guide` 走服务侧 `BASE_PUBLIC_METHODS`
   (library/auth.js)+ 各服务 index.js 注册,**不进 introspection 声明**,
   public-surface / route-consistency 两个检查天然不触发。

落地清单:
- `api/library/guide.js` — `readGuide()`(bundle 时读 gen-entry 构建期播的
  `global.__SOLO_GUIDES__`,镜像 `__SOLO_PORTS__` 模式;from-source 读文件)
- 16 个服务 index.js 各一行 `'guide':` 接线;`api/sample/GUIDE.md` 模板
- Router `system.guide`(经授权):无参 = 匿名第一跳返回 `api/router/GUIDE.md`
  (信封 + 双链路认证参考代码 + 错误码表);`{service}` = 代理转发该服务
  `guide`,生产环境需认证(与 access.js DISCOVERY_METHODS 拓扑防泄一致——
  这是反馈没看到的一个既有安全门)
- 打样内容:`api/router/GUIDE.md`、`api/apps/storage/GUIDE.md`、
  `api/core/agent/GUIDE.md`;下游写法进 `deploy/scaffold/docs/authoring/service.md`
- 测试:`api/library/tests/guide.test.js`(已进 CI 白名单)

wavely 侧接下来:catalog/storage 各写 GUIDE.md(灌数据配方/幂等规则),
升级 bundle 后外部代理入口统一为一句话:「先调 `system.guide`」。

## 四、佐证材料(wavely 侧)

- 真实消费者:`wavely/catalog/scripts/import-to-catalog-service.mjs`
  (登录→传图→建档→幂等,外部代理灌数据的参考实现,其中认证部分就是读源码逆出来的)。
- 若需 GUIDE.md 内容样例,wavely 侧计划先为 catalog/storage 各写一份
  (灌数据配方/字段约定/幂等规则),机制落地后即可直接消费。
