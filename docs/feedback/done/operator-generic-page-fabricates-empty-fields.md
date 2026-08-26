# 反馈：通用实体页给「列表不回传的字段」编造空值 —— 看起来像库里是空的，点 Save 会写回去

> 来源：steward 派生项目，2026-08-26。起因是运营在 operator 里打开一条 scout 采集快照，
> RAW JSON 里 `"items": []`，于是问「数据是不是没存进去」——实际库里有 60 条。
> 依据：**全部自查实测**——线上 Router（`steward-api.w3os.net`）实调 `scout.capture.list` /
> `.get` 对比字段，附代码核对 **solo 仓 HEAD** 的 `portal/operator/`（行号即 HEAD 源码，
> 与 steward 本地那份逐字一致）。无二手引用。
> 涉及：`portal/operator/src/pages/default/EntityUtils.ts:33-45`（编造空值）、
> `portal/operator/src/pages/default/index.tsx:85-88`（编辑数据来自列表行）、
> 同目录全部 `callRpc` 调用（**没有一处调 `.get`**）。
>
> 一句话：服务端为了不把 10MB 载荷塞进列表页，`list` 每行剥掉重字段；而通用页**只有 list、
> 从不调 get**，还把缺席的字段按 schema 补成 `[]`/`""`/`{}`/`0` —— 于是界面上那条记录
> 看起来是空的，**而这个编造出来的空值会被原样提交回去**。

---

## 一、实测：同一条记录，list 与 get 差了 60 条商品

`scout.capture` 是快照层：一条 = 一次搜索结果页，`items` 是原样保存的商品条目。
服务端 `list` 有意剥掉重载荷（一页 50 条 × 每条几百 KB = 10MB 响应）：

```
scout.capture.list 每行的 keys：
  status,platform,keyword,url,capturedAt,requestId,source,note,itemCount,id,createdAt,updatedAt,sampleBytes
  ← 没有 items，没有 sample；换上 itemCount / sampleBytes 告诉调用方"那边有多少东西"

scout.capture.get(同一条 id)：
  keys 里有 sample、items
  itemCount = 60 · items.length = 60 · sample.length = 7794
```

而 operator 的编辑弹窗（VISUAL FORM / RAW JSON 两个 tab）显示的是：

```json
{ "platform": "1688", "keyword": "多功能插座", "itemCount": 58,
  "sampleBytes": 8000,
  "items": [],        ← 编造的
  "sample": ""        ← 编造的
}
```

**旁证就在这份 JSON 里**：`sampleBytes` 根本不在 capture 的 entity 定义中（是 `list` 额外附加的）。
一份 JSON 同时含「schema 里没有的字段」和「schema 里有但被填空的字段」，
说明它是 **list 行 + schema 占位符**拼出来的，不是一条完整记录。

## 二、根因：两件各自合理的事凑在一起

**① 通用页只有 list，没有 get。** `pages/default/` 里的全部 RPC 调用：

```
${serviceId}.${activeEntity}.${method}    // create | update
${serviceId}.${activeEntity}.delete / .restore / .destroy
${serviceId}.category.*
```

`.get` 一次都没有。这个设计的隐含前提是「记录的字段在列表里就看全了」——
对绝大多数实体成立，对**有意剥载荷的实体**不成立。

**② 缺席字段被补成空值。** `EntityUtils.ts:33-45`，注释原话是
"Proactively add missing fields from the entity definition as placeholders"：

```js
if (!systemFields.includes(fieldName) && editableData[fieldName] === undefined) {
    if (fieldDef.type === 'number') editableData[fieldName] = 0;
    else if (fieldDef.type === 'boolean') editableData[fieldName] = false;
    else if (fieldDef.type === 'object') editableData[fieldName] = {};
    else if (fieldDef.type === 'array') editableData[fieldName] = [];
    else editableData[fieldName] = "";
}
```

对「新建」这是对的——表单需要一个初值。对「编辑一条 list 来的行」，它把
**「这个字段这次没回传」翻译成了「这个字段是空的」**。两者是完全不同的事实。

## 三、真正的危险：编造的空值会被提交回去

`index.tsx` 的保存路径把整份 `editContent` 解析后发出去（`create` 或 `update`），
没有做「只发改动过的字段」。所以对一个**既剥载荷、又开了 `update`** 的实体，
在这个弹窗里点一次 Save 就是**静默清空数据**——用户什么都没改，但前端替他把
`items: []` 提交了。

steward 这次侥幸没出事，纯属运气：`scout` 只注册了 `ingest/get/list/delete`，
没有 `update`，点 Save 得到 404 `METHOD_NOT_FOUND`。
换成任何一个开了 update 的剥载荷实体，这就是一次无声的数据破坏。

