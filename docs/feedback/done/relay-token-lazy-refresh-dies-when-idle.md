# 反馈：relay bot token 只在有调用时才续签，车道空闲超过 TTL 就永久失联

- **来源**：steward，2026-09-07。用真素材展开的剧本第一次走完整条「webhook → 履约状态机 → workflow 派单 →
  插件执行 → 探针回读」链路时，第一步 `orchestrator.workflow.approve` 就被拒。
- **依据分类**：**本次实测**（steward 线上栈 N100，bundle `solo.v1.2.14.js`）。报错原文与时间线在下面；
  根因是读 bundle 源码得出的（引到行号），不是猜的。
- **涉及**：`api/library/relay.js`（bundle `solo.v1.2.14.js:80202-80276`：`isExpired` / `needsRotation` /
  `refreshIfNeeded` / `getValidToken`）；派生项目的 `deploy/provision-bots.js` 头注（steward 那份此前写着
  「token 会过期，但不用管」，已按本次实测更正）。
- **影响面**：**每一个用 relay bot 的派生项目里，凡是流量间歇超过 token TTL（24h）的服务**——
  事件链、编排、履约这类「等外部输入、几天才动一次」的东西正是这种形状。

## 一、现象与根因

时间线：

| 时刻 | 事 |
|---|---|
| 2026-09-05 ~17:00 | `provision-bots.js` 给 orchestrator / fulfillment / ingress / notification / approval 发 token，到期 09-06 ~17:00 |
| 09-05 17:00 ～ 09-07 16:50 | 车道无流量（演示做完就没人碰） |
| 09-07 16:50 | ops 签名审批改版的 workflow：`orchestrator.workflow.approve: [NO_TOKEN] No service token configured for "orchestrator". Admin must call orchestrator.token.set with a token from user.bot.issue.token` |
| 09-07 16:59 | 重跑 `provision-bots.js`（幂等）→ 再签 → APPROVED、ACTIVE |

根因（`solo.v1.2.14.js`）：

- `getValidToken()`（`:80267-80276`）是**唯一**的续签入口，而它只在某次 relay 调用时被调；
  `needsRotation`（`:80205`）判「离到期不足 rotateBeforeMs」才续。也就是说续签是**懒的**：没有调用就没有续签。
- 已经过期时（`isExpired`，`:80202`）它 `clearState()` 后抛 `TOKEN_EXPIRED`（`:80271-80274`），
  状态被清掉，之后每次都是 `NO_TOKEN`。过期的 token 本就没法自己 `user.token.refresh`，清掉是对的；
  问题在**没有任何东西在到期前主动去续**。
- 于是「24h 内至少有一次调用」成了 relay 活着的隐含前置，而这条前置**没有写在任何地方**，
  派生项目反而记了相反的结论（steward `provision-bots.js:18-21`：「token 会过期，但不用管…不是需要挂 cron 的续期任务」——
  那句话的实测依据是「nexus 的 token 4 小时前刚自动续过」，nexus 一直有流量，所以看起来像会自己续）。

症状的误导性：报错指向「admin 没配 token」，看起来像从来没接过线；实际是接过、跑通过、然后**安静地死了**，
且死的时刻没有任何日志（过期在 `clearState` 那一刻才被发现，而那一刻是两天后的第一次调用）。

## 二、建议

1. **relay 自己定时续**（首选）：token 拿到后按 `expiresAt - rotateBeforeMs` 挂一个 timer（进程内，
   `unref()` 不挡退出；重启后 `readState` 再挂）。续签本就是 relay 的职责，它已经有锁（`acquireLock`）与
   「等别人续」（`waitForOtherRefresh`）两套机制，只差一个不依赖外部调用的触发点。
2. **过期时别只抛 NO_TOKEN 的兄弟**：`clearState` 前记一条 WARN（服务名、原到期时间、空闲了多久），
   否则运维看到的第一条线索是两天后的 `NO_TOKEN`，而它的措辞把人引向「从没配过」。
3. 短期文档：`docs/authoring/events.md §0.5` 加一句「续签只在调用时发生；流量间歇可能超过 TTL 的服务，
   要么保证每天至少一次调用，要么重跑 `provision-bots`」。派生项目的 seed 脚本头注照此写。

