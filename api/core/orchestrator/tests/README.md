# Orchestrator 测试脚手架 — 使用说明

一套 **fixture 驱动** 的测试设施:把"编排 JSON"喂进真实的执行引擎,用假的依赖把它包起来跑,断言它的行为。**一个真实下游服务、一个 Redis 都不用起。**

---

## 为什么能这么测(核心原理)

orchestrator 的对外调用**只有一个出口**:`logic/runner.js` 里的 `makeRpcCall(routerUrl, method, params)`——一个 HTTP POST 打到它的 `routerUrl`。而 `routerUrl` 是**注入**的。所以:

| 真实依赖 | 测试里替换成 | 文件 |
|---|---|---|
| Router 网关(下游所有服务都走它) | **MockRouter**:本地小 HTTP server,预设每个方法的返回、记录每次调用 | `utils/mock-router.js` |
| Redis(含 RedisJSON) | **fake-redis**:内存版,够引擎用就行 | `utils/fake-redis.js` |
| 真实下游服务(user/gateway/…) | 不需要——MockRouter 代答 | — |

`createHarness()` 把这三样接到**真实的** `logic/index.js` 上,所以测的是货真价实的执行引擎(变量解析、分支、重试、闸门……),只是周围全是假的。

> 这是 SOLO 既有 `api/autocheck/simulation/scenarios/orchestrator/` 用的同一套思路,这里把它整理成可复用的 jest 脚手架。

---

## 目录结构

```
tests/
├── README.md            ← 本文件
├── cases.md             ← 测试场景清单(autocheck 要求)
├── engine.test.js       ← jest 测试,驱动 fixture 跑引擎
├── cases/               ← 编排 JSON fixture(测试用例)
│   ├── linear-flow.json
│   └── branching-flow.json
└── utils/
    ├── fake-redis.js    ← 内存 Redis(json.get/set, keys, get/set, xAdd)
    ├── mock-router.js   ← MockRouter(on / calls / count / stop)
    └── harness.js       ← createHarness():把上面三样接成一套
```

---

## 快速开始

```bash
# 从 api/ 目录跑(jest 装在 api/node_modules)
cd api
npx jest core/orchestrator/tests/engine.test.js          # 跑这一套
npx jest core/orchestrator/tests/engine.test.js --silent  # 关掉引擎的 console.log 噪音
```

---

## harness API

```js
const { createHarness } = require('./utils/harness');

const h = await createHarness();   // 起一个全新的 fake-redis + MockRouter + 真引擎

// 1) 造环境:预设下游方法返回什么(handler 返回值 = workflow 里的 $step.<id>.result)
h.mock.on('user.profile.get', ({ uid }) => ({ uid, name: 'Alice', email: 'a@x.com' }));
h.mock.on('svc.broken', () => { throw new Error('boom'); });   // 抛错 = 该步失败

// 2) 装载 workflow:两种方式
await h.createWorkflow(require('./cases/linear-flow.json'));    // 走真实 create()+校验,status 恒为 ACTIVE
await h.seedWorkflow({ ...def, status: 'PENDING_REVIEW' });     // 直写存储,可指定任意 status(闸门测试用)

// 3) 执行
const res = await h.run('wf_linear_demo', { customerId: 'c-1' }, /* headers */ {});

// 4) 断言
res.status;                                  // 'completed' | 'failed'
res.trace;                                   // [{ id, status: success|skipped|failed, params, result, error }]
h.mock.lastParams('user.profile.get');       // orchestrator 实际发出的 params(验证变量解析)
h.mock.count('gateway.email.send');          // 该方法被调了几次(0 = 没调到)
h.mock.count();                              // 下游总调用次数
h.events('EVENT:WORKFLOW:RESULT');           // 跑完发出的流事件

await h.stop();   // ★ 必须:关掉 MockRouter 的 socket,否则 jest 会挂住不退出
```

`mock` 的 handler 约定:返回值会被包成 JSON-RPC 的 `result`,即 workflow 里 `$step.<id>.result` 看到的东西;**handler 抛异常**就模拟该下游方法失败。

---

## 加一个新测试(三步)

