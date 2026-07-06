# Notification Test Cases

## Delivery reliability (worker.test.js)

The delivery worker must never silently drop a message on a transient failure.

| # | Scenario | Expectation |
|---|----------|-------------|
| 1 | Delivery throws (gateway/relay error), attempts below `maxRetries` | Task is re-scheduled on the retry queue (`QUEUE:RETRY`), not dead-lettered |
| 2 | No relay/token injected yet | Treated as transient → retry, message is not dropped |
| 3 | Delivery keeps failing until `attempts >= maxRetries` | Task is moved to the dead-letter queue (`QUEUE:DEADLETTER`) with `attempts`/`lastError`/`failedAt` |
| 4 | Underlying message no longer exists | Queue entry is dropped (nothing to deliver), no retry/dead-letter |
| 5 | `promoteDueRetries` runs | Retry-queue tasks whose backoff has elapsed are moved back to `QUEUE:PENDING`; not-yet-due tasks stay |

## Dead-letter operations (admin)

| # | Scenario | Expectation |
|---|----------|-------------|
| 6 | `notification.deadletter.list` | Returns parsed dead-letter items + total |
| 7 | `notification.deadletter.requeue` by `messageId` | Moves the matching dead task back to pending with `attempts` reset to 0 |
| 8 | `requeue` with neither `messageId` nor `all` | Throws `MISSING_PARAM` |

Backoff: `min(retryBaseMs * 2^attempts, retryMaxMs)`. All values configurable under `config.worker`.
