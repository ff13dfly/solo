# collection — 模拟收款业务服务（event 流程测试夹具）

> **不是框架服务。** SOLO 是纯框架、无业务层（CLAUDE.md §1）。collection 是为**完整测试 event 流程**而建的**业务夹具**：
> - **不进** `deploy/services.json` / `CLAUDE.md §2` —— 不打包进 solo.js，框架保持 business-free。
> - dev 里单独起 + 运行时经 `system.service.add` 注册给 Router。

---

## 0. 它为什么存在

ingress 测的是**入站边界**（`event.emit` 主动发，§4.7）。collection 补上 ingress 测不到的两件事：

1. **`_event` 搭响应这条生产路径**（§4.1）：业务服务在处理 RPC 的**响应里挂 `_event`**，Router 提取后写流。`collection.payment.record/settle` 就这么发 `EVENT:PAYMENT:*`。
2. **多跳事件编排**（§6.3 的核心）：一个事件触发 workflow → workflow 调 collection → collection 又发事件 → 触发下一个 workflow。

合起来 = 把 event 设计的**两条生产路径 + 匹配 + 执行 + 扇出 + 多跳**全跑通。

```
mock simulate stripe → EVENT:WEBHOOK:STRIPE          (ingress, event.emit)
  → workflow "record-payment"(订 EVENT:WEBHOOK:STRIPE)
       └ step: collection.payment.record(...)
              └ 响应挂 _event → Router 写 EVENT:PAYMENT:RECEIVED   (collection, _event 搭响应)
                   → workflow "settle-payment"(订 EVENT:PAYMENT:RECEIVED)
                        └ step: collection.payment.settle({id})
                               └ _event → EVENT:PAYMENT:SETTLED      (多跳第二跳)
```

---

## 1. 方法

| 方法 | 作用 | 发事件 |
|------|------|--------|
| `collection.payment.record` | 记一笔入账（state=RECEIVED） | `EVENT:PAYMENT:RECEIVED`（_event 搭响应） |
| `collection.payment.settle` | 标记结算（state=SETTLED） | `EVENT:PAYMENT:SETTLED` |
| `collection.payment.get` / `.list` | 查 | — |

> 业务状态用 `state`（RECEIVED/SETTLED），与 Entity Factory 的 `status`（ACTIVE/DELETED 生命周期）分开，避免 list 过滤冲突。

---

## 2. 完整测试的接线（"为完整测试做准备"的下一步）

1. **起服务**：`node api/apps/collection/index.js`（端口 8055）。
2. **注册到 Router**：Portal → Service Management → 加 `http://localhost:8055`。
3. **注册事件**（让 collection 的 `_event` 过 Router 白名单）：在 `api/router/config.js` 的 `eventRegistry` 加（该处注释已邀请"业务流在服务注册时加入"）：
   ```js
   'collection': {
     'EVENT:PAYMENT:RECEIVED': ['payment.received'],
     'EVENT:PAYMENT:SETTLED':  ['payment.settled'],
   },
   ```
   > _event 搭响应路径的 source = **服务名** `collection`（Router 用 targetServiceName 当 source）。不加这条，事件会被 BLOCK。
4. **建 workflow**（Portal → Workflows，`allowed_triggers:["event"]` + ACTIVE）：
   - **record-payment**：`event_subscriptions:[{stream:"EVENT:WEBHOOK:STRIPE"}]`，步骤调 `collection.payment.record`（入参从 `$input` 取，注意 ingress 的 payload = `{request_id, data:<stripe对象>}`）。
   - **settle-payment**：`event_subscriptions:[{stream:"EVENT:PAYMENT:RECEIVED"}]`，步骤调 `collection.payment.settle({id:$input.paymentId})`。
5. **bot token**：orchestrator worker 要 `system.orchestrator` bot（同 ingress 的 `system.ingress`，Portal → Bot Accounts 注入）。
6. **触发**：`node deploy/mock/simulate.js stripe --direct`（用 stripe 源的 key）→ 看：
   - `EVENT:WEBHOOK:STRIPE` 落流 → record-payment 跑 → `collection.payment.record` → `EVENT:PAYMENT:RECEIVED` → settle-payment 跑 → `EVENT:PAYMENT:SETTLED`。
   - 观测：Event Bus → Runs（workflow 运行）、`collection.payment.list`、`redis XREVRANGE EVENT:PAYMENT:RECEIVED`。

---

## 3. 边界

- collection **不在 services.json**：业务服务不打包，框架保持纯净。要它随 dev 自动起，可临时塞进一个 dev-only 启动列表，或手动 `node` + Portal 注册。
- 第 3 步的注册表条目是为**测试**加的；它命名一个业务流，是 `eventRegistry` 注释明确预期的"服务注册时加入"。不想动框架，也可写 Redis `SYSTEM:CONFIG:EVENT_REGISTRY` 覆盖（但那会整表替换，需含全部条目）。
- 这是**夹具**，不是产品代码——真实接入业务时，按真实领域重建，勿直接复用。
