# 同一个账号同时登录两次，必有一个报「Invalid or expired challenge」

- **来源**：steward，2026-09-26，给 hive 补「多账号往同一插件派单」的 e2e 时撞到
  （`e2e/suites/10-hive-concurrency.e2e.test.js`，两个进程并发跑 `integrations/probe-run.js`）。
- **场景**：同一个 user 账号被两个客户端**同时**登录——两个 AI 会话共用一个运维号跑脚本、
  两台机器的插件共用一个插件号且恰好同时重新登录、一个脚本里并发起多个 client。
- **依据分类**：
  - **实测**：同一个号并发起两个 `probe-run.js`（各自 `user.login.request` → `user.login.verify`），
    其中一个退出码 1，报 `✕ user.login.verify: [-32603] Invalid or expired challenge`。**只撞到 1 次**——
    撞到之后测试改成两个号，没再专门跑同号并发去数概率。
  - **源码推导**（solo `a4b16fc` / v1.2.15 的 `api/core/user/logic/user.js`；steward 装的 bundle v1.2.14 同一段代码）：
    下面「根因」里每一条都是读代码得出的，没有逐条实测。
- **涉及**：`api/core/user/logic/user.js`（`loginRequest` / `loginVerify`）。对照：`api/core/administrator/logic/identity.js`。
- **级别**：大声失败，重试一次就好；但**调用方大多不重试**（steward 的 `integrations/dispatch-script.js` `createClient().login()` 就不重试），
  于是表现为「脚本偶尔登录失败」，而报错字面指向「challenge 过期」，很难联想到是另一个进程在同时登录。

## 根因

1. **challenge 按用户名只存一份**：`loginRequest` 生成随机 challenge 后
   ``setEx(`${challengePrefix}${name}`, 120, challenge)``（`user.js:166`）——同一个名字只有一个槽，
   后发的 request 直接覆盖先发的。
2. **verify 只认槽里那一份，且用完即删**：`loginVerify` 读同一个键比对（`user.js:197`），不等就 `INVALID_CHALLENGE`；
   成功后 `del` 这个键（`user.js:245`，注释 `One-time use`）。于是两种交错都会失败：
   - A request → B request（覆盖）→ A verify：槽里是 B 的，A 失败；
   - A request → B request → B verify（成功，删槽）→ A verify：槽空了，A 失败。
3. **（顺带发现）两步对用户名的处理不一致**：`loginRequest` 先 `params.name?.toLowerCase().trim()`（`user.js:134`），
   `loginVerify` 直接用原样的 `params.name`（`user.js:192`）拼键、查 `userNamePrefix`。
   客户端若传 `Ops` 或带空格，request 存进 `challenge:ops`，verify 去读 `challenge:Ops` ⇒ 恒为 `INVALID_CHALLENGE`。
   steward 的账号名全是小写所以没踩到；这条**纯源码推导，未实测**。

**同一个 bundle 里已经有并发安全的写法**：administrator 的挑战响应按 **challenge 值本身**存
（`identity.js:15` `const challengeStore = new Map()`，`:115` `challengeStore.set(challenge, {...})`），
同时发起几次都各验各的。user 服务那一份按名字存，是两份实现各走各的。

## 为什么值得修

- 「一个外部系统 / 一个 AI 一个号」是派生项目的发号纪律，但**同一个号被多个进程用**在运维脚本、多会话 AI 协作里是常态
  （steward 的 `probe-run.js` / `dispatch-script.js` / `register-*.js` 都用 `STEWARD_USER` 登录，多个 AI 会话同时跑时共用同一个运维号）。
- 报错信息误导：「expired」让人去查时钟、TTL、网络延迟，而真因是另一个进程在同一时刻登录。

## 建议（按价值排序）

1. **challenge 按「名字 + challenge 值」存**：request 写 `challenge:<name>:<challenge>`（TTL 不变），verify 读同一个键、成功后删它。
   一次性、120 秒过期、与用户绑定三条性质都不变，只是不再互相覆盖——与 administrator `identity.js` 同一种做法。
   ⚠️ 代价：同一个名字可以同时挂多个未用的 challenge。每个都有 120 秒 TTL，且 Router 默认按 IP 限流（每分钟 500 次），
   量是有界的；要更紧可以给每个名字的在途 challenge 数设个上限（比如 8）。
2. **verify 与 request 用同一套名字归一化**（`toLowerCase().trim()`），拼 challenge 键和查 `userNamePrefix` 都用归一化后的值。
3. （可选）`user` 的 GUIDE 里写一句：同一个号可以并发登录；在 1 落地之前，调用方拿到 `INVALID_CHALLENGE` 应重新 request 一次再 verify。

