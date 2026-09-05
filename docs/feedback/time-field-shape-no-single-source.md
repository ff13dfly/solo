# 时间字段的「形态」没有单一真源：标准只活在一句注释里，兜底能力不外借

> 来源：steward，2026-09-04。起因是一个纯事实提问「monitor 上那个『最后报到』存的是时间戳吧？
> Solo 不是规定过实体时间的存法吗」，顺着查下去，在一个仓库里挖出 **7 处线上读端 bug**。
> 依据：**全部本次实测**（steward 栈，bundle **v1.2.12**，N100 生产库实际记录核对 + 全仓
> 静态扫描 + hermetic 单测反向验证）。唯一的引用已标注：`entity-factory-bypasses-clock.md`
> （finance，2026-08-25）——那篇讲 `entity.js` 不走 clock，**与本篇不是同一件事**，
> 本篇讲的是「形态」（number vs ISO string），不是「时间源」。
> 涉及：`api/library/entity.js:14-34`（标准的唯一出处 + 不导出的兜底）、
> `api/library/validate.js:102-106`（type 硬校验把形态锁进契约）、
> `docs/authoring/modeling.md` · `service.md`（零约定）、各服务 `handlers/entities.js` 的
> `type: "datetime"`。
>
> 一句话：`Date.parse(1788488514012)` 返回 **NaN**，而框架的时间字段恰好有两种形态、
> 标准只写在一句内部注释里、唯一写对了的兜底函数 **不导出**——于是同一个 bug
> 在每个服务、每个前端、每个运维脚本里各犯一遍，且**全部静默**。

---

## 一、标准存在，但它只是一句注释，而且是私有的

`api/library/entity.js:14-26`，`toSortableMs` 的头注：

> The factory standard is epoch ms (`clock.now()` / `Date.now()`), but a few services store
> the timestamp as an ISO-8601 string instead (storage assets, user passport/bot). A raw
> numeric subtract on an ISO string yields NaN, and a comparator that returns NaN makes
> `Array.sort` a no-op — so "newest-first" would silently degrade to the unordered Redis-SET
> order. Coercing both shapes to ms keeps ordering correct regardless of stored format.

这段注释是**全仓唯一**说明「时间字段是 epoch ms」的地方。它同时承认了三件事：

1. 标准是 epoch ms；
2. 已经有服务偏离（框架自己带的 storage / user 就在偏离）；
3. 混形态会让排序**静默失效**——不是报错，是不排序。

然后 `toSortableMs` 在 `module.exports`（`entity.js:989-1001` 只导出
`STATUS_ACTIVE` / `STATUS_DELETED` / `walContext` / `requestContext`）里**没有出口**。

⇒ 框架知道这个坑、写好了唯一正确的处理、把它锁在了模块内部、只用于自己的排序。
服务要处理同一个坑，只能各写一遍。

## 二、代价：一个仓库里 7 处静默 bug，全部是同一个病

steward（三个业务服务 + 一个 React 看板 + 一个 Chrome 扩展 + 运维脚本）全量扫描结果。
**每一处都独立于任何迁移，是当前线上正在发生的**：

| # | 位置 | 表现 |
|---|---|---|
| 1 | `client/plugin/lib/scriptgen.js:724` | 摸排缓存 `Date.parse(x.probedAt)` → NaN → 0 → `now - 0 < 24h` 恒 false ⇒ **缓存永不命中，每次重新活摸整站**。症状反直觉：登录着走服务端（数字）反而慢，掉线走本地缓存（ISO）反而快 |
| 2 | `api/apps/scout/logic/capture.js:59` | `Date.parse(capturedAt) \|\| Date.parse(createdAt) \|\| 0`，第二个 fallback 恒 NaN ⇒ 缺 `capturedAt` 的快照索引 score 落 **0**，且「只升不降」逻辑把这个 0 **永久钉住** |
| 3-4 | `api/apps/steward/logic/page.js:123,149` | 同 #2，路由名录 score 落 0；其中一处在一次性回填里，**存量数据被一次写错** |
| 5-6 | `client/monitor/src/modules/{api,script}/index.tsx` | `Date.parse(updatedAt \|\| createdAt) \|\| 0` ⇒ 比较器恒 0 ⇒ `Array.sort` 退化，列表**不排序**。与 `entity.js:14-26` 注释描述的病一字不差，只是搬到了前端 |
| 7 | `client/monitor/.../CaptureDetail.tsx:45` | `Math.abs(Date.parse(createdAt) - Date.parse(capturedAt)) > 10min` ⇒ `NaN > x` 恒 false ⇒ 「插件采集时刻 vs 服务端收到时刻」的漂移提示**从来没显示过**，而它正是断网补传场景最该出现的那个 |

