# 显示协议 (Display / View-Manifest Protocol)

> [!WARNING]
> **实现状态：分层落地中。**
> - ✅ **已实现**（本 session）：第③层「个人偏好」—— operator 的 `localStorage`（视图模式 `solomind:view_modes` + 字段显隐/排序 `solomind:list_fields`）；字段值渲染走 `portal/operator` 的 `rendererRegistry`；字段 schema 来自各服务 introspection；整服务自定义逃生舱 = `ExtensionRegistry`。
> - 🟡 **草案·未实现**：第②层「operator 配置」（静态基线 + `administrator` 覆盖）、`label/format/computed/locked` 词汇、`display.lint`、治理闸门。
>
> 示例中的 `market` / `commodity` 等为业务举例，SOLO 本身不含这些服务（判断"什么已实现"以 [`CLAUDE.md`](../../../CLAUDE.md) §2 为准）。

---

> **协议版本**: 0.2.0（草案）
> **状态**: 草案 (Draft) — 待评审
> **作者**: Fuu & Claude

---

## 1. 简介

### 1.1 设计目标

SOLO 是**纯框架**。它下发给具体项目后，operator（管理后台）应当**靠配置定义、而非靠改码定制**——否则每个项目都大改 operator，框架的复用价值就被抵消了。

本协议定义一份**声明式显示清单（Display Manifest）**：对每个 `{service}.{entity}`，声明它在 operator 里如何呈现（显示哪些字段、顺序、标签、格式、单行派生列、允许哪些视图模式）。目标是把**绝大多数实体**的后台呈现压到「零码/配置即可」，把改码限定在少数特殊实体。

| 目标 | 说明 |
|------|------|
| **配置定义后台** | 实体一声明，列表/详情自动生成；改样子改配置，不改 React |
| **operator 自治** | 呈现配置归 operator/集成方，**不进数据服务**；服务契约只讲数据含义 |
| **分层可覆盖** | operator 基线 ← 部署级覆盖 ← 个人偏好，逐层覆盖，各有 owner |
| **约束优先** | 配置可对字段加 `locked`，个人层不能越过；`sensitiveFields` 永远不可被显示清单翻出来 |
| **轻量派生** | 支持**单行**计算列（百分比、进度…），用 JsonLogic，不引入聚合 |

### 1.2 一条铁律：服务定义语义，operator 定义呈现

显示配置**不放进服务 introspection**——那等于让 API 来定义 UI，是耦合错误。服务该发布的是**数据的含义**，不是它长什么样：

| 类别 | 例子 | 归谁 | 进 introspection? |
|------|------|------|:--:|
| **语义 / schema** | `price` 是 number、`coverUrl` 是图片地址、某字段 `sensitive`、enum 取值含义 | 服务 | ✅ 本来就该（且大多已在） |
| **呈现指令** | label 文案、列顺序、默认 gallery、列宽、icon、显示哪几列、单行派生列 | **operator** | ❌ 这是 UI，不进服务 |

把呈现指令放进服务有三宗罪：① 服务契约被和数据无关的东西撑胖；② 它**假设只有一个前端**——框架的服务将来可能被 operator / 客户门户 / 移动端同时消费，各自要不同呈现，凭什么 operator 独占；③ 改个 label 要重发后端，正好是我们想消灭的摩擦。

> operator 只从 introspection **读 schema 真相**（有哪些字段、什么类型、谁敏感），呈现自己说了算。服务**可选**地附带"语义提示"（如把某 number 标为 `money`、某 string 标为 `imageUrl`）作为数据事实；operator **可以**拿它当默认格式，但**不被绑定**。

### 1.3 定位与边界（和谁不是一回事）

本协议只管**单条记录的呈现**：输入是已经在手的那些行，1 行进 → 1 行显示（投影 + 格式化 + 单行派生），可在前端按行求值。

| 相关协议 | 它管什么 | 与本协议的关系 |
|----------|----------|----------------|
| [报表协议 `report.md`](./report) | 跨记录**聚合分析**：source→pipeline(group/sum)→chart，N 行 → K 汇总，服务端执行 | **不同层**。报表站在显示原语之上、复用同一套 format 词汇；本协议**严禁**聚合/跨行 |
| [流程协议 `process.md`](./process) | 实体状态机的 **UI 映射 + 动态操作按钮** | **互补**。process 管"能点哪些操作"，display 管"字段怎么显示"，详情页里组合 |
| 权限（`permit` / `constraints`） | 服务端**能不能访问**某字段/某行 | **正交**。本协议只管呈现，**不能放大访问**；被服务端遮蔽的字段，清单写 `show:true` 也显示不出来 |

