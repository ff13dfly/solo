# 编写你自己的 SOLO 服务 · 契约指南（AI / 人都能照着写）

> 本文件让你（或一个 AI）**只凭脚手架交付的信息**，就能在 `api/apps/` 下写出一个 Router 能识别、能转发、wire 兼容的服务。
> 校准基准：与 `{{PROJECT_NAME}}` 随附的 Solo v{{SOLO_VERSION}} 的 **library factory + autocheck** 逐行对齐——
> 不是产品愿景文档。
>
> ⚠️ Solo 仓 `docs/protocol/zh/*` 是更宏大的内部设计草案（含**未实现**的协议、含写给 SOLO 维护者的"设计未决"推导）。
> **以本文件 + `api/sample/`（可运行模板）+ `api/library/README.md`（库目录）为准。**

---

## 0. 第一原则：先复用，别重写

SOLO 把"wire 兼容"做成了**可复用的 library factory**——auth 握手、JSON-RPC 信封、实体 CRUD、联邦分类、索引、日志，全部已经写好，放在 `api/library/`（脚手架已整目录交付给你，升级时 `upgrade.sh` 会同步）。

**你要做的不是重新实现这些，而是 `require` 它们并挂到你自己的命名空间下。** 自己重写 = 走偏：你会丢掉 Router 的签名校验、索引、WAL 审计、去重，还得自己维护。

> 看 `api/library/README.md` 的 **Library Catalog** 表——那是你能直接挂的全部 factory。下面 §4 给出"挂一个进来"的逐字模板。

---

## 1. 一个服务 = 这几个文件

照抄 `api/sample/`，它就是模板。每个文件的职责：

| 文件 | 职责 | 怎么来 |
|------|------|--------|
| `config.js` | 唯一 config 对象：`serviceName`(= RPC 命名空间前缀)、`port`、`version`、`idLengths`、`indexes`、`seeds`、`description` | 端口用 `portFor('name', fallback)` |
| `index.js` | **唯一**接 HTTP 的文件：中间件 + bootstrap + `/jsonrpc` 的"方法名 → logic"派发表 | 见 §2 |
| `handlers/auth.js` | `= createAuthHandlers(config)` —— Z-握手 + X-Router-Token 中间件 | `require('../../library/auth')` |
| `handlers/jsonrpc.js` | `= require('../../library/jsonrpc')` —— **必须是本地 wrapper**（autocheck 禁止 index.js 直接 import library/jsonrpc） | 一行 |
| `handlers/bootstrap.js` | `= createBootstrap(config)` → `{ initializeRedis, ensureDefaultCategories }` | `require('../../library/bootstrap')` |
| `handlers/introspection.js` | **方法声明数组**（`methods` RPC 返回它）—— 见 §3/§5 | 手写 |
| `handlers/entities.js` | 实体 schema（`entities` RPC 返回，给 operator UI 自动建 tab/表单） | 手写 |
| `handlers/events.js` | `{ emits, subscribes }` 事件面（`events` RPC 返回）—— 见 `events.md` | 手写 |
| `logic/index.js` | **logic 工厂**：`(redis, { config }) => ({ entityA, entityB, ... })`；聚合各 entity | 手写 |
| `logic/<entity>.js` | 单个实体的业务逻辑，通常 `createEntity(redis, opts)` 背书；**绝不碰 express/res**，只返回值或 `throw jsonrpc.*` | 见 §3 |
| `GUIDE.md`（可选） | **任务配方**：跨方法的操作顺序/幂等键/字段约定/**每个 list 的分页方式（§6.5）**，introspection 说不出的那层。fleet-standard `guide` RPC 原样返回（外部经 `system.guide {service}` 读到）；与代码同 commit 更新 | 手写，模板见 `api/sample/GUIDE.md` |

---

## 2. 接线（index.js / config.js 里的 require）

逐行照 `api/sample`，但**注意路径深度**：`api/sample/` 直接在 `api/` 下，比你的服务实际位置 `api/apps/<svc>/` 少一层，所以深度不能照抄，要在此基础上再深一层：

| 位置 | `api/sample/`（模板） | 你的服务 `api/apps/<svc>/`（实际要写的） |
|------|----------------------|----------------------------------------|
| `index.js` / `config.js` | `../library/...` | `../../library/...` |
| `handlers/` / `logic/` | `../../library/...` | `../../../library/...` |

```js
// index.js（服务根 → ../library）
const { corsOptionsFromEnv } = require('../library/cors');
const { createLogger }       = require('../library/logger');   // createLogger(serviceName)
const { walContext, requestContext } = require('../library/entity');   // 请求上下文注入（WAL uid + 行隔离 $owner）
const { createIndexer }      = require('../library/indexer');  // (redis, serviceName, indexes)
const jsonrpc                = require('./handlers/jsonrpc');   // 本地 wrapper

// config.js
const { portFor, urlFor } = require('../library/ports');       // portFor('{{PROJECT_NAME}}svc', 8999)
```

**`app.listen` 必须带 host**（否则永远绑所有网卡）：

```js
const { bindAddr } = require('../library/ports');    // 你的服务里是 ../../library/ports
app.listen(PORT, bindAddr('{{PROJECT_NAME}}'), () => { /* ... */ });
```

不带 host 的 `app.listen(PORT, cb)` 会让 Node 绑 `::` / 0.0.0.0 ——**这台机器的每一个网卡**。
本机开发看不出来，机器一旦有公网网卡，这个服务当场对全网可达，而项目里没有任何地方能表达
「它不该对外」，最后只能靠机器上的防火墙规则兜（那份知识不在仓库里、一条 `nft flush ruleset`
就静默解除、加新服务时也没东西提醒你回去改）。

`bindAddr()` 在 `BIND_ADDR` 与 `<服务名大写>_BIND_ADDR` 都没设时返回 `undefined`，
而 `listen(port, undefined, cb)` 与 `listen(port, cb)` **完全等价**——所以接上它对现有部署
零影响，只是把「能锁」这个能力加进来。锁的方式（两选一，都跟着 git 走）：

```bash
# .env — 全锁，再单独放行一个
BIND_ADDR=127.0.0.1
CODER_BIND_ADDR=0.0.0.0
```
```jsonc
// deploy/services.json — per-app env，只对私有 app 生效
{ "name": "coder", "path": "apps/coder/index.js", "port": 8422,
  "env": { "BIND_ADDR": "0.0.0.0" } }
