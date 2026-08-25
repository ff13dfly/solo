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
| `lib/messaging.js` | **扩展内部消息层**：通道瞬时错误的统一判据 + `sendToTab` / `callBackground` / `serveMessages` | steward 十天实战回流（见 §4.6） |
| **`sample/`** | **可直接 load unpacked 的最小扩展**：配 Router → 登录 → 采当前页 → 入队上报 | 新写（= `api/sample/`） |

全部零依赖、零构建。除 `messaging.js` 外全是 ESM，MV3 service worker 直接 `import`；
`messaging.js` 刻意是双形态的，因为它还要进 content script（见 §4.6）。
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

> 📖 **端到端高级配方**：如何结合 Fulfillment 状态机与 AI Agent 服务实现全自动网页 DOM 结构化提取？详见 [`docs/runbook/browser-extension-ai-extraction.md`](../../docs/runbook/browser-extension-ai-extraction.md)。

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

## 4.6 页面那一半：content script 与消息通道

`background.js` 之外的每一处消息，都该走 `lib/messaging.js`。它解决的是 MV3 里
**必然发生**、而不是偶发的两件事。

### ① 向 content script 发消息**必然会瞬时失败**

导航中、bfcache、service worker 刚被回收、新文档还没注入完——这些不是业务失败，是抖动。
Chrome 对这件事有**四种**措辞，其中最常见的一种**没有 `is`**：

| 实际错误文本 | 照着某次报错抄的正则 |
|---|---|
| `…but the message channel closed before a response was received` | ❌ 漏（无 `is`） |
| `The message port closed before a response was received.` | ❌ 漏（是 `port` 不是 `channel`） |
| `Could not establish connection. Receiving end does not exist.` | ✅ |
| `The page keeping the extension port is moved into back/forward cache` | ✅ |

🔴 **各项目自己写必然各漏各的**——你只见过你踩到的那一种。steward 2026-08-25 就漏了第一种：
一场 57 步的演示在第 5 步（导航后等元素）把一个本该被重试吃掉的抖动**升级成整场失败**，
而现场表现是"用户点了下浏览器的保存密码弹窗，演示就断了"，指向完全错误的方向。

```js
import { sendToTab, isTransientChannelError } from './kit.js';

// 瞬时错误自动退避重试；业务错误一次都不重试，直接抛回来
const res = await sendToTab(tab.id, { type: 'READ_PAGE' }, {
    retries: 3,                       // 重试次数要配得上"你有多需要这个答案"
    ensureInjected: (id) => chrome.scripting.executeScript({ target: { tabId: id }, files: [...] }),
});
```

⚠️ `Extension context invalidated` **刻意不算**瞬时——那是扩展被重载、页面上的旧
content script 已经死了，重试只是白等几轮退避再报同一个错。

### ② service worker 空闲即被回收，冷启动那一发 `sendMessage` 会 reject

裸调让异常冒泡出去，把**后面整段 UI 代码**带走，症状是"点了没反应、也没有报错"。
所以页面侧（popup / options / content script）一律用 `callBackground`，它**永不抛**：

```js
const r = await callBackground('AUTH_STATE');
if (!r.ok) return say(r.error, true);
```

background 那一侧与它成对：

```js
chrome.runtime.onMessage.addListener(serveMessages(handlers));
```

🔴 `serveMessages` 替你守住 **`return true`**。MV3 里监听器同步返回假值 = 通道当场关闭，
而对面收到的**恰恰就是** `The message port closed…`——一个自己造出来的"瞬时错误"，
重试永远修不好。手写这段的人漏掉它是常态。

### 🔴 `messaging.js` 是 kit 里唯一不用 import/export 的文件

Chrome 的 content script 是 **classic script**，不是 module——写一个 `export` 就是
`SyntaxError`，而它的表现是**整节注入静默作废**：页面上什么都不会发生，
`chrome://extensions` 也不报错。而一个不含 import/export 的文件在两种上下文里都能求值
（2026-08-26 实测），所以同一份文件两边共用：

| 用在哪 | 怎么拿到 |
|---|---|
| service worker / popup（module） | 经 `kit.js` 具名 import |
| content script（classic） | manifest 的 `js` 数组里排在使用者**前面**，读 `self.SoloMessaging` |

### 顺序注入 + 全局共享：content script 的事实标准

content script 用不了 `import`，所以多文件组织的通行做法是 **manifest 的 `js` 数组顺序注入
+ `self.Xxx` 全局挂载**（wavely 与 steward 各自独立收敛到同一形态）。sample 的 `content/`
就是最小示范。这个契约有两个失效点，**编译器一个都看不见**：

1. **把某个文件从 manifest 摘掉，别处对它那个全局的引用不报错，而是运行时炸。**
   steward 因此踩了两次——一处让面板**永不出现**，一处炸
   `Cannot read properties of undefined (reading 'id')`，而后者的错误文案还写着
   "多半是页面改版，选择器要核对"，把人指向完全错误的方向。
