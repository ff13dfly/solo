# UI E2E (Playwright) — {{PROJECT_NAME}} operator portal

Browser smoke tests for the **operator portal** (the source SOLO ships into this project at
`portal/operator/` for you to customize). Mirror of SOLO's own `e2e/ui` — trimmed to the one
portal you actually own here.

## Quick start

```bash
# 1. Backend up (in another terminal)
bash ../deploy/run.sh

# 2. Serve the operator portal (pick one):
#    a) built tarball via run.sh → already on PORTAL_OPERATOR_PORT (3600)
#    b) live source:  cd ../portal/operator && npm install && npm run dev   # vite, e.g. :5173

# 3. Configure + install + run
cp .env.example .env          # set OPERATOR_URL + auth (SOLO_E2E_TOKEN is easiest)
npm install
npx playwright install chromium
npm test                      # or: npm run test:smoke
```

## How it works

- `global-setup.ts` writes `state/operator.json` — points the portal at the **test router**
  (`SOLO_ROUTER_URL`) and, if you give it auth, drops in a session token so tests start logged in.
  - **Auth (pick one in `.env`)**: `SOLO_E2E_TOKEN` (pre-seeded token, no login) **or**
    `TEST_USER`/`TEST_PASSWORD` (a registered operator user, logged in via `user.login.*`).
  - Token-less still writes the state (router only) → tests cleanly fail by redirecting to `/login`.
- `tests/operator/*.spec.ts` run against `OPERATOR_URL` with that storage state.

## Writing tests

Copy `tests/operator/smoke.spec.ts` per page/flow. The `helpers/` (`api.ts` login + `crypto.ts`)
let you seed/verify state through the Router. Keep `helpers/crypto.ts` in sync with
`portal/operator/src/utils/crypto.ts` if you change the login hashing.

> This is a **starter** — it ships one smoke suite. Grow it as you customize `portal/operator`.