```

autocheck 的 `bind-address` 规则（WARN）会盯着这件事。

`/jsonrpc` 的 handler 整体**必须**包在请求上下文里（审计链 + 行隔离）：

```js
await walContext.run(requestContext(req), async () => { /* 方法派发 */ });
```

**store 必须用 `requestContext(req)` 构造，别手写字面量。** 它除了 WAL 的
uid/trace/depth，还带上 Router 下发的 `constraints.$owner`（passport 外部会话的行隔离
声明）——Entity Factory 据此在数据层**自动执行**行隔离：create 盖章、get/update/delete
校验归属（不符 → NOT_FOUND，不泄露存在性）、list 过滤。手写字面量 = `$owner` 进不了
工厂，外部主体能读到全表且**零告警**（passport.md §3.7 的三道发证关卡只保证声明存在，
执行靠这里）。内部/admin 会话没有 `$owner`，两种写法行为一致——所以这是纯上锁。
只有绕过 Entity Factory 直接读 redis 的自定义数据路径需要自己过滤
（`getConstraints(req).$owner`，参照 Solo 源里 apps/collection 的 `_scope`）。
autocheck 的 `owner-context` 规则（WARN）盯着这件事。

---

## 3. 加一个实体：三处必须同步改

每个新实体，改三处，**一处都不能漏**：

1. **`logic/<entity>.js`** —— 工厂 `(redis, config) => ({ ...methods })`，一般用 `createEntity`：
   ```js
   const createEntity = require('../../library/entity');
   const { normalizeString } = require('../../library/validate');
   module.exports = (redis, config) => {
     const entity = createEntity(redis, { prefix: 'WIDGET', serviceName: config.serviceName, idLength: 16 });
     return {
       create: (p) => entity.create({ ...p, name: normalizeString(p.name) }),
       get:    (p) => entity.get(p.id),
       list:   (p) => entity.list(p),   // 原样透传，分页参数才传得进去；声明见 §6.5（不是可选的）
       // ...
     };
   };
   ```
2. **`logic/index.js`** —— 挂进聚合器：
   ```js
   module.exports = (redis, { config }) => ({
     widget:   require('./widget')(redis, config),
     category: require('./category')(redis, { serviceName: config.serviceName }),  // 见 §4
   });
   ```
3. **`handlers/introspection.js`** —— 声明每个 `{service}.{entity}.{action}`（params/returns，见 §5/§6）。
4. **`index.js` `/jsonrpc`** —— 在派发表里把方法名映射到 `Methods.<entity>.<fn>(p)`。

> 🔴 **红线（CI 守护）**：`handlers/introspection.js` 里**声明**的每个方法名，必须在 `index.js` 里**注册**，反之亦然——**两边一一对应，不许有孤儿**。
> 自查：`node api/autocheck/checker.js api/apps/<你的服务> --static`（CI 里 `deploy/check-doc-drift.js` 也会卡）。

---

## 4. ★ 复用共享库（以 category 为例，逐字可抄）

这是"下游需要 category 却自己重写了"的**正确解法**：`library/category` 是个 factory，**挂成你自己的 `{service}.category.*` 就行，不要重写**。

**(a) `logic/category.js` —— 就一行：**
```js
module.exports = require('../../library/category');
```

**(b) `logic/index.js` —— 用 `{ serviceName }` 实例化：**
```js
const createCategoryLogic = require('./category');
// ...在聚合器里：
category: createCategoryLogic(redis, { serviceName: config.serviceName }),
```

**(c) `handlers/introspection.js` —— 声明这 8 个固定方法：**
```js
{ name: '{{PROJECT_NAME}}.category.create',      params: [NAME],            returns: ['id','name'],        description: 'Create category' },
{ name: '{{PROJECT_NAME}}.category.update',      params: [ID, NAME_OPT],    returns: ['id','name'],        description: 'Update category' },
{ name: '{{PROJECT_NAME}}.category.delete',      params: [ID],              returns: ['id'],               description: 'Delete category' },
{ name: '{{PROJECT_NAME}}.category.list',        params: [],                description: 'List categories' },   // 返回 BARE 数组 → 不声明 returns_schema
{ name: '{{PROJECT_NAME}}.category.get',         params: [ID],              returns: ['id','name','items'], description: 'Get category' },
{ name: '{{PROJECT_NAME}}.category.item.add',    params: [CAT_ID, NAME],    returns: ['id'],               description: 'Add item' },
{ name: '{{PROJECT_NAME}}.category.item.update', params: [CAT_ID, ITEM_ID], returns: ['id'],               description: 'Update item' },
{ name: '{{PROJECT_NAME}}.category.item.remove', params: [CAT_ID, ITEM_ID], returns: ['id'],               description: 'Remove item' },
```

**(d) `index.js` `/jsonrpc` —— 注意 `.item.add → addItem` 的方法名→函数名改写：**
```js
} else if (method.startsWith('{{PROJECT_NAME}}.category.')) {
  const cat = {
    '{{PROJECT_NAME}}.category.create': (p) => Methods.category.create(p),
    '{{PROJECT_NAME}}.category.update': (p) => Methods.category.update(p),
    '{{PROJECT_NAME}}.category.delete': (p) => Methods.category.delete(p),
    '{{PROJECT_NAME}}.category.list':   (p) => Methods.category.list(p),
    '{{PROJECT_NAME}}.category.get':    (p) => Methods.category.get(p),
    '{{PROJECT_NAME}}.category.item.add':    (p) => Methods.category.addItem(p),
    '{{PROJECT_NAME}}.category.item.update': (p) => Methods.category.updateItem(p),
    '{{PROJECT_NAME}}.category.item.remove': (p) => Methods.category.removeItem(p),
  };
  if (cat[method]) result = await cat[method](params);
}
```

**两个前置**：① `ensureDefaultCategories` 要在 boot 时跑（把 `seeds.categories` 索引进 `{SERVICE}:CONFIG:CATEGORY_IDX`，否则 `category.list` 查不到）；② `.env` 配 `ROUTER_URL`（create/delete 会向 Router 发一次 `system.category.reserve` 出站 RPC 协调全局命名空间——这正是"联邦分类"，per-service 命名是有意设计）。

> `api/core/user/`（`user.category.*`）是同款真实挂载，可对照。**workflow 想用 category？调挂好的 `{{PROJECT_NAME}}.category.*` RPC**——workflow 调不到 library，只能调 RPC。

---

## 5. 命名 + X-Router-Token 契约

- **方法名**：`{service}.{entity}.{action}`（如 `{{PROJECT_NAME}}.widget.create`）。嵌套 ≤ 3 段，最深合法形如 `{service}.category.item.add`。
- **外键**：`{targetService}Id`（如 `categoryId`、`itemId`）。
- **身份**（`library/auth` 中间件已解好，`/jsonrpc` 里直接读，**别把整个 payload 当 req.user**）：
  | 字段 | 是什么 |
  |------|--------|
  | `req.user` | UID **字符串**（如 `'uid-abc'`），public 方法时为 null |
  | `req.permit` | `'admin'` \| `'user'`（**字符串**）。判管理员：`const isAdmin = req.permit === 'admin'` |
  | `req.constraints` | 数据级约束对象 |
- **两层授权**：方法级 permit **Router 的 `checkAccess` 转发前已校验**——请求到你服务时这关已过，无需重复做方法级校验。但**数据级 `constraints` 必须你自己每步现场校验**；需要时加自己的管理员闸：
  ```js
  '{{PROJECT_NAME}}.widget.destroy': (p) => { if (!isAdmin) throw jsonrpc.UNAUTHORIZED(); return Methods.widget.destroy(p); },
  ```

---

## 6. 参数 / 返回声明约定

声明可复用的 descriptor 常量，再引用（抄 `api/sample/handlers/introspection.js`）：
```js
const ID       = { name: 'id',       type: 'string', required: true, maxLength: 64, pattern: 'id' };
const NAME     = { name: 'name',     type: 'string', required: true, maxLength: 64 };
const NAME_OPT = { name: 'name',     type: 'string',                 maxLength: 64 };
const DESC     = { name: 'description', type: 'string',               maxLength: 2000 };  // 自由文本：只限长，无 pattern
const CAT_ID   = { name: 'categoryId', type: 'string', required: true, maxLength: 64, pattern: 'id' };
const ITEM_ID  = { name: 'itemId',     type: 'string', required: true, maxLength: 64, pattern: 'id' };
```
规则：
- **每个 string 参数都要 `maxLength`**（autocheck 卡）。标识类参数加 `pattern`（`'id'`/`'slug'`/`'email'`/`'phone'`/`'username'`，来自 `library/validate.js`）。
- `required: true` = 缺失或 trim 后为空即拒。自由文本（description）只限长不加 pattern。
- `returns`：扁平的顶层字段名数组，如 `['id','name','status','createdAt']`——**`ai:true` 的方法必须有**（让外部 AI 能链式调用）。
- `returns_schema`：带类型的机器可校验契约（`library/contract.js` 方言，规则项同 params）。`required:true` 只给"每条非抛错路径都有且非 null"的键。**返回裸数组的方法不声明 `returns_schema`**（如 `category.list`）。`core/user/handlers/introspection.js` 是 `returns_schema` 的范本。
- 系统方法每个服务都同款声明并注册：`ping`、`methods`、`entities`（+ 有索引时的 `{service}.index.rebuild`/`.schemas`）。
- `events` 与 `guide` 这两个系统方法**只注册、不进 introspection 声明**（RPC 命名检查的系统方法白名单只放行 `ping`/`methods`/`entities`，把 `events` 也声明进去会触发 `[RPC] 方法格式错误`）。`events` 一行接线照 `api/sample/index.js`：`'events': () => require('./handlers/events')`。
- `guide`（服务侧 `BASE_PUBLIC_METHODS` 已放行，进声明反而触发 public-surface 白名单联动）。一行接线照 `api/sample/index.js`：`'guide': () => require('<depth>/library/guide').readGuide('<service>', __dirname)`，读服务目录 `GUIDE.md`（没有则明确返回 `available:false`，合法）。
- **`*.list` 方法的分页参数见 §6.5**——那不是"可选的优化"，漏了会静默截断在 50 条。

---

## 6.5 ★ 分页：每个 `*.list` 都要回答的问题

**默认不分页 = 静默丢数据。** `library/entity.js` 的 `list()` 默认 `limit = 50`：一个声明
`params: []` 的 list 方法**实际只返回 50 条**，而调用方（尤其是读 `methods` 自省的外部 AI）
看不到任何翻页参数，会把这 50 条当成全集。不报错、不告警，`total` 字段虽然诚实但没人会去比对。
这是下游项目最常犯的一个错，且要等数据长到 50 条以后才显形。

规则是**二选一，不是"一律分页"**：

> **全队标准是 `limit` / `offset` / `cursor` 这三个名字**（权威表在 `api/autocheck/static/param-conventions.js`
> 的 `FLEET_PARAM_TYPES`，autocheck 卡类型）。你可能在框架的存量服务里见到 `page` / `pageSize`
> ——那是早期方言，只为不破坏既有调用方而保留，**新方法一个字都别抄**。底层 `library/entity.js`
> 只认标准那三个；多一套方言就多一层换算，那三行换算曾在五个服务里各抄了一份，现在收进了
> `library/pagination.js` 的 `resolvePaging()`（要同时接受两套时 `require` 它，别再手抄）。

**(a) 无界集合**（用户数据、随使用增长的实体）→ 必须声明分页参数：

```js
const LIMIT  = { name: 'limit',  type: 'number' };
const OFFSET = { name: 'offset', type: 'number' };
const CURSOR = { name: 'cursor', type: 'string', maxLength: 64 };   // 首页传 null，Router 对 null 跳过类型校验

