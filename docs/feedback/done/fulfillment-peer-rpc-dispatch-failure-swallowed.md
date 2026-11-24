# fulfillment `peer_rpc_with_callback`：投递失败被吞、对端返回值丢弃

- **来源**：finance（`api/apps/company` 店铺/开票履约阶段 2，提交 `finance@f2c4e39`）
- **日期**：2026-11-25
- **状态**：已处理并归档（2026-11-25，随 `v1.3.6` 发布）
- **涉及代码**：`api/apps/fulfillment/logic/instance.js` L449-L513（`solo@63a5e1d`；finance 运行的 bundle 是 v1.3.5）
- **协议**：`docs/protocol/zh/fulfillment.md` §2.2 actions、§3.3 第 6 项

## 背景

finance 把 11 处跨箱派单（`steward.bridge.dispatch`）改成可切换到 `peer_rpc_with_callback` 声明式代投：
company 把派单参数写进 `meta.pendingDispatch`，再触发自环跃迁 `bridge_dispatch_requested`，
由引擎签发令牌并经 `library/peer-relay` 投递给 Steward。真实 bundle e2e（真实 Router + provision + 模拟 Steward）
7/7 场景、26 次派单全部通过，协议本身可用。但在切换生产前，发现下面两个缺口，**只能由 SOLO 补**。

## 问题 1（主要）：投递失败只记 warn，实例静默卡住

```js
// instance.js L503-L511
try {
    await peerClient.call(action.method, dispatchPayload, { ... });
} catch (err) {
    logger.warn(`Instance ${id} peer_rpc_with_callback (${action.method} -> ${endpoint}) failed: ${err.message}`);
}
```

同样会静默跳过的情况还有：`endpoint` 为空（没配 `SOLO_PEER_<PEER>_URL`）时整个 `if (endpoint && action.method)` 直接不执行。

**后果**：跃迁已落盘、令牌已签发，但对端根本没收到工单（节点离线、剧本未审批、席位过期、对端 5xx、地址没配）。
调用方拿到的是成功的跃迁结果，实例只能等 `stateTtls` 超时才进 `ASSIST_REQUIRED`
（finance 生产上 AUTH_LOGIN 15 分钟、EXECUTING_TASK 30 分钟），超时诊断里也只有笼统的「超时」，看不到真正原因。
业务方以前自己直调时，失败当场就能挂起，并附上对端返回的原因（`reasonCode/reason`）。

**这与 `fulfillment` 的「反静默假成功」设计目标（`evidence` 门禁）方向相反**：跃迁看起来成功了，副作用其实没发生。

## 问题 2：对端返回值被丢弃

`peerClient.call(...)` 的返回值没有被使用。Steward 派单返回的 `{ id: bridgeId, jobId, state }` 是业务方
**取消 / 续跑时联动对端** 的唯一句柄。finance 现在只能在跃迁后再调一次 `steward.bridge.list` 按 `requestId` 反查；
如果对端按席位隔离 list（Steward 非运维席位只看得到自己派的单），反查就会失败。

## 建议

二选一或组合，都向后兼容：

1. **失败回推事件（首选）**：action 允许声明 `onError`：
   ```json
   { "kind": "peer_rpc_with_callback", "...": "...",
     "onError": { "event": "assist_requested", "metaKey": "peerDispatchError" } }
   ```
   投递失败或 endpoint 未配置时，引擎以内部身份对**同一实例、同一轮次**补发该事件
   （带 `expectedTransitionId` = 刚落盘的跃迁 id，防止和已到达的回调竞争），
   并把 `{ method, endpoint, code, message, at }` 写进 `meta[metaKey]`。
   同时作废刚签发的令牌（从 `pending_callbacks` 删除并 DEL `CBTOKEN`）。
2. **结果回写**：action 允许声明 `resultMetaKey`，投递成功时把对端返回值（经 `stripSensitiveMeta`）写进 `meta[resultMetaKey]`；
   失败时写 `{ ok: false, error }`。业务方的 `_tasks` 或下一次读实例时就能拿到 bridgeId 或错误原因。
3. **至少让调用方看得见**：`transition` 的响应里附 `_peerDispatch: [{ actionIndex, method, ok, error? }]`
   （Router 剥离 `_tasks` 的逻辑不受影响）。这是最小改动，业务方可以自己当场挂起。

## 顺带核实的一点（不需要改，建议补文档）

finance 早先的注释写着「对端 Router 会以 `-32602` 拒绝未知顶层参数」，所以一度担心引擎在顶层注入的 `idempotencyKey`
会被 Steward 拒收。复核 v1.3.5 Router `validateParams`（bundle L45794）后确认：**它只校验已声明参数，不拒绝未声明参数**。
建议在 `fulfillment.md` §2.2 `peer_rpc_with_callback` 一节注明：「`idempotencyKey` 注入在顶层；对端需要幂等时应在
自省中声明该参数，未声明会被忽略」。

## finance 侧当前处理

- 声明式开关 `FULFILLMENT_DECLARATIVE_DISPATCH` 默认关闭；开启后靠跃迁后的 `steward.bridge.list` 反查 bridgeId，
  失败场景暂时依赖 `stateTtls` 兜底（取舍见 `finance/docs/plan/company-fulfillment-convergence.md` 阶段 2）。
- SOLO 补上建议 1 或 3 后，finance 改两处即可：Profile 的 action 加 `onError`，删掉反查逻辑。

## 处理结论（2026-11-25）

已在 [`api/apps/fulfillment/logic/instance.js`](../../api/apps/fulfillment/logic/instance.js)、[`lint.js`](../../api/apps/fulfillment/logic/lint.js)、[`introspection.js`](../../api/apps/fulfillment/handlers/introspection.js) 与 [`docs/protocol/zh/fulfillment.md`](../protocol/zh/fulfillment.md) 中将建议 1 + 2 + 3 组合落地（100% 向后兼容）：
1. **`resultMetaKey` 结果回写**：投递成功时在实例锁内将对端返回值经 `stripSensitiveMeta` 清洗后写入 `instance.meta[resultMetaKey]`；失败时写入 `{ ok: false, error }`。
2. **`onError: { event, metaKey, reasonCode? }` + 令牌即时回收**：当 `endpoint` 缺失或对端 RPC 失败时，立即销毁刚签发的 `CBTOKEN` 并从 `pending_callbacks` 剔除，把 `{ method, endpoint, code, message, at }` 写入 `meta[metaKey]`，并在同一实例锁内携带 `expectedTransitionId` 自动触发 `onError.event`（支持 Profile 声明的事件或内置 `'suspend'` 直接断点挂起至 `ASSIST_REQUIRED`）。`lint.js` 同步校验 `onError.event` 可达性与 `metaKey` 合法性。
3. **返回体附带 `_peerDispatch` + 协议文档补齐**：含 `peer_rpc_with_callback` 的跃迁响应附带 `_peerDispatch: [{ actionIndex, method, ok, result?, error? }]`；`fulfillment.md` §2.2 已补充顶层 `idempotencyKey` 语义与新字段说明。
