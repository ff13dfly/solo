# Fulfillment 履约生命周期 — 实施设计文档

> 状态：Phase 1 + Phase 2 核心已实现 | 依赖服务：sale, storage, erp, crm, authority

---

## 一、核心概念

### 履约实例 (Fulfillment Instance)

每一张销售订单对应一个履约实例，贯穿从接单到关闭的完整链路。

```
FulfillmentInstance {
    id              : string        // 履约单号，如 FL-20260312-1234
    sourceId        : string        // 来源单号（sale 订单 ID 或其他外部单号）
    profileId       : string        // 使用的履约流程 Profile ID
    state           : string        // 当前状态
    prevState       : string        // 上一状态（用于 ON_HOLD 恢复）
    stateChangedAt  : timestamp
    createdAt       : timestamp
    createdBy       : string        // 创建人（来自 req.user）
    meta            : object        // 各阶段数据缓存（由 meta_fields.source 填充）
    history         : StateRecord[] // 状态变更历史（event + user + stamp，用于审计和 AI 分析）
    pending_callbacks: string[]     // 等待 workflow 回调的任务 ID（Phase 3）
}
```

### Profile（履约流程配置）

Profile 是 Fulfillment 的核心驱动配置，完整描述一种履约流程的全部规则。前端是通用渲染器，只需 instance + profile 两个数据源即可渲染完整的操作界面，无需为每种流程写定制代码。

```
Profile {
    id          : string
    name        : string
    states      : string[]              // 此流程的所有状态
    state_meta  : Record<state, { label, description }>
    meta_fields : MetaField[]           // 实例数据字段目录（含来源声明）
    transitions : Transition[]          // 状态转换规则
    ai_hooks    : AiHook[]              // AI 介入点（Phase 3）
}

MetaField {
    key         : string                // 对应 instance.meta 的字段名
    label       : string                // 显示名称
    type        : 'number' | 'string' | 'date' | 'boolean'
    source?     : {                     // 有 source 则由前端自动拉取，无则从 meta 读缓存值
        service : string               // 微服务名，如 'sale'
        method  : string               // RPC 方法，如 'sale.order.get'
        params  : Record<string, any>  // JsonLogic 模板，如 { id: { var: 'instance.sourceId' } }
        field   : string               // 从返回值取哪个字段，如 'totalAmount'
    }
}

Transition {
    event       : string                // 事件名，如 'payment_received'
    from        : string                // 来源状态
    to          : string                // 目标状态（由后端从规则里取，调用方不传）
    condition?  : JsonLogic             // 触发条件，所有变量来自 instance.meta（由 source 预先填充）
    actions?    : Action[]              // 触发后的下游动作（_tasks）
}

// ⚠️ 没有 inputs。
// transition 是纯粹的事件触发器，不携带任何业务数据。
// 需要附加数据的操作（取消、暂停等）封装为专用 RPC，见"专用操作接口"章节。
```

**前端打开一个 instance 的完整数据流：**

```
1. fulfillment.instance.get(id)   → instance（state, meta, history）
2. fulfillment.profile.get(id)    → profile（meta_fields, transitions）
   ↓
3. 有 source 的 meta_fields → 并发调对应微服务拉实时数据
   sale.order.get({ id: instance.sourceId })  → totalAmount, depositAmount
   erp.stock.query(...)                        → 库存状态
   → 将拉取到的值写入 instance.meta 缓存（fulfillment.instance.update）
   ↓
4. 渲染：
   - 按 meta_fields 展示当前实例数据（source 实时值 + meta 缓存值）
   - 过滤 transitions[from === instance.state] → 当前可触发的事件列表（只显示确认按钮）
   - 专用操作（取消、暂停等）作为独立按钮，调用专用 RPC
   ↓
5. 用户触发事件 → fulfillment.instance.transition({ id, event })
   后端：评估 condition（数据已在 meta）→ 推进状态 → 发射 _tasks

设计原则：
- fulfillment 是状态协调器，不是数据录入系统
- transition 是纯事件触发，不携带业务数据
- 业务数据（金额、库存）来自 meta_fields.source，由前端自动拉取
- 带附加语义的操作（取消/暂停）封装为专用 RPC，保持接口语义清晰
```