{ name: '{{PROJECT_NAME}}.widget.list', params: [LIMIT, OFFSET, CURSOR],
  returns: ['items', 'total', 'nextCursor'],
  description: 'List widgets — paginated（offset 模式返回 {items,total}；cursor 模式返回 {items,nextCursor}）, 默认 limit 50', ai: true },
```

`logic` 层**原样透传** `entity.list(p)`（别只挑几个键往下传，那等于把分页掐掉）。两种模式：

| 模式 | 怎么调 | 返回 | 成本 |
|------|--------|------|------|
| offset | `{ limit, offset }`，**不带 `cursor` 键** | `{ items, total }` | O(集合全量)：把整个索引拉进内存、全排序、再切一页 |
| cursor（推荐） | 首页 `{ limit, cursor: null }`，之后回传 `nextCursor` | `{ items, nextCursor }` | O(limit)：只读一个 ZRANGE 窗口 |

cursor 模式三个前提，写进你的 `GUIDE.md`：① 没有 `total`（keyset 分页不知道共几页）；
② 单页可能少于 `limit`（`status`/`filter` 在取回窗口**之后**才过滤），**只有 `nextCursor === null`
才是结束信号**；③ 服务已有历史数据时要先迁移一次，否则直接抛 `INVALID_PARAMS`（有意不静默
退回慢路径）——全新服务不需要。迁移脚本脚手架已带，每个实体跑一次、幂等可重跑：

```bash
REDIS_URL=$REDIS_URL node deploy/migrate-cursor-index.js {{PROJECT_NAME}} widget
# 实体声明了 storageType: 'json' 就在末尾再加一个 json 参数
```

**(b) 有界集合**（分类、角色、配置项——设计期就有限）→ `params: []` 是对的，但**必须在
description 里明说**"有界集合，有意不分页"。在 wire 上，"不需要分页"和"作者忘了分页"长得一模一样，
只有描述能区分。`{{PROJECT_NAME}}.category.list`（§4）就属于这一类。

**🔴 别用 `redis.keys('PREFIX:*')` 拼 list。** 它让 Redis 的**单线程**遍历整个 keyspace，
期间全栈所有服务的请求一起排队；开发期数据少完全看不出来，上线几个月后突然拖垮整个栈。
`SCAN` 也不是解药（一样要走遍 keyspace）——正解是**维护索引**，而 Entity Factory 已经替你
维护好了。`KEYS` 只在一种场合合法：boot 期一次性重建索引，且必须在那一行写 `// SAFE:` + 理由。
autocheck 的 `pagination-safety` 规则会拦 `keys` / `sMembers` / `hGetAll` / `zRange(k,0,-1)`。