## 四、建议（按价值排序）

1. **编辑前先 `.get`**。服务端声明了 `get` 就调一次再填表单（`introspection` 里查得到）。
   这一条同时解决「看不到完整记录」和「编造值被写回」两个问题，且不需要新约定。
2. **区分「字段缺席」与「字段为空」**。占位符只在 `mode === 'create'` 时补；
   编辑态下缺席的字段就别塞进 formData —— 表单里可以显示成「（未回传）」的只读态。
3. **保存改成 PATCH 语义**：只发**用户改动过的**字段。这是上面两条都失手时的最后一道闸，
   也让「编辑弹窗」不再天然具有破坏性。
4. 若前三条都太重：给 entity 字段加一个 `listOmitted: true` 之类的标记，
   服务端在 `entities` 里声明，通用页据此显示「列表未回传，编辑不影响此字段」。
   成本最低，但需要每个服务自觉声明，护不住没声明的。

## 五、附：这份代码是 [Project]-owned，修上游只对新项目生效

`deploy/scaffold/upgrade.sh` 明写 `portal/operator/` 是 source-distributed、
"→ never touched"（`:283`、`:325`）。所以派生项目各持一份副本，改上游不会流下去：
**已有项目要自己同步**。triage 时值得一并决定要不要给个「怎么把这处补丁同步到已有项目」的提示，
否则修了也只对下一个新项目有效。

（steward 侧的临时处置：把这两个服务从通用页移出去，写了专用前端 `client/monitor`，
点开一条走 `capture.get` 拉回完整记录再渲染。**没有改本地的 `EntityUtils.ts`** ——
等这条 triage 的结论。）

## 六、处理结论

**已采纳，建议 1+2+3 全部落地；建议 4 不做（2026-08-26，进 [Unreleased]）。**
核实结论：§一~§三全部属实。一处细小纠偏：「同目录没有一处调 `.get`」不准确——
`EntityResolver.tsx:35` 有一处 `.get`，但那是外键**展示**解析，不在编辑路径上，结论不受影响。

1. **建议 ①（编辑前先 `.get`）**：`startEditing` 改为——服务的 `methods`（来自
   `system.service.list`，本就在 ServicesProvider 里）声明了 `{entity}.get` 就先调它，
   拿完整记录开弹窗；调不到/失败则回退列表行 + toast 提示「未显示的字段保存时不动」。
2. **建议 ②（缺席 ≠ 空）**：`prepareEntityForEditing` 加 `authoritative` 参数——
   **只有**记录来自 `.get` 时才按 schema 补占位符（此时缺席才真等于未设置）；
   列表行兜底路径不再编造任何空值。create 路径不变。
3. **建议 ③（PATCH 语义）**：保存时 diff 打开弹窗时的基线，**只提交改动过的字段**
   （entity factory 的 `update` 是 merge 语义，实测 `{...existing, ...updates}`，未提交
   字段不动）；零改动直接关弹窗不发请求。附带一道针对性防线：基线里没有、值又是
   deep-empty（`""`/`[]`/`{}`）的字段不提交——这挡住 RJSF 给 object 字段物化
   `default: {}` 的残余路径（`EntityForm.tsx:43`，本轮未改它）。
4. **建议 ④（`listOmitted` 声明标记）**：**不做**。①+②+③ 已把"看错"与"写坏"都关掉，
   且不依赖服务自觉声明；再加一个靠自觉的标记是负价值（护不住没声明的，还多一处会过时的元数据）。

落点：`portal/operator/src/pages/default/index.tsx`（get-first + 基线 + diff 保存）、
`EntityUtils.ts`（authoritative 参数）、`locales/en.ts`/`zh.ts`（新增 `entity.editPartialRow`）。
验证：`tsc --noEmit` + `vite build` 绿；操作端 UI e2e 现有 4 个 spec 不覆盖编辑弹窗，未受影响。
**已知边界**：diff 保存假定 update 是 merge 语义（factory 契约）；自写 replace 语义
update 的服务会收到部分对象——但那类服务在旧行为下（整份 list 行 + 编造空值）只会坏得更早。

**§五的同步问题，明确回答**：`portal/operator/` 是 source-distributed、升级永不覆盖——
**本修复只随脚手架流向新项目，已有项目要自己拿**。要同步的就是上面落点列的 4 个文件
（`EntityUtils.ts` 与 locales 是纯增量，`index.tsx` 三处改动都带注释块可对照移植）。
steward 已用专用前端绕开通用页，不急；其它有剥载荷实体 + 开 `update` 的项目建议尽快port。
