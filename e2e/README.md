# SOLO E2E 测试系统 — 搭建文档（设计 / 实施计划）

> 本文是**如何搭建**一套显式、完整的 SOLO 端到端测试系统的设计文档。目标：注入测试用户 → **走真实登录流程** → 系统性地跑每个 API → 断言。
> 本文只规划与给骨架，**尚未实现**。校对基准 2026-06-03，基于对当前代码的精确核查（含 file:line）。

---

## 0. 一句话 + 一个必须先知道的修正

E2E 系统 = **拉起整栈 → 用真实挑战-响应登录拿 token → 经 Router 跑每个服务的 API → 断言 + 清理**。

> ⚠️ **关键事实（曾有文档漂移，已于本轮修正）**：CLAUDE.md §2 / `core/user/README.md` / `docs/reference/overview.md` 一度写用户是 **"Ed25519 挑战-签名"**，但**代码不是**——已改正。`user.login.*` 实际是**对称 SHA-256 挑战-响应**（`api/core/user/logic/user.js:160`）：
> ```
> register:  hash = SHA256(password + salt)        # 客户端算,服务端原样存 user.hash
> login.request({name}) → { challenge, salt }      # challenge:{name},120s TTL,一次性
> response = SHA256(challenge + hash)               # 客户端算
> login.verify({name,challenge,response,deviceId}) → 服务端比对 SHA256(challenge + user.hash)
> → { success, token, uid, permit }                # token 写 session:{token},7 天 TTL
> ```
> **没有 keypair、没有公钥、没有签名验证**。`user.hash` 对服务端是**不透明**的——存什么就比什么,测试可以自选任意 hash,只要 register 和 login 用同一个值。
> （Ed25519 在 SOLO 里只用于 **Router→微服务**的传输层签名,与人登录无关。Portal/管理员走的是**另一套**:`admin.login.*` + PBKDF2,打 administrator 服务,别混。）
>
> 现成参考实现:`api/autocheck/simulation/framework/account.js:37-54`、`client/mobile/src/lib/api.ts`。

---

## 1. 目标与范围

| 目标 | 含义 |
|------|------|
| **注入测试用户** | 经 Redis 直写,或经公开的 `user.register` API 建用户(带已知 salt/hash) |
| **真实登录** | 走 `user.login.request` → 算 response → `user.login.verify` 拿真 session token(不是直接塞 `session:{token}` 的捷径) |
| **permit 可调** | 改 `user:{uid}.permit`(`{allow_all, services:{svc:[全名method或'*']}}`)即调权限;H6 与 Router 鉴权都读这里 |
| **跑每个 API** | 经 Router(POST `/`,Bearer token),按服务遍历每个方法,分公开/会话/admin 三档身份 |
| **深度验证** | 每个写操作**四连断言**:① API 结果对、② **Redis 落库**形状/字段/索引对、③ **日志/WAL**对(且 happy-path 无 error)、④ **没写异常数据**(keyspace 快照-diff)。详见 §8 |
| **清理 + 隔离** | 每条用例自清(含 WAL 文件),唯一标记防撞,可独立 DB |

**显式** = 不靠 mock,真起服务、真过 Router、真签名转发、真 Redis。这是比 `--static` / 单测 / 仿真更高一档的关口。

---

## 2. 目录结构（Jest,`e2e/` 独立项目)

> **架构基调:用 Jest,但 `e2e/` 是自带 `package.json` + `node_modules` 的独立项目**(自己装 jest + redis)。理由:微服务单测 与 这套黑盒 E2E 是**两种场景**——统一落在"**运行器/写法**"(都 Jest)即可,**不必在依赖库的颗粒度上统一**。换来 `cd e2e && npm test` 可**独立跑**,不绑 api 的安装;代价是 redis/jest 版本与 api 可能小幅漂移——E2E 只在测试侧用 redis 读写裸 key,漂移无害、同步也快。

```
e2e/                                 # 独立 Node 项目:自带 package.json + node_modules(不入根 workspaces)
├── README.md                        # 本文(设计文档)
├── package.json                     # devDeps: jest + redis;"scripts": { "test": "jest" }
├── jest.config.js                   # globalSetup/teardown + testMatch *.e2e.test.js + maxWorkers:1 + forceExit
├── harness/
│   ├── setup.js                     # globalSetup:spawn api 服务入口 → 等就绪 → 注册 → 播 bot token(§6)
│   ├── identity.js                  # 建测试用户(register)+ 真实登录 + permit 调整 + admin 会话
│   └── teardown.js                  # globalTeardown:反序杀进程(external 哨兵的留)+ 清 Redis
├── lib/
│   ├── crypto.js                    # sha256(str);算 register hash、login response
│   ├── client.js                    # JSON-RPC over Router(POST /,Bearer token)→ {result,error}
│   ├── redis.js                     # 连 6699 + 小工具(json.set / set / del / SCAN)
│   ├── verify.js                    # §8 四连断言:assertRecord / assertWal / assertNoErrors / snapshotKeyspace+diff
│   └── wal.js                       # §8.3 WAL 只读 reader:query(key,logDir,N)(从 api/library/logger.js 拷精简,不跨项目 require)
└── suites/
    ├── 00-login.e2e.test.js         # 注册 + 真实挑战-响应登录(基础,必须先过)
    ├── 10-permit.e2e.test.js        # permit 杠杆:最小→挡,调全→过(纳入已有 deploy/mock/e2e.js 思路)
    ├── 2x-<service>.e2e.test.js     # 每个【独立】服务一套(user/orchestrator/storage/...);见 §7.5
    └── 90-event-chain.e2e.test.js   # ingress→collection→market→notification 整链(【单文件】,见 §7.5)
```

