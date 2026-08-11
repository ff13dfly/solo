# 反馈：Router 转发超时按**方法名前缀**硬编码，派生项目的慢方法永远只有 10 秒，被迫全改成「假异步」

> 来源：trend 项目，2026-08-08/08-09 实测；写本篇时在 solo 源码里核实根因。
> 场景：派生项目里出现「一次调用天然就要几十秒」的业务方法——批量 LLM 分类、带检索的
> 信息补全、批量回填。这类方法在 Router 转发时一律 10 秒超时，无法配置。
> **依据分两类，本文逐处标注**：
>   · 〔trend 实测〕两个方法被 10s 超时打回、以及绕行方案的代价，来自 trend 的实测；
>   · 〔本次核实〕`forward.js:77` 的三档硬编码、`entity.js` 的写接口面，是写本篇时读源码确认的。
> 涉及：`api/router/handlers/forward.js:77`（主）、`api/library/entity.js`（同族观察）。
> 版本：trend 用 bundle v1.1.14 实测；`forward.js:77` 在 **solo 源码 1.1.15 中依然如此**。

## 一、根因〔本次核实〕

`api/router/handlers/forward.js:77`：

```js
const timeout = method.startsWith('agent') ? 90000 : method.startsWith('gateway') ? 60000 : 10000;
```

超时是**按方法名前缀**决定的三档白名单：`agent*` 90s、`gateway*` 60s、其余一律 10s。
没有环境变量、没有 per-service 配置、没有 per-method 声明。

这里的设计意图是清楚的——框架**承认「有些方法就是慢」**，所以给 `agent` / `gateway` 开了口子。
问题在于**扩展方式是硬编码前缀**：派生项目的方法名遵循 `{service}.{entity}.{action}` 约定
（`brand.*`、`goods.*`、`media.*`…），永远匹配不上这两个前缀，也就永远拿不到更长的超时。
换句话说，这个口子只对 solo 自己的内置服务开放。

## 二、实测现象〔trend 实测〕

trend 里有两个方法天然超过 10 秒，都被打回：

| 方法 | 为什么慢 | 实测 |
|---|---|---|
| `brand.company.enrich` | LLM 两步式检索（先 grounded search 再结构化） | 早期即踩，代码注释已写明"超过 Router 写死的 10s 中继超时" |
| `brand.event.tag` | 批量给事件打类型标签，每批 50 条标题 | `{"error":{"message":"Upstream Service Error (brand): timeout of 10000ms exceeded","code":-32099}}` |

两者最后都只能改成同一套绕行方案，我称之为**「假异步」**：

```js
'brand.event.tag': (p) => {
    Methods.event.tagPending(p || {})            // 不 await，后台跑
        .then((r) => logger.info(`done: tagged=${r.tagged} calls=${r.calls}`))
        .catch((err) => logger.error('background job failed:', err));
    return { started: true };                     // 立即返回，什么都还没做
}
```

**代价是实打实的，而且每个慢方法都要重付一遍：**

1. **调用方拿不到结果。** 返回值只能是 `{started: true}`。trend 里为此写了轮询——
   `company.enrich` 轮询 `enrichedAt` 是否变化，`event.tag` 只能靠数「还剩多少条没有
   `ext.eventType`」来判断进度。每个慢方法都要自己发明一套「怎么算跑完了」。
2. **错误退化成日志。** 后台 promise 的失败只能进 `logger.error`，RPC 层永远是成功。
   调用方无从得知这次到底成没成——这与 solo 自己在
   `inherited-router-url-silent-misdelivery.md` 里认定的问题**是同一类**：
   「返回值不反映真实结果」正是那次静默丢数据的根因之一。这里是框架在**逼**派生项目
   制造同款盲区。
3. **introspection 里的 `returns` 变成谎报。** 本来该声明 `['scanned','pending','tagged','calls']`，
   实际只能写 `['started']`——自描述 API 的信息量被超时机制削掉了。

## 三、建议（按价值排序）

### 建议 1：让方法自己声明超时（推荐）

