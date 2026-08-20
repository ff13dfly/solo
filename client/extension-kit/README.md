# Extension Kit — 浏览器插件的框架侧半边

> **[Solo] 所有，`upgrade.sh` 整目录覆盖。** 别在这里写站点逻辑——改动下次升级就没了。
> 你自己的扩展（manifest、popup、站点 adapter、DOM 选择器）放 **`client/extension/`**，那边永不被覆盖。
> 起步：`cp -r sample/* ../extension/`，然后只改 `kit.js` 一行路径（见 [`sample/README.md`](./sample/README.md)）。
>
> 🔴 **别跟 `client/plugin/` 搞混**——那是**桌面客户端**的 React 视图插件
> （`{id, name, icon, entry: "View.tsx"}`，由 `client/desktop` 以 `@plugins/…` import），
> 与浏览器扩展毫无关系。早期脚手架文档没写清楚，已有派生项目把 MV3 扩展放进了 `plugin/`。

---

## 1. 为什么有这个目录

三个派生项目各自手搓了一个 MV3 插件，其中两个的传输层是**同一个文件**：

| | 位置 | 用途 |
|---|---|---|
| **wavely** | `erp/client/plugin/` v1.2.9 | 1688 商品页采集 → `catalog`/`supply` |
| **steward** | `client/plugin/` | 领工单 → 在店铺后台执行 → 回报 |
| **trend** | `collector/extension/` | YouTube/Instagram/1688 采集 → `ingress.ingest` |

（三家的落点各不相同，正是因为脚手架此前只有一个含义模糊的空 `client/plugin/` 占位符。）

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
| **浏览器扩展** | **`client/extension-kit/`**（本目录，含 `lib/` + `sample/`） | **`client/extension/`**（其中 `kit/` 子目录例外，见下） |

目录形态刻意对齐 `api/`：`lib/` 之于 `api/library/`，`sample/` 之于 `api/sample/`。
（`client/plugin/` 不在这张表里——它是桌面客户端插件，见顶部 🔴。）

### 🔴 kit 是**复制进**扩展的，不是被 import 出去的

Chrome 扩展的根目录是一棵**封闭的树**：`import '../../extension-kit/lib/rpc.js'` 越过扩展根
**加载不到**。而它的失败形态是这套东西里最坏的一种——**service worker 注册得起来、
chrome://extensions 不报错、SW 的 URL 看着完全正常，但模块从未求值，所有调用石沉大海**
（2026-08-20 实测，playwright 里表现为 `sw.evaluate()` 永久挂住）。

所以每个扩展根内部都要有一份 kit：

```bash
bash client/extension-kit/sync.sh <你的扩展目录>     # lib/ → <目录>/kit/
```

`upgrade.sh` 会自动对 `client/extension/`（当它有 `manifest.json` 时）做这件事，
所以框架修复照样随升级到达；**只有 `kit/` 这个子目录被覆盖**，你的其余文件永不被动。
`sample/kit/` 已 gitignore——本仓库里跑一次 `sync.sh sample` 即可。

考虑过软链（实测 Chrome 确实跟随），**没有采用**：它在 Windows / `zip -y` / 商店打包下会断，
而断掉的症状正是上面那个"起得来但完全不工作、不报错"。复制的失败形态是"kit 旧了"，
看得见、查得出——按仓库一贯的判据，选失败会响的那个。

🔴 **这条边界必须一开始就对。** `portal/operator/` 就是反例：它 scaffold 时拷一次、
`upgrade.sh` 永不覆盖，于是 SOLO 侧每一处前端修复都要各项目手工回填（v1.1.17 的下游
action 第 ② 条就是在还这笔债）。本 kit 从第一版起就在覆盖清单里。

---

## 3. 模块

| 文件 | 干什么 | 来历 |
|---|---|---|
| `lib/rpc.js` | Router JSON-RPC 客户端：网络层失败归一化、退避重试、会话失效重登；`call`（交互式）/ `attempt`（给队列） | wavely（源头）+ steward 的 🔴 合并 |
| `lib/queue.js` | **持久化发送队列，熬过 MV3 休眠** | 新写——三家一个都没有 |
| `lib/image.js` | 图片抓取 → `storage.asset.upload` 载荷（分块 base64 + 逐级降质） | wavely 独有，抬进框架 |
| `lib/endpoints.js` | Router 地址单一真源 | wavely + steward 合并 |
| `lib/session.js` | token 存哪一层、凭据怎么留 | 抽自两家的 `auth.js` |
| `lib/storage.js` | `chrome.storage` 适配 + 串行化读改写 | 新写（为了可测 + 防并发覆盖） |
| **`sample/`** | **可直接 load unpacked 的最小扩展**：配 Router → 登录 → 采当前页 → 入队上报 | 新写（= `api/sample/`） |