2. **顺序排反**：提供者在使用者后面。同样只有运行时 undefined。

两者都是**纯静态可查**的，所以别拿真机去排查：

```bash
node client/extension-kit/lint-injection.js <你的扩展目录>
```

它交叉检查 manifest 各节的 `js` 注入清单 ↔ 代码里的 `self.<全局>` 引用（顺序也管），
顺带核对清单里的文件是否真的存在。行尾写 `// solo-lint-ignore <全局名>` 可豁免
（`chrome.scripting.executeScript` 动态注入的那种）。

### ⚠️ 通配 `matches` 会污染你不想污染的页面

match pattern **表达不了端口**，所以 `http://localhost/*` 命中的是**本机所有端口**——
包括你自己的开发前端和**回归基准页**。steward 因此把一轮回归从 9/9 打到 6/9，
且结果不稳定（重跑变 0/4）；两节的 `js` 列表逐字相同、肉眼完全看不出来，
最后是 `git worktree` 拉 HEAD 做对照二分才锁定的。lint 会对这类 pattern 出忠告。

---

## 4.7 长大之后怎么拆（sample 是起点，不是终局）

`sample/background.js` 是 164 行、平铺一个 `handlers` 对象——**在那个尺寸上这是对的形态**，
所以 sample 刻意不拆。但真实项目会长：steward 的插件到 2026-08-26 有 **48 个 handler**，
`background.js` 一度 **1712 行**（handlers 一个对象就占 768 行）。

**先澄清一个普遍误解**：MV3 对 service worker **没有文件大小限制**，manifest 声明
`"type": "module"` 后 ESM `import` 完全可用。"不能拆"从来不是约束——但因为示例只有平铺形态，
项目很容易一路平铺到失控才想起来拆。

steward 拆成四组（`conn` 152 行 / `action` 95 / `collect` 362 / `show` 450），拆完主文件 927 行。
三条纪律：

1. **按业务轴分组，不按文件大小。**
2. **handlers 之间不许互相 import。** 共享的下沉 `lib/`，或由装配层注入——否则拆完变成一张网，
   比一个大文件更难改。
3. **跨组调用走延迟取值**（`serveMessages(null, { getHandlers: () => table })`）。
   工厂里直接持有会拿到 `undefined`——那时另一组还没装配完。

### 🔴 拆分时那个静默的坑：模块级 `let` 状态

主文件里的 `let deepRun = null` 被 handler 直接赋值，拆出去之后有**两种**结局，
`node --check` 对两种都一个字不报（它按 CJS 解析，2026-08-26 实测 `exit 0`）：

| 写法 | 结果 |
|---|---|
| handler 里 `import { deepRun }` 然后赋值 | **运行时** `TypeError: Assignment to constant variable`——import 绑定是只读的 |
| 拆的时候顺手在各模块各留一份 `let deepRun = null` | **完全静默**：handler 改的是自己那份，主文件读到的永远是初值 |

第二种才是真正难查的：症状是「状态永远不动、互斥判断永远放行」，没有任何报错。
**解法是改成共享对象传引用**：

```js
const runState = { deep: null, gen: null };     // 传 runState，改 runState.deep
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

102 用例 / 7 套（2026-08-26 实跑 ~2.5s）。独立 config，**不并进 `api/jest.ci.config.js`**：
kit 是 ESM，而 ESM 要 `--experimental-vm-modules`；为它给 127 套既有 CJS 用例都挂上实验标志不划算。
CI 的 `static` job 里有一步跑它（连同下面的 lint），用的就是上面那条 `PATH=` 命令。

### 注入清单交叉检查

```bash
node client/extension-kit/lint-injection.js <你的扩展目录>
```

manifest 各节的 `js` 注入清单 ↔ 代码里的 `self.<全局>` 引用（含顺序），见 §4.6。
**这类问题纯静态可查，别拿真机去排查。** 退出码：有不一致 = 1，只有忠告 = 0。

### 真浏览器 E2E

```bash
cd client/extension-kit/e2e && npm install && npx playwright install chromium && npm test
```

24 用例，约 18s，**不需要起 SOLO 栈**（自带假 Router）。验的是单元测试结构上够不到的那层：
kit 在真 MV3 service worker 里是否真的跑起来、队列是否真的落盘、**worker 被回收后条目还在不在**、
**`messaging.js` 的 classic script 形态是否真的注入进了 content script**（jest 里怎么跑都是
module 上下文，结构上够不到）。它同时是「扩展根是封闭的树」那个坑的回归守卫——
见 [`e2e/README.md`](./e2e/README.md)。**必须串行跑**，理由在那份 README 里。

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
