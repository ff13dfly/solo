# 反馈：relay 惰性轮转在「稀疏调用方」上必然静默过期 —— permit 配齐也躲不掉

> 来源：colony 派生项目，2026-08-16 部署事件总线阶段一（K 线闭合事件 + 熔断 Sentinel）
> 时实测，2026-08-17 次日核查时定性。
> 依据：**全部本机/N100 实测**——① ant 侧 2026-08-14 完整故障链（当时已记档于 colony
> CLAUDE.md）；② nexus 侧 2026-08-16 NO_TOKEN 日志原文 + 2026-08-17 到期前 12h 的预判
> 与拆弹验证。源码引用为 solo 仓 HEAD（`api/library/relay.js` / `api/core/nexus/logic/stream.js`）。
> 涉及：`api/library/relay.js`（轮转触发机制）、`api/core/nexus/`（最典型的稀疏调用方）、
> `nexus.sentinel.create`（无 token 时的静默死亡）。
>
> 一句话：轮转是**惰性**的（只在 `call()` 里的 `getValidToken()` 被走到时才检查，
> `relay.js:217/307`），所以「有没有调用」决定「轮转会不会发生」——**调用稀疏的服务，
> 轮转窗口（到期前 2h）内可以一次调用都没有，token 静默过期**。这与 events.md §0.5
> 红线讲的「permit 漏 `user.token.refresh`」是两个不同的故障：那个是轮转**被拒**，
> 这个是轮转**根本没被触发**，permit 配得再全也一样死。

---

## 一、两次实测：同一个病，先咬 ant、再咬 nexus

### ① ant（业务服务），2026-08-14，真实故障

ant 的 relay 调用是事件驱动的稀疏调用（开仓/平仓/entry 判定），持仓期间可以连续
十几个小时零调用。实测平均持仓 4.6h、最长 13h：

```
08-14 03:48  开仓（最后一次 relay 调用）
     …       持仓静默 9.5 小时，期间零 relay 调用
08-14 10:14  轮转窗口开启（到期前 2h）—— 没有任何调用去触发它
08-14 12:14  token 到期
之后         event.emit 与 agent.decide 全部 -32001
```

**只要有一个静默期盖住轮转窗口就漏，这是必然复发不是偶发。**
ant 侧修法：服务里加了 10min 的独立 timer 调 `relay.getToken()`（它内部走
`refreshIfNeeded`，不发任何 RPC、不需要额外 permit，光调它就够触发轮转）。

### ② nexus（框架内置服务），2026-08-17，炸前 12h 拆掉

nexus 的共享 relay 只在 Sentinel 事件触发时才被调（`stream.js:49`
`deliverEventInner` 里的 emit 与 `notification.send`）。我们的熔断 Sentinel 只订阅
「连续开仓失败 breach」——**正常运行时可以连续几天零触发**。token 注入于 08-16 13:42、
24h 有效期 ⇒ 08-17 11:42–13:42 的轮转窗口内大概率零调用 ⇒ 静默过期 ⇒
下一次真熔断直接 NO_TOKEN、重试 5 次进 DLQ。

拆弹用的是 SOLO 自己的设施（这个绕法值得写进文档）：`nexus.schedule` 建 30min 递归的
`emit_event` 心跳（stream 落在 `EVENT:SENTINEL:*`，内置 glob 白名单免登记）——
emit 走 `relay.call('event.emit')`，任何 2h 轮转窗口至少被踩 4 次。已线上验证
（`last_fired_at` 前进、事件落流、`actor=cron:<schedule_id>`）。

## 二、为什么这值得框架层面解决

- **每一个部署了 Sentinel 的 Solo 栈都会踩**：nexus 的调用频率由业务事件决定，
  框架自己没有保底调用。「provisioning 当天全绿、第一个安静的 24h 后死亡」
  是这个 bug 的标准形态，极难与「没配好」区分。
