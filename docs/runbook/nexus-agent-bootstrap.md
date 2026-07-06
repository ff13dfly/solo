# Nexus Agent Bootstrap Runbook

How to register an AI agent in the Nexus control plane and wire it up so
it actually receives and responds to events.

This procedure is repeated each time a new agent is added to the system.

> Related: `docs/runbook/bot-bootstrap.md` (system bot accounts)
> Reference: `api/core/nexus/README.md §3`

---

## Prerequisites

- Solo dev stack is running (`bash deploy/dev.sh`)
- System bot accounts are bootstrapped (`system.nexus` token deployed)
- You can log in to portal/system as admin

---

## Step 1 — Create a bot account (Track 1 only)

If the agent is an **internal bot** (Track 1) that needs to make outbound
RPC calls through the Router, create a bot account first.

In **portal/system → Bot Accounts**, click **+ NEW BOT**:

| Field | Value |
|-------|-------|
| Service | Select the service hosting the agent |
| Description | What this bot is used for |

Then configure its permit (**PERMIT** button) to grant only the methods it
actually needs. `allow_all` is forbidden for bot accounts (§7.3).

Finally click **INJECT** to issue a token and deploy it to the service.

> Skip this step for Track 2 external agents — they manage their own tokens.

---

## Step 2 — Register the Agent in Nexus

In **portal/system → Nexus Agents**, click **+ NEW AGENT**:

| Field | Notes |
|-------|-------|
| Name | Human-readable display name |
| Authority Role | Links to the bot account from Step 1 (descriptive, not enforced) |
| Description | What this agent does |
| Track | `internal` for host-embedded AI, `external` for external processes |
| Reachability | How events reach this agent (see table below) |
| Webhook URL | Required if Reachability = `webhook` |
| Event Subscriptions | One stream key per line, e.g. `EVENT:WORKFLOW:STATUS:PENDING_REVIEW` |

### Reachability modes

| Mode | Meaning | Needs BROADCAST? |
|------|---------|-----------------|
| `built-in` | Agent is embedded in a host service, triggered by direct function call | No |
| `polling` | Agent polls its notification inbox | No |
| `sse` | Events pushed via SSE to an online Adapter | **Yes** |
| `webhook` | Events delivered to an HTTP endpoint | **Yes** |

---

## Step 3 — Broadcast (sse / webhook only)

If reachability is `sse` or `webhook`, the agent's delivery config must be
explicitly pushed to the notification service. Without this step, messages
are stored in the agent's inbox but never actively delivered.

Click **BROADCAST** on the agent row.

Expected result: `Delivery config pushed to notification (sse|webhook)`

**Why this is a manual step:** BROADCAST writes to notification's config
store on behalf of nexus. Making it explicit keeps the cross-service
contract visible — it is not a hidden side effect of agent creation.
See `api/core/nexus/README.md §3` for the full rationale.

---

## Step 4 — Verify

Check the agent row in Nexus Agents:

- **Status**: `ACTIVE`
- **ONLINE** dot: lit if the agent has sent a heartbeat in the last 60 s

To confirm notification config was set:

```bash
curl -X POST $ROUTER/jsonrpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"notification.config.get\",\"params\":{\"targetId\":\"<agent_id>\"}}"
```

Expected for an SSE agent:

```json
{
  "targetId": "<agent_id>",
  "rules": [{ "type": "*", "channel": "sse" }]
}
```

If `rules` is empty, BROADCAST did not complete — retry Step 3.

---

## Day-to-day

- **Swap an agent**: register new agent → BROADCAST if needed → disable old agent. No code changes.
- **Change webhook URL**: currently requires disabling and re-creating the agent, then re-BROADCAST.
- **Disable an agent**: click DISABLE on the agent row. Nexus stream consumer stops routing events to it immediately.

---

## Emergency

If an agent is suspected of misbehaving, click **DISABLE** in the Nexus
Agents page. Event routing stops immediately. The agent's notification
inbox is preserved but no new messages will be delivered.

To fully remove: disable the agent, then delete its bot account in Bot
Accounts if one was provisioned.
