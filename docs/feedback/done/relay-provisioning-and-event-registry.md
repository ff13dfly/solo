# 反馈：事件/内部调用通路在派生项目里「开箱不通」，且踩坏它的方式是静默的

> 来源：colony 派生项目，2026-08-10 给私有服务 `api/apps/ant/` 接事件到 nexus 时逐条撞到。
> 依据：**全部为本机实测**（solo v1.1.15，colony 全新 scaffold 出来的栈），每条都附命令与原始返回。
> 涉及：`api/library/relay.js`、bundle 的 `getRegistry()`(74588-74604) 与内置 `eventRegistry`(24361-24403)、
> `deploy/scaffold/`（缺 provisioning）、`deploy/scaffold/docs/authoring/events.md` §2。
> 影响面：**任何想让自己的服务发事件的派生项目**；问题一还波及 **Solo 自带的 nexus / orchestrator**。
>
> 一句话：`docs/authoring/events.md` 教了怎么写事件，但没有任何地方交代**通路本身要先被开通**；
> 而开通它的那一步如果自己摸索着做，最可能的做法会**静默吊销另外五个服务的发事件权限**。

---

## 一、开箱状态下 relay 的 bot token 是空的，`event.emit` 路径对谁都不通

新 scaffold 的栈跑起来后，直接问三个服务的 relay 状态：

```
nexus.token.status        → {"hasToken":false}
orchestrator.token.status → {"hasToken":false}
ant.token.status          → {"hasToken":true,"sub":"system.ant",...}   ← 只有手工 provision 过的
```

Redis 里的实际情况（provision 之前）：

```
RELAY:TOKEN:*                   → (空，一个键都没有)
SYSTEM:CONFIG:EVENT_REGISTRY    → (键不存在)
user:name:system*               → (无匹配，一个 bot 账号都没有)
```

`library/relay.js` 的 `call()` 在这个状态下抛 `NO_TOKEN`（其文案是
"No service token configured. Admin must call setServiceToken."）。于是：

- **派生项目自己的服务**发不出 `event.emit`；
- **Solo 自带的 nexus / orchestrator 同样发不出**——按代码，nexus 的 Sentinel `context.emit`
  与调度器 `emit_event`、orchestrator worker/matcher 的 workflow 事件都走
  `relay.call("event.emit", …)`（bundle:102181 / 102552 / 116526 / 117834 / 117942 / 121039 / 124358）。

> **依据分类**：`hasToken:false` 与三个 Redis 扫描结果是本机实测；「nexus/orchestrator 的这些功能因此不可用」
> 是**从调用点代码推出的结论，未单独构造用例验证**——我只实测了 ant 这条链。

问题不在于「要 provision」，而在于**没有任何地方说要 provision**：
`init.sh` / `run.sh` 都不做，`docs/authoring/events.md` 通篇没提，
唯一的线索是 `NO_TOKEN` 的错误文案，而它指向的 `setServiceToken` 是 relay 的**内部函数名**，
不是任何一个可调用的 RPC 方法名（真正要调的是 `{service}.token.set`）。

摸索出来的完整步骤是这样的，四步一步都不能少：

```
1. 写 SYSTEM:CONFIG:EVENT_REGISTRY               （见第二节，这一步最容易踩坏）
2. user.bot.create      { uid: 'system.<svc>', permit: { allow_all: false, services: {} } }
3. user.bot.issue.token { uid: 'system.<svc>' }  →  <svc>.token.set { token, expiresAt, sub }
4. <svc>.token.status 验证 hasToken:true
```

其中 `uid` 必须**恰好**是 `system.<serviceName>`——relay 的 `expectedSub` 是这么拼的
（`library/relay.js:87`），不匹配会抛 `SUB_MISMATCH`。这条也只在源码里，文档没有。

**建议**（按价值排序）：

1. **scaffold 提供一个幂等的 provisioning 脚本**（如 `deploy/provision-relay.sh <service>`），
   或直接并入 `run.sh` 的启动序列——它本来就已经在跑 `seed-registry.js` 做类似的事了。
   Solo 自带服务（nexus/orchestrator/fulfillment/gateway/ingress）的 bot 更应该开箱就有，
   否则「Solo 的自动化链路」在每个新项目里默认都是断的。
2. `events.md` 增一节「发事件之前：通路怎么开通」，把上面四步和 `system.<svc>` 的命名规则写进去。
3. `NO_TOKEN` 的文案把 `setServiceToken` 换成实际要调的 RPC：
   `Call {service}.token.set (admin) with a token from user.bot.issue.token`。

---

## 二、🔴 `SYSTEM:CONFIG:EVENT_REGISTRY` 是**整体替换**，而内置默认在派生项目里无处可查

这条是三条里最危险的，因为**做错了不报错、不回滚、还有 60 秒延迟**。

