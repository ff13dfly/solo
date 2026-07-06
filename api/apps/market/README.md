# market — 模拟发货业务服务（event 流程测试夹具）

> **不是框架服务**（同 collection）。SOLO 是纯框架、无业务层。market **不进** `deploy/services.json` / `CLAUDE.md §2`，dev 运行 + 运行时注册，不打包。

接在 collection（收款）**之后**：付款结算 → 发货。和 collection 一起，把多跳事件编排拉成一条完整业务链。

---

## 0. 在事件链中的位置

```
simulate stripe → EVENT:WEBHOOK:STRIPE                         (ingress, event.emit)
  → wf record-payment → collection.payment.record → EVENT:PAYMENT:RECEIVED
       → wf settle-payment → collection.payment.settle → EVENT:PAYMENT:SETTLED
            → wf create-shipment(订 EVENT:PAYMENT:SETTLED)
                 └ market.shipment.create → EVENT:SHIPMENT:CREATED        ← market 第一跳
                      → wf ship(订 EVENT:SHIPMENT:CREATED)
                           └ market.shipment.ship → EVENT:SHIPMENT:SHIPPED ← market 第二跳
```

收款（collection）+ 发货（market）= 一条横跨 4 个微服务、6+ 个事件、若干 workflow 的端到端编排，把 event 设计**两条生产路径（event.emit + _event 搭响应）+ matcher + worker + 人在环 + 多跳扇出**全覆盖。

---

## 1. 方法

| 方法 | 作用 | 发事件 |
|------|------|--------|
| `market.shipment.create` | 创建发货单（state=CREATED） | `EVENT:SHIPMENT:CREATED` |
| `market.shipment.ship` | 发货、分配运单号（state=SHIPPED） | `EVENT:SHIPMENT:SHIPPED` |
| `market.shipment.get` / `.list` | 查 | — |
| `market.order.create` | 下单（state=PLACED，幂等去重） | — |
| `market.order.pay` | 标记已付（PLACED→PAID，幂等） | — |
| `market.order.confirm` | 确认（PAID→CONFIRMED） | — |
| `market.order.hold` | 风控扣留（PAID→HELD，带 holdReason） | — |
| `market.order.get` / `.list` | 查 | — |

> 业务状态用 `state`（shipment：CREATED/SHIPPED；order：PLACED/PAID/CONFIRMED/HELD），与 Factory 的 `status`（ACTIVE/DELETED）分开。
>
> `order` 是为 **AML pipeline e2e**（`e2e/suites/101-aml-pipeline`）加的状态机驱动实体：**不发 piggyback 事件**（避免事件注册表耦合），由 fulfillment 状态机经 Router `_tasks` 推进（pay→confirm/hold），AI（nexus）在中间判 AML 决定 confirm 还是 hold。

---

## 2. 接线（与 collection 同套，端口 8056）

1. **起服务**：`node api/apps/market/index.js`（8056）。
2. **注册到 Router**：Portal → Service Management → 加 `http://localhost:8056`。
3. **事件注册表**（让 `_event` 过白名单）：在 `api/router/config.js` 的 `eventRegistry` 加：
   ```js
   'market': {
     'EVENT:SHIPMENT:CREATED': ['shipment.created'],
     'EVENT:SHIPMENT:SHIPPED': ['shipment.shipped'],
   },
   ```
4. **建 workflow**（Portal，`allowed_triggers:["event"]` + ACTIVE）：
   - **create-shipment**：订 `EVENT:PAYMENT:SETTLED` → 调 `market.shipment.create({orderId:$input.orderId, paymentId:$input.paymentId})`。
   - **ship**：订 `EVENT:SHIPMENT:CREATED` → 调 `market.shipment.ship({id:$input.shipmentId})`。
5. **触发**：从 collection 的链路自然流过来（settle → SETTLED → 这里）。观测：`market.shipment.list`、`redis XREVRANGE EVENT:SHIPMENT:SHIPPED`、Event Bus → Runs。

---

## 3. 边界

- **不打包**：market 与 collection 都是业务夹具，不进 `services.json`，框架保持 business-free。
- 第 3 步注册表条目为测试加，命名业务流，是 `eventRegistry` 注释预期的"服务注册时加入"。
- 夹具，非产品代码——真实接入按真实领域重建。
