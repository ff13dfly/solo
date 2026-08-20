# Extension Kit — 浏览器插件的框架侧半边

> **[Solo] 所有，`upgrade.sh` 整目录覆盖。** 别在这里写站点逻辑——改动下次升级就没了。
> 你自己的插件（manifest、popup、站点 adapter、DOM 选择器）放 **`client/plugin/`**，那边永不被覆盖。

---

## 1. 为什么有这个目录

三个派生项目各自手搓了一个 MV3 插件，其中两个的传输层是**同一个文件**：

| | 位置 | 用途 |
|---|---|---|
| **wavely** | `erp/client/plugin/` v1.2.9 | 1688 商品页采集 → `catalog`/`supply` |
| **steward** | `client/plugin/` | 领工单 → 在店铺后台执行 → 回报 |
| **trend** | `collector/extension/` | YouTube/Instagram/1688 采集 → `ingress.ingest` |

`wavely/lib/rpc.js` 与 `steward/lib/rpc.js` 逐行 diff：**逻辑差异 0 处**，实质差异只有
`deviceId` 一个字符串，其余全是注释。`lib/endpoints.js`、`mock/serve.sh` 同样是复制品。

更麻烦的是**修复不回流**：steward 的 `endpoints.js` 里记着一条 🔴——"wavely 踩过默认值
漂移的坑，症状是登录成功但什么都读不到"——**而 wavely 自己的文件里没有这条**。
抄的人拿到了教训，被抄的人还在原地。这正是 `api/library/` 存在的理由，只是换到了客户端。

---

## 2. 边界（照抄 `api/` 已经跑通的那条）

| | 框架侧（升级整目录覆盖） | 项目侧（永不覆盖） |
|---|---|---|
| 服务 | `api/library/` `api/sample/` `api/autocheck/` | `api/apps/` |
| **插件** | **`client/extension/`**（本目录） | **`client/plugin/`** |

🔴 **这条边界必须一开始就对。** `portal/operator/` 就是反例：它 scaffold 时拷一次、
`upgrade.sh` 永不覆盖，于是 SOLO 侧每一处前端修复都要各项目手工回填（v1.1.17 的下游
action 第 ② 条就是在还这笔债）。本 kit 从第一版起就在覆盖清单里。

---

## 3. 模块

| 文件 | 干什么 | 来历 |
|---|---|---|
| `lib/rpc.js` | Router JSON-RPC 客户端：网络层失败归一化、退避重试、会话失效重登 | wavely（源头）+ steward 的 🔴 合并 |
| `lib/queue.js` | **持久化发送队列，熬过 MV3 休眠** | 新写——三家一个都没有 |
| `lib/image.js` | 图片抓取 → `storage.asset.upload` 载荷（分块 base64 + 逐级降质） | wavely 独有，抬进框架 |
| `lib/endpoints.js` | Router 地址单一真源 | wavely + steward 合并 |
| `lib/session.js` | token 存哪一层、凭据怎么留 | 抽自两家的 `auth.js` |
| `lib/storage.js` | `chrome.storage` 适配 + 串行化读改写 | 新写（为了可测 + 防并发覆盖） |

全部 ESM、零依赖、零构建——MV3 service worker 直接 `import`。

---

## 4. 最小接法

```js
// client/plugin/background.js   ← 你的项目自己的文件
import { createRpc, createPasswordAuth } from '../extension/lib/rpc.js';
import { createQueue }    from '../extension/lib/queue.js';
import { createSession }  from '../extension/lib/session.js';
import { createEndpoints } from '../extension/lib/endpoints.js';
import { chromeArea }     from '../extension/lib/storage.js';

const local   = chromeArea('local');
const session = createSession({ local, session: chromeArea('session') });
const eps     = createEndpoints({ backend: local, presets: [
    { url: 'https://your-router.example.com/rpc/', name: '线上' },
    { url: 'http://localhost:8440/jsonrpc',        name: '本地全栈' },
]});

const rpc = createRpc({
    getEndpoint: eps.get,
    getToken:    session.getToken,
    setToken:    session.setToken,
    reauth:      () => reauth(),          // 见下
});
const reauth = createPasswordAuth({
    rpc, deviceId: 'yourproject-ext',
    getCredentials:   session.getCredentials,
    clearCredentials: session.clearCredentials,
});

const queue = createQueue({
    backend: local,
    send: (item) => rpc.call(item.method, item.params),
    scheduleWake: (ms) => chrome.alarms.create('solo-queue', { when: Date.now() + ms }),
});
chrome.alarms.onAlarm.addListener(() => queue.drain());
chrome.runtime.onStartup.addListener(() => queue.drain());   // 冷启动补投上次没送完的
```

