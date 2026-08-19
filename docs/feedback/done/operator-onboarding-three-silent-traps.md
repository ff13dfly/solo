# 反馈：新建一个 operator 账号要连踩三个「失败提示指向错误方向」的坑

> 来源：colony 派生项目，2026-08-19 为「本地起 portal 看线上栈」建第一个运营账号时实测。
> 依据：**三条全部本机实测**（solo v1.1.15 bundle，链路走公网 Router 到 N100 线上栈），
> 附实测返回；根因引用 solo 仓 HEAD 源码（`api/core/user/handlers/introspection.js`、
> `portal/operator/src/`），已与 v1.1.15 bundle 双向核对。
> 涉及：`user.register` 的参数声明、`portal/operator` 的错误渲染与登录文案。
>
> 一句话：从零建一个能用的 operator 账号要跨三道坎，**每道坎失败时给出的信号都指向
> 错误的方向**——照自省声明写代码会建出永远登不进去的账号、权限不足显示成「还没有数据」、
> 角色校验报的字段名和实际读的字段不是一个。三条单独看都小，叠起来是一条完整的「全绿
> 但什么都不работает」链路。

---

## 一、`user.register` 的 params 声明缺 `salt` / `hash` —— 照声明写 = 建出永远无法登录的账号

**声明**（`api/core/user/handlers/introspection.js:121`）：

```js
{ name: 'user.register', params: [
    { name: 'name',  type: 'string', required: true, maxLength: 128 },
    { name: 'email', type: 'string', maxLength: 254, pattern: 'email' },
    { name: 'phone', type: 'string', maxLength: 32,  pattern: 'phone' },
], ... }
```

**实际契约**（Router GUIDE §2b 原文）：

> ⚠️ **注册时必须客户端自带 `salt` + `hash`**——不传则服务端随机生成一个你不知道的，
> 该账号**永远无法登录**。这是最常踩的坑。

两边对不上：**GUIDE 说必传的两个参数，在自省声明里根本不存在**。而 GUIDE §4 自己写着
「**参数约束是机读的**……写调用代码前先读它，别猜」——于是「照文档做」和「照声明做」
给出相反的结果，且**错误的那条路会返回 `{ success: true, uid }`**，只在第一次登录时才
以「密码错」的形态暴露。

值得注意的是，同一个文件里已经有两处同型注释（`introspection.js:125` / `:127`）：

```js
// stats() returns { active, total } — `deleted` is NEVER computed (legacy decl lied; see contract audit).
// list() returns records under `users`, NOT `items` (legacy decl lied).
```

⇒ **contract audit 已经在做「声明 vs 实现」的核对，但方向偏在 `returns` 上，`params` 这侧
漏了。** 建议把 params 也纳入同一次审计——register 这条的后果比 returns 对不上严重得多：
returns 错了当场就发现，params 缺了要等到下一次登录。

## 二、权限不足被渲染成「还没有数据」，并引导你去做一个必然失败的动作

新注册账号的 permit 是空的（`{ allow_all: false, services: {} }`），于是每个业务方法都
`-32005 Forbidden`。实测（colony 线上，同一个 token 连打三个方法）：

```
fulfillment.profile.list  → [-32005] Forbidden
fulfillment.instance.list → [-32005] Forbidden
ant.instance.list         → [-32005] Forbidden
```

而 operator portal 的 fulfillment 页面显示的是：

> **No profiles yet — click + New at the top right to create one**

根因（`portal/operator/src/pages/fulfillment/index.tsx:231` +
`components/profile-list/index.tsx:231`）：

```js
const { data: profilesData } = useQuery({ queryKey: ['fulfillment-profiles'], queryFn: ... });
const profiles = profilesData?.items || [];      // ← 请求失败时 data 是 undefined ⇒ []
...
if (profiles.length === 0) return <EmptyState/>; // ← 于是 "No profiles yet"
```

`useQuery` 的 `isError` / `error` 被丢弃，**失败与空数据坍缩成同一个分支**。三重误导：

1. 「没有数据」与「你没权限看」肉眼无法区分——而线上真实状态是 1 个 profile + 44 个实例；
2. 提示**主动引导**用户点 "+ New"，那个动作会再撞一次 Forbidden；
3. 排查方向被带偏：会去查数据写入链路（我们最初就是这么怀疑的，先去核对了 Redis 里的
   实例数），而不是查权限。

这个模式在 fulfillment 页面之外大概率还有（凡是 `useQuery` 只解构 `data` 的地方），
建议做一次统一处理：错误态渲染成「加载失败：<message>」而非空态，尤其要把 `-32005`
显示成「当前账号无权访问该数据」。

## 三、角色校验报的字段名与实际读的字段不一致

`portal/operator/src/pages/Login.tsx:76-81`：

```js
const userRole = categories['POWER'] || categories['power'] || '';
if (userRole.toLowerCase() !== 'operator') {
    toast.error(t('login.role_denied') || 'Access denied: Operator role required');
}
```

读的是 **POWER**，报的是 "**role** required"。而 `user.category.list` 同时返回
**两个类目 `ROLE` 和 `POWER`，取值完全相同（`normal` / `operator`）**——实测踩法：
按提示去设 `categories.ROLE = 'operator'`，登录**照样被拒、报同一句话**，
毫无线索表明设错了字段。

`user.login.verify` 的 returns_schema 里其实写清楚了（"tier axis (categories.POWER gates
portal access)"），但那句注释在 API 声明里，登录页的报错文案不会把人指过去。
建议文案改成「Access denied: account tier (categories.POWER) must be 'operator'」——
一行字的成本，省掉一轮完整的排查。

## 四、建议（按价值排序）

