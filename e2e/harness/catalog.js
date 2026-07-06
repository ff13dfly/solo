/**
 * 服务目录 + profile —— 与 deploy/services.json + services.dev.json 对齐(§13 默认值).
 * 端口以此为权威(setup.js 按此设每服务 PORT env).
 *
 * E2E_PORT_OFFSET:整体平移所有端口(含 router/local-oss/mock-listener 的 setup 派生端口)。
 * 用途:dev 栈占着标准端口时,harness 的"端口被占→当 external 复用"逻辑会把 e2e 跑到
 * dev 栈上(持久化 Redis 旧状态 + 真 LLM provider),结果不可信。设个偏移(如 1000)
 * + REDIS_URL 指独立实例,即可与 dev 栈并存而完全隔离。0(默认)= 现状不变。
 */
const path = require('path');

// e2e/ 在仓库根,api/ 是同级目录.
const API_DIR = path.resolve(__dirname, '../../api');

const PORT_OFFSET = parseInt(process.env.E2E_PORT_OFFSET || '0', 10) || 0;

const SERVICES = {
    router:        { path: 'router/index.js',            port: 8600 },
    administrator: { path: 'core/administrator/index.js', port: 8680 },
    user:          { path: 'core/user/index.js',          port: 8710 },
    agent:         { path: 'core/agent/index.js',         port: 8730 },
    nexus:         { path: 'core/nexus/index.js',         port: 8740 },
    notification:  { path: 'core/notification/index.js',  port: 8040 },
    gateway:       { path: 'core/gateway/index.js',       port: 8020 },
    ingress:       { path: 'core/ingress/index.js',       port: 8070 },
    orchestrator:  { path: 'core/orchestrator/index.js',  port: 8820 },
    storage:       { path: 'apps/storage/index.js',       port: 8750 },
    fulfillment:   { path: 'apps/fulfillment/index.js',   port: 8050 },
    planner:       { path: 'apps/planner/index.js',       port: 8030 },
    approval:      { path: 'apps/approval/index.js',       port: 8060 },
    // dev 夹具(services.dev.json,不打包进 SOLO)
    collection:    { path: 'apps/collection/index.js',    port: 8055 },
    market:        { path: 'apps/market/index.js',         port: 8056 },
};
for (const svc of Object.values(SERVICES)) svc.port += PORT_OFFSET;

// router 永远先起;下列是 router 之外要拉起+注册的服务(按起动顺序).
const PROFILES = {
    // 轻档:00/10/20 套需要的最小集(workers 全关、无 bot token、纯 redis-server 即可).
    lite: ['user', 'collection'],
    // 全档:整栈 + workers + bot token(P5 事件链;需 redis-stack).
    full: [
        'administrator', 'user', 'storage', 'planner', 'fulfillment', 'approval',
        'gateway', 'nexus', 'notification', 'ingress', 'orchestrator', 'collection', 'market',
        // agent runs with AI_PROVIDER=mock (offline, deterministic) for the nexus
        // context-assembly → LLM autorun loop (66-nexus-autorun). See harness/setup.js.
        'agent',
    ],
};

module.exports = { API_DIR, SERVICES, PROFILES, PORT_OFFSET };
