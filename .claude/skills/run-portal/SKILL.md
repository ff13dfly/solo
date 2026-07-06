---
name: run-portal
description: Launch the SOLO admin console (portal/system) already logged-in against the running dev stack and screenshot a page, to visually verify a portal UI change. Optionally seeds reliability demo data (a STALLED run, a FAILED run with a Saga rollback, an ops alert) so the Agent Nexus → Control / Event Bus pages render populated. Use when asked to run / open / screenshot the system console, or to confirm a portal/system UI change actually renders.
---

# run-portal — see a portal/system UI change for real

The system console is a login-gated Vite/React SPA whose reliability pages only render after
admin auth + with data. This skill skips the manual login + data setup: it injects an admin
session (auth bypass) and, optionally, safe demo fixtures, then drives headless chromium to a
screenshot. **Verified working 2026-06-26** (used to confirm the run.retry / ops-alerts /
Saga-compensation UI).

## Prerequisites (check first)

- **Dev stack running**: router answers on `:8600`, redis-stack (RedisJSON) on `:6699`.
  `curl -s -XPOST http://localhost:8600/jsonrpc -d '{"jsonrpc":"2.0","method":"ping","id":1}'`
  → `{"result":{"status":"ok",...}}`. If down: `bash deploy/dev.sh`.
- **Portal deps**: `portal/system/node_modules` present (else `cd portal/system && npm install`).
- redis-stack on 6699 is required (the run docs are RedisJSON) — `JSON.SET` must work.

## Steps (run from repo root)

```bash
SK=.claude/skills/run-portal

# 1) seed safe demo fixtures (admin session + STALLED/FAILED+compensation runs + ops alert).
#    All `vis-`-prefixed, terminal/STALLED so the live worker never touches them.
node "$SK/seed.js"

# 2) launch the portal dev server (Vite, port 9200) in the background
( cd portal/system && npx vite > /tmp/run-portal-vite.log 2>&1 & )
#   wait until it answers:  curl -s -o /dev/null -w '%{http_code}' http://localhost:9200/  → 200

# 3) screenshot (chromium ships with e2e/ui's Playwright — no install). Writes PNGs into $SK/.
node "$SK/shoot.js"                 # reliability tour: Control + expanded Saga rollback + Event Bus runs
#   or one page:  node "$SK/shoot.js" --route nexus/control

# 4) LOOK at the screenshots — $SK/shot-automation.png, shot-compensation.png, shot-events.png
#    (Read them. A blank/login frame = the localStorage injection didn't take → check step 1/2.)

# 5) ALWAYS clean up — remove demo data + stop vite
node "$SK/seed.js" --clean
lsof -ti:9200 | xargs kill 2>/dev/null || true
```

## How the auth bypass works (`shoot.js`)

The portal reads `localStorage['sys_session_token']` for the `Authorization: Bearer` header
and `localStorage['solomind:router_addresses']` (+ `:current_router_index`) for the router URL.
`shoot.js` sets both via Playwright `addInitScript` **before** app scripts run:
- session → `vis-admin-token`, which `seed.js` wrote to redis as `session:vis-admin-token`
  (`{role:'admin', permit:{allow_all:true}}` — the router validates it like any session);
- router → `http://localhost:8600/` (the portal default is the SSL proxy `https://localhost:8800/`,
  so this override is required to reach the plain dev router).

## Routes / where the reliability UI lives

- `nexus/control` — AutomationControl: Re-drive button (STALLED rows), **Ops alerts** panel,
  expand a FAILED run for the **Saga rollback** table.
- `nexus/events` (Runs tab) — EventManagement: **RETRY** button on STALLED rows.

## Gotchas (cosmetic — not failures)

- The header chip says `https://localhost:8800` (the default router *name*); data still loads
  from 8600 (the active address) — ignore it.
- A `/config.js 404` in the console log is expected (no dev config injection) — harmless.
- To screenshot a different portal, point `PORTAL_URL` / routes at it (operator is at `:9100`-ish,
  has no reliability pages — see portal/operator).

## If this skill drifts

Routes, localStorage keys, or seed shapes change → update `seed.js` / `shoot.js`. The seed
entity shapes mirror `api/core/orchestrator/logic/run.js` (run doc) + `notification` message.