1. **`user.register` 的 params 声明补 `salt` / `hash`**（`introspection.js:121`），
   并纳入 contract audit 的 params 方向。更进一步：**不传 salt/hash 时直接拒绝**
   （`-32602`，message 指向 GUIDE §2b），而不是静默生成一个无人知晓的凭证——
   「创建一个永远无法使用的资源并返回成功」本身就不该是一个合法结果。
2. **operator portal 的 `useQuery` 统一处理错误态**：至少 fulfillment / ant / storage
   等列表页，把 `isError` 渲染成错误提示；`-32005` 单独措辞为权限问题。
3. **登录失败文案点名 `categories.POWER`**（Login.tsx），别只说 "role"。
4. （可选）scaffold 或文档里给一个「建第一个 operator 账号」的完整配方：
   register(带 salt/hash) → `user.account.update` 设 `categories.POWER` →
   `user.permit.update` 授权。这三步缺任何一步都会以不同的误导性症状失败，
   而每个新项目都要走一遍。colony 侧的实现放在 `deploy/provision-operator.js`，
   可作参照。

---

## 处理结论（solo 侧）

2026-08-19 triage。三条指控核实：**一、二属实；三的核心属实，附带假设不成立**。四条建议全部落地。

### 核实（逐条）

- **§一 属实**：`introspection.js` 的 `user.register` 确实只声明 name/email/phone，而
  `logic/user.js:56` 读的是未声明的 `salt`/`hash`，缺省时**随机生成**
  （`crypto.randomBytes` → sha256），该值从不回传；`loginVerify` 要求
  `sha256(challenge + user.hash)`，而全服务**没有任何改密/重设入口**——所以「永远无法登录」成立。
  Router GUIDE §2b 的警告原文属实。
  （关于 `:125`/`:127` 那两条 "legacy decl lied" 注释：它们讲的是 `account.status`/`account.list`
  的 **returns** 形状，与 register 无关——本文把它们当作「contract audit 只审 returns、漏了 params」
  的**同型先例**来论证，这个论证成立，不是把它们当作 register 的证据。）
- **§二 属实**：`pages/fulfillment/index.tsx:264` 只解构 `data`/`isLoading`；`utils/rpc.ts` 在
  throw 时**把 JSON-RPC code 丢了**（只剩 message），所以下游连「这是权限问题」都判断不出来。
  同型写法共 **5 个数据源 / 6 处渲染点**（fulfillment ×2、default GenericList、storage AssetList、
  Dashboard 的 WalStats / AiUsage 两个 `.catch(() => {})`）。反例 `PassportManagement.tsx` 用
  try/catch + toast 正确区分了，说明这不是架构限制，是各页各写。
- **§三 核心属实，附带假设不成立**：Login.tsx 读 `categories.POWER` 而文案说 "role" 属实；
  但**不存在 `categories.ROLE`**——仓内的 "ROLE" 是 `USER:ROLE:{role}`（外部主体 RBAC 模板），
  与登录闸的 POWER 是两套无关机制。所以那次「按提示去设 categories.ROLE」失败的根因是
  文案措辞松散导致的误猜，不是「两个同值类目选错了一个」。

### 已做

1. **建议 1（register 声明 + 拒绝）**：introspection 补 `salt`/`hash`（`required: true` + 说明
   「服务端无法恢复、无重置路径」），`logic/user.js` 缺任一即 `-32602` 并指向 GUIDE §2b。
   **这是行为变更**：此前静默随机。已确认仓内两个真实调用方（portal/system 的 UserCreateModal、
   scaffold e2e harness）都已传 salt+hash，无破坏；契约测试补了正反用例。
   采纳了本文「创建一个永远无法使用的资源并返回成功，本身就不该是合法结果」这条判断。
2. **建议 2（portal 错误态）**：`utils/rpc.ts` 改抛 `RpcError`（**保留 code**，含穿过 catch 的路径）；
   新增 `components/ui/LoadError.tsx`——**Forbidden 与其他失败分开措辞**（前者「当前账号无权查看，
   请联系管理员授权」，后者「加载失败」+ 原始 message），中英文案齐。六处渲染点全部接上：
   fulfillment 的 instance/profile 两个分支、default 的 `GenericList`（新增 `error` prop，两个调用点
   都传）、storage `AssetList`、Dashboard 两个面板（`.catch(() => {})` → 记录并渲染，成功时清错误态）。
3. **建议 3（登录文案）**：中英 `login.role_denied` 改成点名 `categories.POWER`，并显式写
   「是 POWER 不是 ROLE，由管理员用 `user.account.update` 设置」——直接堵掉 §三那次误猜。
4. **建议 4（完整配方）**：user GUIDE 新增「配方一之二：从零建一个能用的 operator 账号」，
   三步各自的**失败症状**与其误导方向写在步骤里，末尾加验收要求（前两步的失败在登录暴露、
   第三步只在数据页暴露，**只验登录不算验完**）。

### 验证

user 服务 8 套 89 测试全绿；operator portal `tsc -b` + `vite build` 均通过。

### ⚠️ 给派生项目的动作项（这条比一般的 upgrade 更需要注意）

`portal/operator/` 是 **init.sh 一次性拷贝源码、`upgrade.sh` 永不覆盖**（`upgrade.sh:233` 明写
"team owns portal/operator/"）。所以**建议 2、3 这两处前端修复不会随 bundle 升级到达存量项目**，
各项目要自己回填（改动集中在 `utils/rpc.ts` + 新增 `components/ui/LoadError.tsx` + 六处渲染点 +
两条 i18n）。建议 1、4 在 api/ 与 GUIDE 里，随升级正常下发。
