# 反馈：extension-kit 缺 MV3 的三处**运行时**基建，以及 sample 只示范了「小扩展」

> **来源**：steward `client/plugin/`，2026-08-16 建骨架 → 2026-08-26 的十天连续开发。
> 期间插件从 0.1.x 走到 0.3.2：采集器数据化、页内面板 dock 化、剧本/编剧拆分、
> background 从 1712 行拆成 4 组 handler。
>
> **场景**：这个插件比 extension-kit 早 6 天存在（kit 随 bundle v1.2.1 于 8-22 到达），
> 而 kit README §1 把 steward 列为提炼来源之一。所以本文不是「基座没用上」，
> 是**这十天又往前走了、该回流的东西**。
>
> **依据分三类，引用时别混**：
> **① 实测**——steward 本仓库代码与回归实跑，下文均带 `文件:行号` 或具体数字。
> **② 二手（引用其他项目的记录，未在本仓库复现）**——wavely 插件 v1.2.9 踩过的坑，
> 以 steward 代码里的注释形式留存，下文单独标注。
> **③ 无网络检索**——本文没查任何外部资料，MV3 行为均来自本机真机运行。
>
> **涉及**：`client/extension-kit/lib/`（新增）、`client/extension-kit/sample/`、
> `client/extension-kit/e2e/README.md`、`client/extension-kit/README.md`。
> 全在只读区，所以走 feedback，不在项目里打补丁。

---

## 一、【实测 · 最便宜 · 最该做】通道瞬时错误没有统一判据，各项目各写一份正则，而漏一种措辞就是整场失败

MV3 里「向 content script 发消息」是**必然会瞬时失败**的操作：导航中、bfcache、
service worker 刚被回收、新文档还没注入完。正确做法是识别出这类错误并重试，
而不是把它当业务失败。

**kit 目前完全没有这个能力**：`lib/` 六个文件里 `message channel` / `message port` /
`Receiving end does not exist` / `back/forward cache` 一次都没出现（全目录 grep 为空），
`sample/popup/popup.js:8` 的 `sendMessage` 是裸调。

steward 自己写了一份重试（`client/plugin/lib/showcase.js` `perform()`），但**正则漏了最常见的那种措辞**：

```js
// 漏网的写法（2026-08-25 真机炸在这里）
/back\/forward cache|message channel is closed|Receiving end does not exist|没注入/
```

Chrome 实际有**四种**措辞，其中最常见的一种**没有 `is`**：

| 实际错误文本 | 旧正则 |
|---|---|
| `...but the message channel closed before a response was received` | ❌ 漏（无 `is`） |
| `The message port closed before a response was received.` | ❌ 漏（是 `port` 不是 `channel`） |
| `Could not establish connection. Receiving end does not exist.` | ✅ |
| `The page keeping the extension port is moved into back/forward cache` | ✅ |

**实测现象**：一场 57 步的演示跑到第 5 步（`goto` 导航后等元素）炸出第一种措辞，
本该被重试吃掉的瞬时错误**升级成整场失败**——而现场表现是"用户点了一下浏览器的保存密码弹窗，
演示就断了"，指向完全错误的方向（误以为是弹窗阻断了执行）。

**根因**：这条正则是「照着某一次的报错原文抄下来的」，而不是照着错误类型写的。
**任何项目自己写都会犯同样的错**——因为你只见过你踩到的那一种。

**建议**（价值最高、成本最低）：kit 新增 `lib/messaging.js`，导出两件东西：

```js
export function isTransientChannelError(e)   // 四种措辞的宽匹配：message (port|channel) .*closed 等
export function sendToTab(tabId, msg, opts)  // 带退避重试 + 可选的「补一针注入」回调
```

steward 侧修完的宽匹配（已用 7 个真实文本验证：四种通道措辞全重试、
业务错误「找不到元素」「页面动作失败」不误伤）可直接作为实现：

```js
/back\/forward cache|message (port|channel) .*closed|Receiving end does not exist/i
```

---

## 二、【二手 + 实测】`chrome.runtime.sendMessage` 冷启动 reject，kit 的 sample 教的是裸调

**二手部分**（wavely 插件 v1.2.9 踩过，steward 未复现，仅以注释留存）：
service worker 空闲即被回收，冷启动瞬间 `sendMessage` 会 reject；裸调会让异常冒泡、
**后面的 UI 代码全不执行**——症状是"点了没反应、也没有报错"，排查成本极高。

**实测部分**：steward 的每个页面侧文件都各自包了一层（`client/plugin/content/detail.js:40-50`
是最完整的一份），四个 content script 各写一遍、措辞还不完全一致。

**kit 的 `sample/popup/popup.js:8` 恰恰示范的是裸调**——抄 sample 起步的项目会原样继承这个形态。