`getRegistry()`（bundle:74588-74604）：

```js
const data = await redisClient.get(config.redis.eventRegistryKey);
if (data) {
  CACHED_REGISTRY = JSON.parse(data);     // ← 整体替换，不与 config.eventRegistry 合并
  LAST_FETCH = now;
  return CACHED_REGISTRY;
}
if (!CACHED_REGISTRY) CACHED_REGISTRY = config.eventRegistry || {};   // 仅在 Redis 无键时兜底
```

而内置默认（bundle:24361-24403）覆盖了 **7 个 source**：`orchestrator`、`system.orchestrator`、
`system.nexus`、`system.ingress`、`system.fulfillment`、`gateway`、`system.gateway`。

于是这样一条完全合理的操作链会造成事故：

1. 读 `events.md` §2 —— 原文是「**你的服务发新事件前，先把它登记进 registry**」，
   给的示例也只有自己的那一条；
2. 照着写 `SET SYSTEM:CONFIG:EVENT_REGISTRY '{"myservice":{"EVENT:MY:X":["*"]}}'`；
3. **那 7 个内置 source 当场全部失效**——orchestrator 的 workflow 事件、ingress 的 webhook、
   fulfillment 的状态流转事件、gateway 的投递结果，全部开始被 `checkRegistry` 判 false 而丢弃；
4. `processEvents` 对被拦的事件只做 `blocked++` 计数（不抛错、不影响调用方的 RPC 返回），
   所以**上游一切正常，只是事件没了**；
5. 还有 `CACHE_TTL = 6e4` 的 60 秒缓存，即使当场自查也可能看到旧行为。

派生项目拿到的 `api/publish/solo.v1.1.15.js` 是**单文件 bundle**，那 7 条默认埋在 12 万行里的
第 24361 行。除非有人告诉你「去 grep 它」，否则不可能知道自己需要抄什么。

我这次是先读了 `getRegistry()` 才发现替换语义，然后手工把 7 条默认逐条抄进去 + 自己的 2 条
（`ant` 走 `_event` 顺风车、`system.ant` 走 `event.emit`，两个 source 缺一不可），一共 9 个。
**这一步纯靠运气**——当时如果没顺手点开那 15 行，现在这个栈的事件总线就是半残的，而且要过很久才会有人发现。

**建议**（按价值排序）：

1. **改成合并语义**：`CACHED_REGISTRY = { ...config.eventRegistry, ...JSON.parse(data) }`
   （同 source 下的 stream 也应合并，而不是整个 source 覆盖）。
   派生项目的意图从来都是「**追加**我的事件」，不是「重定义全栈的事件权限」。
   若担心「无法删除内置条目」，可以约定值为 `null` 表示显式撤销。
2. 若坚持替换语义，则**至少**：
   - `events.md` §2 用加粗写明「写入此键会整体替换内置默认，必须把内置条目一并写入」，
     并把那 7 条默认**原样贴在文档里**（派生项目没有别的途径拿到它）；
   - 提供一个 `system.event.registry.get` 之类的只读方法，能返回**当前生效的合并结果**，
     让人写之前先读、写之后能自查。
3. `blocked > 0` 时在 Router 侧记一条 warn（含 source/stream/type），
   现在它只进返回值里的计数，调用方通常不看。

---

## 三、（次要）capability 刷新窗口让 `-32601` 有歧义

给 ant 加了 `ant.token.{set,status,clear}` 后：服务自己 `methods` 返回 21 个，
Router 的 capability map 仍是 18 个，调新方法一律 `-32601 Method not found`。

机制本身是合理的（bundle:74159-74160）：

```js
setTimeout(updateCapabilityMap, 2e3);
setInterval(updateCapabilityMap, 6e4);
```

而 `run.sh` 的顺序是「起 bundle → `sleep 2` → 起私有 app」，所以 2 秒那次通常抓不到私有 app，
**新增/变更的方法最长要等 60 秒才对 Router 可见**。实测栈跑满 34 分钟后 map 自动变成 21 个，
不需要任何手工操作。

问题只在于：这 60 秒里的 `-32601 Method not found` 和「方法真的不存在」**完全无法区分**。
拿到这个错误的人（尤其是刚改完声明↔注册的人）会去反复检查 introspection、命名规范、路由表——
我自己就先怀疑了一轮，并一度把「必须手工 `system.service.add`」写进了项目笔记，是错的。

**建议**：Router 在 `METHOD_NOT_FOUND` 时，若该 method 的服务前缀**已在 active_services 里注册**，
就把文案改成可区分的，例如
`Method ant.token.set not found in capability map (service 'ant' is registered; the map refreshes every 60s — call system.service.add to force a re-handshake)`。
一句话就能省掉下游一整轮误诊。

