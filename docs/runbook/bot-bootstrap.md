# Bot Account Bootstrap Runbook

How to provision and wire up the three system bot accounts that internal
services (`notification`, `nexus`, `orchestrator`) use to make
Router-mediated calls on each other.

This is a **one-time per deployment** procedure. After it's done, the
relay library handles rotation automatically.

> Reference: `docs/protocol/zh/security.md §7`.
> Related: `docs/runbook/nexus-agent-bootstrap.md` (registering AI agents after bot accounts are set up).

---

## Prerequisites

- Solo dev stack is running (`bash deploy/dev.sh`)
- You can log in to portal/system as admin
- portal/system is on your local machine (per §8.2)

---

## Step 1 — Create the three bot accounts

In **portal/system → Bot Accounts**, click **+ NEW BOT** three times to
create:

| UID | Description |
|-----|-------------|
| `system.notification` | Delivers messages to gateway channels |
| `system.nexus` | Routes stream events into notifications |
| `system.orchestrator` | Reserved for autonomous workflow runs (no permit needed yet) |

(The `system.` prefix is added automatically by the form.)

Each bot is created with an empty permit. The next step grants only the
methods that bot actually needs.

---

## Step 2 — Set bot permits

Click **PERMIT** on each bot and grant exactly:

**`system.notification`**
```json
{
  "services": {
    "gateway": ["gateway.email.send", "gateway.sms.send"]
  }
}
```

**`system.nexus`**
```json
{
  "services": {
    "notification": ["notification.send"]
  }
}
```

**`system.orchestrator`**
```
(leave empty for now — runner still propagates the caller's token; this
 bot is reserved for future event/scheduled triggers)
```

The Permit modal forbids `allow_all` for bot accounts (§7.3 enforced
client- AND server-side).

---

## Step 3 — Issue tokens and deploy to services

For each bot, click **ISSUE TOKEN**. A modal shows the token **once**.

Immediately after copying the token, call the target service's
`token.set` RPC (admin auth required, goes through Router):

```bash
# Replace TOKEN, EXPIRES_AT, ROUTER, ADMIN_TOKEN
curl -X POST $ROUTER/jsonrpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "notification.token.set",
    "params": {
      "token": "<paste token from modal>",
      "expiresAt": <paste expiresAt number>,
      "sub": "system.notification"
    }
  }'
```

Replace `notification` with `nexus` for the nexus bot. Skip
`orchestrator` for now (Step 2 leaves its permit empty so a token would
be useless).

The `sub` field is checked server-side — it must match `system.<service>`
or the relay rejects the token.

---

## Step 4 — Verify

For each service whose token you set, run the status RPC:

```bash
curl -X POST $ROUTER/jsonrpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"notification.token.status","params":{}}'
```

Expected response:
```json
{
  "hasToken": true,
  "sub": "system.notification",
  "expiresAt": 1747...,
  "ttlMs": 86399000,
  "needsRotation": false,
  "expired": false
}
```

If `hasToken: false`, the inject failed — re-run Step 3.

---

## Day-to-day

After bootstrap, the relay library rotates tokens automatically
(threshold: 2 hours before expiry). You only repeat this procedure when:

- The bot account is deleted or its permit is changed
- The Redis store loses the token (rare — only on RDB rollback past the
  last refresh)
- You suspect compromise and clear the token manually via
  `<service>.token.clear`

---

## Emergency revoke

If a service token is suspected leaked:

```bash
curl -X POST $ROUTER/jsonrpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"notification.token.clear","params":{}}'
```

The service will start returning `NO_TOKEN` errors on internal calls
until a new token is issued and set (Step 3).
