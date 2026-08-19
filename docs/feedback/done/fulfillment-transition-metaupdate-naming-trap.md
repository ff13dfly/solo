# 反馈：transition 的 `metaUpdate` 与 create/update 的 `meta` 命名不一致 + 未知参数静默吞 —— 组合成一个 24h 无症状的数据丢失陷阱

> 来源：colony 派生项目，2026-08-18 部署 mock AI 介入实验（对 fulfillment 镜像 fire
> review 自环）时实测抓到。
> 依据：**数据丢失现象与修复验证均为 N100 线上实测**；参数合同引用 solo 仓 HEAD 源码
> （`api/apps/fulfillment/logic/instance.js` / `handlers/introspection.js`），v1.1.15 bundle
> 已 grep 核对同名（`metaUpdate` 11 处命中）。
> 涉及：`fulfillment.instance.transition`（参数命名）、Router 参数校验（未声明参数不报）。
>
> 一句话：同一个服务里 `instance.create` / `instance.update` 收 **`meta`**，
> `instance.transition` 收 **`metaUpdate`**（`instance.js:220`）；调用方按直觉混用 `meta`
> 时**没有任何报错或警告**，附带数据被静默丢弃——我们带着这个 bug 跑了一天多，
> 账面全绿，直到一次专门的介入实验才发现。

---

## 一、实测：一天多的静默数据丢失，全程零症状

colony 的 fulfillment 镜像（`logic/mirror.js`）2026-08-17 上线，四处 transition 调用
全部按 create 的直觉传了 `meta:`：

```js
await relay.call('fulfillment.instance.transition',
    { id: flId, event: 'close', meta: { closeReason: reason, realizedPnl } })   // ← 被静默忽略
```

后果：`closeReason` / `realizedPnl` / `timeoutHours` **从没进过任何镜像实例**——
transition 本身照常成功、状态照常推进、TRANSITIONED 照常发、history 照常记，
三本账对账（账本 vs 实例数 vs 事件数）也全部通过，因为对账对的是**条数**不是**内容**。
唯一的暴露方式是有人去读 meta 里本该有的字段——2026-08-18 的介入实验第一发就撞上：
review 自环写成功、TRANSITIONED +7，但 advice/confidence/reason 全部不在实例里。

改成 `metaUpdate` 后当场验证：meta 正确合并（保留 create 时的原字段 + 新增转移附带字段），
真实行情触发的后续转移也持续落 meta。

## 二、根因：两个各自「说得通」的设计叠出一个陷阱

1. **命名不一致**（`instance.js`）：`create({ sourceId, profileId, meta })`（153 行）、
   `update({ id, meta, ...updates })`（287 行）都叫 `meta`；`transition({ id, event, metaUpdate })`
   （220 行）叫 `metaUpdate`。introspection 声明是对的（`introspection.js` transition 的
   params 列了 `metaUpdate` 并写明 merge 语义）——**文档没错，错在同一实体的三个写口
   两种名字**，调用方极易按 create 的肌肉记忆写 `meta`。
2. **未声明参数静默通过**：传 `meta` 给 transition 没有任何报错/警告（线上实测，
   Router param 校验只管声明过的参数的类型/必填/字符规则）。两者叠加 =
   「写错参数名 → 无声无息 → 数据丢失 → 无症状潜伏」。

单独看每一条都不算 bug；叠起来的形态和 events.md §0.5 那类「当天不炸、用到才断」
是同一族——而且这个更隐蔽：它**永远不炸**，只是数据悄悄没了。

## 三、建议（按价值排序）

1. **transition 接受 `meta` 作为 `metaUpdate` 的别名**（`instance.js:220` 一行解构补一个
   fallback：`metaUpdate = params.metaUpdate ?? params.meta ?? {}`）。向后兼容、当场消除
   陷阱，语义也不冲突（transition 的 meta 本来就是 merge 进 instance.meta）。
2. **未声明参数至少 warn**：param-hygiene 已有 `PARAM_VALIDATION=warn|enforce` 的
   滚动机制（router config），把「调用带了未声明参数」纳入 warn 档——不拦请求，
   但日志里能看见。这条能兜住所有同型陷阱，不止 fulfillment。
3. （文档）fulfillment GUIDE 在 transition 一节显式标注「⚠️ 此处是 `metaUpdate`，
   与 create/update 的 `meta` 不同名」，直到建议 1 落地。

---

## 处理结论（solo 侧）

2026-08-19 triage。两条指控经源码核实**均属实**：`instance.js` 的 create(153)/update(287)
收 `meta`、transition(220) 收 `metaUpdate`，merge 语义完全相同（都是浅合并进 `instance.meta`）；
introspection 声明本身没错。Router 侧 `validateParams`（`validator.js:104-162`）只遍历**已声明**
的 schema 取值，params 里多出的 key 从不被访问，未声明参数一路透传到微服务后被解构静默丢弃。

- ✅ **建议 1（`meta` 作别名）**：`transition({ id, event, metaUpdate, meta })` →
  `metaUpdate ?? meta ?? {}`，两名并存时 `metaUpdate` 优先。introspection 同步声明 `meta`
  别名（标注 prefer metaUpdate），GUIDE「坑与约定」加一条点名两个名字的差异。
  新增 2 个用例（别名生效且是 merge 不是 replace / 两名并存时的优先级）。
- ⏸ **建议 2（未声明参数至少 warn）**：**确认该做且成本很低**——`methodSchema` 在
  `validateParams` 这层本就可见，现成的 `blockNew()` 就是 warn|enforce 开关，5-8 行即可，
  且现有测试没有锁定"未声明参数被放行"这一行为（不会破坏）。但落点在 `api/router/`
  修改保护区，**本轮未动**：这条兜住的是所有同型陷阱（不止 fulfillment），值得单独授权后做。
- ✅ **建议 3（GUIDE 标注）**：已写，且**不因建议 1 落地而删**——别名只消除本次这一个陷阱，
  「传错参数名不会报错」这个更大的坑仍在，直到建议 2 落地。
