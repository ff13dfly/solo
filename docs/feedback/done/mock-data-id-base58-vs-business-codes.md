# mock-data 的 Base58 ID 检查把「ERP 发的业务编码」判成非法（ERROR，且只在单测文件里触发）

- **来源**：catalog，2026-09-20，「组合品候选（同单共现）」落地实测
- **场景**：本服务的主键**不是我们生成的** —— SKU 编码、款号都是聚水潭 / 吉客云两个 ERP
  发的业务编码（`C1108`、`C2804`、`A0022`、`B0.35D`、甚至「直接贴」这种中文）。
  服务本身**不生成任何 ID**（`config.js` 里刻意没有 `idLengths`）。
  单测里断言查询结果时自然会写出这些真实编码。
- **依据分类**：以下**全部为本次实测**（catalog 栈，bundle v1.2.14，本机 macOS）。
- **级别**：ERROR —— `checker.js --static` 直接 FAILED，`deploy/precheck.sh` 挡住部署。

## 实测现象

给 `api/apps/catalog/tests/query.test.js` 加了两条断言：

```js
expect(out.items[0].a).toMatchObject({ id: 'C1108', rep: 'C1108A' });
expect(out.items[0].b).toMatchObject({ id: 'C2804' });
```

门禁当场红：

```
❌ [Mock] query.test.js: ID "C1108" 包含 Base58 非法字符: 0
❌ [Mock] query.test.js: ID "C2804" 包含 Base58 非法字符: 0
❌ RESULT: FAILED - Please fix errors before deployment.
```

`C1108` 是聚水潭的商品编码「地漏水槽过滤网袋（100只装）」，`C2804` 是「抽取式滤网收纳盒」。
它们里面的 `0` 是客户 ERP 里的真实字符，不是我们能选的。

**同一个文件里此前一直是绿的**，因为过去的断言恰好没命中这个字面形状
（`expect(out.total).toBe(4242)` 之类），或者 ID 短于 4 字符被跳过了。
⇒ 这条规则是否触发，取决于**断言写成什么句式**，而不是数据对不对。

## 根因

`api/autocheck/static/mock-data.js:96-113`

```js
const idMatches = content.matchAll(/['"]?id['"]?\s*:\s*['"]([^'"]+)['"]/g);
for (const match of idMatches) {
    const id = match[1];
    if (id.includes('$') || id.includes('{') || id.length < 4 || id.includes('-')) continue;
    if (!BASE58_REGEX.test(id)) {
        const illegalChars = id.match(/[0OIl]/g);
        if (illegalChars) results.errors.push(`❌ [Mock] ... 包含 Base58 非法字符 ...`);
    }
}
```

两处假设不成立：

1. **「`id:` 后面的字符串都是我们生成的 ID」**。规则按**字面形状**抓，抓到的是
   任何 `id: '…'`，包括：断言里的期望值、桩数据里的外部编码、以及一切镜像型服务的主键。
   Solo 自己生成的 ID 用 Base58 是对的；但**下游服务的主键常常是别人发的**
   （ERP 编码、条码、第三方平台 itemId、快递单号），它们必然含 `0`。
2. **文件名被当成 mock**。这条规则跑在 `tests/*.test.js` 上，而 hermetic jest 单测里
   出现真实业务编码是**正常且必要的** —— 用假编码写断言，测的就不是真形状了。

## 顺带发现：规则不跳注释

写"为什么这里不能那么写"的注释时，注释里必然要引用那个被禁的写法 ——
于是**讲这件事的注释本身又把规则点着了**（本次实测：把说明写进注释后又红了一次，
指的正是注释那一行）。

同一个坑 catalog 自己踩过并修好了：`client/goods/scripts/check-jsx-markdown.cjs`
（禁 JSX 文本里的 markdown 星号）**必须跳过注释**，否则每次都要人工分辨真假，
等于把"仔细看"换了个地方做。`mock-data.js` 应当同样跳过 `//` 与块注释。

## 建议（按价值排序）

1. **只对"我们生成的 ID"做这个检查**：规则应限定在 `mock_data.js` / `seed.json` 这类
   **播种数据**文件上，`tests/*.test.js` 不在其列（那里的字面量是断言，不是种子）。
   这一步就能消掉这个误报，且不削弱规则本意。
2. **给服务一个声明式出口**：服务已经在 `config.js` 里**没有** `idLengths`，
   这本身就是"本服务不生成 ID"的声明。规则可以读它 —— 没有 `idLengths` 的服务
   直接跳过 Base58 检查。比加注释豁免更可靠（注释豁免见
   `dead-config-key-reserved-marker-not-implemented.md` 那条：文案说了能加注释，
   代码里根本不检查）。