### 专用操作接口

需要附加数据或特殊业务语义的操作，封装为独立 RPC，不通过 transition 的 metaUpdate 传递：

```
fulfillment.instance.cancel({ id, reason, notifyCustomer? })
    → 校验当前状态可取消
    → 写入 meta.cancel_reason
    → 触发 cancel_requested 事件（内部调用 transition）
    → 按阶段决定 ERP 冲销动作（_tasks）

fulfillment.instance.hold({ id, reason, expectedResume? })
    → 记录暂停原因和预计恢复时间
    → 触发 hold_requested 事件

fulfillment.instance.resume({ id })
    → 恢复至 prevState
    → 触发 resume 事件

fulfillment.instance.override({ id, event, reason })
    → 管理员强制推进（跳过 condition 校验）
    → 需要 allow_all 权限
    → 写入特殊 history 标记（forced: true）
```

**设计规则**：这些 RPC 内部统一通过 `transition` 推进状态，对外暴露的是业务语义（"取消订单"），而不是状态机操作（"跳到 CANCELLED"）。

---

### 通用性与跨实例协调

**Fulfillment 是通用状态协调器**，不绑定任何具体业务领域。任何有离散状态 + 事件驱动的流程都可以创建独立 Profile 来驱动，多个 Profile 并存，互不干扰。

**跨实例条件（Cross-Instance Condition）**

当一个 instance 的状态推进依赖另一个 instance 的状态时，不需要引入 `parentId` 等结构性耦合。做法：

1. 在 `instance.meta` 里存关联实例 ID（由创建时或专用 RPC 写入），如 `meta.procurement_instance_id = 'FL-002'`
2. 在 `meta_fields` 里声明 source，调用 `fulfillment.instance.get` 拉取对方的状态：

```json
{
  "key": "procurement_state",
  "label": "采购履约状态",
  "source": {
    "service": "fulfillment",
    "method": "instance.get",
    "params": { "id": { "var": "instance.meta.procurement_instance_id" } },
    "pick": "state"
  }
}
```

3. condition 里直接比较：`{ "==": [{ "var": "instance.meta.procurement_state" }, "READY"] }`

**关键设计原则**：fulfill 把自己当作普通微服务，`fulfillment.instance.get` 就是它对外暴露的 status API，可以被任何 meta_fields source 引用，无需专门设计跨实例协调机制。关联关系存在 meta 数据里，灵活按需配置，实例之间保持解耦。

### 责任方标记

| 标记 | 含义 |
|---|---|
| **H** | Human — 需要人工操作或审批 |
| **M** | Money — 财务归集、逻辑核算 |
| **P** | Product — 货品状态（库存、发货、签收） |
| **ERP** | 与用友 T+ 的单据同步 |
| **AI** | 辅助决策、风险预警、自动填充 |

---

## 二、状态全集

```
                    ┌─────────────────────────────────────────┐
                    │            正常流转路径                   │
                    └─────────────────────────────────────────┘

DRAFT ──→ DEPOSIT_PENDING ──→ DEPOSIT_CONFIRMED ──→ SOURCING
                                                        │
                                                    PACKING
                                                        │
                                               BALANCE_PENDING (可选)
                                                        │
                                                 READY_TO_SHIP
                                                        │
                                                  DISPATCHED
                                                        │
                                                  DELIVERED
                                                        │
                                                   SETTLED
                                                        │
                                                   CLOSED ✓


                    ┌─────────────────────────────────────────┐
                    │            异常/旁路状态                   │
                    └─────────────────────────────────────────┘

任意可逆状态 ──→ ON_HOLD ──→ 恢复原状态
任意状态     ──→ CANCELLED  ✗（终态）
DELIVERED    ──→ DISPUTE  ──→ SETTLED 或 CANCELLED
```

---

## 三、状态详解

---

