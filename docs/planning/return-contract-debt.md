# 返回契约债 · 台账(Return-Contract Debt Ledger)

> **来源**:2026-06-18 全 14 服务“声明 vs 真实返回”审计(15-agent workflow)。本台账记录 **`returns_schema` 全量补齐后剩余的 47 条非阻塞代码缺陷**——它们**不影响系统正常运行**(全量 e2e 55 套通过),`returns_schema` 已**如实**描述这些形状(条件键标 optional、裸数组诚实留白、provider 分歧已标注);属一致性/约定债 + 几个未完成功能。

> **已修(本次)**:`planner.todo.sync`(ReferenceError 崩溃)、`collection.payment.list`(声明参数 status↔逻辑 state 死过滤)。

> **已建守卫**:`library/contract.js`(返回契约引擎)+ 全仓良构扫描 + ai:true 覆盖闸 + `fulfillment/logic/lint.js`(profile pick 路径核验)——防新增方法无契约 / profile pick 错字段。

> **优先级**:🔴 影响 fulfillment 取数 / 真运行时坑 → 先修;🟡 编排/AI 一致性 → 次之;⚪ 整洁度 → 有空再说。


**剩余 47 条**,按性质分 8 类(对 fulfillment 影响标注见每节标题)。


---


## B. agent 多 provider 分歧 / 未实现桩 — 8 条

- **对 fulfillment 取数**:⚠️ **会影响 fulfillment**——若 profile 从 agent.* 取数,pick 的字段名随后端变 → 静默 undefined
- 同一方法换 LLM 后端返回形状即变,或某后端未实现。**修法**:让 provider 适配层归一化输出(在 agent 服务内),或标注后端差异;未实现桩需补齐或路由规避。

  - **`agent.chat`** (agent) — Provider divergence: qwen.chat returns {success, text, metadata}; gemini.chat returns {success, content, metadata} on the messages path, {success, text, content, metadata} on the legacy path, and {success, text, metadata} on error. The SAME RPC method returns different keys (text vs content) by provider/branch — a binding consumer cannot rely on either text or content existing.
  - **`agent.focus`** (agent) — gemini.focus (providers/gemini.js:558) is an unimplemented stub ('// ... (existing code)') that returns undefined; openai.focus and bitexing.focus throw 'not implemented'. Only qwen and mock actually return the {extracted_params, confidence, hint, action} shape, so the contract only holds for those providers.
  - **`agent.image.classify`** (agent) — Inconsistent shape across the two gemini classifyImage overloads (gemini.js defines classifyImage twice; the second def shadows the first) and conditional keys: categoryId/categoryName/confidence/reason exist only on the JSON-parsed success path, absent on the error path which returns {success:false, error, metadata}.
  - **`agent.image.parse`** (agent) — Mode/provider divergence: qwen general mode returns {success, text, metadata}; qwen product mode (extractProductInfo) and gemini both return {success, data, metadata}. The result-bearing key (text vs data) depends on mode and provider.
  - **`agent.image.ps`** (agent) — Provider divergence on the image payload key: qwen/wanxiang returns a CDN {url}; gemini returns inline {image (base64), mimeType}. A consumer must branch on provider to find the edited image; there is no common image field.
  - **`agent.label.scan`** (agent) — Only QwenProvider implements scanLabel; gemini/openai/bitexing have no scanLabel, so calling agent.label.scan with a non-qwen provider/model throws 'provider.scanLabel is not a function' rather than degrading.
  - **`agent.purpose`** (agent) — Severe return-type divergence: qwen identifyPurpose returns an OBJECT ({id:'agent.chat'} or a candidate object); gemini.identifyPurpose returns a BARE STRING (e.g. 'agent.chat' or a method-id). One provider returns an object, the other a primitive string — not bindable to any uniform contract.
  - **`gateway.rmbg.cutout`** (gateway) — Non-uniform return shape across the two provider paths. Local path: return { ...result, provider:'local' } where `result` is the local ONNX server's raw JSON — gateway never guarantees an `image` key, it passes through whatever the server sent (so a misbehaving/changed local server could omit `image` entirely and gateway would still resolve success). remove.bg path: return { image, provider:'removebg' } — `image` always set. The two siblings therefore disagree on whether `image` is guaranteed; AI/orchestration binding to result.image will silently get undefined on the local path. Declaration made honest (image not required); the underlying shape divergence is a code issue, not fixed here.


