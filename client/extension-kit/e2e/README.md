# 真浏览器 E2E —— 把 sample 装进 Chrome 跑一遍

验的是**单元测试结构上够不到的那一层**：kit 在真 MV3 service worker 里是否真的跑起来、
队列是否真的落盘、worker 被回收后条目还在不在。

```bash
cd client/extension-kit/e2e
npm install
npx playwright install chromium      # 只需一次
npm test                             # 18 用例，约 22s
```

**不需要起 SOLO 栈。** 用例自带一个假 Router（`helpers/fake-router.js`）——见下。

## 为什么单元测试不够

`../tests/` 那 50 条用的是我自己写的替身：storage 是个 Map、worker 死亡是模拟的、
fetch 是注入的。模型和实现出自同一个脑子，所以它证明不了「我对 MV3 的理解是对的」。
这套才能。三条最值钱的：

| 用例 | 它守住什么 |
|---|---|
| `load.spec.js` 🔴 kit 在真 SW 里 import 成功 | **扩展根是封闭的树**——有人把 `sample/kit.js` 的 `./kit/` 改回 `../lib/`、或 `sync.sh` 坏了，这里当场红。而那个故障在浏览器里的表现是 **SW 注册成功、不报任何错、URL 看着正常，但模块从未求值** |
| `queue.spec.js` 🔴 SW 被回收后条目仍在 | queue 存在的**全部理由**。CDP 强杀 service worker → 从扩展页面读回持久状态 → 唤醒后照常送达 |
| `auth.spec.js` 会话失效自动重登 | 在真 `crypto.subtle` 上验挑战响应派生，并确认重放用的是**新** token |

## 假 Router 而不是真栈

`helpers/fake-router.js` 是个只会说 JSON-RPC 的小服务，换来三件事：

1. **无需 `deploy/run.sh`**，clone 完就能跑，CI 上也是；
2. **能精确编排错误码**（`-32005` 权限不足 / `-32001` 会话过期 / 限流），真栈很难稳定造出来；
3. **快**——真 Router 不可达时 `rpc.js` 会老实退避重试约 37 秒，一条用例就超时了。

## 🔴 三条实测出来的硬约束（改 `fixtures.js` 前先读）

2026-08-20 测于 playwright 1.62 / Chrome 141：

1. **必须 `channel: 'chromium'`。** 不加的话 headless 下 `waitForEvent('serviceworker')` 直接超时
   ——症状像扩展没装上，实际是装上了但那个 headless 通道不支持扩展。
2. **必须 `launchPersistentContext`。** 普通 `launch()` 装不了扩展。
3. **service worker 被杀之后，旧的 sw handle 上再 `evaluate()` 会永久挂住**（不是抛错，是挂住，
   只能靠超时发现）。所以杀过 SW 的用例一律改走**扩展页面**
   （`chrome.runtime.sendMessage` / `chrome.storage`），别再碰那个 handle。

## 重试只有一层（这套用例守着它）

队列的 `send` 用 `rpc.attempt` 而不是 `rpc.call`——**重试策略归队列**（它是持久的，扛得住
worker 被回收），rpc 只负责把这一次请求尽力发出去。用 `call` 的话两层退避会相乘：实测一个
条目跑满 6 次尝试要发 **36 次 fetch、耗时 135 秒**（改后 6 次 / 0 秒）。

`queue.spec.js` 里那条「🔴 限流不把端点打爆：一次 drain 只发一次请求」就是这条的回归守卫
——谁把 `attempt` 改回 `call`，它会看到 6 次调用和 22.5 秒。

⚠️ 写新用例时仍要注意：`-32029/-32006/-32007/-32099` 这四个码在 `rpc.call` 那层有退避，
拿它们测**交互式路径**会慢；测队列行为用别的码（如 `-32000`）。

## 还没做的

**契约层 e2e（打真 Router）**：验 `user.login.request` 还回不回 `salt`、`ingress.ingest`
还去不去重、`storage.asset.upload` 的 `maxLength` 还是不是 5242880。这类回归假 Router
结构上测不出来——它按我的理解回话，而要抓的正是「我的理解过时了」。
需要活栈，性质同仓库根的 `e2e/`。
