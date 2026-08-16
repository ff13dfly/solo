# 反馈：passport 的行隔离 `$owner` 是**强制声明、可选执行**——服务不实现就等于没有隔离

> 来源：colony 派生项目，2026-08-15 给 ant 控制台（`client/ant`）接 passport 登录时实测。
> 依据：**全部本机实测**（solo v1.1.15），链路 `user.role.set → user.passport.register →
> user.passport.verify → ant.instance.list`，附原始返回；根因部分是读 bundle 源码定位的行号。
> 涉及：`user.role.set` 的 external 校验、`user.passport.verify` 的发证守卫、
> `api/library/permit.js` 的 `getConstraints`、Router 的 constraints 下发。
> 影响面：**每一个用 passport 让外部主体访问业务服务的项目**。
>
> 一句话：框架在**三处**强制你声明行隔离（不声明就 `-32602`/`INTERNAL_ERROR` 拒绝发证），
> 却**没有任何一处执行它**——`$owner` 被原样下发给服务，由服务自己去读；
> 服务不读，passport 用户就能看到全表，而且全程零告警。

---

## 一、实测：三道强制关卡，零执行

### 关卡（框架确实在拦）

```js
// ① role 不给 ownerField —— 拒
user.role.set { role:'ant-operator', scope:'external', services:{ant:[...]} }
→ [-32602] scope:'external' role must define ownerField (row isolation) — see passport.md §3.7

// ② 发证时 $owner.value 缺失 —— 拒（solo.v1.1.15.js:78676, 78754）
throw INTERNAL_ERROR(`passport authority for "${anchor}" is not row-isolated ($owner missing) — refusing session`)
```

三道关卡的措辞都很强硬（"refusing session" / "refusing issuance"），
读下来的合理预期是：**拿到 passport session 之后，看到的行一定是被过滤过的**。

### 执行（没有人做）

补上 `ownerField:'ownerId'` 后走完整链路，用 passport session 调业务方法：

```js
user.passport.verify { anchor:'probe-902322', deviceId, deviceToken }
→ { token, expiresAt, anchor, role:'ant-operator', bot:null }        // session 里带着 $owner

ant.instance.list {}   // 用上面这个 token
→ [{ id:'j9cjCt5CZxrE', symbol:'SOL', ... }, { id:'hiPGTZ6twDvV', symbol:'DOGE', ... }]
```

**两条实例全部返回**。它们是 admin/bot 建的，`ownerId` 字段根本不存在——
按 `$owner: { field:'ownerId', value:'probe-902322' }` 过滤的话应该**一条都不返回**。

对照组说明权限系统本身是活的：

```js
ant.instance.stop { id:'...' }   // 该 role 没放行这个方法
→ [-32005] Forbidden             // ✅ 方法级 permit 正常工作
```

⇒ **方法级鉴权（services 白名单）执行了，行级隔离（$owner）没有。**

## 二、根因：constraints 只是被"下发"，执行方是服务自己

```js
// Router 把 constraints 塞进转发给服务的请求（solo.v1.1.15.js:44447）
constraints: sessionUser.permit?.constraints || {},

// 服务侧拿到的是一个 helper，要自己调（api/library/permit.js，bundle 内 120316-120318）
function getConstraints(req) {
    return req && req.constraints ? req.constraints : {};
}
```

`getConstraints` 是**纯读取**——它不过滤、不改写查询、也不校验调用方有没有用它。
而 `api/library/` 里 grep `$owner` 是**零结果**：Entity Factory（`entity.js`）压根不认识这个约定，
`list`/`get` 都不会自动带上 owner 条件。

于是安全模型的最后一环落在"每个服务作者都记得手工实现行隔离"上，
**而框架既没有在文档里说清这一点，也没有任何检查**（autocheck 不查，Router 不查）。

这与 `fulfillment-condition-fail-open.md` 记的那条是同一类：
**声明被存下来了，取数/执行的那一环不存在**，且失败方向是放行而不是拒绝。

## 三、为什么这个比 fulfillment 那条更危险

1. **它伪装成已生效。** 三道关卡都会拒绝你，你会认为"框架不让我跳过隔离"——
   实际上被强制的只是**填一个字段**。
2. **没有任何可观测信号。** 不报错、不打日志、`user.passport.get` 里能看到 role 绑定得好好的。
   要发现它只能像我这样，专门拿一个外部 session 去 list 一张不属于它的表。
3. **典型场景恰好是多租户。** passport 的设计目标就是"外部主体各看各的"
   （`api/library/README.md:39`），行隔离不是可选优化，是这个特性的**主要卖点**。

我这次是单用户场景，"看到全部实例"正好是想要的行为，所以无害。
但**任何一个真的有多个外部主体的项目**，只要作者没读过 bundle 源码，就会默认它已经隔离了。

## 四、建议（按价值排序）

**① Entity Factory 自动执行 `$owner`（治本）**

`entity.js` 的 `list`/`get`/`update`/`remove` 读 `req.constraints.$owner`，
有 `field`+`value` 就自动加过滤条件。这样"声明即生效"，和三道关卡的措辞对上。
需要配一个显式的逃生舱（如 `entity.list({ _bypassOwner: true })`）给系统内部调用。

