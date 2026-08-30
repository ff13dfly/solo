---
name: solo-service
description: Use when creating OR modifying a microservice under api/apps/ in this Solo-based project ({{PROJECT_NAME}}, Solo v{{SOLO_VERSION}}). Enforces the wire contract a Solo Router will accept — method naming, introspection↔index sync, the Entity Factory, no service-to-service direct calls, a self-describing GUIDE.md — points you at the shipped authoring guides + the api/sample template, and ends on a hard autocheck gate. Invoke before writing any service code, and again before declaring a service done.
---

# solo-service — write a service the Router will actually accept

This project runs on a **Solo bundle** (`api/publish/solo.v{{SOLO_VERSION}}.js`) — a black box that
provides the Router, core services, and the shared `api/library/`. Your code lives only in
**`api/apps/<service>/`** and talks to everything else through the Router. The bundle won't
forgive a service that breaks the wire contract: it just won't route to it. This skill keeps you
inside the contract and ends on a gate that proves it.

> **The bundle and `api/library/` are NOT yours to edit.** They're re-synced on every
> `bash deploy/upgrade.sh` and your changes would be lost. Work only in `api/apps/`,
> `deploy/services.json`, and (if you have one) your portal/client app.

## Step 0 — read the contract first (don't reinvent it)

Before writing anything, read — in this order:

0. **`docs/authoring/modeling.md`** — FIRST, and only if the service boundaries aren't settled yet:
   which services should exist at all, and which nouns are entities vs fields. **autocheck validates the
   wire contract, not the design** — a wrongly-partitioned set of services passes every gate below.
   Skip only when you're modifying an existing service whose shape is already decided.
1. **`docs/README.md`** → **`docs/authoring/service.md`** — the service contract, distilled from
   and aligned to the engine. **§0/§4「先复用别重写」** is the most important part.
2. **`api/sample/`** — a complete, runnable service. **Copy it and adapt** — do not start from blank.
3. **`api/library/README.md`** — the catalog of what's already shipped. If the thing you're about
   to write is auth / entity CRUD / categories / indexing / permits / validation / IDs, it's
   almost certainly already in `api/library/` — `require` it, don't rewrite it.
4. If your service **emits or consumes events** → `docs/authoring/events.md`.
5. If you're composing an **orchestrator workflow** → `docs/authoring/workflows.md` (+ `workflow-examples/`).

The method **vocabulary** (what methods exist, params, returns) is discoverable at runtime from the
Router capability catalog in Redis — you don't guess it. These docs supply the **grammar**.

## The red lines (autocheck enforces most of these — don't fight it)

- **Method naming**: `{service}.{entity}.{action}` (e.g. `{{PROJECT_NAME}}.order.create`).
  Foreign keys are `{targetService}Id`. Entity nesting ≤ 3 levels.
- **Declaration ↔ registration MUST match**: every method declared in
  `handlers/introspection.js` is wired in `index.js`, and vice-versa. A method on one side and
  not the other is a hard failure — autocheck's `introspection` / `route-consistency` rules catch it.
- **Ship a `GUIDE.md`** — the fleet-standard system methods are five: `ping` / `methods` /
  `entities` / `events` / **`guide`**. Wire the last one in your `index.js` handlers table and put a
  `GUIDE.md` next to it:

  ```js
  'guide': () => require('../../library/guide').readGuide('<service>', __dirname),
  ```

  `guide` is the one system method that is **registered but NOT declared in
  `handlers/introspection.js`** — don't add it there. Without the file, `system.guide { service }`
  answers `available: false` and silently degrades: an external AI agent can see *what* methods you
  have but never learns *how* to use them. Write the **task recipes** introspection can't express —
  cross-method ordering, idempotency keys, field semantics, gotchas — not a restatement of
  signatures. When the prose and the machine-readable schema disagree, **`methods` introspection
  wins**; say so in the header. Refer to methods by their **fully-qualified** `{service}.{entity}.{action}`
  name, never a bare `entity.action` shorthand — an agent will copy it straight into a call.
  Copy the shape from `api/sample/GUIDE.md`. (autocheck `guide-check`, WARN)
- **No service-to-service direct calls.** Never HTTP/POST another service. Go through the Router:
  `relay.call(...)` for a synchronous reply, or return `_tasks` and let the Router dispatch
  asynchronously, or return `_event` to fan out a fact. (autocheck `relay-check`)