## D. 条件键 / 其他 — 5 条

- **对 fulfillment 取数**:⚠️ 部分影响 fulfillment——若 pick 命中条件键,某些路径 undefined
- 数据返回了,但某些键看路径才有。**修法**:schema 已标 optional;消费方须容忍缺键。

  - **`approval.gate.sign`** (approval) — Prior audit claimed gate.sign was 'missing-field (under-declared)'. Re-verified against logic/gate.js line 127: the handler returns EXACTLY {id,state,signed,required}, so the legacy returns array was already complete/accurate. The audit was wrong for sign (it WAS right for gate.get and record.request, which were strict subsets and are now fully schema'd).
  - **`fulfillment.instance.create`** (fulfillment) — FIELD-NAME TRAP (declaration-documented, not fixed): the instance lifecycle field is `state` (DRAFT/PROCESSING/...). An instance has NO `status` key at all, while a profile (Entity-Factory record) has `status` (ACTIVE/DELETED) and NO `state`. A meta_field source.pick that picks the wrong one resolves to undefined and silently mis-branches a JsonLogic condition. Both schemas now declare the correct single lifecycle key for their entity.
  - **`notification.token.set`** (notification) — Shape is synthesized in index.js, not in logic: relay.setToken() returns undefined; index.js wraps it as a literal {ok:true}. Same for notification.token.clear (relay.clear() -> undefined, wrapped as {ok:true}). The 'ok' field is always true and never reflects real success/failure (a thrown RelayError is the only failure signal). Declared {ok:boolean,required} to match what index.js actually returns today.
  - **`notification.token.status`** (notification) — relay.status() returns 'lastRefreshAt' which the original legacy returns array never advertised — declaration was silently incomplete. Now captured in returns_schema (conditional). DECLARATION-only fix; no code change.
  - **`entities (meta method)`** (user) — Legacy returns:['entities'] is wrong — the handler returns require('./handlers/entities'), i.e. the bare {user,permit,category} map, NOT {entities:...}. Left untouched per task scope (ping/methods/entities excluded from the schema work), but flagged: the legacy `returns` key does not exist in the actual return.


## H. 返回时点拿不到数据 — 2 条

- **对 fulfillment 取数**:⚠️ 若 pick 这些字段则拿不到
- 声明/期望字段在返回那一刻确实不在。**修法**:补计算 / 返回前完成关联 / 改 pick 目标。

  - **`planner.agenda.create`** (planner) — Declared/expected todoId is NOT on the create return even when a #todoId tag links. logic/agenda.js create() captures result=entity.create(...) BEFORE the syncTodoLink+entity.update(todoId) write, and returns the pre-update `result`. So the linked todoId is persisted to Redis but absent from the create response (a subsequent get() would show it). todoId left non-required in AGENDA_RETURN to stay honest.
  - **`user.account.status (logic stats())`** (user) — Declared field `deleted` is NEVER computed. stats() iterates uids and returns only {active, total} (both paths, including the catch). The legacy returns:['total','active','deleted'] advertised a soft-deleted count that callers/AI would bind to and always get undefined. Declaration made honest (deleted dropped); the code never produced it. To actually expose it the handler must count user.status===DELETED.


## C. 裸数组返回(非 {items,total}) — 6 条

- **对 fulfillment 取数**:一般 list 消费方;fulfillment 从 .list 取标量本属误用,linter 已 unverifiable 告警
- 返回顶层数组,通用按 .items 读的消费方拿到 undefined(AutomationControl 那个前端 bug 即此类)。扁平契约表达不了。**修法**:统一为 {items,total}(动 wire + 改前端读法),或保持现状并文档化。

  - **`setting.config.list`** (administrator) — Returns a bare top-level array of service-name strings, breaking the fleet {items,total}/object-envelope convention; not bindable by the flat dialect (see bareArrayMethods).
  - **`nexus.schedule.list`** (nexus) — Handler returns a BARE top-level array of schedule defs (sorted by fire_at), NOT {items,total}. Cannot be expressed by the flat object-key dialect — left in bareArrayMethods. Pre-existing note in the file also records that the portal AutomationControl reads .items off this and silently gets undefined (a frontend bug). Not fixed here per rules.
  - **`orchestrator.category.list`** (orchestrator) — library/category.js list() returns a BARE top-level array of category docs (shared lib, affects every service mounting it). Uncontracted.
  - **`orchestrator.run.list`** (orchestrator) — Returns a BARE top-level array of run docs (run.js list() returns runs.sort(...)). Inconsistent with workflow.list / collection.payment.list which return {items,total}. A caller binding `result.items` gets undefined. Left uncontracted (flat object-key dialect can't express a top-level array).
  - **`orchestrator.workflow.categories`** (orchestrator) — Returns a BARE top-level array of category values (strings or objects). Same non-uniform shape problem as run.list. Uncontracted.
  - **`user.category.list (library/category.list)`** (user) — Returns a BARE top-level array, while every other *.list in the service returns an object ({items} / {users}). The flat object-key return-contract dialect cannot express a top-level array, so this method is left contract-less and orchestration meta_field source.pick can never bind to it. A wrapping {items:[...]} (like bot.list) would make it expressible and uniform.


## A. 同族 / 跨路径返回形状不一致 — 18 条

- **对 fulfillment 取数**:一般消费方/编排,**不影响 fulfillment 的 pick**
- 消费方/AI 须逐方法特判,无法一套逻辑通吃。**修法**:统一同族信封(动 wire,逐个定方向);或文档化“此方法分支返回不同形状”。

  - **`admin.log.error / admin.log.clear`** (administrator) — Non-uniform shape across paths: error.list returns {service,logs} for a single service but {logs} (no `service`) via listAll; error.clear returns {success,service} vs {success} via clearAll. The `service` key is conditional, so it cannot be required — sibling/path divergence within one method.
  - **`setting.config.get`** (administrator) — Returns a bare arbitrary-key hash map (`overrides || {}`) instead of the conventional {overrides:{...}} wrapper its sibling methods would imply — inconsistent envelope; flat object-key dialect cannot express it.
  - **`setting.config.schema / setting.index.schema`** (administrator) — Both can return a bare `null` (not-found) instead of a typed object, so no return key can be guaranteed; config.schema yields {service,publishedAt,keys} when present while index.schema yields an arbitrary entity-keyed map — two different non-null shapes for sibling `*.schema` methods.
  - **`approval.gate.sign`** (approval) — Non-uniform sibling shape: sign() returns a SHAPED progress object {id,state,signed,required}, NOT the full gate entity like its siblings open/reject/get (which all return the persisted gate record). Orchestration binding to gate.* cannot assume a uniform gate shape across the lane. (Declaration is honest — GATE_SIGN_RETURN reflects the actual shape — flagged as a code-side inconsistency, not fixed.)
  - **`collection.payment.record / settle (logic layer)`** (collection) — The logic-layer return includes an `_event` array key (the Router-piggyback) that the index.js wrapper strips before the client sees it. returns_schema deliberately omits `_event` (it is not client-facing). Flagged so future readers know the logic return and the wire return differ by one key; no change made (correct behaviour).
  - **`fulfillment.instance.resume`** (fulfillment) — NON-UNIFORM RETURN SHAPE across advance()-family siblings. transition/cancel/hold/override all return { ...instance, _tasks } (the Router async-dispatch array, always >= []). resume() returns the bare instance with NO _tasks key (logic/instance.js:255 `return instance;`). So orchestration/AI binding to `_tasks` after a state op must special-case resume. Declared honestly: INSTANCE_WITH_TASKS for the four, INSTANCE_BASE (no _tasks) for resume.
  - **`fulfillment.profile.delete`** (fulfillment) — delete() and destroy() return DIFFERENT shapes. profile is softDelete=true, so delete() = entity update(status=DELETED) and returns the FULL entity record (id/status/name/createdAt/updatedAt with status:'DELETED'), NOT { success: true }. destroy() (hard delete) returns { success: true }. A caller that treats delete like destroy and reads `.success` gets undefined. Declared delete with PROFILE_RETURN, destroy with { success }.
  - **`ingress.ingest`** (ingress) — Non-uniform return shape across paths (the prior-audit 'conditional-key' flag, CONFIRMED against logic/ingest.js handle()). 5 branches: 401/403/400 reject -> {ok:false,error}; 200 duplicate -> {ok:true,duplicate:true,request_id} (the `duplicate:true` flag is UNDECLARED in legacy returns); 200 accept -> {ok:true,stream,request_id}. `stream` is emitted ONLY on the accept path; `request_id` is absent on reject paths; `error` absent on success. An AI/orchestrator binding to result.stream will get undefined on duplicate/reject. Declaration left honest (only ok required); not fixing the handler keeps the wire contract stable.
  - **`nexus.sentinel.create`** (nexus) — create() returns only a 4-key SLICE {id,name,authorityRole,status} of the persisted profile, while update()/get() return the whole profile — sibling methods on the same entity have non-uniform return shapes. Declared each to its actual shape (create gets its own narrow schema, not SENTINEL_PROFILE).
  - **`nexus.sentinel.get`** (nexus) — activity field is non-uniform: activityOf() returns null when the redis client lacks hGetAll (e.g. some hermetic/minimal clients) but a {fired,skipped,failed,lastFiredAt,lastFailedAt} object on a real redis with hGetAll. Declared as a non-required object to be honest about the null path; the shape is path-dependent on the redis capability, not on business state.
  - **`notification.token.status`** (notification) — Non-uniform return shape across paths: relay.status() returns a 7-key object when a token exists but a single-key {hasToken:false} when none exists. This is a real ergonomic trap for AI/orchestration binders (a consumer reading result.expiresAt gets undefined whenever there's no token). Declaration is now honest (only hasToken required); not fixed because that would change the wire contract.
  - **`orchestrator.run.get`** (orchestrator) — Non-uniform across run lifecycle: create() writes a core doc, but status transitions add branch-specific fields (pausedAt/missingMethods, doneAt, failedStep/cleanupManifest, abortedBy/abortReason, etc). Only id/workflowId/status are guaranteed; triggerSource is copied straight from the run-command and can be undefined for a raw create. Declared accordingly.
  - **`orchestrator.run.grant`** (orchestrator) — Shape divergence between logic and wire: run.js grant() returns {run,grant}, but index.js REWRAPS it to {ok,runId,status} before returning to the caller. The schema reflects the index.js wire shape (the actual contract), not the bare logic return.
  - **`orchestrator.workflow.approve`** (orchestrator) — Non-uniform return shape across 4 branches (LOW C1: {success,lane,workflow}; HIGH NEEDS_SIGNATURE: {success,lane,status,gateId,digest,required}; HIGH AWAITING_SIGNATURES: {success,lane,status,gateId,signed,required}; HIGH approved: {success,lane,gateId,effective_at,workflow}). Only success+lane are universal; status/workflow/gateId/etc are branch-conditional. AI binding must discriminate on success+lane before reading any other key.
  - **`planner.agenda.delete vs planner.todo.delete`** (planner) — Non-uniform delete shape across sibling entities: agenda is softDelete:false so entity.delete returns {success:true}; todo is softDelete:true so delete() returns this.update(...) = the full entity object (status=DELETED). Two sibling CRUD methods return structurally different shapes for the same logical 'delete' action. Declarations made honest (DELETE_RETURN vs TODO_RETURN); code not changed.
  - **`storage.asset.get`** (storage) — get returns the RAW stored metadata with no url/thumbnails decoration, whereas list items ARE decorated (carry url+thumbnails) and upload returns the decorated shape. So get vs list/upload are NON-UNIFORM for the same logical 'asset' entity — a meta_field pick of 'url' works off list/upload results but resolves to undefined off a get result. Only id+sha256 are guaranteed on get (thin legacy rows seed just {id,sha256,key}), so the schema requires only those two; everything else is typed-but-not-required.
  - **`storage.asset.upload / storage.asset.get`** (storage) — createdAt is a STRING (new Date().toISOString()), unlike the entity-factory convention elsewhere in the repo where createdAt/updatedAt are numeric epoch millis (e.g. collection.payment). Declared as type:'string' to be honest, but it is an inconsistency vs sibling services — orchestration picks expecting a numeric timestamp will get an ISO string.
  - **`user.account.list vs collection.payment.list / bot.list (non-uniform list shape)`** (user) — Sibling list methods in this very service are non-uniform: user.account.list returns records under `users`, but user.bot.list / user.role.list / user.passport.list return them under `items`, and the shared entity-factory convention is {items,total}. Orchestration cannot assume one list shape across the service. Declaration now matches each method's real key, but the divergence is a latent footgun.


## E. 命名 / 约定 / 冗余 / 无信息量字段 — 4 条

- **对 fulfillment 取数**:不影响 fulfillment 取数
- 纯整洁度债。**修法**:统一时间为 epoch、去重复键、去恒真 success;低优先。

  - **`agent.case.generate`** (agent) — Key naming + path inconsistency: success path returns {success, workflow_id, cases, prompt} using snake_case workflow_id (the introspection param and most FK conventions use workflowId), and the error path returns {success:false, error} with no cases/workflow_id at all.
  - **`gateway.email.send / gateway.sms.send / gateway.smtp.test / gateway.webhook.send`** (gateway) — `success` is hard-coded true on every non-throwing path (errors are thrown, never returned as { success:false }). The field is therefore informationally vacuous — a consumer can never observe success:false. Not a contract problem (it IS always present & boolean), but the field carries no signal; callers must rely on throw/catch, not on inspecting success.
  - **`storage.asset.upload / storage.asset.get`** (storage) — The same asset field is exposed under TWO keys: key and path (path is an explicit back-compat duplicate of key, set to the same value at line 280). Both declared; downstream binders should treat path as a legacy alias, not a distinct field.
  - **`storage.thumbnail.rebuild`** (storage) — errors[] items are {id,size,error} objects but 'size' here is the thumbnail LABEL (sm/md/lg), reusing the param name 'size' which on resolve means a thumbnail size token — naming collision, not a return-shape break. Nested array element shape is not expressible in the flat dialect (only top-level 'errors' declared as array).


## F. 可空 / 校验缺口 — 2 条

- **对 fulfillment 取数**:不影响 fulfillment 取数
- 声明 required 的字段实体工厂未强制。**修法**:在 logic 层补校验或放宽声明。

  - **`gateway.smtp.create / gateway.smtp.get / gateway.smtp.update (+ email/sms template create/get/update)`** (gateway) — Entity Factory does not enforce the entities.js `required` fields (name/host/user/from for smtp; name/subject/html for templates). create() spreads caller params verbatim, so a create call omitting a declared-required content field still succeeds and the field is simply absent from the return. Hence those content keys are typed but NOT marked required in returns_schema — the schema reflects what the code actually guarantees (id/status/createdAt/updatedAt only), not the entities.js intent.
  - **`ingress.source.create`** (ingress) — lastFiredAt is initialized to null at create (present as a key, null value). Declared type:number but NOT required because checkParams rejects null on a required key; an AI expecting a numeric 'last fired' timestamp gets null until the first delivery. healthUrl is conditionally present only when supplied at create/update.


## G. 过度暴露 / 装饰不一致 — 2 条

- **对 fulfillment 取数**:不影响 fulfillment 取数(pick 只取一个字段)
- 返回比声明更多的原始字段、随记录漂移。**修法**:加字段白名单(present());低优先(多返不少返)。

  - **`ingress.source.get/update/enable/disable`** (ingress) — present() returns the raw Entity-Factory record with keyHash stripped, so the outward shape leaks ALL non-sensitive entity fields (status='ACTIVE' entity-lifecycle, updatedAt, lastFiredAt, hitCount, dupCount) that the legacy `returns` never advertised — schemad them so the contract is no longer silently wider than declared. Also: get() is documented elsewhere as returning null on miss, but entity.get() actually THROWS NOT_FOUND — a doc/behaviour mismatch (not changed, only the local description corrected).
  - **`user.profile (getProfile)`** (user) — Returns the raw stored user record with NO field allow-list beyond stripping salt/hash — shape drifts per record (legacy users may lack way/meta/categories; role/last/deletedAt appear only after assign/login/delete). Declared the always-written-at-register keys as required and the rest as conditional, but the handler emits whatever happens to be stored (e.g. `last`, future fields) — an unbounded surface, not a fixed contract.
