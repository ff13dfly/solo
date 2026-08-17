# 反馈：带 context 的 Sentinel 投递到 inbox 的 payload 是三层嵌套，无文档且内层 wrapper 误导

> 来源：colony 派生项目，2026-08-16 部署熔断 Sentinel（polling reachability）时实测——
> 消费侧解析连错两次，第三次靠拉线上消息原文才写对。
> 依据：**N100 线上消息原文**（下附，逐字段）+ solo 仓 HEAD 源码
> `api/core/nexus/logic/context.js:283-284`（形状的出处）。
> 涉及：`api/core/nexus/logic/context.js`（assemble ④）、nexus GUIDE 的投递契约描述。
>
> 一句话：GUIDE 写了「事件信封字段（**无 context 时**直接透传给你）」，但**有 context 时**
> 的形状完全没写——实际是 `{ event: { type: <stream名>, payload: <信封> }, context: {...} }`
> 三层嵌套，且内层 wrapper 的 `type` 字段装的是 **stream 名**而非事件 type，
> 按直觉解析必错。

---

## 一、线上消息原文（2026-08-16，逐层标注）

`notification.inbox.list` 拉到的原始消息（guard 命中后由 nexus 投递）：

```jsonc
{
  "id": "f2pvMhNNEbvh",
  "targetId": "Ac50zBOVpfH8",            // sentinel id
  "type": "EVENT:ANT:ENTRY_FAILED",      // ← 这里的 type 是 stream 名（第一处）
  "payload": {                            // ── 第 1 层：装配产物
    "event": {                            // ── 第 2 层：wrapper
      "type": "EVENT:ANT:ENTRY_FAILED",  // ← 又是 stream 名（第二处），不是事件 type！
      "payload": {                        // ── 第 3 层：这才是 Router 信封
        "type": "ant.entry.failed",       // ← 事件 type 在这里
        "source": "system.ant",
        "event_id": "probe-breach-...",
        "depth": "1", "emitted_at": "...", "trace_id": "...",
        "payload": { "symbol": "PROBE", "breach": true, ... }   // ── 业务数据
      }
    },
    "context": { "system_prompt": "", "data": {}, "sentinel": { ... } }
  },
  "sourceId": "nexus", "ref": "1786887972895-0"
}
```

形状出处：`context.js:283-284`（assemble ④）——
`payload: { event: { type: stream, payload: event || {} }, ... }`。

## 二、为什么这会让每个消费者踩一遍

1. **文档只讲了无 context 的形状**（「无 context 时直接透传信封」），带 context 的
   形状要靠读源码或抓线上原文才知道。我们按文档直觉写的解析（信封在 `payload.event`）
   错了；按「多包一层」猜的（`payload.event.payload` 是业务数据）又错了——
   实际业务数据在 `payload.event.payload.payload`，四段路径。
2. **`type` 字段一词两义**：外层消息与第 2 层 wrapper 的 `type` 都是 **stream 名**，
   信封里的 `type` 才是事件 type。消费侧按 `type` 过滤事件（events.md 说 type 是
   「消费端的过滤键」）的直觉在这里全部落空。
3. 消费侧最终只能放弃按层数解析、改成**按特征下钻**（找带 `source`/`event_id` 的
   那层当信封）——能工作，但这说明契约本身没有给出稳定的形状承诺。

## 三、建议（按价值排序）

1. **文档补形状**：nexus GUIDE「事件信封字段」那条补上带 context 的完整形状
   （照上面的原文给一个标注过的例子），并明说「wrapper 的 `type` 是 stream 名」。
   零代码改动，当天可做。
2. **（v2 契约再议）扁平化 wrapper**：`payload.event` 直接放信封（去掉
   `{ type: stream, payload }` 这层——stream 名在外层消息 `type` 已有，wrapper
   不携带新信息）。是 breaking change，只建议在下个契约版本考虑；做的话消费侧
   按特征下钻的写法（找 `source`/`event_id`）天然兼容两版。
3. `buildEmit` 的变量袋（`context.js:310`）取的是 `assembled.event.payload`（= 信封），
   所以 `{{event.payload.xxx}}` 模板路径与 guard 一致——这一点是对的；文档里
   顺带写明「guard/模板的 `event.*` 指信封层」，消费侧与模板侧就有了同一套坐标。

---

## 处理结论（solo 侧）

2026-08-17 triage。形状指控经源码核实全部属实（`context.js` assemble ④ + `stream.js`
`notification.send` 的 `type: stream`）；且比反馈所述更糟——`docs/protocol/zh/context.md` §6
原有的示例把 `event.payload` 画成了业务数据（实际是 Router 信封）、`context.agent` 实际叫
`context.sentinel`、`message_id` 字段不存在，是主动误导而非单纯缺文档。

- ✅ **建议 1（文档补形状）**：nexus GUIDE「坑与约定」新增「inbox payload 两种形状」条目
  （带标注例子 + 「wrapper `type` 是 stream 名」+ 按特征下钻的稳妥解析法）；context.md §6
  整节重写为与实现逐字段对齐（含 inbox 消息外层结构、`context.output`/`autorun_error`、
  幂等用 `ref`/`event_id`）。
- ⏸ **建议 2（扁平化 wrapper）**：确认为 breaking change，留 v2 契约再议，不进 v1.1.x。
- ✅ **建议 3（guard/模板坐标）**：已并入上述两处——明确 `{{event.*}}` 指信封层、业务数据即
  `{{event.payload.*}}`，消费侧与模板侧同一套坐标。
