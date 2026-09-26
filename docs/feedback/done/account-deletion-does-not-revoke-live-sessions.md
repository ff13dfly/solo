# 反馈：删账号不吊销已发出的 session，而唯一的吊销原语对人类账号是空转

- **来源**：catalog，2026-09-21。拿 `cloudflare/security-audit-skill` 对 catalog 跑了一整轮
  完整审计（六阶段编排，核心规矩是「发现它的 agent 不许验证它」），这条是 29 条唯一根因里
  **7 条 confirmed 之一**，由未参与发现它的独立验证者裁决为 medium（likelihood medium ×
  impact medium，confidence high）。
- **依据分类**（三类分开，别混着读）：
  - 🔴 **本次实测（源码核实）**：下面每一处 `文件:行号` 都是**在 solo 仓 main（v1.2.15）的
    源文件上**逐处读过的，不是从 catalog 的 bundle 副本反推、也不是照抄审计产物。
    两个删除函数、`resolveSessionUser` 全文、人类登录写 session 那一句、`killSessions`、
    `USER:SESSIONS` 反向索引的**全部写入点**，都当场核过。
  - **引用（审计产物，未独立重跑）**：「153,045 行 bundle 里 session 前缀 7 处、
    备用 admin session 前缀 3 处、`USER:SESSIONS` 反向索引 10 处、session key 删除 3 处
    （全部读同一个反向索引）、且不存在任何基于 scan 的 session 清扫」这组**穷举性**声明。
    我核实了其中的结构性结论（反向索引只由 bot / passport 两条路写），没有重跑穷举。
  - ⚠️ **没有动态复现**：那一轮是 source-only（那台 Mac 凑不齐沙箱：无 cgroups、
    `ulimit -v` 报 setrlimit failed、`timeout` 没装，且 macOS 没有网络命名空间 ⇒
    "只允许 loopback"的沙箱直通生产栈）。**下面的复现步骤没有被执行过**，
    结论完全建立在源码阅读上。
- **涉及**：`api/router/handlers/auth.js`（`resolveSessionUser`）、
  `api/core/user/logic/user.js`（登录 / `remove` / `destroy`）、
  `api/core/user/logic/bot.js`（`revoke` / `killSessions`）、
  `api/core/user/index.js:213`、`api/core/user/handlers/introspection.js:190`。
- **影响面**：**每一个有人类账号的派生项目**。凡是「发现 token 泄露 → 删账号 → 以为断了」
  这个动作会被执行的地方，它就不成立。

> 一句话：账号生命周期与会话生命周期在 Router 里**没有任何一处连起来**，
> 而框架自己提供的 `user.token.revoke` **对人类账号删 0 条、返回成功**——
> 于是操作者拿不到任何一条「产品内部可用」的补救路径。

---

## 一、现象

三件事叠在一起才构成这个缺口，缺任何一件都不成立：

**① 两条删除路径都不碰 session。** 两个函数体都很短，已整份读过：

- 软删 `user.js:587`（`remove`）：只写 `userData.status = STATUS.DELETED` 与 `deletedAt`，
  然后把记录写回（:602）。**没有读、也没有删任何 session key，permit 一个字没动。**
- 硬删 `user.js:338`（`destroy`）：`sRem` id 集合、`del` name 索引、`del` user key（:348-353）。
  **同样一个 session key 都不碰。**

**② 读路径不把「账号没了」当成吊销信号——但它对 bot 是这么做的。**
`auth.js:19` 的 `resolveSessionUser` 里，两个同胞分支对「主体状态」的态度是相反的：

| 分支 | 行 | 看 `status` 吗 |
|---|---|---|
| 人类（`user:<uid>` 存在） | :48-60 | ❌ 只把 `permit` / `role` / `categories.POWER` 抄进 sessionUser |
| bot（`uid` 以 `system.` 开头） | :61-74 | ✅ `:67` 判 `botData.status !== 'ACTIVE'` 就返回 guest |

🔴 **这不是设计选择，是不对称**——证据是框架自己写在 `:65-66` 的注释：

> `// Suspension bites live sessions immediately: a non-ACTIVE bot`
> `// resolves to guest even if its session token is still in Redis.`

「非 ACTIVE 的主体不该继续授权，哪怕 session key 还在」这条原则框架是持有的，
**只是没有在人类那一支实现**。而人类 uid 不以 `system.` 开头，所以那条检查
对人类账号**永远走不到**。

**硬删的情况更直接**：记录被 `del` 之后 `userStr` 为空，`else if` 又不成立
⇒ 整段刷新被跳过，**登录那一刻冻进 session blob 的 permit 原样生效**（`user.js:248` 写入）。

