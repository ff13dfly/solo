# deploy/mock — ingress 模拟工具包（DEV ONLY，不进发行包）

模拟"外部 sources → ingress → 事件链"。两个部件：

| 文件 | 作用 |
|------|------|
| `listener.js` | 通用 mock listener（一个进程 = 一个源）：收 JSON → 按 `sha256(request_id)` 归档原始请求 → 归一化成 `{request_id,data}` → 经 Router 调 `ingress.ingest` |
| `start.sh` | **一键启动器**：读 `keys.env`，每个源起一个 listener（自动分端口 + 写 `.ports` 供 simulate 自动路由 + Ctrl+C 一起清理） |
| `simulate.js` | 把 `samples/<源>.json` 发进链路；默认过 listener（按 `.ports` 自动路由到对的端口），`--direct` 直打 Router |
| `samples/` | 各源外部样本载荷（**drop-in 加源**：放一个 `<源>.json` 就多一个源） |
| `keys.env.example` | 各源 key 模板（拷成 `keys.env`，已 gitignore）；`start.sh` 和 `--direct` 都读它 |
| `workflows/` + `inject-workflows.js` | **完整 event 链测试**：把"AI 自建的" mock workflow 直接注入 Redis（待审核态），打通 ingress→collection→market→notification 整条多跳链（见下方 §完整链测试） |

## 前置

1. 起全栈（含 ingress + SSL 代理）：`bash deploy/dev.sh --ssl`
2. Portal → Service Management 加 `http://localhost:8070`
3. Portal → Bot Accounts 建 `system.ingress` → 注入 token
4. Portal → Ingress → **+ NEW SOURCE**，名字用 `github` / `stripe` / `order`（对上 `samples/`），复制一次性 API key

## 用法

### 模式 A：过 listener（真实链路，含原始归档）

把各源 key 填进 `keys.env`（`SRC_github=ingk_...`），**一键起全部 listener**：
```bash
bash deploy/mock/start.sh        # 每源一个 listener,自动分端口,Ctrl+C 一起停
```
另开一个 shell 发样本（按 `.ports` 自动路由到对的 listener）：
```bash
node deploy/mock/simulate.js github                  # 发 samples/github.json
node deploy/mock/simulate.js github --id fixed-1 -n 3 # 1 accepted + 2 duplicate（验去重）
```

> 只起单个源也行：`INGRESS_API_KEY=<key> SOURCE_NAME=github bash deploy/mock.sh`

### 模式 B：`--direct`（多源方便，直打 Router，跳过 listener）

把各源 key 填进 `keys.env`（`SRC_github=ingk_...`），然后：
```bash
node deploy/mock/simulate.js github --direct
node deploy/mock/simulate.js stripe --direct
node deploy/mock/simulate.js order  --direct -n 5
```
一条命令模拟任意源，不用起 listener 进程。

## 看结果

- Portal → **Ingress → DELIVERIES**：每条投递的 source / request_id / outcome / status。
- 事件落流：`redis-cli -p 6699 XREVRANGE EVENT:WEBHOOK:GITHUB + - COUNT 1`
- 原始请求归档（仅模式 A）：`logs/listener-github/{sha256(request_id)}.json`
- 投递审计：`logs/ingress/{年}/{日}.jsonl`

## 加一个新源

1. `deploy/mock/samples/<名>.json` 放样本载荷
2. Portal → Ingress 建同名源，拿 key
3. 模式 A 起 listener，或模式 B 填 `keys.env` 后 `--direct`

---

## 完整 event 链测试（mock workflows，注入 Redis）

`workflows/*.json` 是 5 个串起整条链的 mock workflow。`inject-workflows.js` 把它们**直接写进 Redis**（绕过 admin-gated 的 create RPC），状态置 **PENDING_REVIEW**——模拟"以后 AI 自己创建 workflow 之后、待人审核"的状态。同时写**事件注册表覆盖**（`SYSTEM:CONFIG:EVENT_REGISTRY` = 框架默认 + collection/market），让两个夹具的 `_event` 过白名单。**不改框架配置**。

### 链路（5 个 workflow，跨 ingress + collection + market + notification[系统服务]）

