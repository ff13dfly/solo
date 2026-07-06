# Approval Test Cases

Covers the SAP MVP: the approval state machine, evidence trail, and integrity guards.
Tests run hermetically with an in-memory fake redis (`utils/fake-redis.js`) — no Redis server.

Run: `cd api && npx jest apps/approval/tests/record.test.js`

## record.test.js

| # | Scenario | Expectation |
|---|----------|-------------|
| 1 | request | Creates `state: INIT`, records `applicant` + a `request` attestation (server-attested, payloadHash, publicKey/signature reserved null) |
| 2 | request with empty/invalid payload, or missing target | Rejected (-32602) |
| 3 | verify by a different actor | INIT → DISPATCHED, appends `verify` attestation |
| 4 | applicant verifies own request | Forbidden (-32005) — no self-approval |
| 5 | request → verify → confirm | DISPATCHED → DONE, `confirmedAt` set, evidence stages = [request, verify, confirm] |
| 6 | confirm on an INIT record | Forbidden (-32005) — illegal transition |
| 7 | reject from INIT | → REJECTED, reason recorded in evidence |
| 8 | verify a DONE record | Forbidden (-32005) — terminal state |
| 9 | list by target / by state | Filters correctly |

## Notes / deviations from the draft protocol (docs/protocol/zh/approval.md)

- **Field name**: SAP §3.1 names the state field `status`; the SOLO Entity Factory reserves
  `status` for the ACTIVE/DELETED lifecycle, so the state machine lives in `state`.
- **Method namespace**: the draft uses `yap.record.*`; implemented as `approval.record.*`
  to satisfy SOLO's `service.entity.action` naming rule (service = `approval`).
- **Evidence**: MVP is server-attested (uid + timestamp + payloadHash). `publicKey`/`signature`
  fields are reserved; real Ed25519 verification is deferred until per-user keys exist in core/user.

## Deferred (later phases)

- §8 system-proxy execution (confirm auto-dispatches the change to the target service via relay; adds PENDING/FAILED states)
- §7.2 multi-sig m-of-n; §7.2 expiry
- §9 rule engine (thresholds / immutability / auto-reject); §6.3 AI pre-audit
- §6.1 per-target dynamic authorization (beyond the Router's method-level gate)
