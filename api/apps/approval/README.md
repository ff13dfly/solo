# approval — Solo Approval Protocol (SAP) service

Gated, auditable change approval. An `approval.record` captures a **change intent**
(`target` + `payload` operations) and walks it through a state machine, accumulating
an append-only **evidence** trail. The service is **data-agnostic**: any
`service:entity:id` can be put behind approval without that service knowing about SAP.

Protocol spec: [`docs/protocol/zh/approval.md`](../../../docs/protocol/zh/approval.md).

## Methods

| Method | Effect | Who |
|--------|--------|-----|
| `approval.record.request` | Create an `INIT` record from `{ target, payload[] }` | applicant |
| `approval.record.verify`  | `INIT → DISPATCHED` (approve content) | a verifier ≠ applicant |
| `approval.record.confirm` | `DISPATCHED → DONE` (attest physical execution) | confirmer |
| `approval.record.reject`  | `INIT|DISPATCHED → REJECTED` (`reason` optional) | verifier |
| `approval.record.get`     | fetch by id | — |
| `approval.record.list`    | filter by `target` / `state` | — |

Method-level access is gated by the Router (`checkAccess`); the service records the
acting `uid` (`req.user`) and enforces **no self-verification**.

## State machine (protocol §4)

```
request → INIT ──verify──▶ DISPATCHED ──confirm──▶ DONE
                 └────────────reject────────────▶ REJECTED
```

`PENDING` / `FAILED` are reserved for when §8 system-proxy task dispatch is added
(then `verify` dispatches a task: `DISPATCHED → PENDING → DONE|FAILED`).

## Evidence (MVP: server-attested)

Each transition appends an attestation:

```json
{ "stage": "verify", "actor": "<uid>", "payloadHash": "<sha256>",
  "timestamp": 1700000000000, "method": "server-attested",
  "publicKey": null, "signature": null }
```

`publicKey`/`signature` are **reserved** in this MVP record shape. Per-user Ed25519
keypairs now **do** exist in `core/user` (`user.key.generate/sign/public/status/revoke`,
private key scrypt+AES-256-GCM at `USER:SIGNKEY:{uid}` — built for the approval gate,
VERSION.md §3.2). The remaining gap is wiring **approval-side signature verification**
into this record (verify `signature` against the signer's public key); until then MVP
evidence is the server's attestation of *who* acted *when* over *which payload hash*
(WAL-audited). So the blocker is no longer "users have no keypair" — it's this service
adopting the now-available `user.key.*` signing into `record.confirm`.

## Implementation notes / deviations from the draft

- **`state` vs `status`**: the SOLO Entity Factory reserves `status` for the
  ACTIVE/DELETED lifecycle (soft delete), so the SAP state machine is stored in `state`.
- **`approval.record.*` vs `yap.record.*`**: renamed to satisfy SOLO's
  `service.entity.action` naming rule (service = `approval`).

## Deferred (later phases)

§8 system-proxy execution (auto-dispatch to target via relay) · §7.2 multi-sig m-of-n
+ expiry · §9 rule engine (thresholds / immutability / auto-reject) · §6.3 AI pre-audit
· §6.1 per-target dynamic authorization · real Ed25519 verification.

## Tests

`cd api && npx jest apps/approval/tests/record.test.js` — hermetic (in-memory fake redis).
