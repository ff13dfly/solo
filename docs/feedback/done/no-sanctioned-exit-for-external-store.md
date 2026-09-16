# 反馈：业务表想落 Redis 之外，没有一条正规出口 —— 门禁是 ERROR，而框架连配置位都没有

> 来源：bence 派生项目，2026-09-15。起因是给本策（全渠道家居电商）选商品主数据的存储：
> 7.5 万 SKU、22 万条渠道映射、月 15 万单（一年 182.5 万行订单明细），查询形态是
> 多维筛选 + JOIN + 中文搜索 + 报表聚合。实测后判断这部分该落 PostgreSQL，
> 于是撞到这条。
> 依据：**全部自查实测**——autocheck 规则与 `api/library/` 为 solo 仓 HEAD **v1.2.14**
> 源码现读，行号即该版本；性能对比数字来自本机实测（Mac 10 核 / 16 GB，
> redis-stack 7.4.0-v8 与 PostgreSQL 16.14 均为默认配置，临时实例用完即删）。
> 无二手引用。
> 涉及：`api/autocheck/static/entity-factory.js`（门禁）、`api/library/config.js` 与
> `deploy/scaffold/.env.example`（没有配置位）、`api/library/bootstrap.js`（启动面）。
>
> 一句话：**「业务表落别处」这件事，框架既没禁止也没支持——它只是没被想过**，
> 于是落到实处就成了一条 ERROR 级门禁，而唯一的豁免标记语义对不上。

---

## 一、先说清楚诉求不是什么

**不是「去掉 Redis」。** 服务照样连 Redis（`bootstrap.js:42-44` 启动即 `createClient` +
`connect`），WAL 审计流、category、config、session、任务队列全都留在 Redis 上，
Entity Factory 也继续管框架自己的实体。

诉求只有一句：**某几张业务表的行存到别的库里，而这件事不该让门禁变红。**

## 二、实测：`api/apps/` 下写 CRUD 而不用 Entity Factory 是 ERROR

`api/autocheck/static/entity-factory.js` 的判据（`:73-74`）是纯文本启发式——
logic 文件里出现 `async function create` / `async function update` / `async function delete` /
`exports.create` / `exports.update` / `exports.delete` 任一，且文件里不含
`/library/entity` 字样，就算「实现了 CRUD 但没用 Entity Factory」。

分级在 `:81-87`：

```js
if (isAppService) {
    results.errors.push(`❌ [架构] logic/${file} 实现了 CRUD 但未使用共享 Entity Factory ...`);
} else {
    results.warnings.push(`⚠️ [架构] ...（建议重构；...）`);
}
```

`api/apps/` 下是 **error**，`api/core/` 下只是 warning。而 `checker.js:53-55` 见到
error 就 `process.exit(1)` ⇒ **门禁红，CI 挡住**。

唯一的豁免是 `// SAFE: singleton`（定义 `:14`，判断 `:66`），注释（`:64-65`）写明语义是「单例配置类文件
（没有 id / 没有软删除 / 永远只有一份）」。**商品表不是单例配置**，拿它豁免是
把标记的语义用坏——而那条注释恰好还写着「别逼人靠改函数名绕过检查」，
说明作者已经预见了规避行为，只是没预见到「合理地不用 factory」这种情况。

⚠️ 这条规则的实现里还留着当时的犹豫（`:119-123` 原文）：

```
// 如果整个 logic 目录都没有使用 EntityFactory，视情况而定，但如果有 CRUD 文件未用则是 Error
// ...
// 用户指令是 "api/library/entity.js这个部分...必须是强制要求"，这通常指具体的 CRUD 实现。
```

「必须是强制要求」当时针对的是**在 Redis 里各写各的 key**——那确实该禁。
但规则的检测面是「有没有 import 那个文件」，于是连**根本不写 Redis** 的实现
也一并挡住了。

## 三、根因：不是禁止，是没有这个概念

比门禁更能说明问题的是**找不到任何支持面**：

| 面 | 现查结果 |
|---|---|
| `api/library/config.js` 的配置解析 | 只有 `redisUrl` / 端口；**无任何外部存储配置** |
| `deploy/scaffold/.env.example` | 搜 `postgres\|database_url\|mysql\|sqlite` = **0 行** |
| `api/library/` 下的 34 个模块 | 没有一个与非 Redis 存储相关 |
| `api/autocheck/static/` 的 58 条规则 | 没有一条为外部存储准备（豁免、约定、健康检查都没有） |