### `DRAFT` 草稿

**描述**：订单已录入系统，尚未正式提交，允许自由编辑。

| 维度 | 内容 |
|---|---|
| **关联操作** | 编辑订单内容、关联客户、设置商品明细 |
| **责任方** | H（销售）|
| **集成点** | sale（写）, crm（读客户信息）|
| **进入方式** | 新建履约实例时初始状态 |

**前进条件** → `DEPOSIT_PENDING`：
- 订单必填字段完整（客户、商品明细、总金额）
- 销售主管确认提交

**拦截条件**：
- 商品库存未完成初步核查（警告，非硬拦截）

---

### `DEPOSIT_PENDING` 待付订金

**描述**：订单已确认，等待客户支付订金。

| 维度 | 内容 |
|---|---|
| **关联操作** | 发送付款通知给客户、记录应收订金金额 |
| **责任方** | M（财务）, H（销售跟进）|
| **集成点** | ERP（生成预收款单）, crm（客户通知）|
| **进入方式** | DRAFT → 提交确认 |

**前进条件** → `DEPOSIT_CONFIRMED`：
- 财务确认订金到账
- 到账金额 >= `order.depositRequired`（比例由订单配置，如 30%~100%）
- **或** 客户信用额度审核通过（免订金路径）

**拦截条件**：
- 超过约定付款期限未收款 → AI 预警，人工介入

---

### `DEPOSIT_CONFIRMED` 订金确认

**描述**：订金已到账，财务完成核账，可以启动备货。

| 维度 | 内容 |
|---|---|
| **关联操作** | 财务归档订金单据、通知内勤启动备货 |
| **责任方** | M（财务）|
| **集成点** | ERP（预收款单状态更新）|
| **进入方式** | DEPOSIT_PENDING → 财务确认 |

**前进条件** → `SOURCING`：
- 内勤/仓管确认接收备货任务
- 供应商/工厂产能已初步确认

---

### `SOURCING` 备货/排产中

**描述**：内勤主导，向工厂或仓库协调货品，生成采购订单。

| 维度 | 内容 |
|---|---|
| **关联操作** | 创建采购订单、分配供应商、确认交期 |
| **责任方** | H（内勤）, P（仓库/工厂）|
| **集成点** | ERP（生成采购订单）, storage（库存预占）|
| **进入方式** | DEPOSIT_CONFIRMED → 内勤接收 |

**前进条件** → `PACKING`：
- 所有货品已到仓（storage 确认入库）
- 采购订单状态完结

**拦截条件**：
- 供应商产能冲突 → AI 预测交期风险，提前预警
- 部分货品缺货 → 进入 ON_HOLD 或拆单（待设计）

---

### `PACKING` 包装处理

**描述**：货品已到仓，进行细部处理、组合打包。

| 维度 | 内容 |
|---|---|
| **关联操作** | 包装确认、唛头制作、装箱清单生成 |
| **责任方** | P（仓管）|
| **集成点** | storage（库存扣减/移库）|
| **进入方式** | SOURCING → 货品到仓 |

**前进条件** → `BALANCE_PENDING` 或 `READY_TO_SHIP`（取决于付款方式）：
- 所有商品已完成包装确认
- 装箱清单已生成

---

### `BALANCE_PENDING` 待付尾款（可选）

**描述**：发货前收取尾款。部分合同要求发货前结清余款。

| 维度 | 内容 |
|---|---|
| **关联操作** | 发送尾款催收通知、确认到账 |
| **责任方** | M（财务）|
| **集成点** | ERP（应收账款）|
| **进入方式** | PACKING 完成 + 合同含发货前付款条款 |

> **注**：若合同为货到付款或信用账期，此状态可跳过，直接进入 READY_TO_SHIP。

**前进条件** → `READY_TO_SHIP`：
- 财务确认尾款到账
- **或** 合同明确约定账期，财务审批豁免

---

### `READY_TO_SHIP` 待发货

**描述**：货品备妥、包装完成、付款条件满足，等待安排物流。