**建议**：与第一条合并进 `lib/messaging.js`，再导出一个 `callBackground(type, payload)`：
统一「reject → 归一成 `{ok:false,error}`」+「`!res` 判为后台无响应」两件事，
sample 改用它。这样新项目一开始就是对的形态。

---

## 三、【实测】sample/background.js 只示范了「小扩展」，48 个 handler 的项目无处参考

kit 的 `sample/background.js` 是 135 行、9 个 handler 的平铺 `const handlers = {}`。
真实项目长起来之后完全不是这个形态：steward 到 8-26 有 **48 个 handler**，
`background.js` 长到 **1712 行**（其中 handlers 一个对象占 768 行）。

**先澄清一个被普遍误解的约束**：MV3 对 service worker **没有文件大小限制**，
manifest 声明 `"type": "module"` 后 ESM `import` 完全可用。所以"不能拆"从来不是约束——
但因为 sample 只有平铺形态，项目很容易一路平铺到失控才想起来拆。

steward 8-26 拆成四组（按**业务轴**分，不按文件大小分），拆完 background 927 行：

| 文件 | 行 | 装什么 |
|---|---|---|
| `handlers/conn.js` | 152 | 身份/连线/本机记录——作用对象是整个插件 |
| `handlers/action.js` | 95 | 工单轴 |
| `handlers/collect.js` | 362 | 采集轴 |
| `handlers/show.js` | 450 | 演出与编剧轴 |

**拆分时踩到一个坑，值得写进 sample 的注释**：

> 模块级 `let` 状态（如 `let deepRun = null`）被 handler 直接赋值时，
> **拆出去之后对 `let` 赋值只改到那个模块自己的绑定**，主文件读到的永远是初值。
> 症状是「状态永远不动、互斥判断永远放行」，而 **`node --check` 一个字都不会报**。
> 解法是改成共享对象传引用（`const runState = { deep: null, gen: null }`）。

**建议**（价值中等，成本低）：sample 增加一个 `sample/handlers/` 子目录（哪怕只拆两组），
示范「工厂函数注入依赖」的形态——与 `lib/` 现有的 `createRpc/createQueue` 风格一致，
并在 README 里写明三条纪律：
① 按业务轴分组，不按文件大小；
② **handlers 之间不许互相 import**（共享的下沉 lib/ 或由装配层注入，否则拆完变成一张网，比一个大文件更难改）；
③ 跨组调用走 `getHandlers()` 延迟取值（工厂里直接持有会拿到 undefined——那时另一组还没装配完）。

---

## 四、【实测】content script 的「顺序注入 + 全局共享」是事实标准，但 kit 完全没有涉及

Chrome 的 content script **不支持 ES module import**，所以多文件组织的通行做法是
manifest 的 `js` 数组顺序注入 + `self.XxxYyy` 全局挂载。steward 的 manifest 有 7 节、
每节 8–11 个文件，全靠这个契约（`client/plugin/manifest.json` 节 0 的 `//` 注释写明了，
并注明该做法「抄自 wavely 插件 v1.2.9」——**两个项目独立收敛到同一形态**）。

**kit 的 sample 只有 background + popup，没有任何 content script**，
所以这套组织方式、以及它带来的两个真问题，新项目要自己从头趟：

1. **摘除一个注入文件后，别处对它的全局引用不会报错，而是运行时炸。**
   steward 因此踩了**两次**：0.2.0 把 `collectors/1688/` 从 manifest 摘掉后，
   `content/collect-panel.js` 的挂载判据和 `content/collect.js` 的响应打包各有一处
   裸读 `C.id`（`C = self.StewardCollector`），一处让面板**永不出现**，
   一处炸出 `Cannot read properties of undefined (reading 'id')`——
   而后者的错误文案还写着「多半是页面改版，选择器要核对」，方向完全指反。
   **这是静态可查的**：扫所有 `self.Steward*` 引用 vs 各节 `js` 数组的实际注入清单。

2. **通配 `matches` 会污染你不想污染的页面。** steward 有一节为 dev 三端放了
   `http://localhost/*`（match pattern 表达不了端口），结果本机所有 localhost 页都被注入，
   **包括回归基准页**——新面板在基准页上挂载并发 RPC，把工单轴回归从 9/9 打到 6/9，
   且**结果不稳定**（重跑变 0/4）。两节的 `js` 列表逐字相同、肉眼完全看不出来，
   最后是 `git worktree` 拉 HEAD 做对照二分才锁定的。

**建议**（价值中等）：
- sample 补一个最小的 content script 组（2 个文件 + 顺序注入契约的注释）；
- kit 提供一个可选的 lint（`sync.sh` 里跑或单独脚本）：
  **交叉检查 manifest 各节 `js` 注入清单 与 代码里的 `self.<全局>` 引用**，
  引用了没注入的全局就报出来。这条在 steward 能省掉两次真机排查。

---