---

## 2. 三层解析模型（Resolution）

显示的"最终样子"由三层从下到上合并，**上层覆盖下层**，但覆盖受 `locked` 与 schema 的 `sensitiveFields` 约束。**API 不在其中定义 UI**——第①层只贡献 schema 真相：

```
③ 个人偏好      localStorage                      owner = 终端用户     （已落地；仅 show/order/viewMode，且仅限未锁字段）
   ▲ 覆盖
② operator 配置  静态基线  ←  administrator 覆盖     owner = operator / 集成方   （呈现全在这；详见 §6）
   ▲ 基于（只读 schema：字段存在性 / 类型 / sensitive）
① schema        introspection.entities             owner = 服务作者
```

第②层内部又分两个子源：operator 仓库里的**静态基线**（开箱默认）被部署级的 **`administrator` 覆盖**盖一层（运行时可改、可治理）。

**合并规则**：`fields` / `computed` 按 `key` 合并（非位置），逐键深合并；`label`/`format`/`order`/`show` 取最高声明层的值。第③层只允许影响 `show`、`order`、所选 `viewMode`，且仅对**非 `locked`、非 `sensitive`** 的字段生效。

**最小工作示例**（一个字段 `price` 经各层后的有效值）：

| 层 | 来源 | 对 `price` 的声明 | 说明 |
|----|------|------------------|------|
| ① schema | introspection | `price: number`（可选语义提示 `money`） | 存在、类型、是否敏感 |
| ② 基线 | operator 静态 | `{ format: 'currency' }` | operator 决定按货币显示 |
| ② 覆盖 | `administrator` | `{ label: {zh:'售价'}, locked: true }` | 本项目术语 + 禁止个人隐藏 |
| ③ 个人 | localStorage | `hidden: ['price']` | 用户想隐藏 |
| **有效** | | 显示、货币格式、标签"售价"、**不被隐藏** | ③的隐藏被 `locked` 否决 |

---

## 3. 显示清单数据结构

> 下面这个对象是 **operator 的配置**（存在静态基线或 `administrator` 覆盖里，见 §6），**不在任何数据服务的 introspection 里**。

```typescript
interface EntityDisplay {
  service: string;            // 微服务 id，如 "market"
  entity: string;             // 实体裸名（无前缀），如 "commodity"
  label?: I18n;               // 实体展示名
  icon?: string;              // 导航/分区图标提示（约定图标名）
  views?: ViewMode[];         // 允许的视图模式白名单，默认 ['table','card','gallery']
  defaultView?: ViewMode;     // 默认模式，必须 ∈ views
  primaryField?: string;      // 卡片/详情标题字段（缺省 = 自动探测 name/title/label）
  imageField?: string;        // gallery 图片字段（缺省 = 现有启发式嗅探）
  fields?: FieldDisplay[];    // 字段呈现声明（按 key 合并，非位置）
  computed?: ComputedField[]; // 单行派生字段
}

type ViewMode = 'table' | 'card' | 'gallery';
type I18n = string | { zh?: string; en?: string; [lang: string]: string | undefined };

interface FieldDisplay {
  key: string;                // R1：必须是实体 schema 的真实字段
  label?: I18n;
  show?: boolean;             // 默认显隐（默认 true）；受 locked/sensitive 约束
  order?: number;             // 排序权重，小在前
  format?: FormatKind;        // R8：渲染器；未知 → 退化为 text 并产生 lint warning
  formatOptions?: Record<string, unknown>;   // 如 { currency:'CNY', decimals:2 }
  width?: string;             // table 列宽提示（grid 单位，如 "2fr"）
  locked?: boolean;           // R5：个人层不可隐藏/改名
}

interface ComputedField {
  key: string;                // R7：不得与真实字段重名
  label?: I18n;
  compute: JsonLogic;         // R4：仅对【当前这一行】求值的纯函数（library/jsonlogic）
  format?: FormatKind;
  render?: 'text' | 'bar' | 'badge';   // 如进度条
}

// 渲染词汇是封闭枚举，由 portal/operator 的 rendererRegistry 兜底实现
type FormatKind =
  | 'text' | 'number' | 'percent' | 'currency' | 'bytes' | 'bool'
  | 'datetime' | 'relative-time' | 'enum-badge' | 'link' | 'json';
```

---

## 4. 约束（Normative Rules）

