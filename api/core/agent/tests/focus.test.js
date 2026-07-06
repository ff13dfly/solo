/**
 * agent.focus — the multi-turn slot-filling contract.
 *
 * Two layers, mirroring decide.test.js:
 *   1. HERMETIC (always runs) — mock provider proves the focus envelope shape
 *      { extracted_params, confidence, hint, action }, that every missing field gets
 *      filled, and that the assembled user input reaches the extraction boundary.
 *      No network, no Redis.
 *   2. LIVE qwen (gated on DASHSCOPE_API_KEY) — the real production path (qwen-turbo,
 *      now json-mode) actually extracts params from an utterance and the envelope holds.
 *
 * Live keys live in core/agent/.env, NOT the repo root — load them before requiring any
 * agent module (config.js reads process.env at require-time).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Methods = require('../logic');
const CapabilityManager = require('../logic/capability');
const WorkflowManager = require('../logic/workflow');

// focus looks up the workflow's param schema via CapabilityManager (Redis). The mock
// slot-fill only needs missing_fields, so stub the lookup to keep this hermetic test
// Redis-independent. Both CapabilityManager and WorkflowManager are singletons that open
// a Redis client at require-time — close both in afterAll so jest exits without --forceExit.
beforeAll(() => { CapabilityManager.getCapabilities = async () => []; });
afterAll(async () => {
    for (const mgr of [CapabilityManager, WorkflowManager]) {
        if (mgr.redisClient && mgr.redisClient.isOpen) await mgr.redisClient.quit();
    }
});

const MEETING = {
    workflow_id: 'meeting_setup_v1',
    workflow_name: '安排项目会议',
    workflow_desc: '预订会议室并发送通知',
    current_params: { duration: 60, platform: 'Zoom' },
    missing_fields: ['roomId', 'startTime'],
    synonyms: { roomId: ['会议室', '三楼大厅'], startTime: ['开始时间', '几点'] },
    user_input: '用三楼的大厅，明天下午三点开始',
};

describe('agent.focus — hermetic (mock provider)', () => {
    test('returns the focus envelope and fills every missing field', async () => {
        const r = await Methods.agent.focus({ ...MEETING, model: 'mock-1' });
        expect(r).toMatchObject({
            extracted_params: expect.any(Object),
            confidence: expect.any(Object),
            hint: expect.any(String),
        });
        // mock deterministically fills every missing field at full confidence → the
        // caller sees no missing fields left and flips to 'pending' (executable).
        for (const f of MEETING.missing_fields) {
            expect(r.extracted_params).toHaveProperty(f);
            expect(r.confidence[f]).toBe(1);
        }
        expect(Object.keys(r.extracted_params).sort()).toEqual([...MEETING.missing_fields].sort());
    });

    test('the rendered user input reaches the extraction boundary', async () => {
        const r = await Methods.agent.focus({ ...MEETING, user_input: 'room 7777 at 9am', model: 'mock-1' });
        // mock echoes the input into hint (like chat's MOCK_REPLY:: / decide's MOCK_DECIDE::)
        // — proves the assembled focus prompt wasn't dropped on the way to the provider.
        expect(r.hint).toContain('MOCK_FOCUS::room 7777 at 9am');
    });

    test('missing workflow_id or user_input is a hard error (caller bug, not a degradation)', async () => {
        await expect(Methods.agent.focus({ user_input: 'x', model: 'mock-1' }))
            .rejects.toMatchObject({ message: expect.stringMatching(/workflow_id|user_input/) });
        await expect(Methods.agent.focus({ workflow_id: 'w', model: 'mock-1' }))
            .rejects.toMatchObject({ message: expect.stringMatching(/workflow_id|user_input/) });
    });
});

// --- LIVE: real qwen extraction, gated on the key (the production focus path) ---
const liveQwen = process.env.DASHSCOPE_API_KEY ? describe : describe.skip;

liveQwen('agent.focus — LIVE qwen (qwen-turbo, json-mode)', () => {
    jest.setTimeout(30000);

    test('extracts the missing params from the utterance and the envelope holds', async () => {
        const r = await Methods.agent.focus({ ...MEETING, model: 'qwen-turbo' });
        expect(r).toMatchObject({
            extracted_params: expect.any(Object),
            confidence: expect.any(Object),
        });
        // the utterance names a room and a time → at least one missing field gets filled.
        expect(Object.keys(r.extracted_params).length).toBeGreaterThan(0);
    });
});
