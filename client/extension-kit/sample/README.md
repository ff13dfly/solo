# Sample —— 可运行的最小 SOLO 插件

> 与 `api/sample/` 同性质：**[Solo] 所有，`upgrade.sh` 整目录覆盖**。
> 这里是给你抄的起点，不是给你改的地方——改动下次升级就没了。

## 跑起来

```bash
bash client/extension-kit/sync.sh client/extension-kit/sample   # ← 第一步，别跳（见下）
bash deploy/run.sh                                              # 起栈（Router 默认 8440）
```

🔴 **第一步不能跳，而且跳了不会报错。** kit 必须有一份复制在扩展根目录**内部**
（`sample/kit/`，已 gitignore）——Chrome 扩展的根是封闭的树，`import '../lib/x.js'`
越过根就加载不到。它的失败形态极坏：**service worker 注册得起来、不报任何错，
但模块从未求值，所有调用石沉大海**。2026-08-20 实测踩到，排查花了不少时间。

1. Chrome → `chrome://extensions` → 开「开发者模式」→「加载已解压的扩展程序」→ 选
   **`client/extension-kit/sample`**
2. 点插件图标 → 选 Router → 填账号密码 → 登录
3. 「上报方法」填你自己服务的写方法（如 `yourservice.capture.create`）→「采当前页并上报」

没填方法会明确报错——sample 不假装某个服务存在。

## 抄成你自己的

```bash
cp -r client/extension-kit/sample/{manifest.json,background.js,kit.js,popup,content} client/extension/
bash client/extension-kit/sync.sh client/extension/       # 把 kit 复制进去
node client/extension-kit/lint-injection.js client/extension/    # 注入清单交叉检查
```

`client/extension/` 是 [Project] 区，`upgrade.sh` 永不覆盖——**只有里面的 `kit/` 子目录**
会在升级时刷新（前提是该目录有 `manifest.json`）。所以框架修复照样到得了你手上，
而你的 manifest / adapter / 选择器一个字节都不会被动。

**`kit.js` 一个字都不用改**——它引的是 `./kit/`，在两个位置都成立。

接着按你的需要改：

| 改哪 | 改什么 |
|---|---|
| `background.js` `PRESETS` | 你的 Router 地址，`[0]` 是默认 |
| `background.js` `CAPTURE` | `idemKey` 的派生规则——**按你的业务定**，它是重发安全的唯一依据 |
| `manifest.json` `content_scripts` | 换成你要注入的站点；站点选择器放 `platforms/<站点>/`，别散进逻辑 |
| `content/panel.js` `readPage()` | 换成站点 adapter 的 `read()`；`flash()` 那套页内反馈可以留着 |
| `popup/` | 照项目设计系统改；sample 刻意朴素 |

## 三条从既有插件提炼的纪律

1. **`platforms/*` 之间不许互相引用，`lib/*` 里不许出现平台名。**
2. **选择器集中在 adapter 的 `selectors.js`**——它天天坏，将来要改成从服务端下发时才不用重写。
3. **动作 type 用跨平台的名字**（`price-change`，不是 `taobao-price-change`）。平台名一旦渗进 type，抽象就没了。

（来自 steward `platforms/contract.js`，那套 adapter 契约值得连着抄。）

## content script 那一组（`content/`）

manifest 里是这样声明的，**顺序有意义**：

```json
"js": ["kit/messaging.js", "content/panel.js"]
```

content script 是 **classic script**，用不了 `import`。所以多文件组织的通行做法是
**顺序注入 + `self.Xxx` 全局挂载**：`kit/messaging.js` 排在前面，往 `self.SoloMessaging`
上挂东西；`content/panel.js` 排在后面，读它。顺序反了不会有编译错误，只有运行时 undefined。

改完跑一次交叉检查（它同时管顺序、管"引用了没注入的全局"、管清单里的文件在不在）：

```bash
node client/extension-kit/lint-injection.js client/extension/
```

### ⚠️ 它会对 sample 的 `matches` 出一条忠告，那是真的

sample 用 `http://localhost/*` + `http://127.0.0.1/*`，而 match pattern **表达不了端口**——
所以它命中**本机所有端口**，包括你自己的开发前端和回归基准页。sample 这么写是为了装上就能试，
**你自己的扩展应该换成真实站点域名**。steward 没换，结果新面板在回归基准页上挂载并发 RPC，
把一轮回归从 9/9 打到 6/9 且结果不稳定（重跑变 0/4），两节的 `js` 列表逐字相同、肉眼看不出来。

## 长大之后怎么拆

本 sample 的 `background.js` 是 164 行、平铺一个 `handlers` 对象——**在这个尺寸上就该这样**，
所以刻意不拆给你看。真长起来（steward 到 48 个 handler / 1712 行）怎么拆、三条纪律、
以及那个 `node --check` 查不出来的模块级 `let` 静默坑，见
[`../README.md` §4.7](../README.md)。

## ⚠️ 「记住密码」= 明文存本机

勾上会把密码存进 `chrome.storage.local`（不上传），这样 token 过期能自动重登。
**这是 sample 沿用既有三个插件的做法，不是推荐做法**——SOLO 有一条不需要存密码的路
（passport 设备线），只是还没人用。见 `../lib/session.js` 顶部。
换过去只需要把 `createPasswordAuth` 换成设备令牌版的 `reauth`，`kit` 与本 sample 的其余部分不动。

## E2E 挂载点

`background.js` 结尾挂了 `globalThis.__solo = { queue, rpc, session, endpoints, readPage }`，
让测试能在 service worker 里直接驱动队列，不必经 popup UI；`content/panel.js` 结尾同理挂了
`self.__soloContent`。生产扩展可以删掉这两行。