- **Method-level permission is already done by the Router.** When your handler runs, `checkAccess`
  has already passed — do NOT re-check method-level permission. You DO still enforce **data-level**
  `constraints` yourself (row scoping / ownership).
- **Entities go through the Entity Factory** (`api/library/entity.js`): it gives you CRUD + indexing
  + MULTI/EXEC + WAL for free. Declare `sensitiveFields` explicitly in `entities.js`. Default to
  logical soft-delete (`softDelete: true` → status `DELETED`, restorable). Exception: batch-replace
  entities (import-style, where a re-import rewrites the whole period and restoring a single row is
  meaningless) should declare `softDelete: false` instead, with the rationale stated in
  `entities.js` — soft-deleting churn data piles tombstones into the INDEX that every `list()`
  pays to read forever. Either way, logic and `entities.js` must agree. And for "give me
  everything" reads use `entity.listAll()`, never `list({ limit: <a big number> })` — anything
  past the guess is silently dropped. (autocheck `entity-factory` / `soft-delete-check`)
- **Every `*.list` method declares its pagination — or declares that it has none.** The rule is a
  fork, not a blanket "always paginate":
  - **Unbounded collection** (user data, anything that grows with usage) → declare `limit` /
    `offset` / `cursor` in `handlers/introspection.js` and document the paging loop in `GUIDE.md`.
    Declaring `params: []` here is the single most common Solo bug: `entity.list()` defaults to
    `limit = 50`, so the method **silently truncates at 50** and leaves the caller no parameter to
    reach page 2. An external AI agent reads `methods`, sees no pagination, and reports the first
    50 rows as the whole collection. Nothing errors; the data is just wrong.
  - **Bounded collection** (categories, roles, configured models — finite by design) → `params: []`
    is correct, but **say so in the description**: "bounded set, intentionally not paginated".
    On the wire, "needs no pagination" and "author forgot pagination" look identical.
  - The fleet-standard names are **`limit` / `offset` / `cursor`** — `param-conventions.js`'s
    `FLEET_PARAM_TYPES` is the authoritative table. Solo's own older services also accept
    `page` / `pageSize`; that dialect exists only so their existing callers keep working.
    **Never declare it on a new method** — `entity.list()` doesn't read it, and every service
    that accepts it needs a conversion layer (use `library/pagination.js`'s `resolvePaging()`
    if you must accept both; don't hand-roll the arithmetic).
  - Prefer the **cursor** mode (`{ limit, cursor }` → `{ items, nextCursor }`, cost O(limit)) over
    the offset mode (`{ limit, offset }` → `{ items, total }`, which pulls the *entire* index into
    memory and sorts it before slicing one page). Cursor mode needs `migrateCursorIndex()` to have
    run once on pre-existing data — it throws rather than silently degrading. Copy the shape from
    `api/sample/handlers/introspection.js` + `api/sample/GUIDE.md` §分页.
- **Never scan the keyspace to build a list.** `redis.keys('PREFIX:*')` blocks Redis's single
  thread across the whole keyspace — every service in the stack queues behind it. It's invisible in
  dev and takes the stack down months later. `SCAN` is not the fix (it walks the same keyspace);
  a maintained SET/ZSET index is, and the Entity Factory already keeps one for you. `KEYS` is
  acceptable in exactly one place: a boot-time one-shot index rebuild, marked `// SAFE:` with the
  reason on that line. (autocheck `pagination-safety` — also flags `sMembers` / `hGetAll` /
  `zRange(k, 0, -1)`; don't silence those with a bare `// SAFE:` unless the set is genuinely bounded.)
- **`app.listen` takes a host** — `app.listen(PORT, bindAddr('<service>'), cb)` with
  `bindAddr` from `api/library/ports.js`. Omitting the host makes Node bind **every
  interface**, so the day the box gets a public NIC your service is on the internet and
  nothing in the repo can say otherwise — the boundary ends up in some host's firewall
  rules, which aren't in git, vanish on `nft flush ruleset`, and nobody updates when a new
  service is added. `bindAddr` returns `undefined` when neither `BIND_ADDR` nor
  `<SERVICE>_BIND_ADDR` is set, and `listen(port, undefined, cb)` is exactly
  `listen(port, cb)` — so wiring it changes nothing until a deployment opts in with
  `BIND_ADDR=127.0.0.1` (+ `<SERVICE>_BIND_ADDR=0.0.0.0` to expose one service), or with
  per-app `env` in `deploy/services.json`. (autocheck `bind-address`, WARN)
- **`walContext.run` takes `requestContext(req)`, never a hand-written store literal** — both
  from `api/library/entity.js`. `requestContext` carries the WAL uid/trace/depth *plus* the
  Router-issued row-isolation predicate (`constraints.$owner`, present on passport external
  sessions). The Entity Factory enforces it automatically — create stamps the owner field,
  get/update/delete reject cross-owner access as NOT_FOUND, list filters. A hand-written
  literal drops `$owner` on the floor: external principals read the whole table, silently.
  Internal/admin sessions carry no `$owner`, so the two spellings behave identically for
  them — wiring it is pure upside. Only custom data paths that bypass the Entity Factory
  still need manual filtering (`getConstraints(req).$owner`). (autocheck `owner-context`, WARN)
- **No scattered `Date.now()`** — use `api/library/clock.js` (injectable, freezable in tests).
- **No `console.log`** — use the built-in logger from `api/library/logger.js`. (autocheck `logging`)
- **Trust the X-Router-Token, parsed correctly.** The Router signs a *compressed* identity payload;
  take exactly three fields (use `api/library/router-auth.js`'s `parseRouterToken`, don't hand-roll):
  - `req.user` = caller UID **string** (e.g. `'uid-abc123'`) — never the whole payload object.
  - `req.permit` = `'admin'` | `'user'` **string**. `isAdmin` = `req.permit === 'admin'`.
  - `req.constraints` = data-permission object.
  - Self-approval guards compare `submittedBy === callerUid` as **strings**, not object refs.

## If your service ships UI (portal/client)

No `window.alert()` / `window.confirm()` / `window.prompt()` anywhere. Dangerous actions render an
inline warning block or a real confirm modal; light feedback uses the toast system. A native
browser dialog can't be styled, tested, or told apart from a phishing popup.

## Deployment layout (recommended convention, not a gate)

The `deploy/` directory Solo scaffolds for you is **flat and Solo-owned** — `run.sh`,
`precheck.sh`, `admin-up.sh`, `services.json`, `solo-services.json`, `seed.json`. It belongs to the
Solo stack and `upgrade.sh` re-syncs it; don't grow it into a dumping ground for unrelated hosting
config.

When a repo serves **more than one public surface** (a marketing site, a catalogue site, the Solo
stack itself — each on its own domain), the convention that holds up is **one directory per
site/subsystem, each carrying its own `deploy/`**:

```
<site>/deploy/        # that site's deploy script + reverse-proxy config
                      # name the config after the domain: nginx-<domain>.conf, <domain>.conf, …
<solo-stack>/deploy/  # the Solo-owned flat deploy/ above, untouched
```

Why: everything needed to ship one domain stays self-contained and greppable by domain name, and it
never tangles with the Solo-owned `deploy/` that gets overwritten on upgrade. Single-surface
projects don't need this — the flat scaffolded `deploy/` is already right.

This is a convention, not something autocheck enforces. Follow the layout already present in the
repo you're in; if there isn't one and the repo is about to grow a second domain, adopt this.

## Step N — the gate (a service is NOT done until this is green)

Run autocheck's static pass on your service. It encodes 40+ of the rules above:

```bash
node api/autocheck/checker.js api/apps/<service> --static
```

Fix every finding — do not rationalize past it. WARN-level rules (e.g. `guide-check`, which
verifies the `guide` wiring + `GUIDE.md` above) don't fail the run, but treat them as work to do,
not noise. Then register the service in `deploy/services.json` (private apps list) and confirm the
whole set still passes:

```bash
bash deploy/precheck.sh        # runs autocheck --static across every service in services.json
```

For a deeper check that boots the service against Redis and exercises core logic:

```bash
node api/autocheck/checker.js api/apps/<service>      # full mode — needs redis-stack-server reachable
```

Only report the service as done once `--static` is green and it's registered. If autocheck flags
something you believe is a false positive, say so explicitly with the rule name and your
reasoning — don't silently skip it.

> ⚠️ The Solo source repo's `docs/protocol/zh/*` is a larger, maintainer-facing design corpus —
> it contains unimplemented features, known code-drift, and business-domain examples this project
> does not have. It is **not** shipped here on purpose. Build against `docs/authoring/*` + the code
> (`api/sample/`, `api/library/`), never against a protocol draft.
