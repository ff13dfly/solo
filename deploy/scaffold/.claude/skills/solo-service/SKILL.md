---
name: solo-service
description: Use when creating OR modifying a microservice under api/apps/ in this Solo-based project ({{PROJECT_NAME}}, Solo v{{SOLO_VERSION}}). Enforces the wire contract a Solo Router will accept — method naming, introspection↔index sync, the Entity Factory, no service-to-service direct calls — points you at the shipped authoring guides + the api/sample template, and ends on a hard autocheck gate. Invoke before writing any service code, and again before declaring a service done.
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
- **No service-to-service direct calls.** Never HTTP/POST another service. Go through the Router:
  `relay.call(...)` for a synchronous reply, or return `_tasks` and let the Router dispatch
  asynchronously, or return `_event` to fan out a fact. (autocheck `relay-check`)
- **Method-level permission is already done by the Router.** When your handler runs, `checkAccess`
  has already passed — do NOT re-check method-level permission. You DO still enforce **data-level**
  `constraints` yourself (row scoping / ownership).
- **Entities go through the Entity Factory** (`api/library/entity.js`): it gives you CRUD + indexing
  + MULTI/EXEC + WAL for free. Declare `sensitiveFields` explicitly in `entities.js`. Implement
  logical soft-delete (`is_deleted`), never hard-delete. (autocheck `entity-factory` / `soft-delete-check`)
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

## Step N — the gate (a service is NOT done until this is green)

Run autocheck's static pass on your service. It encodes 40+ of the rules above:

```bash
node api/autocheck/checker.js api/apps/<service> --static
```

Fix every finding — do not rationalize past it. Then register the service in
`deploy/services.json` (private apps list) and confirm the whole set still passes:

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