> **monorepo 注意**:根 `package.json` 是 workspaces monorepo,但 `e2e/` **不列入** `workspaces` 数组(保持独立安装)。在 `e2e/` 内 `npm install`(若 workspace 探测干扰,用 `npm install --prefix e2e`),并在 `e2e/` 留独立 `package-lock.json`。
> harness 的 `spawnService` / `waitFor` / `system.service.add` 握手范式从 `api/tests/e2e/setup.js` **移植**过来(照抄改写,不跨项目 `require`),保持 `e2e/` 自包含。为何选 C 见 §10。

---

## 3. 整体架构(三层)

```
┌─ globalSetup(harness/setup.js)─────────────────────────────┐
│  起 Redis(或复用 dev.sh)→ spawn 全部服务 → 注册到 Router   │
│  → 播 4 个 relay bot token → 起 dev 夹具 → (可选)注入 workflow │
└────────────────────────────────────────────────────────────┘
        │ 栈就绪
        ▼
┌─ identity.js(harness/identity.js)──────────────────────────┐
│  admin(注入 session:{token} allow_all)                      │
│  testUser(register 真建 → 真实登录拿 token → 可调 permit)    │
└────────────────────────────────────────────────────────────┘
        │ 拿到各身份的 token
        ▼
┌─ suites/*.e2e.test.js(Jest describe/test)──────────────────┐
│  client.rpc(method, params, token) → 经 Router 真调 → expect │
└────────────────────────────────────────────────────────────┘
        │
        ▼ globalTeardown 清理
```

- **client**:POST 到 Router 根 `/`(注意**不是** `/jsonrpc`,见 `tests/e2e/setup.js`),body `{jsonrpc:'2.0',method,params,id}`,头 `Authorization: Bearer <token>`。
- **identity**:admin 用注入 session(allow_all)做管理操作(注册服务、播 token、approve);testUser 用**真实登录**(本系统的核心卖点)。
- **栈**:见 §6 清单。

---

## 4. 真实登录流程(精确,照此写 `identity.js`)

```js
// lib/crypto.js
const crypto = require('crypto');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// harness/identity.js — 建一个能真实登录的测试用户
async function createAndLogin(client, { name, password = 'e2e-pass' }) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = sha256(password + salt);                       // = 服务端将存的 user.hash
    // 1) 注册(public,经 Router 免 token)
    await client.rpc('user.register', { name, salt, hash });
    // 2) 取挑战
    const req = await client.rpc('user.login.request', { name });
    const challenge = req.result.challenge;                     // 120s 一次性
    // 3) 算响应 + 验证
    const response = sha256(challenge + hash);
    const ver = await client.rpc('user.login.verify', { name, challenge, response, deviceId: 'e2e' });
    return { uid: ver.result.uid, token: ver.result.token };    // token = 真 session(7 天)
}
```

关键点(全部已核实):
- `user.register` / `user.login.request` / `user.login.verify` 都是 **public**(`core/user/handlers/auth.js:47` 白名单)→ 无 token 也能调。
- **必须自带 salt+hash**:不传则服务端生成随机的 → 永远登不上(`user.js:31`)。
- challenge 是 **`challenge:{name}` 120s 一次性**,request 后立刻 verify。
- name 会 **lowercase+trim**(两端一致,大小写无所谓)。
- 别给测试用户设 `type:'bot'`(loginVerify 硬拒 bot,`user.js:157`)。

> **可选:Redis 直注入用户**(跳过 register API):写 `user:{uid}`(`{id,name,salt,hash,status:'ACTIVE',permit}`)+ `user:name:{name}→uid` + `sAdd user:ids`。uid 须 16 位 Base58(`library/generator.generateId(16)`)。之后照样真实登录(login 只查 `user.hash`)。

---

## 5. 测试用户生命周期

```
建用户(register 或注入)
  └ 真实登录 → token
       └ 跑会话级 API(permit 列了的)
       └ 调 permit(redis 改 user:{uid}.permit)→ 再跑 → 验证权限变化
  └ admin 操作另起一个 allow_all 身份(注入 session 即可,管理操作不需要"真实登录")
清理:del user:{uid} / user:name:{name} / SREM user:ids / del session:{token}
```

- **permit 形状**:`{ allow_all:bool, services:{ <服务名>: ['<全名method>'|'*', ...] } }`。服务名 = 方法第一段(`collection.payment.record`→`collection`);method 要写**全名**或 `'*'`(`library/permit.js:69`)。
- **admin** = `permit.allow_all===true`(`router/handlers/auth.js:101`);role 字段只影响 TTL 续期,不决定 admin。
- **Scheme F 陷阱**:Router 鉴权若发现 `user:{uid}` 存在,会用它**覆盖** session 的 permit(`auth.js:43`)。所以测试用户的 permit 以 `user:{uid}.permit` 为准,调它即可;注入纯 session(无 user:{uid})则 session permit 生效。

---

## 6. 整栈 bring-up 清单(globalSetup = `harness/setup.js`)

把 `api/tests/e2e/setup.js`(现只起 Router+orchestrator)的 `spawnService` / `waitFor` / external 哨兵 / `system.service.add` 范式**移植**进 `e2e/harness/setup.js`,拉成**整栈**——jest 每个 config 只跑一次 globalSetup,整栈对所有 `*.e2e.test.js` 共享(所以"用到多个服务"不靠合并文件,见 §7.5)。

**两套 profile**(§13):`lite` = workers 全关(`ORCH_WORKER`/`ORCH_MATCHER`/`NEXUS_CONSUMER`/`NEXUS_SCHEDULER`/`NOTIFICATION_WORKER=false`)、不需 bot token,给 P0–P4;`full` = 开 orchestrator matcher + nexus consumer + 播 4 个 bot token(下方步骤 4),只给 P5 事件链。

**前提**:Redis 6699 **redis-stack**(RedisJSON;orchestrator/storage 需要)。可复用 `bash deploy/dev.sh` 起好的栈(setup.js 探到端口已起就跳过 spawn,external 哨兵)。