另有 2 处死代码（`integrations/dispatch-script.js` 的幂等命中判定恒 false）与 1 处**未来地雷**
（`background.js:889` 用 `Date.parse(capturedAt)` 构造幂等键，一旦该字段迁成数字，所有
requestId 塌成 `taskId-0`，跨清空撞键 ⇒ 采集数据被当重复投递吞掉）。

**关键观察**：这 7 处分布在 3 个服务、2 个客户端、1 个脚本，由不同时期的改动引入。
没有任何一处是「写得马虎」——每一处单看都是合理的 `A || B` 兜底写法，作者不知道
A 和 B 是两种类型。**没有共同原语时，踩过的坑不会传播。**

## 三、契约层把形态锁死了，于是迁移不是改一行

`api/library/validate.js:102-106` 对 `type` 是硬校验。服务一旦把时间参数声明成
`type: 'string'`，传数字就被 `-32602` 拒。steward 有三处这样的声明：

- `api/apps/scout/handlers/introspection.js:26` — `CAPTURED_AT { type:'string', maxLength:40 }`
- `api/apps/steward/handlers/introspection.js:81` — `PAGE_CAPTURED_AT { type:'string' }`
- `api/apps/steward/handlers/introspection.js:169` — `RUN_STARTED_AT { type:'string' }`

⇒ 把这些字段迁到 factory 标准，必须**同时**改：服务端写入、introspection 声明、
所有客户端的发送形态、以及任何拿该字段拼幂等键的地方。一个本该是「换个存法」的改动，
变成一次跨端协同发版。

而 `handlers/entities.js` 里的 `type: "datetime"`（steward 一家就有 28 处）
**既不区分 ISO 还是 ms，也不被 `validate.js` 校验**——它对读端不提供任何信息。
「这个字段是什么形态」在整个契约面上**无法表达**。

## 四、建议（按价值排序）

1. **导出 `toSortableMs`，并补一个不静默的 `toMs`**（返回 `number | null` 而非 0）。
   `toSortableMs` 的「取不到落 0」适合排序，不适合做差、比较新鲜度——#1 那个 bug
   即使用了 `toSortableMs` 也照样错（0 会让「24 小时内」判成 false）。两个都给。
   **这是投入产出比最高的一条**：本篇 7 处 bug 有 6 处只需换成这个调用。
2. **把标准从注释提到 `docs/authoring/modeling.md`**，并给 `type: "datetime"` 一个明确定义
   （是 epoch ms；ISO 字符串用别的 type 名）。现状是新服务作者**没有任何途径**知道这条标准
   ——除非他恰好去读 `entity.js` 内部一个私有函数的头注。
3. **autocheck 加一条静态规则**：`Date.parse(` 作用在已知 factory 字段
   （`createdAt` / `updatedAt` / 任何 `entities.js` 里标了 `datetime` 的）上就报 WARN。
   这类 bug 的共同特征是「语法合法、类型检查通过、单测全绿、只在真数据上错」，
   除了静态规则没有别的抓法。
4. **框架自带服务的偏离该收敛**（storage assets / user passport 存 ISO）。注释里那句
   "a few services store the timestamp as an ISO-8601 string instead" 是在描述现状，
   但正是这个现状让「标准」变成了「建议」——服务作者看到框架自己都不遵守，就没有理由遵守。

