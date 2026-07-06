/**
 * Service Capability Registry (Introspection) — Router-facing /jsonrpc surface only.
 *
 * @attention This is NOT where the MCP protocol surface lives. The actual MCP
 *            endpoint (POST /mcp — initialize/tools/list/tools/call) is a separate
 *            external-facing route (see index.js), authenticated by the CALLER's
 *            own bot session token, not by Router forwarding — so it is intentionally
 *            not declared here (mirrors ingress's public /ingest inbound pattern).
 *            Declaration here MUST stay in sync with index.js's /jsonrpc handler map
 *            (CLAUDE.md §5 red line).
 */

const methods = [
    { name: 'ping',     params: [], returns: ['status', 'version', 'uptime'], description: 'Health check', ai: true },
    { name: 'methods',  params: [], description: 'Get surface area definition', ai: false },
    { name: 'entities', params: [], description: 'Get entity definitions (this service holds none)', ai: false },
];

module.exports = methods;