## 本地验证方法

起一个栈，建一个用户，然后同一个名字并发两轮 `request → verify`：

```js
const [a, b] = await Promise.all([rpc('user.login.request', { name }), rpc('user.login.request', { name })]);
const va = await rpc('user.login.verify', { name, challenge: a.challenge, response: sha256(a.challenge + sha256(pw + a.salt)) });
const vb = await rpc('user.login.verify', { name, challenge: b.challenge, response: sha256(b.challenge + sha256(pw + b.salt)) });
// 现状：先到的那个 request 被覆盖，va 报 INVALID_CHALLENGE（-32603）；修好后两个都拿到 token
```

名字归一化那条：`user.login.request { name: 'Ops' }` 后用同一个 `'Ops'` 去 verify，现状恒为 `INVALID_CHALLENGE`。

## 处理结论

**2026-09-26 · 建议 1、2、3 全部采纳并落地，已归档。**

### 核实：三条根因全部坐实（hermetic 实跑，不只是读源码）

用 Map 假 Redis 直接驱动 `logic/user.js`（v1.2.15 + 未发版的 09-22 吊销修复）：

```
交错1 A req→B req→A verify:          A: FAIL -32603 Invalid or expired challenge | B: OK
交错2 A req→B req→B verify→A verify: B: OK | A: FAIL -32603
大小写 request('Ops')→verify('Ops'):  FAIL -32603
```

原文「只撞到 1 次、没数概率」那条不用再数了：按源码，**只要两次 request 交错，先发的那个必失败**，
不是概率问题。名字归一化那条原文标「纯源码推导」，现已实测坐实。

### 原文没提、核实时发现的一点：它同时是一个针对单个账号的登录 DoS

`user.login.request` 是匿名方法。按名字只存一个槽 ⇒ 任何人持续调
`user.login.request { name: <受害者> }` 就能一直覆盖受害者的 challenge，受害者的 verify 恒失败。
浏览器端 PBKDF2 20 万轮让 request→verify 的空档不短，Router 按 IP 每分钟 500 次的限流足够打中。
（源码推导，未实测。）按 challenge 分键后这条自然消失。

### 落地（`api/core/user/logic/user.js`）

| 建议 | 落地 |
|---|---|
| 1 按「名字 + challenge」存 | 键 `challenge:<name>:<challenge>`，值为签发时的 uid；verify 用 **`GETDEL`** 原子消费 |
| 2 同一套名字归一化 | 新增 `normalizeName()`，register / loginRequest / loginVerify 三处共用（此前是两处各写一遍、第三处漏了） |
| 3 GUIDE 写一句 | `core/user/GUIDE.md`「坑与约定」：同号可并发登录；challenge 一次性、答错也烧掉，`-32603` 就重新 request |

比原建议多做的三处，都在同一个函数里：

- **`GETDEL` 而不是 GET 再 DEL**：原先两步之间有窗口，两个 verify 拿同一个 challenge 并发进来可以都过比对。
  代价是**答错也会烧掉 challenge**（此前 120 秒内可拿同一个 challenge 反复试密码），属于收紧。
- **challenge 格式先校验**（`/^[0-9a-f]{32}$/`，即 `randomBytes(16)` 的形状）：客户端传来的值要拼进键名，
  畸形输入直接 `INVALID_CHALLENGE`、不碰 Redis。
- **verify 核对签发时的 uid**：名字在 TTL 内易主（destroy + 重注册）时，旧 challenge 不能兑给新账号。
- **verify 检查 `DELETED`**：这是 `user-session-survives-revoke-and-account-delete.md` 的建议 4，同一个函数、一并修。

没做：给每个名字的在途 challenge 设上限（原文列为可选）。每个键 120 秒 TTL，加上 Router 按 IP 限流，
量有上界；真要做再加。

### 守护

新增 `core/user/tests/login-challenge.test.js`（10 例，已进 CI 白名单）：两种交错、`Promise.all` 并发、
一次性、答错即烧、归一化、畸形 challenge、request 后软删、名字易主、成功后不残留键。
**对旧代码 7 例红**（已实测：把 `user.js` 退回去跑一遍）；剩下 3 例是旧代码本来就对的行为，留作回归。

下游 action：无。调用方不用改；若有客户端在 verify 失败后**拿同一个 challenge 重试**，改成重新 request
（此前这样重试在密码输错时也不会成功，只是会在 120 秒内一直报「密码错」）。
