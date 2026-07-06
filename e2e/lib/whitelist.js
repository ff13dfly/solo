/**
 * Shared _tasks whitelist superset (single source of truth).
 *
 * The Router caches the task whitelist in-process for 60s (handlers/tasks.js CACHE_TTL)
 * with NO cache-bust on write. So a suite that writes WL_KEY then immediately dispatches a
 * _task races that 60s cache — if the cache is still warm it reads the PREVIOUS value and
 * the _task is wrongly BLOCKED (e.g. "market.order.pay is not allowed"). Because every
 * pipeline suite (54/101/102/103/104) rewrote WL_KEY to its own narrow subset + restored,
 * the value flipped at each suite boundary and the race surfaced non-deterministically
 * (BACKLOG §5.6③).
 *
 * Fix: keep WL_KEY at ONE union superset for the whole run — seeded at harness boot and
 * written identically by any suite that still sets it. The value never changes, so the
 * cache always reflects a market/collection-inclusive whitelist and no _task is ever
 * wrongly blocked. (No suite asserts a _task is BLOCKED, so a permissive superset masks
 * nothing — verified.)
 */
const WL_KEY = 'SYSTEM:CONFIG:TASK_WHITELIST';

// Union of every subset the pipeline suites need. allowFrom '*'/fulfillment mirrors what
// those suites already granted; kept broad because this is the test mesh, not production.
const TASK_WHITELIST_SUPERSET = {
    user:         { allowFrom: ['authority'],   allowMethods: ['user.permit.update'] },
    notification: { allowFrom: ['*'],           allowMethods: ['notification.send'] },
    gateway:      { allowFrom: ['*'],           allowMethods: ['push', 'gateway.email.send', 'gateway.sms.send', 'gateway.webhook.send'] },
    log:          { allowFrom: ['*'],           allowMethods: ['log.write'] },
    collection:   { allowFrom: ['fulfillment'], allowMethods: ['collection.payment.record', 'collection.payment.settle'] },
    market:       { allowFrom: ['fulfillment'], allowMethods: ['market.shipment.create', 'market.shipment.ship', 'market.order.pay', 'market.order.confirm', 'market.order.hold'] },
};

module.exports = { WL_KEY, TASK_WHITELIST_SUPERSET };
