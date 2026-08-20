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
cp -r client/extension-kit/sample/{manifest.json,background.js,kit.js,popup} client/extension/
bash client/extension-kit/sync.sh client/extension/       # 把 kit 复制进去
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
| `manifest.json` `content_scripts` | 要读页面就加；站点选择器放 `platforms/<站点>/`，别散进逻辑 |
| `popup/` | 照项目设计系统改；sample 刻意朴素 |

## 三条从既有插件提炼的纪律

1. **`platforms/*` 之间不许互相引用，`lib/*` 里不许出现平台名。**
2. **选择器集中在 adapter 的 `selectors.js`**——它天天坏，将来要改成从服务端下发时才不用重写。
3. **动作 type 用跨平台的名字**（`price-change`，不是 `taobao-price-change`）。平台名一旦渗进 type，抽象就没了。

（来自 steward `platforms/contract.js`，那套 adapter 契约值得连着抄。）

## ⚠️ 「记住密码」= 明文存本机

勾上会把密码存进 `chrome.storage.local`（不上传），这样 token 过期能自动重登。
**这是 sample 沿用既有三个插件的做法，不是推荐做法**——SOLO 有一条不需要存密码的路
（passport 设备线），只是还没人用。见 `../lib/session.js` 顶部。
换过去只需要把 `createPasswordAuth` 换成设备令牌版的 `reauth`，`kit` 与本 sample 的其余部分不动。

## E2E 挂载点

`background.js` 结尾挂了 `globalThis.__solo = { queue, rpc, session, endpoints }`，
让测试能在 service worker 里直接驱动队列，不必经 popup UI。生产扩展可以删掉这行。