**② 退一步：让"没执行"变成可检测**

- Router 侧：session 带 `$owner` 时，在响应上打一个标记（如 `x-solo-owner-enforced`），
  由服务在实际过滤后回填；没回填就在服务端日志里 warn 一次。
- autocheck 侧：服务的 methods 里有 entity 读方法、而代码里没出现过 `getConstraints`
  ⇒ 静态告警。这条很粗糙，但足以让作者第一次就看见这件事。

**③ 无论如何先改文档**

`passport.md §3.7` 与 `user` 服务的 guide 现在的写法（"必须行隔离（`$owner`），否则服务端拒发"）
会让人以为框架执行了它。应当明确写：

> `$owner` 由 **服务自己** 在数据层执行；框架只保证它被下发。
> 你的服务不实现，外部主体就能读到全表。

**④ 给一个可抄的实现**

`api/sample/` 里加一个消费 `$owner` 的 entity 读方法示例（十行左右），
比任何文档都有效——现在作者想照做也没有参照。

---

## 处理结论

**triage 2026-08-16：核实属实（五篇同批 feedback 里最严重的一条），建议 ①③④ 采纳落地，
② 以更强形态实现（静态规则而非运行时标记）。**

核对：三道关卡确在且 fail-closed（role.set 拒无 ownerField 的 external 角色、
`logic/passport.js` verify/register 两处拒签）；`$owner` 在框架侧零执行——`entity.js`
不消费 constraints、`getConstraints` 纯读取；全仓库唯一消费方是 `apps/collection`
（内部测试服务，不随 scaffold 下发），对派生项目等于不存在。全部与本文一致。

已做（实现走了一条比本文建议 ① 更省的路）：

1. **Entity Factory 自动执行 `$owner`**（建议 ①，治本）。关键发现：所有服务的 RPC 分发
   本来就包在 `walContext.run({uid, trace, depth}, …)`（AsyncLocalStorage）里——`$owner`
   搭同一条通道即可，**不用改任何 factory 调用点**：
   - `library/entity.js` 新增导出 `requestContext(req)`（uid/trace/depth + `owner` =
     `req.constraints.$owner`）；工厂内 `ownerScope()` 从 store 读取并执行：
     create 盖章（覆盖客户端伪造）、get/update/delete/destroy 越权 → NOT_FOUND
     （与 collection 手工实现同语义，防存在性泄露）、list/multiGet/cursor 路径过滤、
     update 锁死 owner 字段不可改走。
   - **逃生舱是天然的**：内部/admin/bot 会话的 constraints 没有 `$owner` → 全部行为不变；
     无上下文的直调（测试、维护脚本、启动播种）同样不受影响。不需要 `_bypassOwner`。
   - **fail-closed 方向**：外部会话只能看到盖了自己章的行；enforcement 之前的存量行、
     admin 直建的行没有 owner 字段 → 对外部会话不可见。这是设计（同 verify 拒签的取向）。
   - 14 个用 walContext 的服务 + `api/sample` 全部换成 `walContext.run(requestContext(req), …)`
     （gateway/administrator 不用实体工厂，未动；**`api/router/` 受修改保护，未动也无需动**——
     Router 只负责下发 constraints，本来就工作正常）。
2. **可检测**（建议 ②，改成静态形态）：新增 autocheck 规则 `owner-context`（WARN）——
   `walContext.run` 用手写字面量 store 就告警并给出改法。比运行时回填标记便宜且在
   PostToolUse 钩子里每次改完即呈现。
3. **文档**（建议 ③）：passport.md §3.6 新增「执行位置」条目 + §3.7 加「三关卡只保证声明
   存在」的醒目区分 + 变更记录 1.2.1；user 服务 GUIDE.md、library README、
   scaffold `docs/authoring/service.md` §2 + 自查第 8 条、solo-service SKILL.md 红线，全部
   写明「v1.1.15 及更早没有执行环节」这个版本边界。
4. **可抄的实现**（建议 ④）：`api/sample/index.js` 的注入行带完整注释（自动执行覆盖什么、
   什么时候才需要手工过滤、指向 collection 的 `_scope` 参照）；collection 的手工实现加注
   「工厂已自动执行，此处保留作 belt-and-braces + 自定义数据路径参照」。

验证：新增 `library/tests/entity-owner-scope.test.js`（13 用例：requestContext 构造 / 盖章
与防伪造 / 越权 NOT_FOUND / 无 owner 字段行对 scoped 会话不可见 / update 不可转让 /
list·multiGet·cursor·keyword 复合过滤 / 无 $owner 会话行为不变）全绿，已入 CI 白名单；
CI 绿色子集全量跑过（含 user/passport、collection、entity 系全部既有套件，零回归）。

**给派生项目的动作项**：升级到 v1.1.16 后，把各自有服务 `walContext.run` 的手写 store
换成 `requestContext(req)`（autocheck 会 WARN 提示）；colony 的 ant 服务换完后，
`ant.instance.list` 对 passport 会话将只返回盖了该 anchor 章的行——**存量行没有
ownerId 字段，会从外部视角消失**，单用户场景如需外部会话看全表，给该角色去掉
external scope 或把存量行补上 owner 字段，二选一。