3. **报错文案要指路**：现在只说"包含 Base58 非法字符: 0"，人第一反应是去改数据，
   而正确的动作是"这不是我们发的 ID"。文案应说明规则针对的是**服务自己生成的 ID**，
   并给出豁免方式。

## 本地的临时处理（catalog）

没有改规则、也没有改断言的语义，只把句式从 `toMatchObject({ id: 'C1108' })` 换成
`expect(...a.id).toBe('C1108')` —— 断言的东西一模一样，只是不再命中那个字面正则。
代码里标了 `[Project]` 注释指向本文件。

**这不是一个令人满意的处理**：它意味着这条规则的红绿取决于断言的写法，
而下一个人换回 `toMatchObject` 就会再红一次，且看不出为什么。

## 处理结论

**2026-09-21 已修**（solo 侧，`api/autocheck/static/mock-data.js`）。

### 核实（solo 侧全部复现）

- 隔离复现出三条报错，其中一条来自**注释行** —— 「规则不跳注释」属实。
- `check()` 确实把 `tests/ test/ fixtures/ seeds/` 下所有 `.js` 全收（`mock-data.js:18-33`），
  `*.test.js` 一个不漏。换 `toBe` 句式确实逃逸 —— 「红绿取决于断言写法」属实。
- **solo 自身 16 个服务跑这条规则 0 条报错** ⇒ 框架自己的 ID 全是自己发的，所以它一直没现形。
- 当时**没有任何出口**：`checker.js` 的 `--rules=` 是白名单式（只能「只跑某几条」），
  没有排除机制，而 `deploy/precheck.sh` 跑的是全量。⇒ 文档结尾那句「不是一个令人满意的处理」
  不是没找别的办法，是当时确实没有别的办法。

### 改了什么

1. **收窄到播种数据**（建议 1）：Base58 ID 检查只对 `tests/utils/` `fixtures/` `seeds/` 下的文件、
   或文件名含 `mock|seed|fixture` 的文件生效；`tests/*.test.js` 里的字面量是断言，不再参与。
   —— 补一条本文没提到、但让 triage 更省事的事实：**模块头注本来就声明范围是**「`tests/utils/*.js`
   中的种子脚本 / 任何包含 mock/seed/fixture 的文件」，是**实现越界了**。这一步不是改变规则意图，
   是让代码回到它自己声明的范围。
2. **声明式出口**（建议 2）：服务 `config.js` 没有 `idLengths` ⇒ 整条 Base58 检查跳过。
3. **跳注释**（「顺带发现」）：新增 `stripComments()`，`//` 与块注释不参与**任何**一条 mock 规则。
   ⚠️ 这一条在 `generatesOwnIds()` 里也是**必需**的，不是顺手：catalog 的 `config.js` 里
   `idLengths` 这个词**只出现在注释里**（「刻意没有 idLengths：本服务不生成 ID」）——
   不剥注释就会把这句说明读成「声明了 idLengths」，**讲这件事的注释第二次把规则点着**。
4. **文案指路**（建议 3）：报错改成说明规则只管本服务自己生成的 ID，并指出出口在 `idLengths`。
5. **顺带修一个同源误伤**（本文没提）：正则 `['"]?id['"]?` 没有词边界，实测 `uid: 'uid0abc9'`、
   `order_id: 'AB0CD9'` 都会被当成 `id` 抓走。已加前置断言 `(?<![A-Za-z0-9_$])`。

### 验证

- **反例仍被抓**：有 `idLengths` 的服务 + `tests/utils/seed.js` 里 `id: 'AB0CD'` → 照报 ERROR。
- **误报消失且与句式无关**：把 catalog 的断言**改回** `toMatchObject({ id: 'C1108', rep: 'C1108A' })`
  跑修好的规则 → 零报错。⇒「下一个人换回 `toMatchObject` 就会再红一次」这个隐患消掉了。
- solo 16 个服务 `checker.js --static` 全部 `errors=0`；`deploy/check-upgrade-path.sh` 73 passed / 0 failed
  （其中 `api/autocheck == upstream` 整目录一致这条覆盖了本次改动的下发面）。

### catalog 侧还要做的

本地那处 `[Project]` 注释 + `toBe` 改写**可以撤回**，但要等 catalog 下次 `upgrade.sh`
升到含本修复的 bundle 之后。在那之前留着，注释里的指针仍然有效。