**顺序**(已核实依赖):
1. **Redis**(6699,redis-stack)。
2. **起服务**:Router(8600)+ 12 个(administrator/user/agent/nexus/notification/gateway/ingress/orchestrator/storage/fulfillment/planner/approval)+ 2 夹具(collection 8055/market 8056)。
   - orchestrator 默认起 worker+matcher(`ORCH_WORKER/ORCH_MATCHER` 不设为 false);事件链测试需要它们开。
3. **注册到 Router**:对每个非 router 服务 `system.service.add({url})`(admin 身份;localhost+debug 也可)。做 Ed25519 握手(`/auth/seed`→`/auth/verify`→introspect)。**注册持久化到 `active_services`**,重启不丢。
4. **播 4 个 relay bot token**(否则 event.emit / notification.send / scheduler / ingress 发流全失败):对 orchestrator / nexus / notification / ingress 各做:
   ```
   user.bot.create({ uid:'system.<svc>', permit:{allow_all:false, services:{...}} })   # bot 禁 allow_all
   user.bot.issue.token({ uid:'system.<svc>' }) → { token, expiresAt }
   <svc>.token.set({ token, expiresAt, sub:'system.<svc>' })
   ```
   ⚠️ 事件链能跑通,`system.orchestrator` bot 的 permit 必须**覆盖被触发 workflow 的所有 step 方法**(collection/market/notification 的全名),否则 H6 进人在环(见已修的 runner.js permit-unwrap bug)。
5. **(事件链)注入 workflow + 事件注册表覆盖**:复用 `deploy/mock/inject-workflows.js`(ACTIVE)。
6. **(可选)起 dev 前端**:E2E 走 API,不需要。

**就绪探针**:Router POST `ping`;各服务 GET `/auth/seed` 200(免鉴权)。

---

## 7. 跑每个 API(suites 的遍历策略)

> **范围(§13 已定)**:只读方法(`*.list` / `*.get` / `ping`)**自动遍历冒烟**(静态读 introspection 枚举);`create` / `update` / `transition` 等**结构化/变更**方法**不盲调**——在 per-service suite 手写有效载荷(blind-call 构造不出 `steps`/`permit`/`category` 等必填对象,且会误触副作用)。

### 7.1 身份三档(每个方法属于其一)
| 档 | 怎么过 | 怎么测 |
|----|--------|--------|
| **public** | `public:true`(introspection)或 Router `systemApi` 表 | 无 token 调通 |
| **session** | caller permit 列了该 `service.method`(或 `'*'`) | testUser permit 覆盖后调通 |
| **admin** | `permit.allow_all`(下游 `req.permit==='admin'` 守卫) | admin token 调通;非 admin 调被拒 |

> 真正的方法级 ACL 在 **Router checkAccess**;下游只补 admin 守卫(CLAUDE.md §7)。**测试必须经 Router**,直连服务会绕过 ACL。

### 7.2 发现机制
每个服务都有 `methods` RPC,返回它的 introspection 数组 → 可**枚举后逐个调**。但 `methods` / `system.service.list` 等**发现类在生产(debug=false)被封**(`access.js:37`)。两条路:
- E2E 起服务时开 `DEBUG=true` → `methods` 可调 → 动态枚举。
- 或**静态读** `handlers/introspection.js`(更稳,不依赖 debug)。

### 7.3 安全 vs 变更 vs 危险(决定调用时序)
- **可盲调(只读)**:各服务 `ping`/`methods`/`entities`、`*.list`、`*.get`。
- **变更类(要时序)**:`*.create`→拿 id→`*.update`/`*.delete`/`transition`。典型链:
  - `orchestrator.workflow.create`→id→`approve`(**须换一个 uid**,禁自审)→`run`
  - `fulfillment.profile.create`→`instance.create(profileId)`→`instance.transition(合法枚举态)`
  - `collection.payment.record`→id→`settle`;`storage.asset.upload(base64)`→id→`resolve`/`delete`
- **⚠️ 危险(盲调会坏事,必须排除/特判)**:
  - `admin.self.lock` —— **关掉 administrator 端口**,后续全挂。
  - `storage.asset.delete` / `asset.list` —— introspection 标非 public 但**下游无守卫**(drift),admin token 盲调会真删。
  - `agent.chat` / `agent.image.*` / `agent.audio.*` —— 需真实 LLM key,**非 hermetic**。
  - `ingress.ingest` —— 需 per-source API key(不是 session),单独测(走 mock 工具包)。

### 7.4 自审禁令
`orchestrator.workflow.approve` 禁 `callerUid===submittedBy`(字符串比较)→ 建/审要**两个不同身份**(两个 token,两个 uid)。

### 7.5 用例的文件组织(Jest:独立服务分文件,有序链路单文件)

整栈由 **globalSetup 一次性拉起**,对每个 test 文件都活着 → "想用到多个服务"**不需要**挤一个文件。真正决定合并的是**顺序 / 状态依赖**:

- **独立服务 → 各自一个文件**(`2x-user` / `2x-storage` / …):互不依赖副作用,各自 `beforeAll` 自洽登录。
- **有序依赖链 → 一个文件**(`90-event-chain`):因为 Jest **不保证跨文件执行顺序**,且跨文件难共享状态;链路里 `request_id` / `paymentId` / `trackingNo` 要一路传、逐跳断言 → 放一个文件用闭包串。
- 文件内**不写一个大 `test()`,而是多个 `test()` 按声明顺序 + 闭包共享状态**:`--runInBand` 下同文件 `test()` **串行执行**(顺序天然保证)、逐跳 green/red(第 ④ 跳挂一眼看出是 market 不是 collection)、失败级联正合事件链语义(坏状态上别继续断言)。