⇒ 这不是一个「被权衡后否决」的方向，是**从没进入过设计视野**。所以它现在的表现
不是一条清晰的「不许」，而是一条**语义已经漂移的门禁**：规则想说的是
「别绕过 Entity Factory 在 Redis 里乱写 key」，实际拦下的是「别把数据放 Redis 之外」。

## 四、好消息：真正的阻碍比看上去小

现查了可能挡路的其它几处，都不挡：

- **`dependencies.js` 不拦新依赖**：只比对 `express` / `redis` / `cors` / `body-parser`
  四个关键依赖的版本一致性（`:35`），另外禁用一批加密依赖（`:50`：`bcrypt` /
  `crypto-js` / `sha256` / `md5` / `argon2`）。加 `pg` 不触发任何检查。
- **`redis-keys.js`** 只匹配 `redis.get|set|del|hGet|hSet(` 的硬编码 key，不误伤。
- **`redis-transaction.js`** 只查 `.multi()` 有没有配对的 `.exec()`，不误伤。
- **`pagination-safety.js`** 扫的是 `redis.sMembers|hGetAll|keys(` 这类全键扫描，
  SQL 不在它的检测面上。

⇒ **改动面其实只有 `entity-factory.js` 一个文件**。

## 五、为什么这个口子值得开（数据）

本策的量级在 Redis 上不是装不下，是查询形态不匹配。同一批真实数据实测：

| 查询 | Entity Factory + RediSearch | PostgreSQL |
|---|---:|---:|
| 列表第一页（排序+分页） | 1.2 ms | 0.10 ms |
| 中文名搜索 | 0.5 ms，**召回 9.7%**¹ | 0.03 ms，召回 100% |
| 按品牌聚合 top10 | 66 ms | 12.5 ms |
| JOIN 渠道映射 / BOM 展开 / JSONB 属性筛选 | **没有原语**² | 0.04–0.21 ms |

¹ 见 `redisearch-cjk-both-paths-blocked.md`（同批实测的另一条反馈）。
² `entity.list()` 的 filter 一律在取回之后跑（`entity.js:791-795`、`:884-889`），
一个只命中 50 个 SKU 的品类查询，成本等于翻完整个集合。

这与框架自己的判断也一致：`api/apps/storage/logic/asset.js:296-297` 写着
「A real fix needs RediSearch … intentionally deferred」；`BACKLOG.md:135` 把二级索引
列为「成本最高、收益依赖量级 ⇒ 排最后」。**量级到了的项目需要一条出路，
而不是等那一项被做完。**

## 六、建议（按价值排序）

1. **给 `entity-factory.js` 加一个正规豁免标记**，例如 `// SAFE: external-store`，
   与现有的 `// SAFE: singleton` 同一形状（`:64-69` 那段照抄即可）。改动约 4 行。
   **这是最小且完整的解法**——它把「合理地不用 factory」从「靠改函数名规避」
   变成「显式声明并留痕」，反而更容易审计：`grep -rn 'SAFE: external-store'`
   一把就能扫出全部这类服务。
2. **把规则的检测面收紧到它真正想管的事**：判据从「有没有 import entity.js」
   改成「有没有绕过 factory 直接写 Redis 业务键」（即文件里出现 `redis.set|hSet|sAdd`
   等写操作却没有 `/library/entity`）。这样既保住原意，又天然放过根本不碰 Redis 的实现。
   比方案 1 准确，但改动大、可能影响存量服务的判定，**建议排在 1 之后**。
3. **`.env.example` 与 `config.js` 留一个可选的外部存储配置位**（如注释掉的
   `DATABASE_URL=`），哪怕框架自己不消费它——它的作用是把「这条路是允许的」
   写进默认文档面，省掉每个项目各自发明一次。
4. **`service.md` 加一节「什么时候不该用 Entity Factory」**，给出判据
   （多维筛选 / JOIN / 聚合报表 / 全文检索是主要查询形态时）与代价
   （行隔离 `$owner`、`sensitiveFields` 掩码、WAL 审计这三样都要自己接回来——
   这才是这条路真正的成本，而不是门禁）。

⚠️ 方案 1～3 都不改变默认行为：不写那行注释的服务，判定与今天完全一样。