| 维度 | 内容 |
|---|---|
| **关联操作** | 安排车辆/物流商、生成出库单 |
| **责任方** | H（仓管调度）, P（货品最终清点）|
| **集成点** | ERP（生成出库单）, storage（锁定出库）|
| **进入方式** | PACKING 或 BALANCE_PENDING 完成 |

**前进条件** → `DISPATCHED`：
- 货品已离仓，物流单号已录入
- ERP 出库单已生成

---

### `DISPATCHED` 已发货/运输中

**描述**：货物已交付物流，处于运输状态。

| 维度 | 内容 |
|---|---|
| **关联操作** | 跟踪物流节点、通知客户发货 |
| **责任方** | P（物流跟踪）, AI（异常预警）|
| **集成点** | 物流 API（外部，待集成）|
| **进入方式** | READY_TO_SHIP → 物流确认出库 |

**前进条件** → `DELIVERED`：
- 客户签收确认
- **或** 物流状态更新为"已签收"

**拦截条件**：
- 物流异常（丢件/损毁）→ AI 预警，进入 DISPUTE 或 ON_HOLD

---

### `DELIVERED` 已收货

**描述**：客户已确认收货，进入售后观察期。

| 维度 | 内容 |
|---|---|
| **关联操作** | 售后回访、满意度调查 |
| **责任方** | H（售后）, AI（满意度分析）|
| **集成点** | crm（客户反馈记录）|
| **进入方式** | DISPATCHED → 签收确认 |

**前进条件** → `SETTLED`：
- 无争议期满（默认 N 天，可配置）
- 或客户主动确认无异议

**旁路** → `DISPUTE`：
- 客户在观察期内发起争议

---

### `DISPUTE` 争议处理

**描述**：客户对货品或服务提出异议，暂停正常结算。

| 维度 | 内容 |
|---|---|
| **关联操作** | 记录争议内容、协调解决方案（退货/补货/赔偿）|
| **责任方** | H（售后/销售）, M（财务）|
| **集成点** | crm（工单）, ERP（退货单/红冲）|
| **进入方式** | DELIVERED → 客户发起争议 |

**前进条件** → `SETTLED`：
- 争议已解决，双方确认
- ERP 差额单据已处理完毕

**前进条件** → `CANCELLED`：
- 争议无法解决，订单取消并完成退款

---

### `SETTLED` 已结算

**描述**：款项全部结清，单据完整，订单进入最终确认阶段。

| 维度 | 内容 |
|---|---|
| **关联操作** | 财务最终核账、生成销货单 |
| **责任方** | M（财务）|
| **集成点** | ERP（生成财务销货单）|
| **进入方式** | DELIVERED 或 DISPUTE 解决后 |

**前进条件** → `CLOSED`：
- ERP 所有关联单据状态完结
- 财务核销完成

---

### `CLOSED` 已关闭 ✓（终态）

**描述**：履约完成，订单归档。

| 维度 | 内容 |
|---|---|
| **关联操作** | 归档、生成履约报告 |
| **责任方** | M, AI（绩效统计）|
| **集成点** | 所有服务（只读存档）|

---

### `ON_HOLD` 暂停（旁路态）

**描述**：因内外部原因暂时中止推进，保留当前状态待恢复。

| 进入条件 | 恢复后回到 |
|---|---|
| 客户主动要求暂停 | 暂停前的状态 |
| 供应商产能不足 | SOURCING |
| 物流异常等待处理 | DISPATCHED |

- 需记录暂停原因和预计恢复时间
- 超过最大暂停期限 → AI 预警，人工处理

---

### `CANCELLED` 已取消 ✗（终态）

**描述**：订单取消，根据当前阶段触发不同的退款/冲销流程。

| 取消发生阶段 | ERP 动作 |
|---|---|
| DEPOSIT_PENDING 之前 | 无单据，直接关闭 |
| DEPOSIT_CONFIRMED 之后 | 生成退款单，冲销预收款 |
| SOURCING 之后 | 需处理采购订单取消或转仓 |
| DISPATCHED 之后 | 发起退货流程 |