## 五、【实测】e2e 的一条硬纪律没写进 kit：装扩展的 playwright 必须**串行**跑

kit 有 `e2e/playwright.config.js` 与 `e2e/README.md`，但没提并发问题。

**实测两次**：并发起多个 mock 服务 + 两个 `launchPersistentContext`（都带 `--load-extension`）时，
回归结果**随机**——同一份代码三次跑出 9/9、6/9、0/4。清干净、串行跑立刻恢复 9/9。
这个失败形态极具误导性：**它看起来像"我刚才的改动引入了不稳定的 bug"**，
而实际是测试环境自身的干扰，会把人送去二分一个不存在的代码缺陷。

**建议**（价值中等，成本极低）：`e2e/README.md` 加一节「串行跑」，
`playwright.config.js` 显式设 `workers: 1` 并注明理由。

---

## 建议排序

| # | 内容 | 价值 | 成本 |
|---|---|---|---|
| 一 | `lib/messaging.js`：通道瞬时错误的统一判据 + 带重试的 `sendToTab` | **高**（漏一种措辞就是整场失败，且各项目必然各漏各的） | 低（正则 + 一层包装，实现可直接取用） |
| 二 | 同上文件里补 `callBackground`，sample 改用它 | 高（sample 现在教的是错的形态） | 低 |
| 四·2 | manifest 注入清单 ↔ `self.*` 全局引用的交叉 lint | 中高（静态可查，steward 踩了两次真机） | 中 |
| 三 | sample 示范 handler 分组 + 三条纪律 + `let` 跨模块赋值的坑 | 中 | 低 |
| 四·1 | sample 补最小 content script 组与顺序注入契约 | 中 | 低 |
| 五 | e2e 串行纪律（`workers: 1` + README） | 中 | 极低 |

---

## 本次没有产生本地补丁

第一条 steward 侧已经修好（`client/plugin/lib/showcase.js` 的宽匹配），但那是**项目自己的
一处正则**，不构成对只读区的偏离——kit 里本来就没有这个能力，所以不存在 `DIVERGED` 风险，
也不需要在项目 `CLAUDE.md` 里挂待办。kit 若采纳第一条，steward 那份改成 import 即可。

其余各条都只是「kit 缺什么」的观察，没有在只读区改任何东西。

---

## 一个附带的确认（不是缺口，是做对了的地方）

kit README §1 那张「三家落点各不相同」的表是准确的，而且**根因判断也对**：
脚手架此前只有一个含义模糊的空 `client/plugin/` 占位符。steward 8-16 建插件时那里正是空的，
于是就地写了浏览器扩展；kit 8-22 才随 bundle 到达。

**现在不建议 steward 迁到 `client/extension/`**：目录名已经渗进 7 节 manifest、
5 个回归脚本、部署脚本与三份文档，迁移收益（名字对齐）远小于风险。
但**新项目应该照 kit 的约定走**——这条已经写在 kit README 顶部的 🔴 里，是对的。

---

## 处理结论（2026-08-26，已落地）

**采纳五条中的四条半，全部实现并跑通。** 逐条核实结果如下——**两条的实测依据有误，
在这里更正**，因为它们会误导下一个读这篇的人。

| # | 判定 | 落点 |
|---|---|---|
| 一 | ✅ 全采纳 | 新增 `client/extension-kit/lib/messaging.js` |
| 二 | ✅ 采诉求，**驳论据** | 同上文件的 `callBackground`；sample 改用 |
| 三 | 🔶 部分采纳 | **不拆 sample**，改为 README §4.7 的三条纪律 + `let` 坑 |
| 四·1 | ✅ 采纳 | 新增 `sample/content/panel.js` + manifest 一节 |
| 四·2 | ✅ 采纳 | 新增 `client/extension-kit/lint-injection.js` |
| 五 | ❌ **已经做了** | `playwright.config.js` 本就是 `workers: 1`；只补了 README |

### 三处依据更正

1. **第二条「kit 的 `sample/popup/popup.js:8` 恰恰示范的是裸调」——不成立。**
   那个文件第 7–13 行本来就包了一层 `send()`，`chrome.runtime.lastError` 与 `!res`
   两件事都做了，正是本条建议的形态。看上去是只看了第 8 行（`chrome.runtime.sendMessage`
   那一行）就下的判断。
   **但诉求成立**：那一层是 popup 自己的局部实现、没有下沉到 `lib/`，所以任何多页面项目
   （steward 四个 content script）仍然要各写一遍。**采纳的是「下沉」，不是「popup 是错的」。**

2. **第五条「kit 有 `e2e/playwright.config.js`，但没提并发问题」——已经做了。**
   该文件第 6–8 行就是 `workers: 1` + `fullyParallel: false`，并且写了理由注释。
   本条唯一成立的部分是 `e2e/README.md` 里没写——已补，并把 steward 那组
   9/9 → 6/9 → 0/4 的实测数字连同「它看起来像我刚改坏了代码」这个误导性一起记进去
   （数字比 config 里那句"容易互相挤爆"更有说服力）。