## 处理结论

### 复核（2026-09-16）

§二复现：在 `api/apps/` 下造一个只写 PostgreSQL、不 import `library/entity` 的
`logic/product.js`，`checker.js --static` 报

```
❌ [架构] logic/product.js 实现了 CRUD 但未使用共享 Entity Factory (必须统一标准；
   若确为单例配置（无 id，永远只有一份），在文件任意位置加 `// SAFE: singleton` 豁免)
```

退出码 1。同一份代码放 `api/core/` 下只是 warning —— 分级与本文所述一致。
§四「改动面只有 `entity-factory.js` 一个文件」也成立：加了标记之后，同一份
PostgreSQL 实现在门禁下只剩既有的通用 warning，没有任何其它规则被触发。

### 落地（v1.2.15）

- ✅ **建议 1：加 `// SAFE: external-store` 正规豁免**（`autocheck/static/entity-factory.js`）。
  照 `SAFE: singleton` 的形状，判定与文案都独立——`passed` 里两种豁免的措辞可区分，
  审计时看得出是哪一种。**默认行为一字未变**：不写标记的服务判定与今天完全一样。
  同时把 ERROR 的 hint 改成**两个出口都给**，并在其中点明代价（`$owner` / `sensitiveFields` /
  WAL 三样要自己接回来）——本文§二指出提示只给 singleton 会把人引向用坏语义，这条正是修它。
- ⏸ **建议 2：把检测面收紧到「有没有绕过 factory 直接写 Redis」** —— 本轮不做，
  同意本文「排在 1 之后」的判断。理由补一条本文没写的：那个判据会把**只读**服务
  （查询侧、报表侧，根本没有写操作）一并放过，而它们恰恰是最该被问一句「为什么不用 factory」的。
  建议 1 已经把「合理地不用」从规避变成了显式声明，收紧检测面的收益随之变小。
- ✅ **建议 3：`.env.example` 留配置位** —— 加了，但**刻意只加注释 + 一行被注释掉的
  `DATABASE_URL=`**，没有在 `library/config.js` 里加解析。理由：框架自身不消费它，
  真加进 config 就是一个没人读的字段，而 solo 自己有 DeadConfig 检查在抓这种东西。
  注释里写明「变量名由你的服务自己定义和读取」，把「这条路是允许的」写进默认文档面
  ——这正是本文说的那个作用。顺带把新开关 `REDISEARCH_MAXPREFIXEXPANSIONS` 也写了进去。
- ✅ **建议 4：`service.md` 新增 §6.8「什么时候不该用 Entity Factory」**：
  默认答案仍是「用」→ 四条命中判据（>50 万行 / JOIN / 聚合报表 / 结构化属性筛选）→
  走法（写标记，别改函数名）→ **三样代价的对照表**。§7 自查加第 11 条。
  同步改了 `deploy/scaffold/.claude/skills/solo-service/SKILL.md` —— 下游 AI 读的是它，
  那边原本只有一句「Entities go through the Entity Factory」，没有出口。
- ✅ **回归测试**：新建 `api/autocheck/tests/entity-factory-rule.test.js`（7 例：
  apps=ERROR / core=warning 的分级、hint 含两个出口、两种标记各自放行且文案可区分、
  裸字符串不构成标记），并加进 CI 白名单。**autocheck 的静态规则此前一个测试都没有**
  ——这条规则是唯一决定「不用 factory 算不算 ERROR」的地方，值得钉住。

### 一句值得单记的

本文最有价值的是**把「没有被想过」和「被否决了」分开**：现状表（config 无外部存储项 /
`.env.example` 0 行 / 34 个 library 模块无一相关 / 58 条规则无一为它准备）证明的不是
一条清晰的「不许」，而是一条**语义已经漂移的门禁**——规则想说「别绕过 factory 在 Redis 里乱写 key」，
实际拦下的是「别把数据放 Redis 之外」。

⇒ 判据可一般化：**当一条规则的实现判据（有没有 import 某文件）与它的意图（别绕过某个抽象）
不是同一件事时，它迟早会拦住意图之外的东西**。这类规则要么把判据修到与意图重合（建议 2），
要么给意图之外的合理情况留一个**显式且留痕**的出口（建议 1）。
本仓库里同形状的另一处是 `pagination-safety` 的 `// SAFE:` 约定。