---

## 四、状态转换总表

| 当前状态 | 触发事件 | 切换条件（概要） | 目标状态 |
|---|---|---|---|
| DRAFT | order_submitted | 必填项完整 + 主管确认 | DEPOSIT_PENDING |
| DEPOSIT_PENDING | payment_received | 到账金额 >= 订金要求 | DEPOSIT_CONFIRMED |
| DEPOSIT_PENDING | credit_approved | 信用额度审批通过 | DEPOSIT_CONFIRMED |
| DEPOSIT_CONFIRMED | sourcing_started | 内勤接收任务 | SOURCING |
| SOURCING | goods_arrived | 所有货品到仓 | PACKING |
| PACKING | packing_completed | 装箱清单确认 + 有尾款条款 | BALANCE_PENDING |
| PACKING | packing_completed | 装箱清单确认 + 无尾款条款 | READY_TO_SHIP |
| BALANCE_PENDING | balance_received | 尾款到账 或 账期豁免 | READY_TO_SHIP |
| READY_TO_SHIP | dispatched | 物流单号录入 + 出库单生成 | DISPATCHED |
| DISPATCHED | delivery_confirmed | 客户签收 或 物流回调 | DELIVERED |
| DELIVERED | no_dispute_timeout | 无争议期满 | SETTLED |
| DELIVERED | dispute_raised | 客户发起争议 | DISPUTE |
| DISPUTE | dispute_resolved | 双方确认解决 | SETTLED |
| DISPUTE | dispute_failed | 协商破裂 | CANCELLED |
| SETTLED | finance_closed | ERP 单据完结 + 核销完成 | CLOSED |
| 任意可逆态 | hold_requested | — | ON_HOLD |
| ON_HOLD | hold_released | — | 暂停前状态 |
| 任意态（除终态）| cancel_requested | 取消审批通过 | CANCELLED |

---

## 五、待决策事项

以下问题在正式实现前需要明确：

1. **拆单支持**：同一订单部分货品先到，是否允许拆分履约？
2. **尾款时机**：`BALANCE_PENDING` 触发时机由订单合同条款决定，还是全局配置？
3. **无争议期**：`DELIVERED → SETTLED` 的自动超时天数如何配置？
4. **ON_HOLD 最大时长**：超时后的默认处理策略是什么？
5. **多币种**：到账金额的币种换算由哪一层处理？
6. **ERP 单据失败**：T+ 生成单据失败时，状态是否回滚，还是标记为 WARNING 继续？
7. **通知机制**：状态变更时如何通知相关方（钉钉/企微/邮件）？

**状态回退相关：**

8. **回退可见性**：实物状态逆转（如物流取件失败货品退回仓库）时，是直接配置反向 transition，还是先进 ON_HOLD 再回退？判断标准：实物状态是否真的发生了逆转。

9. **协商期可见性**：备货中发现问题需与客户协商时（如产品无法按时生产），协商过程是否需要在履约里体现（进 ON_HOLD）？还是协商在履约系统外完成后直接记录结果？

**订单内容修改相关：**

10. **订单修改的 ERP 回退策略**：备货阶段发生产品移除（如 B 产品无法按时生产被客户同意取消）时，T+ 已生成的销售订单和预收款单需要走红冲流程。当前 ERP 服务未暴露红冲 API，两个选择：
    - **选项 A（推荐）**：履约记录事件并通知财务，财务人工在 T+ 操作红冲，完成后手动触发 `erp_corrected` 事件回填。
    - **选项 B（后期自动化）**：扩展 ERP 服务，新增 `erp.sale_order.redOffset`、`erp.voucher.cancel` 等接口，由 workflow 自动完成修正链路。
    - 无论选哪种，ERP 单据修正应走 `human_confirm` 而非 `auto_execute`，保留人工审核节点。

11. **订单修改后的拆单决策**：若移除的产品（如 B）不是取消而是延期，需要判断是在原履约实例里等待，还是拆出一个新的履约实例单独跟踪 B 的交付。拆单条件建议：延期超过 N 天 或 金额占比超过 X%。

