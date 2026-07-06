# E2E Tests

Black-box integration tests against the live Solo stack.

## Quick start

```bash
# 1. Start the stack (in another terminal)
bash ../deploy/run.sh

# 2. Install test dependencies
npm install

# 3. Run tests
npm test
```

## How it works

- `globalSetup` (`harness/setup.js`) waits for the Router, injects an allow_all admin session into Redis, registers every service with the Router (`system.service.add`), and writes a context file.
- Each suite connects to Redis directly (to assert record state) and calls RPCs through the Router (to assert API behaviour).
- `globalTeardown` cleans up the admin session.

No services are started or stopped by the test harness — that is left to `deploy/run.sh`. The harness registers them with the Router so methods resolve (otherwise everything is `-32601`); this is idempotent with `run.sh`'s own `seed-registry.js`.

## Writing a new suite

Copy `suites/00-sample.e2e.test.js` and follow the pattern:

```
suites/
  NN-service-name.e2e.test.js
```

Key helpers:

| Helper | Where | What it does |
|--------|-------|-------------|
| `rpc(method, params, token)` | `lib/client` | JSON-RPC call through Router |
| `sessionUser(redis, name, permitServices)` | `harness/identity` | Register + login + optional permit grant |
| `cleanupUser(redis, {uid, name})` | `harness/identity` | Remove test user from Redis |
| `V.assertResult(res)` | `lib/verify` | Assert RPC success, return result |
| `V.assertRpcError(res, code)` | `lib/verify` | Assert RPC error with optional code |
| `V.assertRecord(redis, key, expected)` | `lib/verify` | Assert Redis key exists with field subset |
| `V.assertNoErrors(redis, ['svc'])` | `lib/verify` | Assert ERROR:QUEUE is empty |
| `V.readKey(redis, key)` | `lib/verify` | Parse a JSON Redis key |

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | from `../.env` | Redis connection URL |
| `ROUTER_URL` | from `deploy/solo-services.json` | Router endpoint |

Both can be overridden for remote stacks:

```bash
ROUTER_URL=https://my-server/rpc npm test
```
