# notification 服务任务配方

> 由 fleet-standard `guide` 方法下发（经 Router：`system.guide { service: "notification" }`）。
> 与服务代码同目录、同 commit 更新。方法签名与参数约束以 `methods` 自省为准，
> 本文只讲自省说不出的**任务流程与语义**。

## 这是什么

系统通知的**存储 + Inbox + 投递路由**引擎。`notification.send` 把消息落库并写进
收件人的 Inbox，后台 worker 再按投递规则异步触达（email / sms / webhook 经 gateway），
自带退避重试 + 死信队列。事务性消息（OTP、验证码等实时且无需存档的）**不走这里**，
业务服务直连 gateway。

## 配方一：可靠地发一条系统通知

1. `notification.send { targetId, type, payload, ref? }`
   - `targetId`：收件人（uid 或 agent_id），也是 Inbox 的寻址键。
   - `type`：**实际必填**——缺了会报错，尽管自省签名没标 `required`。语义化命名
     （`workflow.completed` / `system.alert` / `custom` …），delivery 规则按它匹配。
   - `payload`：调用方自定义消息体。
2. 返回 `{ id, status, queued }`：`queued` = 匹配到的投递通道数；`0` = 只落了 Inbox
   （无匹配规则或规则为 `none`）。

**幂等性（重要）**：只有传了 `ref` 才去重。同 `(targetId, ref)` 在 `dedupTtlSec`
（默认 **24h**）内重复 send 只建一条消息，直接返回既有 `id` + `status:'duplicate'`
+ `queued:0`。批量灌消息 / 重试链路**务必带上稳定 ref**（如来源事件 id、workflow id），
中断后可整批重跑。不传 ref = 每次都新建一条，无法去重。

## 配方二：收件人拉取并确认自己的 Inbox（模式 C，当前唯一端到端可用）

1. `notification.inbox.list { targetId, unreadOnly?, page?, pageSize? }` → `{ items, total }`
   - 默认 `unreadOnly:true`、未读优先、`pageSize` 默认 20。
2. 处理完调 `notification.inbox.ack { ids }` 把这些标为已读（`status` unread→read）。
   ack 幂等，已读的自动跳过。

消息只有 `unread` / `read` 两态，**没有删除、无软删**——处理过就 ack，别指望能删掉。

## 配方三：配置投递通道（把通知推到 Inbox 之外）

1. `notification.config.set { targetId, rules }`，`rules = [{ type, channel, params }]`。
   `type` 用 `'*'` 匹配全部类型；`channel ∈ email | sms | webhook | none`。
2. **依赖顺序**：先 `config.set` 定规则，之后该 `targetId` 的 send 才会入投递队列；
   已发的旧消息不追溯。
3. **现实约束**（别当已送达）：
   - email/sms 未配 gateway 凭证时 worker 落到 mock（`provider:'mock'`），记为
     `mocked`——不是真投递。
   - webhook 规则要求 `params.url`（http/https）；但 `gateway.webhook.send` 尚未实现，
     **配得上投不出 → 进死信**。
   - 无出站地址（用户 profile 没 email/phone 且 params 没给）→ **降级为 Inbox**，不算失败。
   - 要"确定送到"，Inbox 轮询（配方二）才是可靠路径。

> `config.set/get` 在自省里 `ai:false`（不对 AI 广告）；死信与 relay token 系列是管理员方法。

## 坑与约定

- **时间字段是 epoch 毫秒数字**（`createdAt` / `readAt` = `Date.now()`），不是 ISO 字符串——
  别按字符串解析。
- `ref` 一字段两用：既是关联资源 id（溯源）也是幂等键；`sourceId` 是发件人 id，
  `targetId` 是收件人，三者别混。
- 投递失败分两类：**永久失败**（方法不存在 / 参数错 / 权限 / 4xx 非 408·429）直接进死信；
  其余按**指数退避**（base 5s，每次翻倍，上限 5min）重试，最多 5 次后才进死信。
- 死信是管理面：`notification.deadletter.list / requeue`（管理员）；单条 requeue 上限 3 次，
  超了留人工，不再自动重烧。
- `channel` 白名单外的值会被 `config.set` 拒绝；`sse` 会被显式拒绝（未实现）。
- 本服务满足不了你的任务时，把缺口提到 `system.report`（用法见 Router guide），
  不要静默放弃或绕野路子。