全部 ESM、零依赖、零构建——MV3 service worker 直接 `import`。
`sample/` 同时是三样东西：§4 那段接法的**可执行版**、E2E 的 fixture、你自己扩展的起点。

---

## 4. 最小接法

```js
// client/extension/background.js   ← 你的项目自己的文件（抄 sample/ 改的）
// 前提：已跑过 bash ../extension-kit/sync.sh .  （kit 必须在扩展根内部，见 §2）
// kit 路径只出现在 kit.js 这一处（抄 sample 的做法），复制到别处时只改那一行
import {
    createRpc, createPasswordAuth, createQueue, createSession, createEndpoints, chromeArea,
} from './kit.js';

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

## 4.5 `call` 还是 `attempt` —— 重试只能有一层

判据一句话：**调用方自己有没有重试机制。有就用 `attempt`，没有才用 `call`。**

| | `call` | `attempt` |
|---|---|---|
| 给谁 | 交互式调用（有人在等结果） | 自带重试的调用方（**队列**） |
| 瞬态错误 | 退避重试 5 轮 | 不重试，直接交回调用方 |
| 网络层抖动 | 快速重试 2 次 | **同样快速重试 2 次**（抖动时端点并没在限流） |
| 会话失效 | reauth + 重放 | **同样 reauth + 重放**（否则 token 一过期，队列里每条都白撞一轮） |

🔴 **两层退避会相乘**，这是实测出来的（2026-08-20，`lib/rpc.js` 的 `attempt` 注释里有原始数字）：

| 一个条目跑满队列的 6 次尝试 | 耗时 | 实际 fetch |
|---|---|---|
| `send: rpc.call`（错） | **135 秒** | **36 次** |
| `send: rpc.attempt`（对） | 0 秒 | 6 次 |

135 秒全程占着 service worker——而 MV3 的 worker 本来就朝不保夕，`drain()` 期间整条队列还被它堵着。
更糟的是那 36 次多数打在一个**已经在限流**的端点上，只会让限流档位更深
（跨项目通则：「限流是分档加深的，打得越多限得越深、恢复越慢」）。

退避档是 **5s → 20s → 80s → 5.3m → 16m（封顶）**，总窗口约 23 分钟。第一档压到 5 秒，是因为
失败现在会瞬间落到队列（不再被 rpc 吃掉 22 秒），而人点一下「采集」走的是同一条路——
一次网络抖动不该让他静默等半分钟。

队列还会**尊重服务端下发的 `retry_after`**（Router 的 `-32029` 带 `data.retry_after`，单位秒）：
服务端知道自己的窗口，本地那张固定退避表只是猜。下限 1 秒、上限 1 小时。

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
| steward | `lib/rpc.js` `lib/endpoints.js` `lib/auth.js` | 本 kit；`platforms/` 原样保留 |
| trend | `background.js` 里的 `pushToIngress` / `generateRequestId` | 本 kit；**顺带获得它现在完全没有的队列**——那个串行 `for` 循环目前一睡就永久丢数据 |

迁移时顺带把扩展从 `client/plugin/` 挪到 `client/extension/`（前者是桌面插件的位置，
当初放错了）；`upgrade.sh` 对两者都不碰，挪不挪都不影响升级，只是名正言顺。

`createRpc` 相对两个原版**只有一处行为变化**：重登钩子从写死的
`getCredentials() → login(name, password)` 改成可注入的 `reauth`。
要保持原样，用 `createPasswordAuth()`（见 §4），行为逐字等价。

---

## 7. 测试

```bash
# SOLO 仓库里（用仓库自己那份 jest，结果确定，不依赖 npx 缓存）
cd client/extension-kit && PATH="$PWD/../../api/node_modules/.bin:$PATH" npm test

# 派生项目里（需要环境中有可解析的 jest）
cd client/extension-kit && npm test
```

50 用例 / 5 套。独立 config，**不并进 `api/jest.ci.config.js`**：kit 是 ESM，而 ESM 要
`--experimental-vm-modules`；为它给 127 套既有 CJS 用例都挂上实验标志不划算。

### 真浏览器 E2E

```bash
cd client/extension-kit/e2e && npm install && npx playwright install chromium && npm test
```

18 用例，约 22s，**不需要起 SOLO 栈**（自带假 Router）。验的是单元测试结构上够不到的那层：
kit 在真 MV3 service worker 里是否真的跑起来、队列是否真的落盘、**worker 被回收后条目还在不在**。
它同时是「扩展根是封闭的树」那个坑的回归守卫——见 [`e2e/README.md`](./e2e/README.md)。

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
- **adapter 契约**（steward `platforms/contract.js` 那套：`detect`/`read`/`execute` +
  `needs_human` 一等结局 + 注册前校验）。它只有一个实例，抽象是否成立要等第二个平台来验
  ——steward 自己也把这当判据（"接第二个平台花的时间 ≈ 第一个的 30% 则抽象是真的"）。