introspection 的方法定义里已经有 `params` / `returns` / `description` / `ai`，加一个可选
`timeoutMs` 是自然延伸，且**信息就在最该知道它的地方**——写这个方法的人最清楚它要跑多久：

```js
{ name: 'brand.event.tag', params: [...], returns: [...], timeoutMs: 120000, ... }
```

Router 转发时按 `CAPABILITY_MAP[method].timeoutMs || 默认` 取值。需要配一个上限
（如 300s）防止派生项目写出无限长的值。这样 `agent`/`gateway` 那两个前缀特例也能收编成
内置服务自己声明的 `timeoutMs`，`forward.js:77` 那行三元表达式可以整个删掉。

### 建议 2：至少让默认值可配（最小改动）

```js
const DEFAULT_FORWARD_TIMEOUT_MS = Number(process.env.ROUTER_FORWARD_TIMEOUT_MS) || 10000;
```

不解决「不同方法需要不同超时」，但至少让派生项目有条活路，不必为一个慢方法把整套
异步轮询脚手架搭起来。改动一行。

### 建议 3：文档里写清楚这个约束

如果 1/2 都不做，那么至少应在 `docs/authoring/service.md` 里明确写出「Router 转发超时
10 秒，超过必须自行异步化」，并给出推荐的 started + 轮询范式。目前这条约束**只能靠踩**——
trend 是在方法写完、门禁通过、服务重启之后，第一次真实调用才发现的。

## 四、同族观察：`entity.js` 没有批量写接口〔本次核实〕

上面那个 `brand.event.tag` 之所以慢，一半是 LLM，另一半是写回：802 条事件要逐条
`eventEntity.update()`。`api/library/entity.js` 的写接口只有单条的
`create / update / delete`，没有任何批量形式，于是 802 次 Redis 往返 + 802 次 WAL 写入。

批量回填在派生项目里是常见形态（补标签、补元数据、历史数据修正），建议评估加一个
`updateMany(items)`：单次 pipeline 提交、WAL 合并成一条批量记录。这与建议 1 是互补的
——前者让慢方法**有资格**跑完，后者让它**不必那么慢**。

## 五、trend 侧现状

已按「假异步」范式各自绕过（`brand.company.enrich`、`brand.event.tag`），**不构成 DIVERGED**
（改的都是 `api/apps/brand/` 项目自有代码，没动只读区）。若建议 1 或 2 上收，trend 侧可以
把两处的轮询脚手架删掉，改回同步返回真实统计。

## 处理结论（solo 侧）

根因属实，已按建议 2（用户确认，最小改动）修复（2026-08-10）：`api/router/handlers/forward.js`
新增 `DEFAULT_FORWARD_TIMEOUT_MS = Number(process.env.ROUTER_FORWARD_TIMEOUT_MS) || 10000`，
第三档超时（`agent`/`gateway` 前缀之外的全部方法）从硬编码 `10000` 改成读这个常量。`agent`/
`gateway` 两个前缀特例原样保留（未采用建议 1 的 per-method `timeoutMs` 声明——那个方案要连改
`forward.js`/`capability.js`/`service.js` 三处，收益是能按方法精细配置，但本轮用户选择了风险
更小的方案 2；per-method 声明留作后续如果证明默认值不够用再评估）。

trend 侧现状：`brand.company.enrich`/`brand.event.tag` 已用「假异步」绕过，这次修复不需要它们
改代码——但如果想把轮询脚手架换回同步真实返回，把派生栈的 `ROUTER_URL` 所在环境加一条
`ROUTER_FORWARD_TIMEOUT_MS=<足够大的值，如 120000>` 即可（注意这是**全局**默认，会影响这个
Router 转发的所有非 agent/gateway 方法，不是只影响这两个慢方法）。

同族观察（entity.js 缺批量写接口）本轮未处理——那是 `api/library/entity.js` 的功能扩展，不在
router 保护区，但涉及 WAL 批量写入语义设计，本轮聚焦 router 三处已授权改动，未评估。

回归验证：`router/tests/forward.test.js` 全绿（无用例断言旧的硬编码超时值）；`api/jest.ci.config.js`
白名单全量跑过（见下方总验证记录）。