- events.md §0.5（HEAD 已写得很好）覆盖了 permit 缺失那条路，但**没有覆盖这条**：
  按 §0.5 四步做全、`user.token.refresh` 也给了，稀疏调用方照样过期。
- 两个业务侧绕法（ant 的 in-process timer、nexus 的 schedule 心跳）本质上都是
  **拿用户侧设施补框架侧缺口**——每个服务作者都得自己重新发现并实现一遍。

## 三、附带发现：Sentinel 在 nexus 无 token 时「创建成功、静默死亡」

2026-08-16 首次部署实测：`nexus.sentinel.create` 成功、status=ACTIVE、
订阅同步正常——但 nexus relay 没有 token，**整套投递与 emit 是死的**，
第一个事件到达时才在服务日志里看到：

```
[nexus-stream] event.emit.failed { code: 'NO_TOKEN',
  message: 'No service token configured. Admin must call setServiceToken.' }
[nexus-stream] event.deliver.fail { step: 'emit', reason: '...' }
```

好的一面（值得肯定）：这条路径**不是静默丢**——指数退避重试 5 次进 DLQ、日志清楚，
比 fulfillment 转移事件的 fire-and-forget（fail-open 篇第五节）好一档；token 注入后
堆积的重投自动送达。HEAD 的 NO_TOKEN 文案（`relay.js:49` 带 serviceName + §0.5 指引）
也已比 v1.1.15 的旧文案好得多。缺的只剩「创建时预警」。

## 四、建议（按价值排序）

1. **relay 库内建可选心跳**（`api/library/relay.js`）：`createRelay` 加
   `rotationHeartbeatMs` 选项（默认开、例如 10min），内部 timer 定期走一次
   `getValidToken()`。改动小、根治所有稀疏调用方，ant/nexus 的两个业务侧绕法
   都可以删掉。注意 timer 要能被 stop（服务优雅退出）。
2. **`nexus.sentinel.create` / `enable` 预检 relay token**：无 token 时返回体带
   `warning: 'nexus relay has no token; delivery and context.emit will fail (NO_TOKEN)'`
   ——把「静默死亡」变成「创建当场可见」。不建议直接拒绝（token 可以后配）。
3. （文档）events.md §0.5 补一段：「permit 配齐只保证轮转**不被拒**，不保证轮转
   **被触发**——调用稀疏的服务要自己安排保底调用」，并给出 schedule 心跳这个
   用 SOLO 自身设施的做法。若建议 1 落地，这段改为说明默认心跳即可。

---

## 处理结论（solo 侧）

2026-08-17 triage，三条建议全部采纳（按原排序落地）：

1. ✅ **relay 内建轮转心跳**（`api/library/relay.js`）：`createRelay` 新增 `rotationHeartbeatMs`
   选项（默认 10min，`0` 关闭），unref'd `setInterval` 定期走 `getValidToken()`——无 token 静默
   （provisioning 前是正常态）、非 NO_TOKEN 错误 console.error、in-flight 防叠、公开 `stopHeartbeat()`
   供优雅退出。所有经 `createRelay` 的服务（含派生项目的业务服务）自动获益，ant 的 in-process
   timer 与 nexus 的 schedule 心跳两个业务侧绕法在升级 bundle 后可删。
2. ✅ **`nexus.sentinel.create`/`enable` 预检 relay token**：共享 relay 无 token 或已过期时，
   返回体带 `warning`（不阻止创建，token 可后配）；introspection returns_schema 同步声明。
3. ✅ **文档**：events.md §0.5 补「permit 配齐 ≠ 轮转被触发」一段（含 ≤v1.1.16 的两个业务侧
   绕法）；nexus GUIDE 补 `warning` 语义。

测试：relay.test.js 新增心跳 5 例（纯定时轮转 / NO_TOKEN 静默 / 过期告警 / 关闭 / stop 幂等），
sentinel.test.js 新增预检 4 例，连同既有 relay/nexus 套件全绿。文中「v1.1.17 起」以本次改动
随下一个 tag 发布为准。