```js
// 90-event-chain.e2e.test.js
describe('event chain: ingress → collection → market → notification', () => {
  let token, paymentId, shipmentId;                          // 闭包,跨 step 传递
  beforeAll(async () => { token = await login(/* … */); });  // 本文件自洽登录

  test('① ingress.ingest(stripe) → EVENT:WEBHOOK:STRIPE 落流', async () => { /* … */ });
  test('② wf-record-payment → collection RECEIVED',  async () => { paymentId  = /* … */; });
  test('③ wf-settle → SETTLED',                       async () => { /* 用 paymentId */ });
  test('④ wf-create-shipment → market CREATED',       async () => { shipmentId = /* … */; });
  test('⑤ wf-ship → SHIPPED(trackingNo)',            async () => { /* … */ });
  test('⑥ wf-notify → notification 已发 + ERROR:QUEUE:* 全空', async () => { /* … */ });
});
```

> 若确实要**跨文件**强顺序(如 `00-login` 必须最先跑),加个十几行的 `testSequencer` 按文件名排序;但更稳的做法是**每个文件自洽**(自己登录),让编号只表达"概念顺序",文件间不共享状态。

---

## 8. 深度验证(状态 / 日志 / 异常)、隔离、清理

> **核心:断言不止于 API 返回。** 每个写操作要同时验证**四层**:① API 结果对、② Redis 落库对、③ 日志/WAL 对、④ 没写异常数据。下面给出每层的精确读回点(全部已核实 file:line)。

### 8.1 每条用例的"四连断言"标准结构

```js
const before = await snapshotKeyspace(redis);        // 8.4 异常检测基线
const res = await client.rpc(method, params, token); // ① API
assertResult(res);                                   // ① 结果/错误码对
await assertRecord(redis, expectedKey, expectedShape); // ② 落库对(8.2)
await assertWal(expectedKey, 'create', { user: uid }); // ③ WAL 对(8.3)
await assertNoErrors(redis);                         // ③ happy-path 无 error(8.3)
await assertOnlyExpectedKeysChanged(before, redis, allow); // ④ 无异常(8.4)
```

**①结果**:`res.result`(成功)/ `res.error.code`(`-32601` METHOD_NOT_FOUND、`-32604`/`-32005` Forbidden、`-32003` Unauthorized)。"可达性"= 码 ≠ -32601。

### 8.2 Redis 落库校验（记录正确性 checklist）

读回写入的 key,逐项核对(Entity Factory 范式,`library/entity.js`):

- **data key 存在 + 形状对**:`SERVICE:ENTITY:{id}`(string 或 RedisJSON,见 8.4 类型表)。含自动字段:`id` / `status`(默认 `ACTIVE`,枚举内)/ `createdAt` / `updatedAt`(均为 ms 整数)。
- **INDEX 成员对**:`id ∈ sMembers(SERVICE:ENTITY:INDEX)`。**孤儿检测**:有 data key 但不在 INDEX、或在 INDEX 但无 data key = 异常。
- **不变量**:`updatedAt >= createdAt`(注意 `createdAt` **可被调用方覆盖**、可能被回填,别拿它对墙钟,`entity.js:136`);status 在枚举内;required 字段都在。
- **软删**:`status=DELETED` 但**仍在 INDEX**(softDelete 实体正常;hard-delete 实体若还在 INDEX 则异常,`entity.js:213`)。
- **敏感字段密文**:`sensitiveFields`(如 gateway `pass`、ingress `keyHash`)在 data key 里是**密文/哈希**,断言**不等于明文**(`entity.js:72`)。
- **原子性**:string 存储走 MULTI/EXEC 原子;**RedisJSON 的 create/delete 是顺序非原子**(`entity.js:140`)——对 RedisJSON 实体别假设"全有或全无"。

### 8.3 日志 / WAL 校验(三个 sink,各有读回点)

| sink | 落点 | 读回 | E2E 断言 |
|------|------|------|----------|
| **error 队列** | Redis LIST `ERROR:QUEUE:{service}`(`logger.error` rPush,需 `setRedis`,15 个服务启动都调了) | `lRange` / `admin.log.error` | **happy-path:每个 `ERROR:QUEUE:*` 都空(`LLEN==0`)**;负向用例:断言队列里有预期 `{code, method}` |
| **Entity WAL** | **文件**(非 Redis):`logs/{h}/{h}/{h}/{hash[6:]}.log` + 日索引 `logs/wal/{年}/{日}.index` | `logger.query('SERVICE:ENTITY:{id}', folder, N)` | 断言 create 行 `{op:'create', before:null, after:全实体, user:调用uid}`;update `{op:'update', before, after}`;**软删是 `op:'update'`(status DELETED),不是 delete** |
| **Router 交互日志** | **文件**:`api/router/logs/interactions`,分区 `{uid}_{YYYYMM}` | `logger.query` / `admin.log.interaction` | **仅 `agent.*` 成功 + 所有被拒(METHOD_NOT_FOUND/AUTH_REQUIRED/FORBIDDEN)** 才有行;非 agent 成功**不写**交互日志→ 改断言其 WAL 行 |

注意:
- `info/warn` **只进 stdout**,不落 Redis/文件 → 不可断言(除非抓 stdout)。只有 `error` 持久(到 Redis 队列)。
- WAL `query()` 的 key 是 **data key**(`SERVICE:ENTITY:{id}`),不是裸 id;传错 → 返回 `[]` 伪装成"没写 WAL"。
- WAL 里 sensitiveFields 是 `[REDACTED]`,别断言明文。
- WAL 索引用 **UTC** 日期,交互日志分区用**本地**月——跨 UTC/本地午夜跑别找错分区。

> **"零 error"的可信度前提**:Redis error 推送 gated 在 `setRedis()+isOpen`。E2E 必须**真起服务**才能让 `ERROR:QUEUE:*` 断言有效。⚠️ 本轮核查发现 `administrator` 启动**漏调** `setRedis()`(其余 14 服务都调了),其错误从不入队 → 断言假绿;**已补修**(`api/core/administrator/index.js`,见 §13)。新增服务务必照 `user/index.js:67` 在连 Redis 后调一次。

### 8.4 异常数据检测（keyspace 快照-diff）

