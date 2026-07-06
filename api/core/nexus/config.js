require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');

module.exports = {
    port: portFor('nexus', 8740),
    debug: process.env.DEBUG === 'true',
    serviceName: process.env.SERVICE_NAME || 'nexus',
    version: pkg.version,
    pageSize: 20,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',
    routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
    routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',

    idLengths: {
        sentinel: 12
    },

    // §1.2 per-Sentinel identity: a Sentinel whose authorityRole is a `system.*` bot
    // uid runs its data-fetches under its OWN token (least-privilege). rotateBeforeMs
    // is how early a held Sentinel token self-refreshes (mirrors relay's default 2h).
    identity: {
        rotateBeforeMs: 2 * 60 * 60 * 1000,
    },

    redis: {
        sentinelPrefix:        'NEXUS:SENTINEL:',
        sentinelSet:           'NEXUS:SENTINEL:SET',
        subscriptionPrefix: 'NEXUS:SUB:',
        onlinePrefix:       'NEXUS:SENTINEL:ONLINE:',
        // §1.2 — per-Sentinel bot session tokens, keyed by authorityRole (system.* uid).
        sentinelTokenPrefix:   'NEXUS:SENTINEL:TOKEN:',
        // Per-sentinel activity ledger (fired/skipped/failed counters + lastFiredAt),
        // written best-effort by the stream consumer, surfaced by sentinel.get/list —
        // "did this sentinel ever react?" used to require grepping nexus logs.
        sentinelActivityPrefix: 'NEXUS:SENTINEL:ACTIVITY:',
        // §2.2 — at-most-once guard for context.emit, keyed NEXUS:EMIT:{ref}:{sentinelId}.
        emitGuardPrefix:       'NEXUS:EMIT:',
        // Runtime automation pause flag ('1' = paused). Honored by the stream consumer +
        // scheduler loops so an operator can degrade to manual without a restart.
        controlPausedKey:      'NEXUS:CONTROL:PAUSED',
        consumerGroup:      'nexus',
        consumerName:       process.env.NEXUS_CONSUMER_NAME || 'nexus-consumer-1',
        // Reliability: per-entry retry bookkeeping + dead-letter stream (context.md §7.3).
        retryPrefix:        'NEXUS:RETRY:',
        dlqStream:          'NEXUS:DLQ',
        // event.md §6.2 — scheduler storage
        scheduleZset:       'NEXUS:SCHEDULE',
        scheduleDefPrefix:  'NEXUS:SCHEDULE:DEF:',
        // Direct lPush target for run_command actions (orchestrator shared Redis).
        // Both services share the same Redis instance in a single-node deployment.
        orchRunQueuePending: 'ORCHESTRATOR:RUNQ:PENDING',
    },

    heartbeat: {
        ttlSeconds: 60
    },

    consumer: {
        enabled: process.env.NEXUS_CONSUMER !== 'false',
        streams: [
            'EVENT:WORKFLOW:STATUS',
            'EVENT:WORKFLOW:RESULT'
        ],
        blockMs: Number(process.env.NEXUS_CONSUMER_BLOCK_MS) || 5000,
        batchSize: 10,
        // Reliability knobs (env-overridable for tests). After maxDeliveries failed
        // attempts an entry is parked to the DLQ; retries use exponential backoff.
        maxDeliveries: Number(process.env.NEXUS_MAX_DELIVERIES) || 5,
        retryBaseMs:   Number(process.env.NEXUS_RETRY_BASE_MS) || 2000,
        retryMaxMs:    Number(process.env.NEXUS_RETRY_MAX_MS) || 60000,
        // §2.2 — how long the context.emit at-most-once guard key lives (>> any retry window).
        emitGuardTtlSec: Number(process.env.NEXUS_EMIT_GUARD_TTL_SEC) || 86400,
    },

    // event.md §6.2 — time-driven scheduler (D6: same-process setInterval tasker).
    scheduler: {
        enabled: process.env.NEXUS_SCHEDULER !== 'false',
        // how often to scan for due schedule entries (env override for tests / tuning).
        tickMs:  Number(process.env.NEXUS_SCHEDULER_TICK_MS) || 30_000,
    },

    description: {
        en: {
            main: [
                "Sentinel registry & event-routing hub",
                "manages Sentinels — event-subscribed, declarative, optionally AI-backed reactors",
                "assembles each Sentinel's context and routes events to it; delivery via notification"
            ],
            methods: {
                "nexus.sentinel.create":    ["create a Sentinel (event subscriptions + declarative context)"],
                "nexus.sentinel.update":    ["update a Sentinel's fields; re-syncs event subscriptions"],
                "nexus.sentinel.list":      ["list registered Sentinels"],
                "nexus.sentinel.get":       ["retrieve a Sentinel by id"],
                "nexus.sentinel.disable":   ["disable a Sentinel (stops event delivery + cleans subscriptions)"],
                "nexus.sentinel.enable":    ["re-enable a DISABLED Sentinel"],
                "nexus.sentinel.delete":    ["permanently delete a Sentinel from the registry"],
                "nexus.sentinel.heartbeat":  ["a Sentinel reports liveness (writes a TTL online key)"],
                "nexus.sentinel.resolve":    ["resolve active Sentinels subscribed to an event stream key"],
                "nexus.sentinel.broadcast":  ["push a Sentinel's delivery config to notification (explicit step)"],
                "nexus.sentinel.token.set":  ["admin: inject a per-Sentinel bot token (§1.2 manual provisioning)"],
                "ping":     ["service health check"],
                "methods":  ["get service method list"],
                "entities": ["get entity definitions"]
            }
        },
        zh: {
            main: [
                "Sentinel 注册与事件路由中枢",
                "管理 Sentinel —— 订阅事件、声明式、可选 AI 驱动的反应体",
                "为每个 Sentinel 装配上下文并把事件路由给它；物理投递走 notification"
            ],
            methods: {
                "nexus.sentinel.create":    ["创建 Sentinel（事件订阅 + 声明式上下文）"],
                "nexus.sentinel.update":    ["更新 Sentinel 字段；变更事件订阅会重新同步"],
                "nexus.sentinel.list":      ["列出已注册 Sentinel"],
                "nexus.sentinel.get":       ["根据 id 获取 Sentinel"],
                "nexus.sentinel.disable":   ["禁用 Sentinel（停止事件投递 + 清订阅集）"],
                "nexus.sentinel.enable":    ["重新启用已禁用的 Sentinel"],
                "nexus.sentinel.delete":    ["从注册表永久删除 Sentinel"],
                "nexus.sentinel.heartbeat":  ["Sentinel 上报存活心跳（写 TTL online key）"],
                "nexus.sentinel.resolve":    ["查询订阅了指定事件 stream key 的活跃 Sentinel"],
                "nexus.sentinel.broadcast":  ["将 Sentinel 投递配置推送到 notification（显式步骤）"],
                "nexus.sentinel.token.set":  ["管理员：注入某个 Sentinel 的 bot token（§1.2 手动发证）"],
                "ping":     ["服务健康检查"],
                "methods":  ["获取服务方法列表"],
                "entities": ["获取实体定义"]
            }
        }
    },

    indexes: {}
};
