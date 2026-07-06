# e2e/ui — Playwright UI e2e (system + operator + mobile)

Browser-level e2e for the SOLO frontends. Two stacks live side-by-side and stay separate:

- **`e2e/` (Jest)** — node RPC regression against the live mesh (no browser). Blocking in CI.
- **`e2e/ui/` (Playwright, this dir)** — real Chromium driving the portals. The ~part that
  only a browser can verify: rendering, auth/session, navigation, and *what the UI calls*.

Adapted from the septopus/world desktop e2e patterns, fitted to SOLO's multi-portal + RPC mesh.

## Layout

```
playwright.config.ts          system (:9200) + operator (:9300) projects; webServer auto-serves both
playwright.mobile.config.ts   mobile (:9500), ROUTE-MOCKED (no mesh/Redis)
global-setup.ts               logs in admin + operator → writes Playwright storageState
scripts/meshup.js             boots the 13-service mesh + seeds admin & operator users + readiness :8699
helpers/
  fixtures.ts                 injects window.__SOLO_ROUTER__ before portal bundles evaluate
  api.ts / crypto.ts          challenge-response login (admin = PBKDF2, user = SHA-256)
  rpc.ts                      RPC-call recorder — assert WHICH JSON-RPC the portal emits
  portals.ts                  page objects (stable data-testid contract, not raw selectors)
  mobile.ts                   route-mock harness for the mobile client
tests/{system,operator,mobile}/*.spec.ts
```

## Running

```bash
cd e2e/ui && npm ci && npx playwright install chromium

# One command — auto-boots the mesh AND serves both portals (vite), then tests.
# Use an ISOLATED Redis so you never touch the dev stack on 6699.
REDIS_URL=redis://localhost:6799 UI_E2E_BOOT_MESH=1 \
  ADMIN_PASSWORD=changeme TEST_USER=e2e-operator TEST_PASSWORD=changeme \
  npx playwright test --grep-invert @quarantine          # the stable core

# Portals only (mesh already running elsewhere): drop UI_E2E_BOOT_MESH.
npx playwright test --project=system

# Mobile (route-mocked, nothing else needed):
npx playwright test --config=playwright.mobile.config.ts
```

`webServer` (playwright.config.ts) always auto-serves the two portals (`reuseExistingServer`).
The **stateful mesh is opt-in** via `UI_E2E_BOOT_MESH=1` — the harness reuses any router/redis
already on its ports, so booting it transparently would cross-wire with a running dev stack.

### Useful env

| var | default | meaning |
|-----|---------|---------|
| `SOLO_ROUTER_URL` | `http://localhost:8600` | Router the portals + global-setup target |
| `SYSTEM_PORTAL_URL` / `OPERATOR_PORTAL_URL` | `:9200` / `:9300` | portal baseURL + storageState origin (keep in sync) |
| `UI_E2E_BOOT_MESH` | unset | `1` → webServer boots the mesh via meshup.js |
| `UI_MESH_READY_PORT` | `8699` | meshup HTTP readiness endpoint |
| `ADMIN_USERNAME`/`ADMIN_PASSWORD`, `TEST_USER`/`TEST_PASSWORD` | `admin`/`changeme`, — | login creds for global-setup |

## Patterns

- **RPC-call assertions** (`helpers/rpc.ts`) — `recordRpc(page)` observes every JSON-RPC the
  portal sends to the Router. Assert the *set* of methods: e.g. an anonymous surface emits no
  privileged/non-public method (the UI mirror of the public-method convergence work), or every
  authenticated call carries a Bearer token. See `tests/system/rpc-surface.spec.ts`.
- **Page objects + data-testid** (`helpers/portals.ts`) — portal labels are i18n'd, so text/role
  selectors break on copy changes. Key elements carry a stable `data-testid`; specs talk to a page
  object, never raw selectors. New screen → add testids + a page object.

## Quarantine

A spec tagged **`@quarantine`** in its title is known-unstable. CI runs the stable core
(`--grep-invert @quarantine`) **blocking** and the quarantined set (`--grep @quarantine`) in a
**non-blocking** step for visibility. Fixing one → drop its tag. Don't add `@quarantine` to dodge a
real regression — only for pre-existing instability.

### Triage (2026-06-30) — all 7 fixed, zero product bugs

The original 7 quarantined specs were every one a TEST issue, not a framework/product defect.
All are now fixed and un-quarantined (clean full run: 49 passed / 0 failed):

- **Route drift** — `nexus-sentinel` (×2) + `sentinel-autorun-emit` + `sentinel-provisioning`
  navigated to `/nexus`, but the NexusHub refactor (`NexusManagement` → `NexusHub`) moved the
  sentinel UI to `/nexus/sentinels` (`/nexus` now redirects to `/nexus/streams`). Fix: route.
- **i18n drift (portal default lang is `en`)** — `bot revoke` asserted Chinese `/吊销 bot/`;
  `provisioning :90` asserted `token 已注入`; `fulfillment` used Chinese placeholders. Fix: assert
  the `en` strings. Also fixed a cosmetic locale defect — `revokeTitle` in `locales/en.ts` was a
  Chinese string.
- **Inter-test dependency** — `provisioning :90` expects badge `●` (token injected), injected only
  by its sibling `:64` (shared `beforeAll`). Resolved by un-quarantining together (same-file serial).
- **Test-setup, not a product gap** — the seeded `e2e-operator` had an EMPTY permit. meshup.js now
  grants it the operator-portal domains (fulfillment/nexus/...). Note: `nexus.sentinel.create` is
  **admin-gated** (an operator session gets Unauthorized — correct: sentinels are admin-managed), so
  `profile-watchers` now provisions its sentinel with the **admin** token and only the page view runs
  as operator (which can READ `nexus.sentinel.list`).
- **Robustness, surfaced once the operator could load data** — `fulfillment :98` used an ambiguous
  `getByText('Raw')` (matched button + title) → assert the `<pre>`; `fulfillment :47` used a
  per-day-constant profile name with no cleanup → made unique per run.
