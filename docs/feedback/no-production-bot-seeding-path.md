# 反馈：没有生产可用的 bot 播种入口，于是每个消费者各挑各的、必漏传递依赖

> **本篇是从 [`done/event-triggered-workflow-lifecycle-drops-events.md`](./done/event-triggered-workflow-lifecycle-drops-events.md)
> §4.2 拆出来的**（2026-09-05）。拆的理由：它与那篇的事件生命周期**毫无关系**，只是同一条链路
> 上一起撞到的；留在那篇里，等其余建议结案归档时它会跟着一起消失。
> （同款前车之鉴：`entity-factory-bypasses-clock.md` 的建议 1 混在别的结论里，至今没做。）

- **来源**：steward，2026-09-05。接通「外部 webhook → 履约状态机 → 下一条剧本」这条链、
  给各服务发 relay bot token 时撞到。
- **依据分类**：**本次实测**（steward 线上栈，bundle `solo.v1.2.13.js`）：下面那条报错原文与
  失败时机。**源码引用**（solo 仓 main，未跑）：`deploy/seed-bots.js` 的 dev-only 头注、
  `deploy/bot-permits.js` 的内容。
- **涉及**：`deploy/seed-bots.js`（dev-only，无生产等价物）、`deploy/bot-permits.js`（单一真源，
  内容是对的）、`e2e/harness/setup.js` 的 `seedBots()`（生产形态的那条路，但只在 e2e 里）、
  `docs/protocol/zh/events.md §0.5`。
- **影响面**：**每一个要用 relay bot 的派生项目**，也就是每一个用 `_tasks` / 事件链 / 编排的项目。

> 一句话：`BOT_PERMITS` 已经是单一真源了，缺的只是**「整份播种」这个动作的生产入口**——
> 于是每个消费者按"我这条链用到哪些服务"自己挑，而这个挑法**必然漏掉传递依赖**。

---

## 一、现象与根因

`deploy/seed-bots.js` 头注明写 **dev-only**，且它**往 Redis 直写一个 `solo-dev-admin` 会话**
绕过登录——生产上不能用。于是每个下游项目自己写一份，而写的时候的自然做法是
"按我这条链会用到哪些服务来挑 bot"。

这个做法必然漏掉**传递依赖**。实测：我们挑了 orchestrator / fulfillment / ingress / notification，
漏了 `system.approval`——因为这条链里**没有任何一步直接调 approval**，
是 `workflow.approve` 经 relay 调 `approval.gate.sign`，**approval 自己**再去 `user` 服务
读审批人公钥验签。

失败点极靠后：投稿成功、gate 开了、`user.key.sign` 算出签名了，**提交签名那一刻**才报：

```
[RPC_FAILED] Could not fetch approver public key: No service token configured for "approval".
```

**这条报错本身是范例级的好**——点名了是哪个服务、要调哪个方法、去哪看文档。
问题不在报错，在于"到那一刻才知道"。

建议：给 `deploy/seed-bots.js` 一个**生产形态的同胞**（走 admin 登录 + `<svc>.token.set` RPC，
不碰 Redis，即 e2e harness 那条路），或者至少在 `events.md §0.5` 写一句判据——
**给某个服务发 token 时，连它「为了完成这次调用还要再打给谁」一起看**。
`BOT_PERMITS` 已经是单一真源了，缺的只是"整份播种"这个动作的生产入口。

---

## 二、建议

1. **给 `deploy/seed-bots.js` 一个生产形态的同胞**：走 admin 登录 + `<svc>.token.set` RPC
   （即 e2e harness `seedBots()` 那条路），不碰 Redis、不写 dev 会话。
   `BOT_PERMITS` 已经是单一真源，这一步只是把"整份播种"变成一个可在生产执行的动作。
2. **退一步的最低成本版**：在 `docs/protocol/zh/events.md §0.5` 写一句判据——
   **给某个服务发 token 时，连它「为了完成这次调用还要再打给谁」一起看**。
   （本篇的实例：链路里没有任何一步直接调 approval，但 `workflow.approve` 经 relay 调
   `approval.gate.sign`，approval 自己再去 user 读公钥验签。）
3. 可选：把"缺 token"的失败提前——投稿/审批入口在真正用到之前先探一次依赖服务的 token 是否齐。
   本篇的失败点极靠后（签名都算出来了才报），报错本身很好，问题是"到那一刻才知道"。

---

## 三、处理结论

（待 triage）
