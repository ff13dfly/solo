require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');

module.exports = {
    serviceName: process.env.SERVICE_NAME || 'orchestrator',
    category: 'system',
    version: pkg.version || '0.1.0',
    port: portFor('orchestrator', 8820),
    routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
    routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',
    linkTimeout: 24 * 60 * 60 * 1000, // 24 hours
    debug: process.env.DEBUG === 'true',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',
    
    // Redis 存储配置
    redis: {
        workflowPrefix: 'ORCHESTRATOR:WORKFLOW:',
        // Workflow id index (Redis SET) — replaces O(keyspace) KEYS scans with O(workflows)
        // SMEMBERS. Underscore (not ':') so it can't collide with a workflow id nor be
        // matched by an 'ORCHESTRATOR:WORKFLOW:*' glob.
        workflowIndex: 'ORCHESTRATOR:WORKFLOW_INDEX',
        // toFix §6.6 — immutable per-version snapshots ('ORCHESTRATOR:WORKFLOW_V:{id}:{n}').
        // Underscore prefix (like workflowIndex) so 'ORCHESTRATOR:WORKFLOW:*' globs and the
        // rebuildIndex KEYS scan can never mistake a snapshot for a live workflow doc.
        workflowVersionPrefix: 'ORCHESTRATOR:WORKFLOW_V:',
        snapshotKey: 'AGENT:WORKFLOW_SNAPSHOT',
        semanticPrefix: 'SYSTEM:SEMANTIC:',
        categoryConfigPrefix: 'CONFIG:CATEGORY:',
        // event.md §5.2 — async run-queue (mirrors notification's queue keys)
        runQueuePending:    'ORCHESTRATOR:RUNQ:PENDING',
        runQueueRetry:      'ORCHESTRATOR:RUNQ:RETRY',
        runQueueDeadletter: 'ORCHESTRATOR:RUNQ:DEADLETTER',
        // event.md §5.4 — run entity (D8: async sources only)
        // Grant keys are stored at runPrefix + id + ':GRANT'
        runPrefix:          'ORCHESTRATOR:RUN:',
        // Run id index (SET) — same rationale as workflowIndex: O(runs) SMEMBERS, not
        // O(keyspace) KEYS. Underscore so it can't collide with a run id / :GRANT suffix.
        runIndex:           'ORCHESTRATOR:RUN_INDEX',
        // Runtime automation pause flag ('1' = paused). Honored by the worker + matcher
        // loops so an operator can degrade to manual without a restart (control.* RPCs).
        controlPausedKey:   'ORCHESTRATOR:CONTROL:PAUSED',
        // toFix §6.2① — at-most-once trigger guard per (event, workflow). The matcher
        // acks AFTER enqueue, so a crash between the two re-delivers the event; this
        // SETNX stops the re-delivery double-firing the workflow.
        firedGuardPrefix:   'ORCHESTRATOR:FIRED:'
    },

    // Where auto→human governance alerts (a run paused awaiting a grant) are delivered.
    // A well-known shared ops inbox operators watch via notification.inbox.list.
    opsInbox: process.env.OPS_INBOX || 'ops',

    // VERSION.md §3.1 — layered approval. Risk is derived from the footprint (see
    // library/risk.js); HIGH-risk workflows route to the approval service's multi-sig
    // gate. Defaults: 1-of-1 (single signature) + a cooling period before the workflow
    // can run + a gate expiry. Submitters cannot weaken these (set by config, not input).
    approval: {
        requiredSignersHigh: parseInt(process.env.APPROVAL_REQUIRED_SIGNERS_HIGH) || 1,
        coolingMsHigh:       parseInt(process.env.APPROVAL_COOLING_MS_HIGH) || (24 * 60 * 60 * 1000), // 24h
        gateExpirySec:       parseInt(process.env.APPROVAL_GATE_EXPIRY_SEC) || 259200,                // 72h
        // sensitiveServices: undefined → library/risk.js default (write-verb only)
    },

    // VERSION.md §3.4 — external submission quota (non-admin workflow.create only).
    submission: {
        maxPerHourPerUser: parseInt(process.env.WORKFLOW_SUBMIT_MAX_PER_HOUR) || 10,
        windowSec:         parseInt(process.env.WORKFLOW_SUBMIT_WINDOW_SEC) || 3600,
        pendingCap:        parseInt(process.env.WORKFLOW_PENDING_CAP) || 100,
    },

    // event.md §6.1 — event matcher consumer. Separate consumer group from nexus
    // (different purpose: nexus delivers to agents; orchestrator triggers workflows).
    // Streams are discovered at startup from ACTIVE workflow event_subscriptions.
    consumer: {
        enabled:       process.env.ORCH_MATCHER !== 'false',
        consumerGroup: 'orchestrator',
        consumerName:  process.env.ORCH_CONSUMER_NAME || 'orchestrator-matcher-1',
        batchSize:     10,
        blockMs:       5000,
        // Extra streams to watch beyond workflow event_subscriptions (optional override).
        extraStreams:  (process.env.ORCH_CONSUMER_STREAMS || '').split(',').filter(Boolean),
        // Fired-guard TTL — same horizon as the Router's event dedup window.
        firedGuardTtlSec: parseInt(process.env.EVENT_DEDUP_TTL_SEC || '3600', 10),
    },

    // event.md §5 — async execution worker. Async triggers (event/cron) enqueue
    // run-commands; this worker drains them under the service bot identity.
    worker: {
        enabled:       process.env.ORCH_WORKER !== 'false',
        botUid:        process.env.ORCH_BOT_UID || 'system.orchestrator',
        retryBaseMs:   1000,
        retryMaxMs:    60000,
        maxRetries:    5,
        blpopTimeout:  5,     // seconds
        loopBackoffMs: 1000,  // pause after an unexpected loop error
        // toFix §6.1④ — stall detection: a RUNNING run whose last activity is older
        // than stallMs was orphaned by a worker death (blPop already ate the command).
        stallMs:       parseInt(process.env.RUN_STALL_MS || '600000', 10),      // 10 min
        stallScanMs:   parseInt(process.env.RUN_STALL_SCAN_MS || '60000', 10),  // sweep every 60s
        // v1-implementation-plan.md P2 (2026-07-03) — Saga compensation retry cap. A distinct,
        // more conservative axis than the in-step `retry` (step.js executeCall, within one
        // attempt): this counts separate ROUNDS a given compensation step has been (re-)attempted
        // ACROSS restarts (STALLED → requeue cycles), persisted on the run doc so it survives a
        // process restart instead of resetting to zero. Past this cap the run stops auto-retrying
        // that compensation and requires a human — see runner.js's runCompensations().
        compensationMaxAttempts: parseInt(process.env.RUN_COMPENSATION_MAX_ATTEMPTS || '3', 10),
    },

    
    // AI 语义描述 (用于 Agent 意图识别)
    description: {
        en: {
            main: [
                "workflow orchestration service for multi-service choreography",
                "defines executable workflow templates with step sequences",
                "supports variable injection ($input, $config, $step, $context)",
                "use for complex business processes spanning multiple services"
            ],
            methods: {
                "orchestrator.workflow.create": [
                    "create a new workflow definition",
                    "requires id, category, name, desc, and steps array"
                ],
                "orchestrator.workflow.get": [
                    "retrieve a single workflow by its ID"
                ],
                "orchestrator.workflow.list": [
                    "list all workflows with optional category filter",
                    "supports pagination via limit and offset"
                ],
                "orchestrator.workflow.update": [
                    "update an existing workflow's metadata or steps"
                ],
                "orchestrator.workflow.delete": [
                    "soft delete a workflow (marks as DELETED)",
                    "workflow can be restored later"
                ],
                "orchestrator.workflow.restore": [
                    "restore a soft-deleted workflow to ACTIVE status"
                ],
                "orchestrator.run": [
                    "execute a workflow with provided input parameters",
                    "returns execution trace with step results"
                ],
                "orchestrator.run.trace": [
                    "per-step execution trace for completed/failed runs (file-backed log, admin)"
                ],
                "orchestrator.workflow.categories": [
                    "list all unique workflow categories",
                    "used for two-step intent matching"
                ],
                "orchestrator.workflow.snapshot": [
                    "get current AI capability snapshot"
                ]
            }
        },
        zh: {
            main: [
                "工作流编排服务，用于多服务流程编排",
                "定义可执行的工作流模板和步骤序列",
                "支持变量注入 ($input, $config, $step, $context)",
                "用于跨多个服务的复杂业务流程"
            ],
            methods: {
                "orchestrator.workflow.create": [
                    "创建新的工作流定义",
                    "需要 id、category、name、desc 和 steps 数组"
                ],
                "orchestrator.workflow.get": [
                    "根据 ID 获取单个工作流"
                ],
                "orchestrator.workflow.list": [
                    "列出所有工作流，可按类别筛选",
                    "支持分页 (limit/offset)"
                ],
                "orchestrator.workflow.update": [
                    "更新工作流的元数据或步骤"
                ],
                "orchestrator.workflow.delete": [
                    "软删除工作流 (标记为 DELETED)",
                    "可稍后恢复"
                ],
                "orchestrator.workflow.restore": [
                    "恢复已软删除的工作流为 ACTIVE 状态"
                ],
                "orchestrator.run": [
                    "使用提供的输入参数执行工作流",
                    "返回包含步骤结果的执行跟踪"
                ],
                "orchestrator.run.trace": [
                    "已完成/失败 run 的逐步执行轨迹（文件落盘日志，管理员）"
                ],
                "orchestrator.workflow.categories": [
                    "列出所有唯一的工作流类别",
                    "用于两步意图匹配"
                ],
                "orchestrator.workflow.snapshot": [
                    "获取当前 AI 能力快照"
                ]
            }
        }
    },

    idLengths: {
        workflow: 6
    },
    
    // 初始化数据种子
    seeds: {
        categories: [
            {
                key: 'TYPE', // Workflow Type
                type: 'LIST',
                scope: 'LOCAL',
                desc: 'Workflow Classification',
                status: 'ACTIVE',
                items: [
                    { id: 'process', label: { zh: '业务流程', en: 'Business Process' }, desc: 'Standard business operation flow' },
                    { id: 'automation', label: { zh: '自动化', en: 'Automation' }, desc: 'Background automation task' },
                    { id: 'approval', label: { zh: '审批流', en: 'Approval' }, desc: 'Human approval required' }
                ]
            }
        ]
    }
};
