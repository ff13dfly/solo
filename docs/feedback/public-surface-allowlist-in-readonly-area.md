# public 方法白名单在只读区：派生项目每次升级都要手动补回自己那一节

- **来源**：awareness，2026-08-29，用 `deploy/scaffold/init.sh` 新建项目并写第一个业务服务
- **场景**：awareness 是个刻意没有账号体系的系统——参与者拿一张邀请码匿名进入，
  不注册、不登录。因此 13 个业务方法必须声明 `public: true`（Router 跳过 RBAC），
  归属由服务自己在每个方法第一步现场校验（session token 的 proof 比对 + 逐条记录的
  sessionId 归属校验）。
- **依据分类**：以下为本次实测（awareness 栈，bundle v1.2.7，本机全栈起停 + 经 Router
  的黑盒调用核对）。

## 实测现象

`node api/autocheck/checker.js api/apps/awareness --static` 报：

```
❌ [public-surface] 13 个未登记的 public:true 方法:
   - awareness.session.start
   - awareness.entry.create
   ...
   若确需公开,先评审必要性,再把方法名加进 autocheck/static/public-surface-check.js
   的 ALLOWED_PUBLIC_METHODS['awareness']
```

报错文本给出的动作是对的，问题在**那个文件的归属**：

`api/autocheck/` 是 `[Solo]` 交付区（`deploy/scaffold/README.md` 的目录表明确标注），
`deploy/upgrade.sh` 升级时整体覆盖。于是派生项目被要求把**自己的**业务事实
（哪些方法对外公开）写进一个**框架拥有、升级会被冲掉**的文件里。

后果是一条必然发生的技术债：升级 → 白名单一节消失 → 门禁在下一次 CI 里红 →
有人再手动补回来。而且这一节的内容恰恰是安全评审的结论，丢失时没有任何提示。

## 根因

`api/autocheck/static/public-surface-check.js:22` 的 `ALLOWED_PUBLIC_METHODS` 是一个
**硬编码字面量**，键是服务名。里面现有的四项（`user` / `administrator` / `ingress` /
`fulfillment`）全部是框架自己的 core/apps 服务——也就是说这张表的设计假设是
「public 方法只会出现在框架服务里」。派生项目的私有 app 一旦需要 public 方法，
就只能往这张框架表里塞。

对照组：同一目录下的 `param-conventions.js` 的 `FLEET_PARAM_TYPES` 是纯粹的全队约定，
放在只读区是对的；而 public 白名单是**每个项目各自的安全边界**，性质不同。

## 建议（按价值排序）

1. **让检查器合并一份项目自有的声明**，框架表只管框架服务。例如读
   `deploy/public-surface.json`（`[Project]`，升级不覆盖）：
   ```jsonc
   { "awareness": ["awareness.session.start", "..."] }
   ```
   合并语义与 `library/indexer.js` 的「Redis override > local config」同构，
   项目里已有先例，不引入新概念。
2. 或者**就近声明**：允许服务在 `handlers/introspection.js` 里对 public 方法要求一行
   理由字段（如 `publicReason: '...'`），检查器只校验「有 public 就必须有 reason」。
   好处是评审结论与方法声明同一处、同一个 commit，永远不会漂移；坏处是没有集中视图。
3. 最低限度：`upgrade.sh` 在覆盖 `autocheck/` 前，把 `ALLOWED_PUBLIC_METHODS` 里
   **非框架服务**的键 diff 出来告警，别让它静默消失。

## awareness 侧的临时处置

已在 `api/autocheck/static/public-surface-check.js` 加 `awareness` 一节，带 `[Project]`
标记与「升级后要补回」的注释，并记进项目 `CLAUDE.md` 的升级待办。

## 处理结论

（待 triage）