1. **写 fixture**:在 `cases/` 放一个 workflow JSON(字段见下),文件即用例。
2. **在 `engine.test.js` 里 require 它**,写一个 `test(...)`:
   ```js
   const myFlow = require('./cases/my-flow.json');

   test('我的流程: ……', async () => {
       h.mock.on('a.b.c', () => ({ ok: true }));      // 造每个 step 的下游返回
       await h.createWorkflow(myFlow);
       const res = await h.run(myFlow.id, { /* input */ });
       expect(res.status).toBe('completed');
       expect(h.mock.lastParams('a.b.c')).toEqual({ /* 期望发出的 params */ });
   });
   ```
3. `npx jest core/orchestrator/tests/engine.test.js` 跑。

### workflow fixture 字段

`create()` 必填:`id`、`category`、`name`、`desc`、`steps[]`。每个 step 必填 `id`/`service`/`method`/`params`。可选:`required_inputs[]`、`resolvers{}`、step 上的 `condition`、`ignore_error`、`retry`。

变量(在 step `params` 里用字符串):
- `$input.x` —— 调用时传入的 input
- `$step.<id>.result.y` —— 上一步的返回
- `$config.x` —— workflow.defaults + input
- condition 例:`"$step.s1.result.tier == 'gold'"`(只允许字面量+比较/逻辑运算符,见 runner 的白名单)

---

## 该断言什么

| 关注点 | 怎么断言 |
|---|---|
| 步骤顺序/状态 | `res.trace.map(t => [t.id, t.status])` |
| 变量解析对不对 | `h.mock.lastParams('svc.m')` —— 看实际发出的 params |
| 分支跳过 | 对应 step `status==='skipped'` 且 `h.mock.count('被跳过的方法')===0` |
| 容错(ignore_error) | 该步 `failed` 但 `res.status==='completed'` |
| 失败传播 | `res.status==='failed'`、`res.failedStep`、后续方法 `count===0` |
| 事件发出 | `h.events('EVENT:WORKFLOW:RESULT' \| 'EVENT:WORKFLOW:STATUS')` |

---

## 写未来的闸门测试(C1 状态机 / H6 足迹预审)

这套脚手架就是为这两块准备的。要点:**闸门必须在任何下游调用之前拦住**,所以断言 `h.mock.count() === 0`。`engine.test.js` 里的 `boundary: ... DELETED ...` 就是模板。

- **C1 状态闸门**(只有 ACTIVE 能跑):
  ```js
  await h.seedWorkflow({ ...def, id: 'wf_pending', status: 'PENDING_REVIEW' });
  await expect(h.run('wf_pending', {})).rejects.toMatchObject({ code: -32005 }); // FORBIDDEN
  expect(h.mock.count()).toBe(0);    // 零副作用
  ```
- **H6 足迹预审**(caller permit 必须覆盖 workflow 全部方法):
  ```js
  // 预审会去拉完整 permit —— 用 MockRouter 代答 user.permit.get
  h.mock.on('user.permit.get', () => ({ uid: 'c', permit: { services: { user: ['user.profile.get'] } } }));
  // gateway.email.send 不在 permit 里 → run 应在执行前 403
  await h.createWorkflow(linearFlow);
  await expect(h.run(linearFlow.id, { customerId: 'c' }, { authorization: 'Bearer t' }))
        .rejects.toMatchObject({ code: -32005 });
  expect(h.mock.count('gateway.email.send')).toBe(0);
  ```
  (AUDIT H6 点名的两个验收测试 `run-rejects-when-permit-misses-method`、`run-prechecks-all-branches` 就照这个套路写,可放到 `cases/` + 新增 `boundary.test.js`。)

---

## 注意事项

- **务必 `await h.stop()`**(放 `afterEach`),否则 MockRouter 的 HTTP server 不关,jest 会报 "did not exit" 并挂住。
- **`--silent`**:runner 里有大量 `console.log` 调试输出(那是 orchestrator 源码自带的),嫌吵就加 `--silent`。
- **覆盖边界**:这套是**引擎层 hermetic 测试**——它验编排逻辑,不验真实下游服务是否真的执行了动作、不验 Ed25519 签名链。那属于"真黑盒 E2E"(起 `deploy/dev.sh` 全栈 + HTTP 打 Router),只覆盖几条黄金路径即可,见仓库根 `todo.md` 的 E2E 条目。
- **fake-redis 是按需实现的**:引擎将来用到新的 redis 命令时,去 `utils/fake-redis.js` 补上对应方法即可。
