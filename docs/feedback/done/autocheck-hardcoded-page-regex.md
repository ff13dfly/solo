# 反馈：autocheck「硬编码分页数字」的正则少了右边界，把 `= 10000` 报成 `1000`

> 来源：trend 派生项目，2026-08-06 升到 v1.1.14 后跑门禁时发现。
> 依据：本机实测 + 可复现的正则片段（见第二节）。
> 涉及：`api/autocheck/static/config-check.js:96`。
> 影响面：所有在 `logic/` 里定义过 `*_LIMIT = <5 位以上数字>` 常量的服务。
>
> **状态：已上收**（2026-08-06，建议 1/2 采纳、建议 3 判定不做，见文末「处理结论」；随下一个 v1.1.x 发版下发）。
>
> 一句话：一条 `(?!\d)` 的事，但它每次门禁都会喊，而且喊的是**不存在的数字**，
> 排查的人得先去读代码才能确认是误报。

---

## 一、实测现象

trend 三个服务的 `--static` 门禁里，7 条「硬编码分页数字」全部是误报：

```
⚠️ [配置] logic/company.js:14: 硬编码分页数字 1000，建议改为 config.pageSize
⚠️ [配置] logic/event.js:7:   硬编码分页数字 1000，建议改为 config.pageSize
⚠️ [配置] logic/person.js:14: 硬编码分页数字 1000，建议改为 config.pageSize
⚠️ [配置] logic/channel.js:6: 硬编码分页数字 1000，建议改为 config.pageSize
⚠️ [配置] logic/product.js:6: 硬编码分页数字 1000，建议改为 config.pageSize
⚠️ [配置] logic/rank.js:6:    硬编码分页数字 1000，建议改为 config.pageSize
⚠️ [配置] logic/series.js:9:  硬编码分页数字 5000，建议改为 config.pageSize
```

而这些行上**根本没有 `1000` 或 `5000`**，代码是：

```js
// 不是分页参数——create 的 (companyId, url) 幂等去重需要扫全部事件（含已删除）逐一比对，
// 与列表接口的分页语义无关。
const DEDUP_SCAN_LIMIT = 10000;

// series 是全服务增长最快的实体（关键词 × 天 + 商品 × 天），先给出高限，
// 越过它就该按 config.js 里的注释上 RediSearch 索引，而不是继续调大数字。
const SERIES_SCAN_LIMIT = 50000;
```

七处每一处都带着注释说明它是**去重/diff 的全量扫描上限**，与分页语义无关——也就是说
这条规则想抓的问题（把 pageSize 写死在代码里）在这里一个都不存在。

## 二、根因与复现

`config-check.js:96`：

```js
const hardcodedPagePattern =
    /(?:\.slice\s*\(\s*(?:offset\s*,\s*)?(\d{2,4})\s*\)|(?:limit|LIMIT|pageSize)\s*[=:]\s*(\d{2,4}))/g;
```

`(\d{2,4})` **没有右边界**，在 `10000` 上匹配掉前 4 位就收工。而
`(?:limit|LIMIT|pageSize)` 又能匹配 `DEDUP_SCAN_LIMIT` 的词尾 `LIMIT`，两者一叠加，
任何 `*_LIMIT = 10000` 形式的常量都会被报成「硬编码分页数字 1000」。

现有的三条豁免（注释行 / 同行出现 `pageSize` / 文件名含 seed·test·mock，`:104-111`）
都覆盖不到这种写法。

复现（node）：

```js
const re = /(?:\.slice\s*\(\s*(?:offset\s*,\s*)?(\d{2,4})\s*\)|(?:limit|LIMIT|pageSize)\s*[=:]\s*(\d{2,4}))/g;
re.exec('const DEDUP_SCAN_LIMIT = 10000;')   // → 命中 "1000"
re.exec('const SERIES_SCAN_LIMIT = 50000;')  // → 命中 "5000"
re.exec('const LIMIT = 100;')                // → 命中 "100"   ← 真警告
```

## 三、建议

1. **加右边界**，两个捕获组各加一个 `(?!\d)`：

   ```js
   const hardcodedPagePattern =
       /(?:\.slice\s*\(\s*(?:offset\s*,\s*)?(\d{2,4})(?!\d)\s*\)|(?:limit|LIMIT|pageSize)\s*[=:]\s*(\d{2,4})(?!\d))/g;
   ```

   实测（同上三个样本）：两条误报消失，真警告 `const LIMIT = 100;` **仍然命中**。

2. **（可选）给这条规则加 `// SAFE:` 豁免**，与同目录 `pagination-safety.js:28` 的既有约定
   一致（那条规则已经支持 `// SAFE: small` 单行豁免）。同一套检查里两条相邻规则、一条有
   豁免口子一条没有，写代码的人会以为标了没用。

   有了豁免口子，像 `SERIES_SCAN_LIMIT = 50000` 这种「确实是个大数字、但确实不是分页」的
   情形就有了正规的消音方式，不必去改常量名迁就检查器。

3. **顺带一提命名耦合**：这条规则实际是靠标识符里出现 `limit|LIMIT|pageSize` 来定位的，
   所以任何叫 `*_LIMIT` 的常量都会进入判定。加了右边界之后误报会大幅收敛，但如果之后还想
   更准，可以要求 `limit`/`pageSize` 是**完整标识符**（前面加 `\b(?<![A-Za-z_])`），
   这样 `DEDUP_SCAN_LIMIT` 从一开始就不进判定。这条优先级低于前两条。

## 四、为什么值得改

单看是 7 条无害的黄字。但门禁输出是给人扫一眼用的——trend 这三个服务一共 42 条 warning，
其中 7 条（1/6）是这一个正则造成的**指向不存在数字**的误报。噪音多了，真警告就被淹没，
最后变成「反正它一直在喊，不用管」。

这跟 v1.1.14 刚治的「三层假绿」是同一类病，只是方向相反：那次是**该报的没报**，
这次是**不该报的一直在报**，终点都是「这个信号不可信了」。

---

## 处理结论（solo 侧，2026-08-06）

根因复核成立（`(\d{2,4})` 无右边界 + `LIMIT` 词尾匹配叠加），node 一行即复现。逐条：

1. ✅ **右边界采纳**：两个捕获组各加 `(?!\d)`，与建议逐字一致。验证走了两层——
   8 组样本的正则单测（两条五位数误报消失、`LIMIT = 100` 真警告保留），以及真实
   `config-check.check()` 跑 fixture 服务确认端到端行为。
2. ✅ **`// SAFE:` 豁免采纳**：与同目录 `pagination-safety.js:28` 同一约定（`lineText.includes('// SAFE:')`）。
   同意"相邻规则一条有豁免口子一条没有，标了没用"的观感问题；`SERIES_SCAN_LIMIT = 50000`
   这类"确实是大数字、确实不是分页"从此有正规消音方式。fixture 里验证了豁免行不再报。
3. ❌ **完整标识符边界（`(?<![A-Za-z_])`）不做**：它会把 `page_limit = 20` 这类**真警告**
   （下划线命名的分页量）一并排除；右边界 + 豁免已把已知误报清零，这条的增量收益
   不抵损失。反馈自己也标了"优先级低于前两条"，判定一致。

落地：`api/autocheck/static/config-check.js`（随 `upgrade.sh` 的 `api/autocheck` 整目录
替换下发）。trend 那 7 条误报在下次升级后消失；`SERIES_SCAN_LIMIT` 若想显式消音可加
`// SAFE:` 标注。记入 CHANGELOG `[Unreleased]`。