`SCAN` 整个库,操作前后做 diff,断言**只有预期前缀变了**,任何意外 key = 异常。需要一张**期望前缀 allow-list**(下表,已核实 file:line):

| 服务 | 写的 key 前缀(类型) |
|------|---------------------|
| router | `active_services`/`system:capability:list`/`session:`(TTL)/`ERROR:QUEUE:router`(list)/`SYSTEM:CONFIG:*`/`SYSTEM:AI:REPORT`(zset)/`RL:*`(TTL) |
| user | `user:`/`user:name:`/`user:ids`(set)/`challenge:`(120s)/`session:`(7d)/`user:bot:`/`user:bot:ids` |
| nexus | `NEXUS:AGENT:*`/`NEXUS:SUB:*`/`NEXUS:AGENT:ONLINE:`(60s)/`NEXUS:SCHEDULE`(zset)/`NEXUS:SCHEDULE:DEF:`(JSON) |
| notification | `NOTIFICATION:MSG:`/`INBOX:`(zset)/`CONFIG:`/`INDEX`(zset)/`QUEUE:PENDING|RETRY|DEADLETTER` |
| orchestrator | `ORCHESTRATOR:WORKFLOW:`(JSON)/`AGENT:WORKFLOW_SNAPSHOT`/`ORCHESTRATOR:RUNQ:*`/`ORCHESTRATOR:RUN:*`(JSON) |
| administrator | `administrator:user:`/`session:`(1800s)/`ERROR:QUEUE:`/`SYSTEM:INDEX_SCHEMA:` |
| ingress | `EVENT:WEBHOOK:*`(stream)/`INGRESS:KEYHASH:`/`INGRESS:DEDUP:`(86400s)/`INGRESS:SOURCE:*`/`INGRESS:NAME:` |
| gateway | `GATEWAY:SMTP:*`/`GATEWAY:EMAIL_TEMPLATE:*`/`GATEWAY:SMS_TEMPLATE:*`(+`:INDEX`) |
| storage | `STORAGE:ASSET:*`/`STORAGE:SHA256:*`/`STORAGE:ASSETS:SORTED`(zset) |
| planner | `PLANNER:U:{uid}:AGENDA:*`/`PLANNER:U:{uid}:TODO:*`(+`:INDEX`) |
| fulfillment | `FULFILLMENT:INSTANCE:*`/`FULFILLMENT:PROFILE:*`(+`:INDEX`) |
| approval | `APPROVAL:RECORD:*`(+`:INDEX`) |
| collection/market | `COLLECTION:PAYMENT:*`/`MARKET:SHIPMENT:*`(+`:INDEX`);emit `EVENT:PAYMENT:*`/`EVENT:SHIPMENT:*` |
| 共享库 | `SYSTEM:SEMANTIC:{svc}`(JSON)/`{SVC}:CONFIG:CATEGORY:*`/`RELAY:TOKEN:{svc}`(+`:LOCK` 30s)/Entity `SVC:ENT:*`+`:INDEX` |

diff 的坑(否则误报):
- **TTL key 自动过期,不算异常**:`session`/`challenge`/`ONLINE`/`RL`/`INGRESS:DEDUP`/`RELAY:TOKEN:LOCK`。
- **`EVENT:*` 是流**:offset 会变但不是"领域写入";按 `XLEN` 增量而非 key 存在性 diff。
- **多写者共享 key**:`session:`(user+admin+router)、`ERROR:QUEUE:`(router 写/admin 删)、`ORCHESTRATOR:RUNQ:PENDING`(orch worker + nexus scheduler)——归因要小心。
- **config 不是 ground truth**:Entity Factory 的 `SVC:ENT:*` 不在 config 里(从写点推);有些 config 前缀是 **dead**(`PLANNER:AGENDA:`/`PLANNER:TODO:`/`STORAGE:ASSETS` set),出现即可疑。
- **agent 服务**几乎不写领域 key(只 boot 时写 `SYSTEM:SEMANTIC:agent`)。

### 8.5 隔离与清理

- **隔离**:本次 run 的 key 带唯一标记(用例自带唯一 `name`/`uid`,`generateId` 防撞)。
- **清理**:每套 `afterAll` 删自己造的 key(user/session/workflow/payment/WAL 文件…);harness teardown 杀 spawn 进程(反序,external 的留)。
- **隔离 DB**:默认用 dev 6699;要彻底隔离起独立 redis-stack 端口 + `REDIS_URL` 覆盖(所有 spawn 服务继承)。**WAL 文件**用 `LOG_DIR` env 指到临时目录,避免污染 `api/logs`。

---

## 9. 分阶段实施(建议落地顺序)

> 全程基于 **Jest**,但 `e2e/` 是独立项目(自带 `package.json` + `node_modules`,见 §2)。运行器从 P0 就定了。

1. **P0 项目骨架 + 最小 globalSetup**:`e2e/package.json`(`npm install` 装 jest+redis)+ `lib/`(crypto/client/redis)+ `harness/identity.js`(真实登录)+ `suites/00-login.e2e.test.js`;`jest.config.js` 的 globalSetup 先只起**最小栈**(Router+user)。**先把"真实登录"跑通**,这是整套的根。
2. **P1 深度验证 helpers**:`lib/verify.js`(§8 的 `assertRecord`/`assertWal`/`assertNoErrors`/`snapshotKeyspace`+diff)。**先把验证工具建好**,后面每套 suite 都用它做"四连断言"——否则只断言 API 返回,等于没测副作用(你正担心的那层)。
3. **P2 permit 杠杆**:`suites/10-permit.e2e.test.js` —— 纳入 `deploy/mock/e2e.js`(sync workflow + permit 杠杆),验证 H6/权限(依赖已修的 runner permit-unwrap)。
4. **P3 整栈 globalSetup**:把 `harness/setup.js` 从最小栈扩成**整栈**(全部服务 + 注册 + 播 bot token,§6)。先手动 `dev.sh` + external 哨兵,跑通后再让 globalSetup 自起。
5. **P4 逐服务 suite**:每个**独立**服务一套 `suites/2x-<svc>.e2e.test.js`(各自一文件,§7.5),**每条用例走四连断言**(API+落库+WAL+无异常),先只读(list/get)再变更链,排除 §7.3 危险方法。
6. **P5 事件链**:`suites/90-event-chain.e2e.test.js`(**单文件 + 多 `test()` 闭包串**,§7.5)—— 注入 workflow(ACTIVE)+ 配 `system.orchestrator` bot permit + 触发 → 逐跳断言 collection SETTLED / market SHIPPED / notification 已发 + 沿途 `EVENT:*` 流落库对 + `ERROR:QUEUE:*` 全空。
7. **P6 接 CI**:`cd e2e && npm test` 即入口;跑通且稳定后挂进 CI(独立 job,带 redis-stack 服务 + `cd e2e && npm ci`),作为比 `--static` / 单测高一档的 PR 关口。