⚠️ 顺带：`:76-78` 的 catch 吞掉刷新失败（`[Auth] Dynamic permit loading failed`）后
**继续拿旧 permit 往下走**。Redis 抖一下的后果是"按上一次已知权限放行"。

**③ 唯一的吊销原语对人类账号是空转，而且报成功。**
`user.token.revoke`（`index.js:213`）→ `bot.revoke`（`bot.js:191`）→
`killSessions`（`bot.js:259`）。`killSessions` 读的是 `USER:SESSIONS:<uid>` 反向索引。

而这个索引**只有两处写入**（现查 `grep -rn "userSessionsPrefix" api/`，排除 tests）：
`logic/bot.js`（bot 会话）与 `logic/passport.js`（passport 会话）。

**人类登录那一句是裸的**——`user.js:252`：

```js
await redisClient.setEx(`${config.redis.sessionPrefix}${token}`, SESSION_TTL, JSON.stringify(sessionData));
```

没有配对的 `sAdd`。⇒ 对人类 uid，`sMembers` 拿到空集、`multi` 里一条 `del` 都没有、
`revoked = 0`，函数**正常返回**。

🔴 **这一点是验证者纠正 hunter 得到的，纠正方向是让问题更严重**：
最初的报告把 `user.token.revoke` 写成可用的补救手段，验证者去读了分派链才发现它对
人类账号根本不工作。而它的自述是（`handlers/introspection.js:190`）
**"Revoke all live session tokens of a uid (admin)"**，返回 `{ uid, revoked }`——
一个管理员看到 `revoked: 0`，最自然的解读是"本来就没有活着的会话"，
而不是"这个方法覆盖不到这类账号"。**静默失败 + 名字承诺了它做不到的事**，
这比"缺一个功能"坏得多。

## 二、边界（这条缺口有多大，也说准）

**有一道真实的控制限住了它**：`user.js:140` 的 `loginRequest` 确实判
`status === STATUS.DELETED` 并抛 `ACCOUNT_DELETED` ⇒ **软删账号不能再登出新 session**。
所以这条缺口严格限定在「**删之前就已经发出去、现在还活着的 session**」，
不是"删了等于没删"。

**窗口**：`user.js:241` 的 `SESSION_TTL = 86400 * 7`，即最多 7 天。
🔴 **但对 `allow_all` 账号这个上界不存在**：登录时 `role` 被标成 admin（`user.js:249`），
`ttl` 一并写进 session（:250），而 Router 在 `auth.js:87` 对 admin/operator tier
**每次请求都把 session key 重新 expire 到那个 ttl**。⇒ 只要还在用，这个 token 自己续自己。

## 三、根因

**账号生命周期与会话生命周期在 Router 里没有任何一处连起来。**
吊销只被建模成"一个单独的管理动作"，而每请求的身份解析把「记录不在了」和
「记录说 DELETED」都当成**非事件**而不是吊销信号——尽管同一个函数在 `:67` 已经
对 bot 这么判了，尽管 `loginRequest` 在 `:140` 已经把 DELETED 当成终止授权的信号。

缺口被第二个独立的洞放大：整套吊销机制依赖的 `USER:SESSIONS:<uid>` 反向索引，
由 bot 和 passport 两条路写、**唯独不由人类登录路径写**——于是管理员最可能去用的那个
兜底手段，恰好对最可能需要它的那类账号静默失效。

## 四、🔴 它为什么一直在：台账记着「2026-06 已解决」，而守护它的测试只测了覆盖到的那一半

这一节是写这篇反馈时**顺手查出来的**，比上面的缺口本身更值得看——
它解释了为什么一个这么直接的不对称能存在这么久。

`docs/planning/security.md:39` 把这件事列在**已修复**表里：

> | 外部 token 无主动吊销（泄露后只能等 TTL） | 2026-06（方案 b：`USER:SESSIONS:{uid}` 反向索引 +
> `user.token.revoke`(admin) 按 uid 吊销其全部 live session；`core/user/tests/bot-revoke.test.js` 守护） |

三处都对得上，**唯独"按 uid 吊销其全部 live session"这句对人类 uid 从来没成立过**：

- **方案落地时只接了两条路**。`docs/planning/toFix.md:19` 自称
  「**三类** principal 硬吊销」，而同一句里只点得出两个机制——
  `bot.revoke` / `passport.disable`。**第三类（人类账号）没有对应的动作，
  这在那句话自己的措辞里就看得出来。**