> 关键词 **MUST / MUST NOT / SHOULD** 按 RFC 2119 解释。`display.lint`（§5）负责把可机检的约束在 author 时挡住。

- **R1 字段引用完整性（MUST）**：每个 `fields[].key`、每个 `computed[].compute` 里的 `{"var": "..."}`，MUST 指向该实体 schema 的真实字段或同实体的某个 `computed.key`。悬空引用 = lint error。
- **R2 `id` 结构性（MUST NOT 隐藏）**：`id` 是行的句柄（复制按钮 / EntityResolver 锚点），MUST 始终存在、不可被配置或个人层隐藏；不进 `fields` 配置列表。
- **R3 敏感字段不可翻出（MUST NOT）**：schema 声明为 `sensitiveFields`、或被数据级 `constraints` 遮蔽的字段，无论配置是否 `show:true`，MUST NOT 显示。**呈现层不能放大访问**——遮蔽以服务端为准。
- **R4 计算 = 单行纯函数（MUST）**：`compute` 是对**一条记录**字段求值的 JsonLogic。MUST NOT 依赖当前行以外的任何数据：**禁止聚合（sum/count/avg）、禁止跨行、禁止跨实体取数**。跨行聚合属 [报表协议](./report)；跨实体取名走已有的 `EntityResolver`（`{xxx}Id` → 拉取关联实体）。
- **R5 锁语义（MUST）**：`locked:true` 由 operator 配置（基线或覆盖）声明；第③层（个人）MUST NOT 隐藏或改名锁定字段，个人层仍可在**非锁字段之间**调序与显隐。有效显隐 = `locked ? cfg.show : (个人隐藏 ? false : cfg.show)`。
- **R6 视图白名单（MUST）**：`defaultView` MUST ∈ `views`；个人所选模式 MUST ∈ `views`。项目可借此把某实体限定为只读表格（去掉 gallery）。
- **R7 派生不撞名（MUST NOT）**：`computed[].key` MUST NOT 与真实字段重名，避免遮蔽真实数据。
- **R8 格式词汇封闭（SHOULD）**：`format` SHOULD 取自 `FormatKind` 枚举；未知值退化为 `text` 并产生 lint warning。新增格式 = 扩 `rendererRegistry` + 扩本枚举，二者同步。
- **R9 i18n 回退（MUST）**：`label` 为字符串或 `{zh,en,...}`；解析回退顺序 `当前语言 → zh → en → key`。
- **R10 治理（SHOULD）**：第②层的 `administrator` 覆盖是**共享且可写表达式**的工件，SHOULD 通过 `display.lint` 后再生效，MAY 走审批闸门（见 §5）。静态基线随 operator 代码走 PR；第③层个人偏好不治理，但运行时仍受 R3/R5 约束。
- **R11 合并按键（MUST）**：`fields`/`computed` 跨层 MUST 按 `key` 合并而非数组位置，确保上层只声明差量即可。

---

## 5. 治理与校验（复用既有模式）

第②层的 `administrator` 覆盖与 [履约 Profile](./fulfillment) 同性质：一份会影响所有人、还能跑表达式的可投放工件。因此**复用** fulfillment 那套 `lint + 提审 + 冻结` 模式，不另起炉灶：

`display.lint(manifest, methodIndex)` —— 基于跨服务 introspection 索引做机检：

1. 每个实体的 `service.entity` 在索引中存在；
2. R1 字段/var 引用存在性（含 `computed` 的 var 闭合在本实体字段 + computed 内）；
3. R4 `compute` 不含聚合算子、不引用外实体；
4. R6 `defaultView ∈ views`；R7 派生不撞名；
5. R3 没有把 `sensitiveFields` 强制 `show:true`；
6. R8 `format` ∈ 枚举（否则 warning）。

> **可机检 vs 不可机检的边界**：lint 能保证"引用的字段/方法/格式存在、计算不越界、约束自洽"，但**不能**判断"这个 label 取得好不好、这几列是不是业务上最该展示的"——那是人审的范围。

覆盖清单 MAY 经审批后标记 `APPROVED` 并冻结可执行字段（`computed` / `locked`），改动需重新过审——直接套用 fulfillment 的后审完整性闸门思路。

---

## 6. 配置存哪（推荐：静态基线 + administrator 覆盖 + 个人）

呈现配置归 operator，**绝不进数据服务的 introspection**。三处各司其职，owner 各归各位：

