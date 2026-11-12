# 反馈与底座建议：跨栈异步 RPA 驱动原语与批量工单汇聚屏障（Barrier）

> 来源：2026-11-12 四栈（`Steward`、`Finance`、`Catalog`、`SOLO`）自动化与履约能力边界复盘。
> 关联前序单：[`rpa-fulfillment-convergence-and-evidence-gate.md`](./rpa-fulfillment-convergence-and-evidence-gate.md)（SOLO `v1.3.3` 五项履约原语已落地）。

---

## 一、现状与真实痛点（源码核实）

SOLO `v1.3.3` 补齐 `idempotent`、`suspend/resume`、`stateTtls`、`transition.evidence` 与 `flcb_...` 单次回调令牌后，单实例履约状态机已具备扎实底座。但在 2026-11-12 横向审查 `Finance` 与 `Catalog` 调用 `Steward` 的真实代码时，仍存在两处**因框架编排原语缺位而迫使业务仓手写异步胶水/轮询**的结构性摩擦：

1. **`fulfillment` / `orchestrator` 缺少原生跨栈异步 RPA 派单动作（每个业务栈被迫重复手写 Bridge Adaptor）**：
   - 现状：`fulfillment` 的 `transition.actions`（`_tasks`）只能向**本栈 Router 内部服务**派发一锤子异步调用；而 `orchestrator` 的远程 step 面向短耗时同步 RPC（受 Router 转发超时约束，无法挂起等待数分钟的浏览器执行与人工扫码）。
   - 后果：`Finance` 不得不在 `api/apps/company/adaptor/steward.js` 手写近千行跨栈登录续期、`token.issue` 签发、`steward.bridge.dispatch` 组装与回调桥接胶水；`Catalog` 也在 `api/apps/connector/workers/steward-rpa.js` 维护了一套 `hive.job.create` + 1.5s `hive.job.get` 同步轮询 Worker。
2. **缺少「定时任务组扇出（Fan-out）→ 全员终局汇聚（Barrier Fan-in）→ 触发下游履约」的原生屏障原语**：
   - 现状：`core/nexus` 已支持定时触发 `hive.group.expand` 一次性扇出 N 张带时间窗的 RPA 采集/导出工单（如双 ERP 每日 5 张报表导出单），但 SOLO 没有「当同一 `roundKey` 下 N 张子单全部进入终态（`DONE`/`FAILED`/`SKIPPED`）时，自动汇总结果向本栈或对端 `fulfillment` / `ingress` 推一次批次收口事件」的原语。
   - 后果：`Catalog` 的 `in/1022-erp-180d/sync-pulse-daily.js` 只能以 Crontab 脚本在 06:10 起来手搓 `waitJob` 循环轮询 `hive.job.get` / `hive.job.list` 来做批次汇聚。

---

## 二、建议在 SOLO 框架演进的两项原语

### 建议 1：`fulfillment` / `gateway` 原生跨栈异步委托出口（`peer_callback_task`）

在 `apps/fulfillment`（配合 `core/gateway` / `api/library/peer-relay`）支持声明式跨栈异步任务出口，自动完成「签发 `flcb_` 令牌 + 跨箱认证投递」闭环：

```jsonc
// Profile transition.actions 示例：框架自动签发绑定当前 transition_id 的 flcb_ 令牌并注入 upstream.callbackToken
{
  "event": "dispatch_requested",
  "from": "READY",
  "to": "EXECUTING",
  "actions": [
    {
      "kind": "peer_rpc_with_callback",
      "peer": "steward",
      "method": "steward.bridge.dispatch",
      "callback": {
        "allowedEvents": ["rpa_succeeded", "rpa_failed", "assist_required"],
        "ttlMs": 1800000
      },
      "paramsFromMeta": "rpaDispatch"
    }
  ]
}
```

- **收益**：`Finance`、`Catalog`、`Solar` 只需在业务层准备 `meta.rpaDispatch`（如 `storeId`、`slug`、`inputs`、`extractors`、`sessionPolicy`），跨栈会话续期、`flcb_` 签发与防重放 `idempotencyKey` 全部下沉至 SOLO 框架标准层，各业务仓不再各自复制一套 `adaptor/steward.js` / `solo-client.js`。
- **注意（端到端密文信封边界）**：若任务含敏感凭据（`sealedInputs`），仍遵循零明文跨网原则——业务服务在起单前调一次对端只读 `steward.bridge.preflight` 取节点公钥本地完成 RSA-OAEP 封装，框架层只负责原样透传 `sealedInputs`。

### 建议 2：批次汇聚屏障（Batch Barrier / `roundKey` Fan-in Event）

提供轻量级声明式批次屏障（可落在 `apps/fulfillment` 的 `batch` 子能力或 `core/orchestrator` 的 `fanout_barrier` 原语）：
1. 扇出方（如 `hive.group.expand` 或批量采购拆单）登记 `(barrierKey, expectedCount, ttlMs, onSettledTarget)`；
2. 每张子任务进入终态（`DONE` / `FAILED` / `SKIPPED`）时向屏障原子打卡（`HINCRBY` / `SADD` 幂等去重）；
3. 当打卡数达到 `expectedCount` 或到达 `ttlMs` 死期时，原子触发**唯一一次** `settled` 回调（携带 `{ succeeded, failed, skipped, results }`），直推目标栈 `fulfillment.instance.callback` 或 `ingress.ingest`。

