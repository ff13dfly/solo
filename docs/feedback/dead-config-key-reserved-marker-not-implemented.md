# 反馈：`dead-config-key` 的 `// RESERVED:` 豁免是**文案里承诺、代码里不存在**的

> 来源：catalog 派生项目（本策商品主数据），2026-09-16。起因是新写的只读服务
> `api/apps/catalog/` 过静态门禁时被这条规则 WARN，照着报错文案加注释、加了两遍都没用。
> 依据：**全部自查实测**——bundle **v1.2.14** 随 scaffold 下发的
> `api/autocheck/static/dead-config-key.js`，行号为该文件。无二手引用。
> 涉及：`api/autocheck/static/dead-config-key.js`（唯一涉及文件）。
>
> 一句话：报错说「如为预留配置请加 `// RESERVED:` 注释」，而**这个文件从头到尾
> 没有一处读取注释**——照做没有任何效果，规则也不会因此闭嘴。

---

## 一、实测

服务 `api/apps/catalog/` 的 `config.js` 声明了 `idLengths`，但该服务**不生成 ID**
（主键是两个外部 ERP 发的业务编码，原样沿用），因此 `logic/` 与 `index.js` 里没有引用点。

```
⚠️ [DeadConfig] config.js 定义了 `idLengths` 但在 logic/ 和 index.js 中未找到引用。
   如为预留配置请加 `// RESERVED:` 注释，否则可能是"飞单"遗留。
```

按文案照做，两种写法都试过，**WARN 一字不变**：

```js
// 写法 A：注释独占一行，紧贴声明上方
// RESERVED: 本服务不生成 ID —— 主键是两个 ERP 发的业务编码，原样沿用
idLengths: { sku: 21, supplier: 12 },

// 写法 B：注释放在声明的行尾
idLengths: {   // RESERVED: 本服务不生成 ID，留给将来的自建实体
    sku: 21,
    supplier: 12
},
```

## 二、根因：这个检查器只做「key 字面量是否出现在源码里」的匹配，从不看注释

`api/autocheck/static/dead-config-key.js`（v1.2.14）：

- `:68-92` 收集服务源码：递归 `logic/` `handlers/` 等子目录 + `index.js`，
  **刻意排除 `config.js` 本身**（注释说明：把定义处算作引用会让检查永远通过）。
- `:106-111` 判定引用的三个正则，全部针对 **key 名**，与注释无关：
  ```js
  new RegExp(`\\.${key}\\b`),      // config.key
  new RegExp(`\\['${key}'\\]`),     // config['key']
  new RegExp(`["']${key}["']`),     // 字符串形式
  ```
- `:112-118` 三者都不命中 → push 警告，文案里写上 `// RESERVED:`。

⇒ **整个文件搜不到 `RESERVED` 之外的第二处**——它只出现在那句报错文案里，
没有任何代码消费它。规则的其它同门（`pagination-safety.js` / `entity-factory.js` /
`event-listener-leak.js`）都真的实现了 `// SAFE:` 标记的读取，所以「autocheck 的注释标记
是会被读的」是一个合理预期，这条打破了它。

## 三、为什么值得修（而不是"一个 WARN 而已"）

1. **它教人做一件没用的事**。照文案做完、WARN 还在，下一步的合理推断是"我注释写错位置了"，
   于是换写法再试——本次实测就花在这上面。
2. **它把唯一的出路变成"删掉那个 key"**。而 `idLengths` 恰恰是 `config-check.js` 列为
   **推荐字段**的（缺了另有一条 WARN）。两条规则一进一退，作者只能在两个 WARN 之间挑一个，
   却没有"这个字段是有意预留的"这个表达方式——而那正是文案承诺过的。
3. **降低了 `// SAFE:` 家族的可信度**。注释标记之所以有用，是因为它可靠；
   出现一个"写了也没用"的标记之后，作者对其它标记也会先怀疑再用。

## 四、建议（按价值排序）

1. **实现它**（约 6 行，与 `pagination-safety.js` 的 `// SAFE:` 同形状）：读 `config.js` 原文，
   若 key 声明行的上一行或行尾含 `// RESERVED:`，跳过该 key。
   注意**只能扫 `config.js`**——第 `:70-72` 行的注释已经解释了为什么不能把 config.js
   算进"引用源"，读注释是另一回事，不冲突。
2. **或者改文案**，把承诺去掉，直说「预留配置请删除，用到时再加」。
   比留一个不存在的出口好，但比 1 差：预留字段是真实存在的需求
   （scaffold 自己下发的 `config.js` 模板里就有一堆注释掉的示例块）。
3. 顺带：`api/sample/config.js` 里若能给一个 `// RESERVED:` 的正例，
   作者第一次遇到这条 WARN 时就不用猜写法。

## 处理结论

（待 triage）