---

## 五·补 幂等契约（Idempotency Contract）

### 问题

`transition` 推进状态后会返回 `_tasks` 数组，由 Router 异步派发给下游服务。下列场景会导致下游被重复调用：

1. Router 收到响应后崩溃，重启时重放保存的 `_tasks`
2. 下游服务执行成功但 ACK 丢失，Router 自动重试
3. 运营人员通过 `instance.override` 手工再次推进，旧 transition 留下的 task 与新 task 撞期

对于"写型"下游（`ledger.transfer`、`bank.send`、`erp.voucher.create`），任何一次重复执行都意味着账务错乱。fulfillment 必须给下游一个能用来去重的稳定 key。

### 设计

**transition_id**：每次成功的 transition 生成一个稳定的 id：

```
transition_id = `${instance.id}-T${history.length + 1}`
例：FL-20260517-1234-T3
```

- 单调递增，等于 history 里这次 transition 占用的槽位号
- 同一次 transition 重放（Router 重试、崩溃恢复）会落到同一槽位 → 同一 id
- 人工 override 后再次推进，是 history 里新的一行 → 新 id（**故意区分**：这是一次新动作，不该被去重）

**idempotency_key（每个 _task）**：

```
params.idempotency_key = `${transition_id}:A${action_index}`
例：FL-20260517-1234-T3:A0
```

- 放在 `params` 里，对下游就是一个普通 RPC 参数，**无需任何协议改动**
- transition 内多个 action 之间用 `:A0` / `:A1` 区分
- 下游服务负责按 key 去重；fulfillment 不维护去重状态

**transition_id 同时挂在 _task 顶层**，方便 Router 日志和审计回放按 transition 聚合。

### 下游契约

凡是被 fulfillment 调用的"写型"方法，**必须**：

1. 接受 `idempotency_key` 参数
2. 首次执行时记录 key 与结果（建议 Redis SET + TTL ≥ 重放窗口）
3. 重复 key 直接返回首次结果，**不再执行业务逻辑**
4. 若首次执行仍在进行中（并发到达），后到者应阻塞或返回 RETRY，不能直接执行

只读方法（`erp.saleorder.query` 等）可以忽略 `idempotency_key`，但建议至少不报错。

### history 中的痕迹

```json
{
  "state": "DEPOSIT_CONFIRMED",
  "event": "payment_received",
  "transition_id": "FL-20260517-1234-T3",
  "user": "operator-zhang",
  "stamp": 1747454400000
}
```

凭 transition_id 可在下游服务的 audit 日志里反查："这次状态推进派发了哪些 task、各自执行结果是什么"。

### 不在此契约内的部分

- **workflow 类 action**（`action.type === 'workflow'`）走 orchestrator 自己的 callback 模型，不在 _tasks 里，自然不在本契约内
- **fulfillment 内部状态写入**自身是原子的（一次 `redis.set`），不依赖此契约
- **下游服务的事务边界**由下游自决，fulfillment 只保证 key 稳定

### 为什么不在 fulfillment 内做服务端去重

考虑过让 fulfillment 维护一个 "已派发 key 集合"，命中即跳过。最终放弃，原因：
- 下游服务最终还是要自己去重（直接被外部调用时无 fulfillment 参与）
- 双层去重容易状态分裂（fulfillment 认为派过了，但下游其实没收到）
- 下游去重逻辑可以更精细（按业务规则判断"算不算同一笔"）

fulfillment 的职责到"生成稳定的 key 并传过去"为止，剩下的让下游负责。

---

## 六、与现有服务的集成关系

```
fulfillment
    ├── sale       读取订单原始数据，状态变更回写订单
    ├── crm        读取客户信息，写入客户互动记录
    ├── storage    库存预占、入库确认、出库单触发
    ├── erp        各阶段单据生成（预收款/采购/出库/销货单）
    ├── planner    （可选）将履约节点同步为团队日程/待办
    └── authority  权限校验（哪些角色可以触发哪些事件）
```