## 三、处理结论

**2026-09-07 核实：现象属实，根因写错了；框架级缺陷是真的，但在另一处。**

### 更正：定时续签 v1.1.17 就有了，且 steward 那份 bundle 里就在跑

- `api/library/relay.js:404-430` 有 **rotation heartbeat**（`rotationHeartbeatMs` 默认 **10 分钟**，
  `unref()` 不挡退出，重启后随 `createRelay` 重挂）——正是 2026-08-17 处理 colony
  `nexus-relay-lazy-rotation-sparse-callers.md` 时加的，commit `d438a6f`，随 v1.1.17 发布。
- steward 用的 `solo.v1.2.14.js` 里就有它（`:80384`）。**本文建议 1 = 已实现**。
- 过期前的告警也已实现（`relay.js:210` `console.error`）。**本文建议 2 = 已实现**，
  「死的时刻没有任何日志」这句同样不成立。

### 真实根因：bot permit 里没有 `user.token.refresh`，心跳每 10 分钟被 Router 挡回一次

线上实证（N100 `~/AI/steward/api/debug/stack.log`，**47 行**，五个服务全中）：

```
[relay:orchestrator] token refresh failed (expires 2026-09-06T05:37:20.967Z): RPC call failed: Forbidden
[relay:fulfillment]  token refresh failed (...): RPC call failed: Forbidden
...（每 10 分钟一条，持续到期前 2h）
[relay:orchestrator] rotation heartbeat: Service token expired and refresh failed.
```

`Forbidden` = Router `checkAccess` 的 -32604：`user.token.refresh` 既不在 `systemApi` 静态白名单里，
introspection 也没标 `public`，于是它跟普通业务方法一样要 permit。而
**`deploy/bot-permits.js`——自称「单一真源」、派生项目照抄的那份——9 个 bot 一个都没给这条**，
`deploy/scaffold/docs/authoring/events.md:40` 却用 🔴 写着「必须含」，依据正是 colony 2026-08-10 同款事故。
**教训进了文档，没进代码**；steward 的作者读的是代码那份。

为什么藏得住：dev 播种（`deploy/seed-bots.js`）与 e2e mesh（`e2e/harness/setup.js`）
require 的是同一份 BOT_PERMITS，但两者的栈都活不过一个 24h token 生命周期，**永远走不到轮转窗口**。

### 落地（v1.2.15）

- ✅ **`user.token.refresh` 标 `public: true`**（`core/user/handlers/introspection.js:180`）。
  它只能续调用者**自己**的 token——`tokenRefresh` 按 `callerUid` 取 bot，非 bot 拒、非 ACTIVE 拒，
  给不出任何横向权限；停用 bot 仍走 `suspend`/`revoke`（ACTIVE 闸在 `tokenRefresh` 内部，不在 permit 上）。
  **选它而不是「把权限图补齐」，是因为它对所有已存在的 bot 立即生效**：派生项目升 bundle 即修好，
  不必回去改各自那份手抄的权限图、也不必重新发一轮 token。
  同步登记进 `autocheck/static/public-surface-check.js` 的白名单（那道门当场拦住了这次改动，按设计）。
- ✅ **`deploy/bot-permits.js` 9 个 bot 仍显式补上 `user: ['user.token.refresh']`** + 头注说明
  「这是 infra 通道不是业务权限，别因为『这个服务又不调 user』就删」。冗余是故意的：照抄它的项目
  可能常年跑着更早的 bundle。
- ✅ **`deploy/scaffold/docs/authoring/events.md §0.5`** 补上「v1.2.15 起 Router 不再查这条，但仍照写」
  + **症状长什么样、去哪个日志文件搜**——这次的教训不是「不知道要配」，是「配漏了之后
  47 行报错摆在那里没人看」。
- ❌ 本文建议 1、2（定时续签 / 过期告警）不做：v1.1.17 已实现。

### 给派生项目的动作

跑着 ≤ v1.2.14 bundle 的栈**不会自动修好**，两条路二选一：① 升 bundle；
② 各自的 provision 脚本里给每个 bot 的 permit 加 `user: ['user.token.refresh']` 后重跑一次（幂等）。
判据现查：`grep "token refresh failed" api/debug/stack.log`。
