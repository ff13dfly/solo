require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');

module.exports = {
    // portFor(name, fallback): process.env.PORT > global.__SOLO_PORTS__ > fallback.
    port: portFor('mcp', 8091),
    debug: process.env.DEBUG === 'true',
    serviceName: process.env.SERVICE_NAME || 'mcp',
    version: pkg.version,
    pageSize: 20,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',
    routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
    routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',

    // v1-implementation-plan.md P4 "MCP adapter" — workflow-first scope (2026-07-03):
    // tools/list maps ACTIVE orchestrator workflows to MCP tools; tools/call forwards to
    // orchestrator.workflow.run. Non-workflow capability-table exposure is deferred.
    mcp: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'solo-mcp-adapter', version: pkg.version },
        // orchestrator.workflow.list page size when building tools/list. No pagination
        // cursor yet — MVP scope, see plan doc.
        workflowListLimit: 200,
    },

    // AI 语义描述 (Agent 意图识别) — 本服务不暴露 ai:true 方法（外部协议适配层，不供内部 Agent 直调）。
    description: {
        en: {
            main: [
                "MCP (Model Context Protocol) adapter",
                "external MCP clients POST to /mcp with their own bot session token (Authorization: Bearer <token>)",
                "tools/list maps ACTIVE orchestrator workflows to MCP tools; tools/call forwards to orchestrator.workflow.run",
                "dumb pipe: every call is relayed via library/relay.js callAs() under the CALLER's own bot identity — Router checkAccess enforces that bot's permit, this adapter does no authorization of its own"
            ],
            methods: {
                "ping": ["service health check"],
                "methods": ["get service method list"],
                "entities": ["get entity definitions (schema) — this service holds no persisted entities"]
            }
        },
        zh: {
            main: [
                "MCP (Model Context Protocol) 适配器",
                "外部 MCP 客户端直接 POST 到 /mcp，自带 bot session token（Authorization: Bearer <token>）",
                "tools/list 把 ACTIVE 的 orchestrator workflow 映射成 MCP tool；tools/call 转发到 orchestrator.workflow.run",
                "哑管道：每次调用都用调用方自己的 bot 身份经 library/relay.js 的 callAs() 转发——Router checkAccess 按该 bot 的 permit 卡关，adapter 自身不做鉴权"
            ],
            methods: {
                "ping": ["服务健康检查"],
                "methods": ["获取服务方法列表"],
                "entities": ["获取实体定义（本服务无持久化实体）"]
            }
        }
    },

    indexes: {},
    seeds: { categories: [] },
};