---

## 10. 与现有 `api/tests/e2e/` 的关系

- 现有 `api/tests/e2e/`(jest globalSetup/teardown,只起 Router+orchestrator,worker/matcher 关)是**最小黑盒 harness**,范式好(spawnService/waitFor/external 哨兵/system.service.add/session 注入)。
- **决定:`e2e/` 独立成项(C)—— 自带 `package.json` + `node_modules`(自己装 jest+redis),`cd e2e && npm test` 独立跑。** 微服务单测 与 黑盒 E2E 是**两种场景**:前者白盒、`require` 服务内部模块、跟 api 依赖树绑死;后者黑盒、只经 Router/HTTP + redis 读裸 key。统一应落在**运行器与写法**(都 Jest),而非**依赖库的颗粒度**。
- **复用方式 = 移植,不跨项目 `require`**:把 `api/tests/e2e/setup.js` 的 `spawnService` / `waitFor` / `system.service.add` 握手等积木**照抄进 `e2e/harness/`**,保持自包含。
- **版本漂移可接受**:`e2e/` 的 redis/jest 可与 api 不同步;E2E 只在测试侧用 redis 读写裸 key、用 jest 跑断言,漂移无害、同步也快。
- (曾考虑:A「独立 `run.sh` 手搓 runner」——丢掉 jest 隔离/钩子/报告,放弃;B「并进 `api/tests/e2e/` 共用 api 安装」——把两种场景在库颗粒度上强绑,放弃。)

---

## 11. 危险方法清单(实现 §7 遍历前必读)

| 方法 | 后果 | 处理 |
|------|------|------|
| `admin.self.lock` | 关 administrator 端口,后续全挂 | **永不盲调**,排除 |
| `storage.asset.delete` / `asset.list` | 无下游守卫,admin 盲调真删/真列 | 只在专门用例、可控数据上调 |
| `agent.chat` / `agent.image.*` / `agent.audio.*` | 需真实 LLM key,非 hermetic | 排除或单独标 `@external` |
| `ingress.ingest` | 需 per-source API key,不是 session | 走 mock 工具包单独测 |
| `gateway.email.send` / `gateway.sms.send` | 真发邮件/短信(若配了 SMTP/SMS) | 用未配置账号 / 排除 |
| `orchestrator.workflow.run` | 真执行 workflow,有副作用 | 用受控的测试 workflow + 测试用户 permit |
| `orchestrator.workflow.create` | 建即 ACTIVE(无审核闸),matcher 可立即触发 | 用 PENDING_REVIEW 注入或受控 category;勿盲调 |
| `orchestrator.workflow.restore` | 绕审计恢复旧版本 | 排除自动遍历 |
| `nexus.schedule.create` / `schedule.*` | 写 `NEXUS:SCHEDULE` zset,到点真触发 | 专门用例 + 清理;勿盲调 |
| `ingress.source.test` | 发合成 `webhook.received` 事件 | 专门用例 |

---

## 12. 与现有协议/工具的关系

| 东西 | 关系 |
|------|------|
| `api/autocheck/simulation/framework/account.js` | 现成的"注册+真实登录"recipe,`identity.js` 照抄 |
| `client/mobile/src/lib/api.ts` | 用户服务的权威参考客户端(register/login 的 hash 推导) |
| `api/tests/e2e/` | 最小 jest harness;把它的 spawnService/waitFor/握手范式**移植**进 `e2e/harness/`(§10 走 C:e2e 独立成项,不跨项目 require) |
| `deploy/mock/` | ingress 模拟 + `inject-workflows.js` + `e2e.js`(permit 杠杆),P1/P4 直接复用 |
| `deploy/dev.sh` + `services.dev.json` | 一键起整栈(含 collection/market),harness 可复用 + external 哨兵 |
| `CLAUDE.md §2` / `core/user/README.md` / `docs/reference/overview.md` | "Ed25519 挑战-签名" 措辞与代码(SHA-256)不符 —— **已于本轮修正** |

---

## 13. 实现前定下的决策(2026-06-03,核查代码后)

> 动手前对设计做了一轮"代码 vs 假设"核查(5 路并行,~40 项)。以下为定案。带 **ⓤ** 的是与用户确认过的叉子。

### ⓤ 四个叉子
1. **bot token 注入 = RPC 真链路**:`user.bot.create` → `user.bot.issue.token` → `<svc>.token.set`(四服务统一,`sub:'system.<svc>'`),证明生产 seeding 流程真能跑通。`deploy/orchestrator/scripts/seed_bot.js` 的 Redis 直注法留作开发快捷,不进 E2E 主路径。
2. **`administrator` 漏调 `setRedis()` = 补 1 行框架修复**(✅ 已改 `api/core/administrator/index.js`:连 Redis 后 `logger.setRedis(redisClient)`,与其余 14 服务对齐)→ admin 错误现在也入 `ERROR:QUEUE:administrator`,`assertNoErrors` 不再假绿。
3. **WAL 读取 = 拷贝精简只读 reader**:`e2e/lib/wal.js` 自带 `query(key, logDir, N)`(MD5 三级路径 + 解析 jsonl),从 `api/library/logger.js` 照抄精简,**不跨项目 `require`**、不加 `file:../api` 依赖(守住 C 的自包含)。
4. **"跑每个 API" 范围 = 只读自动 + 写操作手写 fixture**(见 §7 范围注)。