```
simulate stripe → EVENT:WEBHOOK:STRIPE
  → wf-record-payment   → collection.payment.record → EVENT:PAYMENT:RECEIVED
  → wf-settle-payment   → collection.payment.settle → EVENT:PAYMENT:SETTLED
  → wf-create-shipment  → market.shipment.create    → EVENT:SHIPMENT:CREATED
  → wf-ship             → market.shipment.ship      → EVENT:SHIPMENT:SHIPPED
  → wf-notify-shipped   → notification.send (系统服务，闭环)
```

### 步骤

```bash
bash deploy/dev.sh --ssl                    # 全栈(含 ingress/collection/market) + RedisJSON
node deploy/mock/inject-workflows.js        # 注入 5 个 PENDING_REVIEW + 注册表覆盖
```
然后在 Portal → **Workflows**：每个 workflow **APPROVE**（审核人需 ≠ `ai-agent`）→ 翻成 ACTIVE（matcher 只触发 ACTIVE）。配好 stripe 源 + key 后触发：
```bash
node deploy/mock/simulate.js stripe --direct
```
观测：**Event Bus → Runs**（5 个 workflow 依次跑）、`redis XREVRANGE EVENT:SHIPMENT:SHIPPED + - COUNT 1`、`market.shipment.list` / `collection.payment.list`。

### 选项

```bash
node deploy/mock/inject-workflows.js --active   # 直接注入 ACTIVE(跳过审核,立即可触发)
node deploy/mock/inject-workflows.js --clean    # 删除这 5 个 + 注册表覆盖(只删夹具,不碰其它 workflow)
```

### 前置/注意

- **RedisJSON 必需**：workflow 是 RedisJSON doc，dev.sh 用 redis-stack（6699）才有；纯 redis-server 会 `JSON.SET` 报错。
- **执行身份 + H6**：matcher 触发后，workflow 跑在 `system.orchestrator` bot permit 下（不是用户）。bot permit 须覆盖 `collection.payment.record` / `market.shipment.create` / `notification.send` 等，否则进**人在环**（`PAUSED_AWAITING_HUMAN`，在 Event Bus → Runs 里 GRANT 放行）——这本身也是值得测的一环。
- **改了源/链路**：workflow 的 `$input.*` 路径要对上事件 payload 形状（见各 json 的 `desc`；record-payment 因 stripe 样本嵌套，用 `$input.data.data.object.*`）。

---

## E2E 测试（测试用户 + permit 杠杆 + 跑 workflow）

`e2e.js` 针对 **sync 路径**（`orchestrator.workflow.run`，callerUid = 调用用户，H6 查**该用户的 permit**）——这正是"建测试用户 + 调 permit + 跑 workflow"的落点。它对**运行中的 dev 栈**做端到端断言：

```
1. 注入测试用户(最小 permit) + session + admin session       (直接写 Redis)
2. 注册 collection 到 Router(system.service.add) + 注入一个 ACTIVE sync workflow
   (steps: collection.payment.record → collection.payment.settle,$step 串联)
3. 以测试用户跑 → 期望【被挡】(H6 footprint 预审:permit 缺 collection)
4. 在 Redis 把用户 permit 调成 services.collection=['*'] → 再跑 → 期望【成功】
5. 验证副作用:该订单的 payment 存在且 state=SETTLED
```

```bash
bash deploy/dev.sh                 # 起栈(Router 8600 + orchestrator + user + collection)
node deploy/mock/e2e.js            # 跑 E2E,报 pass/fail(自动清理;--keep 保留)
```

> **修了一个真 bug**（`orchestrator/logic/runner.js`）：H6 footprint 预审把 `user.permit.get` 的返回 `{uid, permit}` 直接当 permit 用（没取 `.permit`），导致对**真实 user 服务**永远判"缺权"——**任何 H6 把关的 workflow 运行(sync 或 event)在修复前都跑不通**。已改为解包 `.permit`（兼容单测的 bare permit），H6 单测 + CI 全绿。这正是 E2E 暴露的价值。

- **redis 直调 permit**：用户 permit 存 `user:{uid}.permit`（`{allow_all, services:{svc:[全名method或'*']}}`）；改它即调权限（H6 与 Router 鉴权都读这里）。
- **uid 须 16 位 Base58**：脚本用 `library/generator` 的 `generateId(16)` 生成,过 `validateId`。
- **事件链(bot permit)是另一半**：event 触发的 workflow 跑在 `system.orchestrator` bot 下（非用户）；那条用 `inject-workflows.js --active` + `simulate.js` 测，需把 bot permit 配全（见上方"前置/注意"）。