## 五、本地已做的处置（不等上游）

steward 侧已按建议 1 的形状自建了 **6 份**同样的 `toMs`（服务端 3 份、前端 1 份共享原语、
插件 1 份、运维脚本 1 份），并修掉了上述 7 处 bug + 1 处地雷加了警示注释。
**这 6 份就是本篇的证据**：它们本该是 `require('../../library/entity').toMs` 一行。
上游导出后，本地这几份可以直接删。

---

## 处理结论（2026-09-04 核实，**结论=采纳，建议 1/2/3 已落地 v1.2.13；建议 4 暂缓**）

**报告属实，且比它自己说的更值钱**——本篇是与 solo 侧同日独立发起的排查（solo 会话当时正
在查「autocheck 为什么检测不出时间串」）撞在一起的，两边结论一致、证据互补：solo 侧查清了
**为什么没人拦得住**（三层同时静默），本篇给出了**代价有多大**（一个仓库 7 处线上 bug）。
本篇的 §二是决定性的：没有它，这一版只会做写侧，而**线上真正在错的是读侧**。

### 建议 1 —— ✅ 已做，但落在 `clock.js` 而不是 `entity.js`

`api/library/clock.js` 导出两个：

- `toMs(v)` —— 严格档，解析不了**抛错**（不是返回 null）。
- `toMsOr(v, fallback = null)` —— 容错档，解析不了返回 fallback。
  `toMsOr(v, 0)` 就是本篇要的 `toSortableMs`；`toMsOr(v)` 就是本篇要的「不静默的 toMs」
  （返回 `number | null`）。**没有把 `toSortableMs` 这个名字导出去**：它的语义是"排序键"，
  名字里没有这层意思，直接外借正是本篇 §四.1 警告的那个坑（#1 那个 bug 用它照样错）。
  把「落什么值」做成显式参数，调用点自己回答，比记住两个函数名可靠。

**为什么正主放 `clock.js`**：它是时间模块，`entity.js` 是实体模块。
但本篇 §五说得对——服务作者的第一反应是 `require('.../library/entity')`。
所以 `entity.js` 也转发了一份（`module.exports.toMs` / `toMsOr`），两条路都通。
`entity.js:toSortableMs()` 已改为委托，顺带补掉它原有的两个窟窿：`NaN` 输入此前原样返回
（比较器返回 NaN ⇒ `Array.sort` 变 no-op，**正是它自己想躲的坑**）、`Date` 对象此前落 0。

⇒ **steward 侧那 6 份手写 `toMs` 现在可以删了**（升到 v1.2.13 之后）。

### 建议 2 —— ✅ 已做，但用 `format` 而不是「换个 type 名」

标准已从注释提进两处**会随升级下发**的文档：

- `docs/authoring/modeling.md` §3 「★ 时间字段：一律 epoch ms，例外必须声明」——
  含四种错法的对照表（做差 / 排序 / `Date.parse` / `zAdd` score）、`entities.js` 怎么写、
  读侧该调什么，以及「做时间差别用 `|| 0` 兜底」这条（本篇 #1 的形状）。§6 自查表加一行。
- `.claude/skills/solo-service/SKILL.md` 的红线清单——此前时间那条是**唯一没有门禁标注**的。

**没有采纳「ISO 用别的 type 名」**：`type` 是 Portal 的渲染提示
（`RendererRegistry` 按 `datetime` 注册渲染器），改名会让这些字段掉出时刻渲染。
改为新增可选 `format: 'iso' | 'epoch-ms'`（缺省 = epoch ms）：`type` 继续回答"怎么显示"，
`format` 回答"怎么存"。本篇 §三说的「`type:"datetime"` 对读端不提供任何信息」，
补的就是这一格。已给 `apps/storage.asset.createdAt`、`core/user.user.last` 标上。

### 建议 3 —— ✅ 已做，且比要求的更严

`api/autocheck/static/clock-check.js`，四条判据：

