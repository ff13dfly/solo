/**
 * Hermetic behaviour suite for core/mcp — logic/tools.js (MCP tools/list + tools/call,
 * backed by orchestrator workflows). v1-implementation-plan.md P4 "MCP adapter"
 * (2026-07-03, workflow-first scope).
 *
 * tools.js's factory takes an injected {config, relay}, so we inject a fake relay and
 * assert schema conversion + the isError:true/false result shapes — no redis, no
 * network, no real Router.
 */
const createTools = require('../logic/tools');

const CONFIG = {
    mcp: { workflowListLimit: 200 },
};

function makeHarness(overrides = {}) {
    const callAsCalls = [];
    const relay = {
        callAs: async (token, method, params) => {
            callAsCalls.push({ token, method, params });
            if (overrides.callAsImpl) return overrides.callAsImpl(token, method, params);
            throw new Error(`unexpected callAs(${method})`);
        },
    };
    const tools = createTools({}, { config: CONFIG, relay });
    return { tools, callAsCalls };
}

const ACTIVE_WORKFLOW = {
    id: 'wf-send-report',
    name: 'Send Report',
    desc: 'Sends a report to the configured recipient',
    status: 'ACTIVE',
    input_schema: [
        { name: 'recipient', type: 'string', required: true, maxLength: 128, pattern: 'email' },
        { name: 'urgent', type: 'boolean', required: false },
    ],
};

const PENDING_WORKFLOW = {
    id: 'wf-draft',
    name: 'Draft',
    desc: 'not yet approved',
    status: 'PENDING_REVIEW',
    input_schema: [],
};

describe('mcp logic/tools — list', () => {
    test('maps ACTIVE workflows to MCP tools with JSON Schema inputSchema', async () => {
        const { tools, callAsCalls } = makeHarness({
            callAsImpl: async () => ({ items: [ACTIVE_WORKFLOW, PENDING_WORKFLOW], total: 2, limit: 200, offset: 0 }),
        });

        const result = await tools.list('tok-consumer-1');

        expect(callAsCalls).toEqual([
            { token: 'tok-consumer-1', method: 'orchestrator.workflow.list', params: { limit: 200 } },
        ]);
        expect(result.tools).toHaveLength(1); // PENDING_REVIEW excluded
        expect(result.tools[0]).toEqual({
            name: 'wf-send-report',
            description: 'Sends a report to the configured recipient',
            inputSchema: {
                type: 'object',
                properties: {
                    recipient: { type: 'string', maxLength: 128, pattern: '^[^\\s@]{1,64}@[^\\s@]{1,255}\\.[^\\s@]{2,24}$' },
                    urgent: { type: 'boolean' },
                },
                required: ['recipient'],
            },
        });
    });

    test('empty workflow list -> empty tools array', async () => {
        const { tools } = makeHarness({ callAsImpl: async () => ({ items: [], total: 0, limit: 200, offset: 0 }) });
        const result = await tools.list('tok-consumer-1');
        expect(result.tools).toEqual([]);
    });

    test('upstream relay failure (bad/expired token, checkAccess denial) propagates — protocol-level, not swallowed', async () => {
        const { tools } = makeHarness({
            callAsImpl: async () => { const e = new Error('token expired'); e.name = 'RelayError'; e.code = 'TOKEN_EXPIRED'; throw e; },
        });
        await expect(tools.list('tok-bad')).rejects.toThrow('token expired');
    });
});

describe('mcp logic/tools — call', () => {
    test('missing tool name throws a proper jsonrpc-shaped error (caller forwards it as-is)', async () => {
        const { tools } = makeHarness({});
        await expect(tools.call('tok-consumer-1', {})).rejects.toMatchObject({
            code: -32602,
            message: expect.stringContaining('name'),
        });
    });

    test('successful workflow run -> isError:false result', async () => {
        const { tools, callAsCalls } = makeHarness({
            callAsImpl: async () => ({ status: 'completed', workflowId: 'wf-send-report', workflowVersion: 3, trace: ['step1'] }),
        });

        const result = await tools.call('tok-consumer-1', { name: 'wf-send-report', arguments: { recipient: 'a@b.com' } });

        expect(callAsCalls).toEqual([
            { token: 'tok-consumer-1', method: 'orchestrator.workflow.run', params: { workflowId: 'wf-send-report', input: { recipient: 'a@b.com' } } },
        ]);
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 'completed', workflowId: 'wf-send-report' });
    });

    test('missing arguments defaults to {} input', async () => {
        const { tools, callAsCalls } = makeHarness({
            callAsImpl: async () => ({ status: 'completed', workflowId: 'wf-x', trace: [] }),
        });
        await tools.call('tok-consumer-1', { name: 'wf-x' });
        expect(callAsCalls[0].params.input).toEqual({});
    });

    test('workflow run failed (status:failed) -> isError:true result, not a thrown error', async () => {
        const { tools } = makeHarness({
            callAsImpl: async () => ({ status: 'failed', workflowId: 'wf-x', failedStep: 'step2', error: 'downstream timeout', trace: [] }),
        });

        const result = await tools.call('tok-consumer-1', { name: 'wf-x', arguments: {} });

        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toEqual({ error: 'downstream timeout', failedStep: 'step2' });
    });

    test('relay/Router failure (auth denial, unknown workflow) -> isError:true result, not thrown', async () => {
        const { tools } = makeHarness({
            callAsImpl: async () => { throw new Error('workflow not found'); },
        });

        const result = await tools.call('tok-consumer-1', { name: 'wf-ghost', arguments: {} });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('workflow not found');
    });
});