- **守护它的测试正好只覆盖已经工作的那一半**：`core/user/tests/bot-revoke.test.js:58`
  是 `const UID = 'system.test-bot'`。测试是绿的，而且会一直绿——
  它测的是反向索引被写过的那条路。⇒ **"有测试守护"这条证据在这里不成立**，
  但台账上它与另外两条并列。
- 还有一条判断被这件事推翻了：`toFix.md` 的贯穿主题 ⑥ 写着
  「**机器身份控制比人弱** ✅(2026-06-10：bot permit 热刷咬活 session + 可逆 suspend/resume)」。
  就 status 咬活 session 这一项而言**现在是反过来的**：bot 有（`auth.js:67`），人没有。

⇒ 这不是"漏做了一件事"，是**一个被记为完成的条目实际只完成了三分之二，而验收它的测试
恰好落在完成的那部分上**。建议 triage 时连带更新 `security.md` 与 `toFix.md` 那两行，
并把 `bot-revoke.test.js` 扩一个人类 uid 的用例——**那个用例今天会红，红的就是这条反馈**。

## 五、复现（**未执行**，source-only 那一轮的产物）

1. 用一个持有非空 permit 的测试账号走 `user.login.request` → `user.login.verify`，留下 token。
2. 以 admin 调 `user.account.remove`（或 `user.account.destroy`）删掉它。
3. 拿同一个 bearer 打该账号 permit 里的任一方法 → **预期仍被授权**。
4. 以 admin 调 `user.token.revoke { uid }` → **预期返回 `revoked: 0`**，
   之后同一个 bearer **仍然可用**。

## 六、建议（按价值排序）

1. 🔴 **读路径加 status 闸（最有价值，且是唯一能救「修复前已发出的 session」的一条）。**
   在 `auth.js` 的人类分支补上 bot 分支已有的检查：`userData.status` 不是 ACTIVE 就返回
   guest；`userStr` 为空且 uid 不以 `system.` 开头（= 已被硬删）同样返回 guest。
   **它是无状态的、追溯生效的**——不依赖任何索引是否被正确维护过，
   也不需要对存量数据做迁移。改动落在一个函数内，与 `:67` 那几行对称。
2. **让 `user.token.revoke` 名副其实**：`user.js:252` 那一句改成 multi —— `setEx` session +
   `sAdd` 进 `USER:SESSIONS:<uid>` + 给索引一个匹配的 `expire`，与 `bot.js` 那条路一致；
   然后 `remove` / `destroy` 返回前各调一次 `killSessions(uid)`，让**删除即吊销**。
   这条解决的是"管理员手上要有一个真的能用的开关"，与第 1 条互补：
   1 管"授权不该活过记录"，2 管"我要主动切断时有工具"。
3. **收紧 `auth.js:76-78` 的 catch**：刷新失败时继续用旧 permit，等于把 Redis 抖动
   变成"按上一次已知权限放行"。至少让 admin/operator tier 的刷新失败降级为 guest。
4. **如果以上暂不做，至少改文档与返回值**：`user.token.revoke` 的描述里写明它只覆盖
   bot / passport 会话，并在 `revoked: 0` 时回一个能区分「本来就没有」与
   「这类账号不在覆盖范围内」的字段。**一个静默返回成功的安全开关，比没有这个开关更危险。**

### 下游项目在框架修好之前只能这样

`user.account.remove` / `destroy` **不能**被当作"断开访问"；`user.token.revoke` 对浏览器
账号不起作用。要切断一个泄露的人类 token，目前只有**直接去 Redis `DEL session:<token>`**
（或轮换账号）这一条路。这一点值得写进 user 服务的 GUIDE / `docs/protocol` 里。
⚠️ **现在文档给的是相反的印象**（见 §四）：`security.md` 把主动吊销列为已解决，
读到的人会以为 `user.token.revoke` 覆盖所有 principal。

## 七、处理结论

**2026-09-22 · 全部采纳并落地（建议 1–4 逐条），已归档。**

### 核实结果：源码声明逐条属实，行号全部精确，没有一处夸大

两个删除函数、`resolveSessionUser` 全文、`user.js:252` 那句裸 `setEx`、`killSessions`、
`USER:SESSIONS` 反向索引的全部写入点（`grep -rn userSessionsPrefix api/`）、`introspection.js:190`
的自述、以及 §四 的三处台账（`security.md:39` / `toFix.md:19` / `bot-revoke.test.js:58`）
都重新核过一遍，**全部属实**。§二的边界（`loginRequest:140` 挡住重新登录、7 天 TTL、
admin/operator 自续）也属实——这篇没有把缺口说大。