---

## 四、为什么这三条值得一起看

它们共享一个形状：**通路是否通畅，没有任何一处能被观察到**。

- token 没配 → `relay.call` 抛错，多数调用方 catch 成 warn（我自己也是这么写的）；
- registry 写坏 → 事件静默丢弃，上游 RPC 一切正常；
- capability 没刷新 → 报一个语义上指向别处的错误码。

三者叠加的结果是：一个派生项目可以**自以为接好了事件**，实际上一条都没发出去，
而所有表面信号（服务健康、RPC 返回、日志）都是绿的。这次是因为我逐条去 Redis 里数 stream 长度
才确认真的写进去了（`EVENT:ANT:INSTANCE_STATE` 0 → 6），否则没有任何迹象能说明成功与否。

---

## 处理结论（solo 侧）

三条实测属实。已修复两处、一处按提议做了文档级缓解、provisioning 脚本本身评估后判断不适合仓促自动化，说明如下（2026-08-10）：

1. **`events.md` 补 §0.5「发事件之前：通路怎么开通」**：把四步流程、`system.<service>` 命名规则、
   `permit` 不能 `allow_all:true` 的约束都写进去（对应建议 2）。
   **provisioning 脚本本身（建议 1）没有做**，评估后判断风险不对称，理由：
   - 走"登录态 + RPC"的正规路径：admin 密码只在 `SETUP.md` 短暂存在，`admin.password.reset` 后
     `seed.json` 自毁，脚本无法长期持有可用凭证，做不到幂等可重跑；
   - 走"直接写 Redis"的捷径（`core/orchestrator/scripts/seed_bot.js` 本地开发脚本的做法）：
     它写一个 10 年后过期的假 token，绕开了 `user.bot.issue.token` 真实 24h TTL + `relay.js`
     自动续期的设计，相当于给框架永久塞进一个不会轮换、不会随 `user.token.refresh` 审计链路
     走的 token——这是安全设计上的取舍，不该在 triage 里顺手做掉；
   - Solo 自己的 nexus/orchestrator/fulfillment/gateway/ingress **各自需要不同的 `permit`**
     （`assertPermitSafe` 强制枚举 `services.method`，不许 `allow_all`），要写对每个服务的最小权限
     需要逐个审计其 `relay.call()` 实际调用面，是本身就该独立评估的任务，不适合搭车做。
   这条建议保留在本文档，留给专门的一轮设计评估。
2. **`events.md` §2 加粗警示 + 内置 7 条默认原样贴出**（对应建议 2 的第一个子项），**且用户已授权
   后追加了真正的代码修复**：`api/router/handlers/events.js` 的 `getRegistry()` 从整体替换改成
   按 source 合并——`CACHED_REGISTRY = { ...defaults, ...JSON.parse(data) }`。同一 source 若两边
   都有，Redis 值整体覆盖那个 source（允许运维故意收窄某个内置 source），但**不会波及其它未提及
   的 source**。用最小复现验证过：Redis 里只写了派生项目自己的 `ant` 源时，`orchestrator`（内置
   默认源）与 `ant`（派生项目源）两条都能正常写入事件，同时一个完全未注册的 source 仍然照常被拦——
   合并没有变成"放行一切"。建议里"提供只读方法查看当前生效结果"的部分没做（本轮改动范围以外，
   且需要新增一个 RPC 方法，超出这次三处授权的范围）。
3. **`NO_TOKEN` 错误文案已改**（`api/library/relay.js`，不在 router 保护区）：从
   `"No service token configured. Admin must call setServiceToken."` 改成点名真实服务名 + 真实
   RPC 名 + 文档指针：`` No service token configured for "<service>". Admin must call
   <service>.token.set with a token from user.bot.issue.token (see docs/authoring/events.md §0.5). ``
   `api/library/tests/relay.test.js` 52 个测试全部只断言 `.code === 'NO_TOKEN'`，不断言文案，跑过
   回归全绿。
4. **capability 60s 刷新窗口的报错文案已改**（用户授权后落地，`api/router/index.js` 的
   Unknown Method Guard）：先判断该方法的服务前缀是否已在 `SERVICES` 里注册，是则返回
   `` Method X not found in capability map (service 'svc' is registered; the map refreshes
   every 60s after a service restart — call system.service.add to force a re-handshake, or wait) ``，
   否则维持原来的 `METHOD_NOT_FOUND`；错误码两种情况都仍是 `-32601`，`router/tests/security/
   e2e-permission.test.js` 只断言 code 不断言文案，不受影响。

四处改动（本文档 3/4 项 + forward.js 超时项）已合并跑过 `api/jest.ci.config.js` 全量白名单回归，
详见 `router-forward-timeout-prefix-whitelist.md` 的处理结论。