| 子层 | 存哪 | owner | 优 | 劣 |
|------|------|-------|----|----|
| **A 静态基线** | `portal/operator` 仓库里的 JSON/TS，构建期打包 | operator | 零基建、随版本走、PR 可审、**开箱即用** | 改配置要重新构建+部署 |
| **B 部署级覆盖** | `administrator`(8680) 的一个实体，`administrator.display.*`（get/set/list），走实体工厂存 Redis | 集成方 | **运行时可改**（免重发）、过 Router 带 auth/permit、白拿 WAL/审计/乐观锁、可 `lint`+审批 | 需种子；启动多一次拉取 |
| **C 个人偏好** | 浏览器 `localStorage`（已实现） | 终端用户 | 即时、个人化 | 仅本人本机 |

**解析顺序**：`A 静态基线  ←  B administrator 覆盖  ←  C 个人`。

**韧性**：operator 启动时拉 B；**拉失败就退回 A 的静态基线**——后端不可用时 operator 仍能渲染。

**为什么是 `administrator` 而不是 operator 直写 Redis**：SOLO 铁律是"服务自管数据、operator 经 Router 访问"。所以 B 是"administrator 的一个实体"，不是"operator 直捅 Redis"。`administrator` 本就是系统后台/单管理员模型，放部署级 UI 配置很自然，并自动落到 Router 的 auth / permit / 审计链上。

**轻量变体（A + C，去掉 B）**：纯静态基线 + 个人 localStorage，也成立；代价是部署级改配置要重新构建 operator。取舍点 = "非开发的集成方要不要在**运行时**改后台样子 + 要不要治理"。本协议**推荐上 B**：既然目标是下发降开发量、且已有治理线，运行时可改 + 复用 lint/审批 值这一层。

---

## 7. 完整示例（`market.commodity`，仅举例）

> 这份对象存在 operator 静态基线，或作为 `administrator` 覆盖下发；**不在 `market` 服务里**。

```json
{
  "service": "market",
  "entity": "commodity",
  "label": { "zh": "商品", "en": "Commodity" },
  "views": ["table", "gallery"],
  "defaultView": "gallery",
  "primaryField": "name",
  "imageField": "coverUrl",
  "fields": [
    { "key": "name",   "label": { "zh": "名称", "en": "Name" }, "order": 1, "locked": true },
    { "key": "sku",    "label": { "zh": "SKU" }, "order": 2, "format": "text" },
    { "key": "price",  "label": { "zh": "售价" }, "order": 3, "format": "currency",
      "formatOptions": { "currency": "CNY", "decimals": 2 }, "locked": true },
    { "key": "status", "order": 4, "format": "enum-badge" },
    { "key": "internalNote", "show": false }
  ],
  "computed": [
    {
      "key": "stockPct",
      "label": { "zh": "库存占比", "en": "Stock %" },
      "compute": { "/": [ { "var": "stock" }, { "var": "stockCap" } ] },
      "format": "percent",
      "render": "bar"
    }
  ]
}
```

效果：gallery 默认；卡片标题取 `name`、图片取 `coverUrl`；正文显示 SKU / 售价(￥) / 状态徽章 / 库存占比进度条；`internalNote` 默认隐藏；`name` 与 `price` 锁定，个人不能藏；用户可切到 table，但切不到 card（不在 `views`）。

---

## 8. 与现状的映射 & 未决

**已实现（本 session，第③层 + 渲染底座）**
- 视图模式按 `{service}_{entity}` 记忆：`UIProvider` + `localStorage['solomind:view_modes']`
- 字段显隐 + 排序按 `{service}_{entity}`：`ColumnConfig` + `localStorage['solomind:list_fields']`（数据形状 `{order, hidden}` 即第③层差量，向上层兼容）
- 字段值渲染：`portal/operator/.../registry/RendererRegistry`
- 整服务自定义逃生舱：`ExtensionRegistry`（config 吃 80%，自定义页吃 20%）

**未决**
1. **表达式方言统一**：本协议推荐 JsonLogic（与 fulfillment 一致、已实现）；`report.md` 用了 `"$price * $quantity"` 字符串方言。二者应收敛到 `api/library/jsonlogic`，避免一个仓库两套表达式。
2. **B 是否上**（§6）：推荐上 `administrator` 覆盖层；若只需开发型集成方在构建期改，`A + C` 亦成立——待拍板。
3. **写侧布局**：本协议只管**读侧**（list/detail 呈现）。编辑表单的布局/分组可作姊妹协议，暂不并入。
4. **与 process.md 的接缝**：display 管字段呈现、process 管状态机操作按钮，详情页里如何组合需细化。