### 默认值(已直接定,可推翻)
- **端口**:每服务 spawn 按 `services.json`/`services.dev.json` 设 `PORT` env(不靠 config 默认)。
- **Redis 生命周期**:harness 自起 `redis-stack@6699`(探到已起则复用,external 哨兵);teardown 只杀自己起的。
- **profile**:`lite`(workers 全关、无 bot)跑 P0–P4;`full`(matcher+consumer 开、播 bot)跑 P5(§6)。
- **注册**:Router 就绪后对所有非 router 服务统一 `system.service.add`(握手同步、幂等;`active_services` 持久,重启不必重注)。
- **admin 会话**:`{uid, username, role:'admin', permit:{allow_all:true, services:{}}}`;判定**只认 `permit.allow_all===true`**(role 仅管 TTL 续期)。下游只收 `X-Router-Token`(`permit` 压成 `'admin'|'user'` 字串),不见 role。
- **LOG_DIR**:spawn **前**设到临时目录(logger 模块加载即固化路径,设晚了无效),verify 读同目录;`ERROR:QUEUE:*` globalSetup 先清(list 无 TTL,防跨测污染)。
- **方法发现**:静态读各 `handlers/introspection.js`(glob `api/{core,apps,router}/**/handlers/introspection.js`),不靠 DEBUG 的 `methods` RPC。
- **bot permit**:create 给最小 `{allow_all:false, services:{}}`(框架禁 bot `allow_all`),每套 suite 用 `user.bot.update` 临时放宽;`system.orchestrator` 跑事件链须覆盖 `collection.payment.record`/`settle`、`market.shipment.create`/`ship`、`notification.send`。
- **危险清单**:§11 已补 `workflow.create`/`workflow.restore`/`nexus.schedule.*`/`ingress.source.test`。

### 仍待实现期确认(非阻塞)
- `agent.chat`/`image.*`/`audio.*`:非 hermetic(要真 LLM key),默认**排除**(§11);要测再单独配 key 标 `@external`。
- 事件链 workflow fixture:优先复用 `deploy/mock/workflows/` 已有 5 个;若没有覆盖完整六跳的单条,再补一个。

---

## 14. 实现状态(2026-06-03)

**已实现并跑通(lite + full 两档全绿)。** `e2e/` 是独立 Jest 项目(`cd e2e && npm install`).

`npm test`(**lite**:redis-stack + router + user + collection):
```
Test Suites: 1 skipped, 3 passed, 3 of 4 total
Tests:       5 skipped, 6 passed, 11 total
```
`npm run test:full`(**full**:整栈 15 服务 + 事件链 + matcher 驱动 + 逐服务 + 安全/模糊):
```
Test Suites: 17 passed, 17 total
Tests:       59 passed, 59 total
```
- `00-login` ✓ 真实 SHA-256 挑战-响应 + 落库/session/challenge 断言
- `10-permit` ✓ permit 杠杆:最小→Forbidden(可达,非 -32601),放宽→成功
- `20-collection` ✓ **四连断言完整示范**:①API ②落库(+INDEX)③WAL(`user`=调用方 uid)④keyspace 无异常
- `21-storage` / `22-planner` / `23-fulfillment` / `24-approval` / `25-gateway` / `26-notification` / `27-nexus` / `28-user` ✓(full)**逐服务**:每服务建测试用户 + 真实登录 + CRUD,按契约做①API ②落库(+索引,SET/ZSET)③WAL(entity-factory 服务)断言;危险/非 hermetic 方法排除
- `90-event-chain` ✓(full)五跳直链 collection→market→notification:每跳实体落库 + `EVENT:*` 流增量 + 全链 ERROR:QUEUE 空
- `91-event-trigger` ✓(full)**真事件驱动**:注入 ACTIVE workflow → 发真事件 → orchestrator matcher 自动跑 workflow → payment 自动 SETTLED(无人直接调 settle)
- `30-injection` ✓(full)**模糊/注入**:向 13 个接口输入面灌 16 类恶意载荷(异常字符/超长/JS·模板 SSTI/Redis 命令/键逃逸/路径穿越/XSS/SQL 风格)→ 每发后断言**服务不崩 + canary 未被擦库**;另测**原型污染不绕鉴权**(behavioral canary)
- `31-resilience` ✓(full)韧性:2MB 超大载荷不 OOM/不挂、类型混淆(array/object/number 灌 string 字段)不崩、glob(`keyword=*`)不 hang
- `32-administrator` ✓(full)单管理员 **SHA-256 挑战-响应**登录(注入 admin 账号 → 真实 `login.request`/`verify` → token 调通 admin 方法;`admin.self.lock` 等危险方法排除)
- `33-ingress` ✓(full)入站 webhook:`source.create`(一次性 apiKey)→ `ingress.ingest`(`Authorization: ApiKey`)真发 `EVENT:WEBHOOK:{源}` 流 + **去重** + 坏 key 拒绝 + 审计 `log.recent`

**实现期发现/修复(都是真问题,框架自己暴露的):**
1. **`NODE_ENV=test` 本地鉴权 bypass** —— jest 默认置 `NODE_ENV=test`,子进程继承后触发
   `library/auth.js:105` 的"本地 bypass",**服务直接跳过 Router token 校验、`req.user` 永远 null**
   → 等于没测真签名路径(WAL `user` 全 null)。修:harness spawn 服务时强制 `NODE_ENV=production`.