| 判据 | 级别 |
|---|---|
| 对声明为数值时刻的字段调 `Date.parse()`（**本篇 §二那半**） | **ERROR** |
| 字段声明为数值时刻，实际写入 ISO 串（含经一跳同文件变量） | **ERROR** |
| 时间字段写 ISO 但从未声明形态 | WARN |
| 时间字段用裸 `Date.now()`（应走 `clock.now()`） | WARN |

本篇建议的是 WARN，实际定 ERROR——因为这两档都是**可证伪的自相矛盾**，
不是风格偏好。拿 steward HEAD（修复前）实跑：**scout 1 + steward 2 + hive 3 = 6 条 ERROR**，
本篇 §二表里的服务端三处（#2 · #3 · #4）全部命中。

两处必须记下来的**假阳性**，都是实测撞出来的：

- **手写的 `toMs` 兜底函数本身**。`if (typeof x === 'string') { Date.parse(x) }` 是对的，
  不能报——steward 的 `hive/logic/node.js:lastSeenMs()` 触发过。已加类型守卫豁免（回看 3 行 + 当前行）。
- **给 `createdAt`/`updatedAt` 兜隐式 'ms' 默认**（理由是 Factory 盖戳用的就是 `Date.now()`）。
  试过，撤了：finance `insight/logic/passwd.js:104` 写的是 **user 服务（bundle 自带）的记录**，
  那条本来就是 ISO、作者还就地注了原因。**服务写别家记录时，形态不由本服务决定。**
  撤掉之后一条真阳性也没少——scout/steward/finance 本来就都显式声明了 `createdAt: datetime`。

⚠️ **够不着的部分**：autocheck 只扫 `api/apps/<svc>/`。本篇 7 处里 **#1（插件）、#5 #6（monitor
前端）、#7（monitor 前端）在 `client/` 下，规则一处也拦不住**，那 2 处死代码与 1 处未来地雷同理。
别把「门禁绿了」读成「这类 bug 没有了」。前端要同款保护得另起一条（tsc 类型层更合适）。

### 建议 4 —— ⏸ 暂缓（框架自带服务的 ISO 偏离不收敛）

本轮查清了它比本篇估的贵：那些字段**在 introspection 字段表里被显式声明成 `type:'string'`
并注了 `// ISO string`**（`core/user/handlers/introspection.js:45,84,96,108`、
`apps/storage/handlers/introspection.js:18,42`），`core/administrator/GUIDE.md:42` 也明写
「时间字段都是 ISO-8601 字符串」。那不是漂移，是**已发布的 RPC 契约**——收敛要同时动
introspection 类型、GUIDE、以及每个既有部署里的存量数据，远超 patch 量级。

但本篇「框架自己都不遵守，服务作者就没有理由遵守」这句的要害已经处理了一半：
这些例外现在是**被声明的**（`format: 'iso'` / `type: 'string'` + 门禁认这个声明），
而不是无人知晓的偏离。**留给单独一版 + 迁移脚本**，与
[`entity-factory-bypasses-clock.md`](./entity-factory-bypasses-clock.md) 的建议 3 是同一件事，
两篇都指向它。

### 与另一篇的关系

[`entity-factory-bypasses-clock.md`](./entity-factory-bypasses-clock.md)（finance，2026-08-25）
讲**时间源**（`Date.now()` vs `clock.now()`，测试冻不住），本篇讲**形态**（number vs ISO）。
两条独立的病，共用同一个缺口：`SKILL.md` 的红线里时间那一块没有执行面。
v1.2.13 把那个缺口补上了，两篇的「建议 2 / 建议 3」因此同时结案；
那篇的**建议 1（`entity.js` 7 处 `Date.now()` → `clock.now()`）仍未做**，
⚠️ 本版给 `entity.js` 加的那行 `require('./clock')` 是读侧归一，别读成那件事已完成。

### 本篇状态

留在 `docs/feedback/` 顶层（未进 `done/`）：建议 4 还没做完。