### 复现：原文标注"未执行"，现已在真栈上双向实跑

脚本跑在 `deploy/dev.sh` 全栈上，**同一段脚本、同一套栈，只换代码**：

| 场景 | v1.2.15（修复前） | 修复后 |
|---|---|---|
| A 软删后旧 token 仍授权 | **是**（洞坐实） | 否 |
| B 硬删后旧 token 仍授权 | **是**（洞坐实） | 否 |
| C `token.revoke` 对人类 uid（2 个活会话） | **`revoked: 0` + 成功** | `revoked: 2`，两个 token 当场失效 |
| D 未进索引的历史 session + 软删 | 仍授权 | `revoked: 0`，但 Router 的 status 闸挡住 |

场景 D 是建议 1 那句「无状态、追溯生效」的实测证据：删除路径够不着它（不在索引里），
Router 仍然挡住。

### 落地（建议 1–4 全做）

| 建议 | 落地 |
|---|---|
| 1 读路径 status 闸 | `router/handlers/auth.js` 人类分支补 status 闸 + 硬删闸（**Router 保护区，已获用户明确授权**） |
| 2 让 revoke 名副其实 | 新增 `core/user/logic/sessions.js` 共享原语；人类登录改走 `persistSession`；`remove`/`destroy` 调 `killSessions`，返回加 `revoked` |
| 3 收紧 catch | admin/operator tier 的 permit 刷新失败改为降级 guest；普通用户维持原行为 |
| 4 改文档与返回值 | `introspection.js` 三处描述 + `returns_schema`；user `GUIDE.md` 新增「配方四：切断一个已泄露的凭据」；`security.md` / `toFix.md` 两行更正 |

### 这篇没说、但实施时必须处理的三件事

1. 🔴 **「userStr 为空 ⇒ guest」不能一刀切，会杀掉所有 passport 会话。**
   建议 1 的原文没区分主体类型。实际全仓只有 4 个 session 发放点：人类（`user.js:252`）、
   bot（`bot.js:51`）、passport（`passport.js:216`，`uid: anchor` + `type:'external'`，
   **锚在 `USER:PASSPORT:` 下、本来就没有 `user:{uid}` 记录**）、administrator
   （`identity.js:153`，**blob 里根本没有 uid**，整段刷新不经过）。
   ⇒ 硬删闸必须排除 `type:'external'`。落地用的就是这个判据。
2. 🔴 **status 检查必须带真值守卫**：`userData.status && userData.status !== 'ACTIVE'`，
   照抄 bot 分支那一个。存量记录可能没有 `status` 字段（`router/tests/security/e2e-permission.test.js:62`
   写进去的就没有），严格判等会把这类账号全部降成 guest。
3. **三处夹具把这个洞编码成了预期行为**，改完才现形，都已修：
   - `router/tests/auth.test.js` 的 `[Scheme F] falls back to session permit when user record missing`
     ——**它断言的正是这条缺口**，已翻转成 `[lifecycle] hard-deleted internal account resolves to guest`；
   - `autocheck/simulation/scenarios/router/core-security.js` 的并发隔离场景只建 session 不建账号记录；
   - `e2e/harness/setup.js` 直接塞 `session:e2e-harness-admin`（`uid:'e2e-admin'`）却从不建
     `user:e2e-admin`——**整个 e2e 的 admin 身份都靠它**，不补就是 26 个用例连环红。
   这三处和 §四 那条是同一个病：**没有共同原语时，某一条路的特例会静静地变成"事实规范"**。
   建议 2 落地时因此把 session 落库/吊销收敛成了 `logic/sessions.js` 一份，而不是给 `user.js` 再抄一份。

### 门禁

- jest CI 白名单 **137 套 / 2299 测试全绿**（2294 passed + 5 skipped）
- `autocheck/simulation` 全绿（补夹具后）、`deploy/check-doc-drift.js` 通过、`deploy/build.sh` 构建通过并确认新模块进了 bundle
- e2e：`00-login` / `55-user-mgmt` / `68-external-isolation` 与 HEAD 基线**逐条同结果**
  （残留 6 个失败在基线上一模一样，是 passport issuance 模式 / category 联邦的既有环境项，与本次无关）
- 新增守护：`router/tests/auth.test.js` +8 例、`core/user/tests/bot-revoke.test.js` +5 例
  （后者**对旧代码全红**，已实测确认——正是本文 §四 预言的那个用例）

变更明细与下游 action 见 `docs/planning/CHANGELOG.md` 的 `[Unreleased]`。