2. **node-redis v4 探针无限重试** —— 默认 `reconnectStrategy` 对拒绝连接不抛、无限重连,导致
   redis 存活探针挂死。修:探针用 `reconnectStrategy:false + connectTimeout` fail-fast + 挂 `error` 监听.
3. **`redis-stack-server` 是 wrapper** —— SIGTERM 它的 pid 杀不掉真正监听 6699 的 `redis-server` 子进程
   → teardown 后 redis 泄漏。修:teardown 用 `SHUTDOWN NOSAVE` 协议关停(SIGTERM 兜底).
4. **`administrator` 漏调 `logger.setRedis()`** —— 已于本轮补修(§13 决策 2).
5. **`administrator` 无 `/auth/seed`** —— 它是 Router 自动纳管(`ensureAdministratorService`)的特例,
   只有 `POST /jsonrpc`;harness 对它用 **TCP 端口探针**就绪、且**跳过** `system.service.add`.
6. **`_event` piggyback 需事件注册表** —— full 起栈后写 `SYSTEM:CONFIG:EVENT_REGISTRY` 覆盖
   (collection/market),否则 Router `checkRegistry` BLOCKED、`EVENT:*` 流为空(events.js:113).
7. **事件总线→workflow 执行被 H6 挡死(核心 bug,91 暴露)** —— matcher 把事件匹配 + 入队都成功,
   但 runner 的 H6 footprint 预审要读 `system.orchestrator` bot **自己的** permit,而 `user.permit.get`
   ① 对 bot uid 读错 key(`user:` 而非 `user:bot:`)② 又是 admin-only,bot 自读被拒
   → **事件/定时驱动的 workflow 从来跑不通**(文档号称能跑,实际从没经 bot 走过 H6)。
   修 2 处:`user/logic/user.js getPermit` 解析 bot uid(`system.*`→`user:bot:`);
   `user/index.js` 的 `user.permit.get` 放开 **self-read**(`req.user===uid` 免 admin)。CI 绿子集 308 仍全过。

8. **`planner` 硬编码 `debug:true` → 本地鉴权 bypass 长开(核心 bug,22 暴露)** ——
   `apps/planner/config.js:7` 写死 `debug:true`(别的服务都是 `process.env.DEBUG==='true'`)。
   `library/auth.js:106` 的本地 bypass 条件是 `isLocal && (NODE_ENV==='test' || config.debug)`,
   Router 永远从 localhost 转发 → planner **永远跳过 Router token 校验、`req.user` 永远 undefined**。
   叠加 planner 取 `user?.uid`(req.user 现为字符串)→ **所有用户的待办/日程全落到 `PLANNER:U:ANONYMOUS`**
   (多租户隔离彻底失效)。修:config 改读 env;`todo.js`/`agenda.js` 的 uid 兼容字符串 req.user.
9. **多个服务自定义存储无 entity-factory WAL** —— storage(直接 `redis.set`)、notification、nexus、
   user(account/bot)不走 entity factory → 无 `op:create` WAL 行,这些套不断言 ③ WAL(已注明).
10. **`fulfillment.profile.create` id/key 错位** —— introspection 要求 `id`,但底层 factory 自己生成 id,
    提供的 id 只覆盖 `data.id`、不改 key → `profile.get(业务id)` 找不到。23 套**直接注入 profile**绕过,只测 instance 状态机.

**服务覆盖**:15 个服务里 **14 个有直接套件**(user/collection/storage/planner/fulfillment/approval/
gateway/notification/nexus/market/orchestrator/administrator/ingress)+ router 被全程穿透;唯一留白是
**agent**(非 hermetic,要真 LLM key,按设计排除,要测单独标 `@external`)。

**full profile 已跑通**(整栈 15 服务 + `seedBots()` + 事件注册表 + 逐服务 CRUD + 安全/模糊 + administrator + ingress).
`90-event-chain` 走 **direct 编排**;`91-event-trigger` 走 **matcher 驱动**;`2x-*` 逐服务四连断言;
`30/31` 安全/模糊层. 全程共暴露 **10 个真问题**(见上),`api` CI 绿子集 308 测试始终全过 —— 改框架未伤存量.

### 安全/模糊层结论(30/31)
13 接口 × 16 类载荷 + 类型混淆 + 2MB 超大 + glob,**全部安全通过**:任意非法输入下服务都
**不崩、不擦库、不被原型污染绕权、glob 不 hang**(`__proto__`/`constructor.prototype` 注入后,
最小权限用户仍调不动 admin 方法)。**两个加固点已处理干净**:
- ✅ **ERROR:QUEUE 污染 + INTERNAL_ERROR 泄漏** —— 诊断发现 208 次模糊里仅 1 处真抛 INTERNAL_ERROR
  (`nexus.schedule.create` 遇孤立代理破 RedisJSON、泄漏底层解析消息);而 `ERROR:QUEUE` 噪声的真因是
  `logger.error` 把**客户端预期错误**(jsonrpc 普通对象 `{code}` 未被识别)也当 INTERNAL_ERROR 入队。
  修:① `library/logger.js` —— 带客户端错误码(≠ -32603)的错误**不入** `ERROR:QUEUE`(防日志洪泛 DoS、
  让队列只剩真故障),仍照常打 stderr;② `nexus/logic/schedule.js` —— `schedule_id` 加字符集校验 → 干净 `-32602`。
  **30/31 现断言**:整套模糊**不增** `ERROR:QUEUE`、无任何 `-32603`。`api` CI 绿子集 308 仍全过。
- ✅ **Portal XSS** —— 核查 portal/client 全量:React JSX **默认转义**所有渲染数据,唯一 `dangerouslySetInnerHTML`
  是静态 CSS(`AssetList.tsx`,无用户数据)。**本已安全,无需改动**(原"观察"过于保守)。
- 仍留:存储型 XSS/SSTI 载荷会原样落库(存储层安全;RESP 协议下 Redis 命令注入不可达)—— 这是**设计上正确**的
  (存储层不该改写内容),渲染端的转义由上面 React 默认机制兜住。