- **收益**：彻底消灭 `sync-pulse-daily.js` 等定时批处理脚本里的 `while + sleep + hive.job.get` 轮询循环，使「06:00 `nexus` 触发 `BC001` 双 ERP 扇出采集 → 全部报表就绪后主动回调 `Catalog` 触发入库与 Pulse 发布履约单」成为 100% 事件驱动闭环。

---

## 三、`Steward` 侧已先行就绪的配套能力（无需框架改动即可对接）

在 SOLO 上述两项底座演进前，`Steward` 已于 2026-11-12 先行完成执行侧收敛，保证协议向前兼容：
1. `hive.node.resolve` 与 `steward.bridge.preflight`：支持按 `storeId` 动态寻址在线空闲节点并返回加密公钥；
2. `steward.bridge.dispatch`：支持省略 `nodeId`、内置平台最低插件版本闸、声明式闭集结构化提取器 `extractors`（产出 `metaUpdate.structured`）及有界单次掉线唤醒重放 `sessionPolicy`；
3. 历史遗留的 `steward.listing.*` / `steward.action.*` 全部冻结为 `ai: false`，不再对外部暴露第二套对象/工单模型。

---

## 处理结论

- **状态**：✅ 已核实并落地（2026-11-12，随 SOLO `v1.3.4+` 演进闭环），归档至 `docs/feedback/done/`。
- **落地明细**：
  1. **声明式跨栈异步委托原语（`kind: "peer_rpc_with_callback"`）**：
     - 在 [`api/apps/fulfillment/logic/instance.js`](../../api/apps/fulfillment/logic/instance.js) 中支持 `transition.actions[]` 声明 `kind: 'peer_rpc_with_callback'`：状态跃迁原子落盘时自动签发绑定当前 `transition_id` 的单次 `flcb_...` 回调令牌，读取 `instance.meta[paramsFromMeta]` 并注入 `upstream: { instanceId, profileId, sourceId, transitionId, expectedTransitionId, callbackToken, tokenId, allowedEvents, expiresAt, callbackUrl }`，通过 [`api/library/peer-relay.js`](../../api/library/peer-relay.js) 向对端 SOLO 栈投递（不会误入本栈 Router `_tasks` 队列）。
     - 在 [`api/apps/fulfillment/logic/lint.js`](../../api/apps/fulfillment/logic/lint.js) 中新增静态校验：校验 `peer`/`endpoint`、远端 RPC 方法名格式（2~4 段全小写点分），并强制核验 `callback.allowedEvents` 中的每个回调事件在目标状态 `to` 下均有对应的出边转移规则，同时豁免本栈 `methodIndex` 与本栈 Router `taskWhitelist` 限制。
  2. **批量工单扇入汇聚屏障（`fulfillment.barrier.{create,checkin,get,reap}`）**：
     - 新增 [`api/apps/fulfillment/logic/barrier.js`](../../api/apps/fulfillment/logic/barrier.js)，并在 [`api/apps/fulfillment/index.js`](../../api/apps/fulfillment/index.js)、[`api/apps/fulfillment/handlers/introspection.js`](../../api/apps/fulfillment/handlers/introspection.js) 与 [`api/apps/fulfillment/config.js`](../../api/apps/fulfillment/config.js) 完整注册 4 个标准方法：
       - `fulfillment.barrier.create`：按 `barrierKey` 幂等创建批次屏障（支持 `$owner` 租户隔离、`expectedCount`、`ttlMs` 与 `onSettled` 声明）；
       - `fulfillment.barrier.checkin`：按 `itemId` 幂等记录子任务终态（`DONE` / `FAILED` / `SKIPPED`），当 `completedCount === expectedCount` 时经 `optimisticUpdate` 原子置为 `SETTLED` 并**唯一一次**触发 `onSettled`（支持推进本栈 `fulfillment` 实例、派发本栈 `_tasks` 或通过 `peer-relay` 回调对端栈 `fulfillment.instance.callback` / `ingress.ingest`）；
       - `fulfillment.barrier.get`：查询屏障实时进度与子任务结果汇总；
       - `fulfillment.barrier.reap`：扫描超时未齐套的 `PENDING` 屏障，原子置为 `EXPIRED`（`timedOut: true`）并触发超时回调（同时挂载至 `FULFILLMENT_REAP_INTERVAL_MS` 后台周期扫描器）。
  3. **协议文档与单测回归**：
     - 同步更新 [`docs/protocol/zh/fulfillment.md`](../protocol/zh/fulfillment.md)（升级至协议版本 `1.7.0`）；
     - 在 [`api/apps/fulfillment/tests/logic.test.js`](../../api/apps/fulfillment/tests/logic.test.js)、[`api/apps/fulfillment/tests/profile-lint.test.js`](../../api/apps/fulfillment/tests/profile-lint.test.js) 与 [`api/apps/fulfillment/tests/returns-contract.test.js`](../../api/apps/fulfillment/tests/returns-contract.test.js) 补齐完整契约与行为单测。
