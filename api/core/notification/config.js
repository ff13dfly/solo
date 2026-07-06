require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');

module.exports = {
    port: portFor('notification', 8040),
    debug: process.env.DEBUG === 'true',
    serviceName: process.env.SERVICE_NAME || 'notification',
    version: pkg.version,
    pageSize: 20,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',
    routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
    routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',

    idLengths: {
        message: 12
    },

    redis: {
        msgPrefix:     'NOTIFICATION:MSG:',
        inboxPrefix:   'NOTIFICATION:INBOX:',
        configPrefix:  'NOTIFICATION:CONFIG:',
        indexKey:      'NOTIFICATION:INDEX',
        dedupPrefix:   'NOTIFICATION:DEDUP:',           // {targetId}:{ref} -> messageId (idempotency)
        queuePending:  'NOTIFICATION:QUEUE:PENDING',
        queueRetry:    'NOTIFICATION:QUEUE:RETRY',      // zset: nextAttemptAt(ms) -> task json
        queueDead:     'NOTIFICATION:QUEUE:DEADLETTER'  // list: tasks that exhausted retries
    },

    // Idempotency window: a (targetId, ref) seen within this TTL is a duplicate send
    // (covers consumer redelivery/retry). Long enough to outlast any upstream retry loop.
    dedupTtlSec: Number(process.env.NOTIFICATION_DEDUP_TTL_SEC) || 86400,

    worker: {
        enabled: process.env.NOTIFICATION_WORKER !== 'false',
        blpopTimeout: 5,
        retryBackoffMs: 30000,  // sleep after a worker-loop crash (e.g. redis disconnect)
        maxRetries: 5,          // delivery attempts before a task is dead-lettered
        retryBaseMs: 5000,      // exponential backoff base: base * 2^attempts
        retryMaxMs: 300000,     // backoff cap (5 min)
        // toFix §6.5 — minimal DLQ-depth alerting (no Prometheus required).
        // Sweep interval + threshold; re-alert throttling rides on dedupTtlSec (ref-dedup).
        dlqAlertScanMs:    Number(process.env.NOTIFICATION_DLQ_ALERT_SCAN_MS) || 300000,
        dlqAlertThreshold: Number(process.env.NOTIFICATION_DLQ_ALERT_THRESHOLD) || 10,
        opsInbox: process.env.OPS_INBOX || 'ops',
    },

    description: {
        en: {
            main: [
                "system notification service: storage, inbox, delivery routing",
                "single source of truth for async system messages",
                "transactional messages (OTP etc) go direct to gateway, not here"
            ],
            methods: {
                "notification.send":         ["store a message, write to inbox, route delivery per config"],
                "notification.inbox.list":   ["list inbox messages for a target (paginated, unread-first)"],
                "notification.inbox.ack":    ["mark messages as read"],
                "notification.config.set":   ["set delivery rules for a target"],
                "notification.config.get":   ["get delivery rules for a target"],
                "notification.deadletter.list":    ["list failed-delivery tasks in the dead-letter queue (admin)"],
                "notification.deadletter.requeue": ["requeue dead-letter tasks back to pending for redelivery (admin)"],
                "ping":     ["service health check"],
                "methods":  ["get service method list"],
                "entities": ["get entity definitions"]
            }
        },
        zh: {
            main: [
                "系统消息存储与触达引擎",
                "系统通知的唯一可信源，需持久化的异步消息走这里",
                "事务性消息（OTP 等）直接走 gateway，不进 notification"
            ],
            methods: {
                "notification.send":         ["存储消息、写入目标 Inbox、按配置触发投递"],
                "notification.inbox.list":   ["拉取目标的 Inbox（未读优先，支持分页）"],
                "notification.inbox.ack":    ["标记消息已读"],
                "notification.config.set":   ["设置目标的投递规则"],
                "notification.config.get":   ["读取目标的投递规则"],
                "notification.deadletter.list":    ["查看死信队列中投递失败的任务（管理员）"],
                "notification.deadletter.requeue": ["将死信任务重新放回待投递队列重新触达（管理员）"],
                "ping":     ["服务健康检查"],
                "methods":  ["获取服务方法列表"],
                "entities": ["获取实体定义"]
            }
        }
    },

    indexes: {}
};
