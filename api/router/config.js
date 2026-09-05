require('dotenv').config();
const { portFor, urlFor } = require('../library/ports');
const { intFromEnv } = require('../library/env');

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
    // gateway outbound delivery outcomes (2026-07-30, gateway-gaps G8): sent/mocked ride
    // the _event piggyback on the RPC result (source = the 'gateway' service); failed goes
    // out via the system.gateway relay bot's event.emit (the piggyback only carries events
    // on a SUCCESSFUL result). Same stream, three types: gateway.delivery.{sent,mocked,failed}.
    'gateway': {
      'EVENT:GATEWAY:DELIVERY': ['*'],
    },
    'system.gateway': {
      'EVENT:GATEWAY:DELIVERY': ['*'],
    },
  },

  // event.md D10 — approximate MAXLEN for EVENT:* streams (memory safety valve).
  //
  // @why Until 2026-09-05 this value existed but was never read: handlers/events.js did a bare
  //   xAdd, so every EVENT:* stream grew without bound for the life of the deployment. The two
  //   reasons the old comment gave for holding off were both already false — the value is a
  //   positive number, and node-redis TRIM is proven in-tree by entity.js's WAL stream.
  //   (docs/feedback/done/event-bus-xadd-unbounded-dead-config.md)
  // @attention MAXLEN '~' is APPROXIMATE by design: Redis trims at radix-tree node boundaries,
  //   so the stream keeps *at least* this many entries. That is the right trade — exact trim
  //   costs O(n) per write. Same shape as entity.js:184's WAL ring.
  // @attention The stream is a DELIVERY channel, not an audit ledger (events.md §6.5).
  //   Long-term history belongs in your own store; a trimmed entry is not a lost event.
  eventMaxLen: intFromEnv('EVENT_MAXLEN', 10000),

  // Per-stream overrides, as ONE env list: 'EVENT:MARKET:CANDLE_1M=100000,EVENT:X:Y=500'.
  // @why A high-volume stream (market candles) and a low-volume one (approvals) do not want the
  //   same window, but the two obvious alternatives are both worse: one env var per stream needs
  //   a stream-name→identifier mangling that is ambiguous (':' and '_' both appear in real names),
  //   and hanging a field off the event registry widens a data structure that many places read.
  //   A single flat list keeps stream names VERBATIM and touches nothing else.
  // Malformed pairs are skipped loudly rather than silently dropping the whole override set —
  // a typo in one entry must not quietly un-bound a different stream.
  eventMaxLenOverrides: (() => {
    const raw = process.env.EVENT_MAXLEN_OVERRIDES;
    if (!raw || !String(raw).trim()) return {};
    const out = {};
    for (const pair of String(raw).split(',')) {
      const t = pair.trim();
      if (!t) continue;
      const eq = t.lastIndexOf('=');            // lastIndexOf: stream names contain ':' but not '='
      const name = eq > 0 ? t.slice(0, eq).trim() : '';
      const n = eq > 0 ? Number(t.slice(eq + 1).trim()) : NaN;
      if (!name || !Number.isInteger(n) || n < 0) {
        console.warn(`[config] EVENT_MAXLEN_OVERRIDES entry ${JSON.stringify(t)} is not '<stream>=<int>' — ignored`);
        continue;
      }
      out[name] = n;
    }
    return out;
  })(),
  debug: process.env.DEBUG === 'true', // Default to false, explicitly enable with 'true'
  bodyLimit: process.env.BODY_LIMIT || '50mb',
  maxStringLength: intFromEnv('MAX_STRING_LENGTH', 5242880), // 5MB default
  maxArrayLength: intFromEnv('MAX_ARRAY_LENGTH', 1000),
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
    maxAttempts: intFromEnv('TASK_MAX_ATTEMPTS', 3),
    retryBaseMs: intFromEnv('TASK_RETRY_BASE_MS', 200),
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
