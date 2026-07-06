/**
 * logic/tools.js — MCP tool discovery + invocation, backed by orchestrator workflows.
 *
 * @why v1-implementation-plan.md P4 "MCP adapter" (2026-07-03, workflow-first scope).
 *      A workflow's `input_schema` already speaks the same flat dialect as
 *      library/validate.js's checkParams (name/type/required/maxLength/minLength/pattern)
 *      — that maps close to 1:1 onto an MCP tool's JSON Schema `inputSchema`, so no new
 *      schema language is invented here, just a converter.
 *
 * @auth Every call is relayed via relay.callAs(token, method, params) using the EXTERNAL
 *       caller's OWN bot session token (library/user/logic/bot.js `permit` — must explicitly
 *       enumerate the methods it may call, §7.3). This module does no authorization of its
 *       own; Router's checkAccess is the only enforcement point (mirrors the nexus per-
 *       Sentinel identity pattern this callAs() primitive was built for).
 *
 * @limitation Router checkAccess is method-level, not per-workflow-instance — so a bot
 *             whose permit includes orchestrator.workflow.list sees the SAME full ACTIVE
 *             workflow list as any other bot with that permit (no per-consumer filtering
 *             of WHICH workflows are visible). Fine-grained per-workflow authorization would
 *             need orchestrator-side data-level constraints, out of scope for this MVP.
 */

const { PATTERNS } = require('../../../library/validate');
const jsonrpc = require('../../../library/jsonrpc');

function toJsonSchemaProperty(item) {
    const prop = {};
    if (item.type) prop.type = item.type;
    if (typeof item.maxLength === 'number') prop.maxLength = item.maxLength;
    if (typeof item.minLength === 'number') prop.minLength = item.minLength;
    if (item.pattern && PATTERNS[item.pattern]) prop.pattern = PATTERNS[item.pattern].source;
    return prop;
}

/** SOLO flat schema (checkParams dialect) -> standard JSON Schema object. */
function inputSchemaToJsonSchema(items) {
    const list = Array.isArray(items) ? items : [];
    const properties = {};
    const required = [];
    for (const item of list) {
        if (!item || typeof item.name !== 'string' || !item.name) continue;
        properties[item.name] = toJsonSchemaProperty(item);
        if (item.required) required.push(item.name);
    }
    const schema = { type: 'object', properties };
    if (required.length > 0) schema.required = required;
    return schema;
}

function workflowToTool(wf) {
    return {
        name: wf.id,
        description: wf.desc || wf.name || wf.id,
        inputSchema: inputSchemaToJsonSchema(wf.input_schema),
    };
}

module.exports = (redis, { config, relay }) => {
    /**
     * MCP tools/list — ACTIVE workflows only (PENDING_REVIEW/REJECTED/DELETED are not
     * invokable, so they are not valid MCP tools).
     */
    async function list(token) {
        const res = await relay.callAs(token, 'orchestrator.workflow.list', {
            limit: config.mcp.workflowListLimit,
        });
        const items = Array.isArray(res && res.items) ? res.items : [];
        const active = items.filter((w) => w && w.status === 'ACTIVE');
        return { tools: active.map(workflowToTool) };
    }

    /**
     * MCP tools/call — forwards to orchestrator.workflow.run under the caller's own
     * bot identity. Anything beyond "the request itself is malformed" (unknown workflow,
     * checkAccess denial, the workflow run failing) is reported as a normal tool RESULT
     * with isError:true rather than a JSON-RPC protocol error — the request was valid,
     * running the named tool just didn't succeed. Malformed requests (missing `name`)
     * throw and the caller (index.js) turns that into a JSON-RPC -32602 error instead.
     */
    async function call(token, { name, arguments: args } = {}) {
        if (!name || typeof name !== 'string') {
            throw jsonrpc.MISSING_PARAM('name');
        }
        try {
            const result = await relay.callAs(token, 'orchestrator.workflow.run', {
                workflowId: name,
                input: (args && typeof args === 'object') ? args : {},
            });
            if (result && result.status === 'failed') {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: result.error, failedStep: result.failedStep }) }],
                    isError: true,
                };
            }
            return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                isError: false,
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: e.message || 'tool call failed' }],
                isError: true,
            };
        }
    }

    return { list, call, workflowToTool, inputSchemaToJsonSchema };
};