**所有写型集成方都受幂等契约约束**（见 §五·补），下游实现时按上文要求处理 `idempotency_key`。

---

## 七、分阶段实施路线

三个阶段完全增量，每阶段独立交付价值，后一阶段只在前一阶段基础上**只加不改**。

### Phase 1 — 信息聚合（Profile 驱动的数据透视）

**目标**：创建履约实例后，前端通过 instance + profile 两个数据源，自动聚合所有关联数据，提供订单全貌的只读视图。

**核心价值**：解决"订单到哪了要问人"的问题，所有角色通过统一界面获得同一张订单地图。

> **设计变更说明**：原方案使用独立的 `erp_views` 配置 + `fulfillment.view` 聚合接口，现统一改为 `meta_fields.source` 机制。好处是字段定义、数据来源、条件变量三者合一，Profile 完全自描述，无需额外的聚合接口。

`meta_fields` 中有 `source` 的字段由前端在打开 instance 时并发拉取：

```json
{
  "id": "standard_trade",
  "meta_fields": [
    {
      "key": "total_amount",
      "label": "订单总金额",
      "type": "number",
      "source": {
        "service": "sale",
        "method": "sale.order.get",
        "params": { "id": { "var": "instance.sourceId" } },
        "field": "totalAmount"
      }
    },
    {
      "key": "deposit_required",
      "label": "应付订金",
      "type": "number",
      "source": {
        "service": "sale",
        "method": "sale.order.get",
        "params": { "id": { "var": "instance.sourceId" } },
        "field": "depositAmount"
      }
    },
    {
      "key": "amount_received",
      "label": "已到账金额",
      "type": "number"
    },
    {
      "key": "erp_order_id",
      "label": "ERP 预收款单号",
      "type": "string",
      "source": {
        "service": "erp",
        "method": "erp.sale_order.query",
        "params": { "externalCode": { "var": "instance.sourceId" } },
        "field": "id"
      }
    }
  ]
}
```

**前端数据聚合逻辑**（无需后端聚合接口，完全在前端并发处理）：
- 有 `source` 的字段：并发调用对应微服务，拉取实时值展示
- 无 `source` 的字段：从 `instance.meta` 读缓存值展示
- 两类字段合并渲染，用户看到统一的实例数据面板

**本阶段实现范围**：✅ 已完成
- 履约实例 CRUD（`fulfillment.instance.*`）
- Profile CRUD（`fulfillment.profile.*`）
- 基础 Redis 存储（实例 + Profile）
- `meta_fields.source` 数据结构定义（前端渲染逻辑待实现）

**本阶段不涉及**：状态切换、事件、条件校验、AI。

---

### Phase 2 — 流程协调（状态机 + 事件驱动）

**目标**：在 Phase 1 的基础上加入 `transitions`，通过事件驱动状态切换，强制业务流程卡控。

**核心价值**：解决"流程执行不一致"的问题——条件不满足无法推进，责任节点明确。

Profile 新增 `transitions`：

```json
{
  "id": "standard_trade",
  "meta_fields": [
    {
      "key": "amount_received",
      "label": "已到账金额",
      "type": "number",
      "source": {
        "service": "erp",
        "method": "erp.receipt.query",
        "params": { "externalCode": { "var": "instance.sourceId" } },
        "field": "amountReceived"
      }
    },
    {
      "key": "deposit_required",
      "label": "应付订金",
      "type": "number",
      "source": {
        "service": "sale",
        "method": "sale.order.get",
        "params": { "id": { "var": "instance.sourceId" } },
        "field": "depositAmount"
      }
    }
  ],
  "transitions": [
    {
      "event": "payment_received",
      "from": "DEPOSIT_PENDING",
      "to": "DEPOSIT_CONFIRMED",
      "condition": {
        ">=": [{ "var": "instance.meta.amount_received" },
               { "var": "instance.meta.deposit_required" }]
      },
      "actions": [
        {
          "type": "task",
          "service": "erp",
          "method": "erp.order.sync",
          "params": { "sourceId": { "var": "instance.sourceId" } }
        }
      ]
    },
    {
      "event": "cancel_requested",
      "from": "SOURCING",
      "to": "CANCELLED"
      // 取消原因不在 transition 里定义
      // 由 fulfillment.instance.cancel({ id, reason }) 专用 RPC 处理
    }
  ]
}
```

