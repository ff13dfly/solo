require('dotenv').config();
const { portFor, urlFor } = require('../library/ports');

module.exports = {
  port: portFor('router', 8600),
  category: 'system',
  administratorServiceUrl: process.env.ADMINISTRATOR_SERVICE_URL || urlFor('administrator', 8680),
  defaultLanguage: 'zh',

  redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',

  // Redis 存储配置
  redis: {
    activeServicesKey: 'active_services',
    capabilityKey: 'system:capability:list',
    sessionPrefix: 'session:',
    errorQueuePrefix: 'ERROR:QUEUE:',
    categoryRegistryKey: 'SYSTEM:REGISTRY:CATEGORIES',
    capabilitySnapshotPrefix: 'AGENT:CAPABILITY_SNAPSHOT',
    taskWhitelistKey: 'SYSTEM:CONFIG:TASK_WHITELIST',
    rateLimitsKey: 'SYSTEM:CONFIG:RATE_LIMITS',
    permitBlacklistKey: 'SYSTEM:CONFIG:PERMIT_BLACKLIST',
    // event.md §4.2 / D1 — event registry (who may emit what to which stream)
    eventRegistryKey: 'SYSTEM:CONFIG:EVENT_REGISTRY'
  },

  // event.md §4 — default event registry (overridable via Redis SYSTEM:CONFIG:EVENT_REGISTRY).
  // Format: { [source]: { [stream]: ['type', '*'] } }
  // source = service name (for _event in response) or bot uid (for event.emit calls).
  // '*' in types array means any type is allowed for that stream.
  // Business-domain streams (EVENT:ORDER:*, etc.) should be added when real services register.
  eventRegistry: {
    // orchestrator service emitting via _event piggyback on RPC responses
    'orchestrator': {
      'EVENT:WORKFLOW:STATUS': ['*'],
      'EVENT:WORKFLOW:RESULT': ['*'],
    },
    // system.orchestrator bot emitting via event.emit (worker / matcher)
    'system.orchestrator': {
      'EVENT:WORKFLOW:NEEDS_GRANT': ['workflow.needs_grant'],
      'EVENT:WORKFLOW:STATUS':      ['*'],
      'EVENT:WORKFLOW:RESULT':      ['*'],
    },
    // system.nexus bot emitting via event.emit: Sentinel context.emit decision events
    // (§2.2 action loop) onto the EVENT:SENTINEL:* namespace, plus scheduler emit_event
    // actions. Glob lets a Sentinel emit any decision type to EVENT:SENTINEL:{name}
    // without a per-stream registry edit. (e2e uses a separate Redis fixture registry.)
    'system.nexus': {
      'EVENT:SENTINEL:*': ['*'],
    },
    // system.ingress bot emitting via event.emit (inbound webhook adapter).
    // Prefix glob: any dynamically-created EVENT:WEBHOOK:{source} stream is allowed,
    // restricted to the single generic type 'webhook.received' (ingress is a dumb
    // pipe — domain classification happens downstream, not here). See core/ingress/.
    'system.ingress': {
      'EVENT:WEBHOOK:*': ['webhook.received'],
    },
    // system.fulfillment bot: emits one event per successful state transition.
    // Orchestrator/nexus sentinels subscribe to EVENT:FULFILLMENT:TRANSITIONED to
    // chain downstream actions (notification, next workflow step, etc.).
    'system.fulfillment': {
      'EVENT:FULFILLMENT:*': ['*'],
    },
  },

  // event.md D10 — approximate stream MAXLEN (placeholder; xAdd currently unbounded).
  // Set to a positive number to enable MAXLEN trim once confirmed with node-redis version.
  eventMaxLen: 10000,
  debug: process.env.DEBUG === 'true', // Default to false, explicitly enable with 'true'
  bodyLimit: process.env.BODY_LIMIT || '50mb',
  maxStringLength: parseInt(process.env.MAX_STRING_LENGTH, 10) || 5242880, // 5MB default
  maxArrayLength: parseInt(process.env.MAX_ARRAY_LENGTH, 10) || 1000,
  // Param-hygiene rollout mode (router/handlers/validator.js): the NEW string rules
  // (control-char floor, blank-required, pattern, minLength) roll out behind this switch.
  //   'warn'    (default) — log the violation, let the request through (observe first)
  //   'enforce'           — reject with -32602
  // Existing size/type/required-missing checks are unaffected (always enforced).
  paramValidation: process.env.PARAM_VALIDATION || 'warn',

  // System Roles
  roles: {
    admin: 'admin',
    operator: 'operator'
  },

  // Rate Limiting Configuration
  // RATE_LIMIT_DISABLED=true bypasses the limiter entirely — for test harnesses where
  // all traffic comes from one IP and would falsely trip limits (e2e). Off in prod.
  rateLimitDisabled: process.env.RATE_LIMIT_DISABLED === 'true',
  rateLimits: {
    default: { window: 60, max: 500, by: 'ip' },
    prefixes: {
      'agent.': { window: 60, max: 300, by: 'user' },
      'admin.': { window: 60, max: 100, by: 'user' },
      'system.service.': { window: 60, max: 50, by: 'ip' },
      // public, unauthenticated report endpoint — keep tight (throttled at the local-dispatch gate in index.js)
      'system.report': { window: 60, max: 30, by: 'ip' }
    }
  },

  // Security: Background Task Whitelist
  // Defines which services can trigger which asynchronous tasks.
  // Kept tight: fulfillment is the only _tasks producer in the codebase (state-machine
  // transition actions); stale 'authority'/'log' entries (services that no longer
  // exist) and the wildcard allowFrom have been removed — a wildcard let ANY service
  // that returns a _tasks block fan out notifications/sends. Runtime override lives
  // in Redis (setting.task.update) for deployments that add producers.
  taskWhitelist: {
    'notification': {
      allowFrom: ['fulfillment'],
      allowMethods: ['notification.send']
    },
    'gateway': {
      allowFrom: ['fulfillment'],
      allowMethods: ['gateway.email.send', 'gateway.sms.send', 'gateway.webhook.send']
    }
  },

  // Background Task Dispatch — bounded retry + exponential backoff before a _task
  // dispatch (handlers/tasks.js) gives up and persists to ERROR:QUEUE:router (P0 fix,
  // 2026-07-05). Previously a single non-awaited axios.post — one transient failure
  // (or a process restart mid-flight) silently dropped the task with no trace at all.
  tasks: {
    maxAttempts: parseInt(process.env.TASK_MAX_ATTEMPTS, 10) || 3,
    retryBaseMs: parseInt(process.env.TASK_RETRY_BASE_MS, 10) || 200,
  },

  // --- Assets Serving (Option A: Direct Disk Access) ---
  /**
   * @property {boolean} enableStaticAssets
   * @why Enables the Router to serve uploaded files directly from the local filesystem.
   * @attention
   *   1. PERFORMANCE: Direct disk access is faster than proxying requests to the storage service.
   *   2. STATEFULNESS: This makes the Router service 'stateful' regarding the shared assets directory. 
   *      In distributed environments (e.g., K8s), ensure the `uploadDir` is mounted as a shared PV/NFS.
   *   3. SECURITY: Files are served without additional authentication checks (Public access to /assets).
   */
  enableStaticAssets: process.env.ENABLE_STATIC_ASSETS === 'true', // Default OFF: files are served by the OSS provider/CDN now (storage migrated to OSS). Opt-in only for legacy local-disk serving.

  /**
   * @property {string} uploadDir
   * @why Absolute path to the directory containing asset partitions (L1/L2/L3 structure).
   */
  uploadDir: process.env.UPLOAD_DIR || require('path').join(__dirname, '../../../uploads/assets')
};