3. **第三条的 `let` 坑，描述把两种形态混成了一句。** 2026-08-26 在 node 20 上实测，
   拆分后有**两种**结局，`node --check` 对两种都 `exit 0`：
   - handler 里 `import { deepRun }` 然后赋值 → **运行时** `TypeError: Assignment to
     constant variable`（ESM 的 import 绑定是只读的），**不是**"只改到自己的绑定"；
   - 拆的时候顺手在各模块各留一份 `let deepRun = null` → **这才是完全静默的那种**，
     handler 改自己那份，主文件读到的永远是初值。
   README 里按两种分开写了——**只记住第一种的人，碰到第二种会找错方向**。

（另：第三条说 sample 是「9 个 handler」，实际是 10 个。不影响结论。）

### 第三条为什么只采一半

建议是「sample 增加一个 `sample/handlers/` 子目录（哪怕只拆两组）」。**没有照做**，理由：
sample 同时是**最小可运行起点**、e2e 的 fixture、和你 `cp -r` 的那份。在 10 个 handler
的尺寸上，平铺一个对象就是对的形态；加一层 `getHandlers()` 间接是在教人给小扩展上仪式，
而这种仪式最容易被原样抄走。

**要传的知识不是目录结构，是那三条纪律和那个坑**——它们是散文就能完整传达的，于是落进
kit README §4.7「长大之后怎么拆」，并在 `sample/README.md` 里挂了指针。
`serveMessages` 的 `getHandlers` 选项做了（第③条纪律「跨组调用走延迟取值」要它），
所以真要拆的人有现成的接口，只是 sample 自己不摆出来。

### 实现里比建议多做的两处

- **`serveMessages(handlers)`**：建议里没有，但它是 `callBackground` 的**另一半**。
  MV3 里监听器同步返回假值 = 通道当场关闭，而对面看到的**恰恰就是**
  `The message port closed…`——一个自己造出来的"瞬时错误"，重试永远修不好。
  把信封（`{data}`/`{error}`）和 `return true` 一起收进框架，第一条那个正则才不用去接
  自己制造的错误。
- **`messaging.js` 刻意不用 import/export**。建议默认它是普通 ESM 模块，但那样
  content script **用不了**（classic script 里一个 `export` 就是 `SyntaxError`，
  且表现为整节注入**静默作废**）。实测确认无 import/export 的文件在 module 与 classic
  两种上下文都能求值，于是一份文件两边共用，靠 `globalThis.SoloMessaging` 交接——
  这同时把「顺序注入」这个契约在 sample 里示范了出来。真 Chrome 里有 e2e 守着。

### 门禁与验证

- kit 单测 **50 → 102 用例 / 7 套**（新增 `messaging.test.js` 38 条、`lint-injection.test.js` 14 条）
- 真浏览器 e2e **18 → 24 用例**，全绿（新增 `content.spec.js`，在真 Chrome 里验 classic
  script 注入、`sendToTab` 往返、无 content script 时的优雅退化）
- 顺带修掉 e2e 假 Router 的一个真 bug：`close()` 缺 `closeAllConnections()`，
  加了网页路由之后现形为**拆解阶段挂死到 60s 超时**，报错却指向被测用例
- 🔴 **kit 此前从未进过 CI**（`ci.yml` 里一个 extension 字样都没有）。已接进 `static`
  job：`sync.sh sample` → `lint-injection.js sample` → jest。这条不在建议里，但按
  §6.1 那条教训（「本地手跑门禁反而掩盖了 CI 红」），新加的门禁不进 CI 等于没加。

### steward 侧的后续

第一条 steward 已自己修好（`client/plugin/lib/showcase.js` 的宽匹配）。kit 采纳之后，
那份可以改成读 `self.SoloMessaging.isTransientChannelError`——**但 steward 的插件在
`client/plugin/`、没有跑 `sync.sh`**，所以要先决定是否接 kit。本文原判断
「不建议 steward 迁到 `client/extension/`」仍然成立（目录名已渗进 7 节 manifest
与 5 个回归脚本），迁不迁与接不接 kit 是两件事：`sync.sh <任意目录>` 不关心目录叫什么。

**这属于 steward 项目自己的决定，本仓库不代劳。** 建议顺序：先跑
`node client/extension-kit/lint-injection.js <steward 的插件目录>` ——它对现状零改动，
而 steward 恰好是那两次真机排查的当事人。

---

**处理结论**：✅ 已落地（v1.2.5+，见 `docs/planning/CHANGELOG.md` 的 `[Unreleased]`）。
第三条按上述理由部分采纳；第五条判定为已实现，只补文档。