**触发流程（前端 → 后端）**：
```
前端打开 instance：
  meta_fields.source → 并发拉取 erp.receipt、sale.order → 写入 instance.meta 缓存
  渲染当前数据面板（已到账金额、应付订金等）

用户触发"订金确认"事件（纯状态推进）：
  fulfillment.instance.transition({ id, event: "payment_received" })

用户触发"取消订单"（带业务语义的专用操作）：
  fulfillment.instance.cancel({ id, reason: "客户主动取消" })
  → 内部写入 meta.cancel_reason，再调用 transition

后端（instance.js transition）：
  1. 按 event + fromState 找 transitionRule
  2. 用 instance.meta（已由 source 预填充）评估 JsonLogic condition
  3. 通过 → 推进 state，写入 history（含 event 字段），发射 _tasks
```

**关键设计点**：
- `transition` 是纯事件触发，不携带任何业务数据，调用方只传 `event`
- condition 所需数据来自 `meta_fields.source`，由前端预先拉取缓存，无需用户录入
- 带附加数据的操作（取消/暂停）封装为专用 RPC，内部再调 transition，对外暴露业务语义

**本阶段实现范围**：✅ 已完成
- `fulfillment.instance.transition`（event 路由 + JsonLogic 条件 + _tasks 发射）
- `fulfillment.instance.cancel / hold / resume / override` 专用操作 RPC（待实现）
- TransitionEditor / ConditionEditor / ActionEditor Portal UI
- history 记录（event + user + stamp）

**本阶段不涉及**：workflow 类型 Action、AI 钩子。

---

### Phase 3 — 智能协同（AI 介入 + Workflow 回调）

**目标**：在 Phase 2 的基础上加入 `ai_hooks` 和 `type: "workflow"` Action，接入编排器与 AI 能力。

**核心价值**：解决"人工判断的效率瓶颈"——低风险事件自动推进，高风险事件 AI 预警后人工确认。

Profile 新增 `ai_hooks`，transitions 可升级为 `type: "workflow"` Action：

```json
{
  "id": "standard_trade",
  "meta_fields": [...],
  "transitions": [
    {
      "event": "payment_received",
      "from": "DEPOSIT_PENDING",
      "to": "DEPOSIT_CONFIRMED",
      "condition": { ... },
      "actions": [
        {
          "type": "workflow",
          "workflowId": "erp-sync-on-deposit",
          "input": { "instanceId": { "var": "instance.id" } },
          "on_complete": {
            "event": "erp_synced",
            "meta_patch": { "erpOrderId": "$step.sync.result.id" }
          }
        }
      ]
    }
  ],
  "ai_hooks": [
    {
      "trigger": {
        "event": "payment_received",
        "condition": { ">": [{ "var": "instance.meta.amount_received" }, 50000] }
      },
      "invoke": "risk.creditAssessment",
      "input": ["instance", "user"],
      "disposition": "human_confirm"
    }
  ]
}
```

**本阶段实现范围**：
- `type: "workflow"` Action 调用编排器
- `on_complete` 回调接口（编排器侧约 20 行改动）
- `ai_hooks` 触发与 disposition 处理
- AI 观察记录（含 `adopted` 字段）

---

### 三阶段对比总览

| | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| **交付价值** | 信息可见 | 流程卡控 | 智能辅助 |
| **Profile 字段** | `meta_fields`（含 source） | + `transitions` | + `ai_hooks` |
| **依赖** | ERP 服务已通 | + JsonLogic | + 编排器 + AI |
| **数据积累** | 实例创建记录 | + 状态历史 | + AI 观察记录 |
| **可独立上线** | ✅ | ✅ | ✅ |