采到数据之后**入队，不要直接发**：

```js
await queue.enqueue({
    method: 'ingress.ingest',
    params: { request_id: id, data },
    idemKey: id,                 // 必填
});
await queue.drain();
```

---

## 5. 投递语义（用之前必须知道）

**at-least-once。去重是服务端的事。**

条目**只有在确认成功之后才出队**，所以 worker 死在"已发出、还没出队"之间会**再发一次**。
这是刻意的取舍：宁可重发，不可丢——因为丢是静默的，重发不是。

因此 `idemKey` 必填，没有直接抛。它对应服务端已有的两道幂等闸：

- `ingress.ingest` 的 `(source, request_id)`
- 实体的业务唯一键

⚠️ **没有服务端幂等的方法，别放进队列。** 这跟 `rpc.js` 里"自动重试对非幂等方法危险"
是同一条纪律的两处落点。

溢出、永久失败（`-32005` 权限不足等）、重试用尽——**一律进死信，不静默丢**。
`queue.listDead()` 看，`queue.retryDead()` 修完权限后重投。

---

## 6. 迁移（三家各自怎么换）

| 项目 | 删掉 | 换成 |
|---|---|---|
| wavely | `lib/rpc.js` `lib/endpoints.js` `lib/image.js` `lib/auth.js` | 本 kit；`stripCdnResize` 作为 `normalizeUrl` 传给 `fetchAsUploadPayload` |
| steward | `lib/rpc.js` `lib/endpoints.js` `lib/auth.js` | 本 kit；`platforms/` 原样留在 `client/plugin/` |
| trend | `background.js` 里的 `pushToIngress` / `generateRequestId` | 本 kit；**顺带获得它现在完全没有的队列**——那个串行 `for` 循环目前一睡就永久丢数据 |

`createRpc` 相对两个原版**只有一处行为变化**：重登钩子从写死的
`getCredentials() → login(name, password)` 改成可注入的 `reauth`。
要保持原样，用 `createPasswordAuth()`（见 §4），行为逐字等价。

---

## 7. 测试

```bash
# SOLO 仓库里（用仓库自己那份 jest，结果确定，不依赖 npx 缓存）
cd client/extension && PATH="$PWD/../../api/node_modules/.bin:$PATH" npm test

# 派生项目里（需要环境中有可解析的 jest）
cd client/extension && npm test
```

50 用例 / 5 套。独立 config，**不并进 `api/jest.ci.config.js`**：kit 是 ESM，而 ESM 要
`--experimental-vm-modules`；为它给 127 套既有 CJS 用例都挂上实验标志不划算。

⚠️ **`node --check` 查不出这里的语法错。** 它按 CJS 解析，`async` 回调里漏写 `async`
这类错误会一路放行到 jest 才炸成 "Test suite failed to run"。要单独验语法用
`node --experimental-vm-modules -e "import('./lib/queue.js')"`。

---

## 8. 还没做的（有意留白）

- **passport 设备线**。三家都在用内部员工账号 + **明文密码存 `chrome.storage.local`**
  才能自动重登，而 `user.passport.device.issue` → `verify`（设备令牌换 24h 会话、可按人
  吊销、`$owner` 自动行隔离）本来就是为外部客户端设计的——实扫三家对 `user.passport.*`
  的引用数是 **0**。不是选错了，是没人知道这条路。`session.js` 的凭据已抽象成不透明对象，
  迁过去不用改本 kit。
- **schema / 枚举下发**。`ingress` 的 `dataSchema` 现在只在服务端**拒绝**，客户端看不见；
  wavely 的 `COLORWAY_MAP` 更是把 catalog 的枚举抄了一份在插件里，服务端加一个色值它就
  静默旧了。要新增 RPC 方法，而方法一旦发布就撤不回来（runbook §5），等第二个实例出现、
  形状清楚了再定。
- **manifest / popup 骨架**。三家的 manifest 差异主要在 `host_permissions` 与
  `content_scripts`，都是站点知识；抽骨架的收益还没验证过。