---

## 7. 写完自查（8 条最常踩）

1. **声明↔注册不同步** → `autocheck --static` 直接红。先跑它。
2. **自己重写了 library 已有的东西**（category/entity/index/auth）→ 回 §0/§4 改成 `require` + 挂载。
3. **把整个 token payload 当 `req.user`** → 只读 `req.user`(uid 串)/`req.permit`/`req.constraints`（§5）。
4. **string 参数漏 `maxLength`** / 标识漏 `pattern` → autocheck 卡。
5. **服务里直接 POST 另一个服务** → 禁止。走 Router：`relay.call(...)`（带 bot token），或返回 `_tasks` 让 Router 派发，或返回 `_event`（见 `events.md`）。
6. **`*.list` 声明 `params: []`** → 无界集合会静默截断在 50 条；有界集合也要在 description 里
   明说"有意不分页"（§6.5）。顺手确认没在 logic 里用 `redis.keys()` 扫 keyspace。
7. **`app.listen(PORT, cb)` 漏了 host** → 服务永远绑所有网卡，部署到有公网 IP 的机器上就是
   直接对外。接 `bindAddr('<service>')`（§2）。
8. **`walContext.run` 手写 store 字面量** → passport 外部会话的行隔离（`$owner`）进不了
   Entity Factory，外部主体能读全表且零告警。用 `requestContext(req)`（§2）。

> 跑通后：`node api/autocheck/checker.js api/apps/{{PROJECT_NAME}} --static` 必须 PASS；把服务加进 `deploy/solo-services.json` 或你的 services.json 才会被 Router 拉起。
