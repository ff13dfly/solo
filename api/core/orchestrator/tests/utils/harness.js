/**
 * createHarness — wires a fake Redis + a MockRouter into the REAL orchestrator
 * logic (logic/index.js), so tests exercise the actual execution engine while
 * every dependency around it is faked.
 *
 *   const h = await createHarness();
 *   h.mock.on('user.profile.get', () => ({ name: 'Alice' }));   // stub downstream
 *   await h.createWorkflow(require('../cases/linear-flow.json')); // real create() + validation
 *   const res = await h.run('wf_linear_demo', { customerId: 'c-1' });
 *   expect(res.status).toBe('completed');
 *   expect(h.mock.lastParams('user.profile.get')).toEqual({ uid: 'c-1' });
 *   await h.stop();   // closes the MockRouter socket — REQUIRED
 *
 * Two ways to load a workflow:
 *   - createWorkflow(def): goes through the real workflow.create() — runs the
 *     same validation production does, always stored as status:'ACTIVE'.
 *   - seedWorkflow(def):  writes the doc straight into storage, so you can set
 *     any status (e.g. 'PENDING_REVIEW' / 'DELETED') for gate/boundary tests.
 */
// logic/index.js wires a REAL file-backed trace-audit (logic/trace-audit.js) —
// redirect it to a tmpdir BEFORE requiring logic (LOG_ROOT is a module-load-time
// constant there), same fix ingress/tests/returns-contract.test.js uses, so the
// whole orchestrator suite doesn't write real files under repo-root logs/.
const os = require('os');
const path = require('path');
if (!process.env.LOG_DIR) process.env.LOG_DIR = path.join(os.tmpdir(), `solo-orchestrator-test-${process.pid}`);

const createLogic = require('../../logic');
const config = require('../../config');
const { makeFakeRedis } = require('./fake-redis');
const { MockRouter } = require('./mock-router');
const { NeedsGrantError } = require('../../logic/NeedsGrantError');
const jsonrpc = require('../../handlers/jsonrpc');

const WF_PREFIX = config.redis.workflowPrefix;

async function createHarness({ relay = null } = {}) {
    const redis = makeFakeRedis();
    const mock = new MockRouter();
    const routerUrl = await mock.start();
    // relay (optional) lets tests exercise the §3.1 high-risk approval lane, which
    // relays to the approval service (approval.gate.*) + user.key.getPublic.
    const logic = createLogic(redis, { serviceName: 'orchestrator', routerUrl, config, relay });

    return {
        redis,
        mock,
        logic,
        config,

        // Author a workflow via the real create() path (exercises validation).
        createWorkflow(def) {
            return logic.workflow.create(def);
        },

        // Write a workflow doc directly — lets you pin any status/fields,
        // bypassing create()'s ACTIVE default. Use for gate/boundary tests.
        async seedWorkflow(def) {
            const now = Date.now();
            const doc = {
                priority: 50,
                tags: [],
                required_inputs: [],
                optional_inputs: [],
                resolvers: {},
                status: 'ACTIVE',
                createdAt: now,
                updatedAt: now,
                ...def,
            };
            await redis.json.set(WF_PREFIX + doc.id, '$', doc);
            await redis.sAdd(config.redis.workflowIndex, doc.id);   // 维护 id 索引(matcher 用 SMEMBERS)
            return doc;
        },

        // Execute a workflow (simulates the sync RPC path — index.js orchestrator.workflow.run).
        // `callerUid` activates H6 footprint pre-check.
        // `opts.triggerSource` / `opts.triggerId` exercise the allowed_triggers gate.
        // `opts.oneTimeGrant` passes a one-shot grant to runner (resume path, event.md §9).
        // `opts.runId` joins trace-audit records to a run entity id (async-path shape).
        //
        // D5: NeedsGrantError is converted to FORBIDDEN here, matching what index.js
        // does for sync callers — the harness simulates the sync RPC path.
        run(workflowId, input = {}, headers = {}, callerUid = null, opts = {}) {
            return logic.runner.run(
                { workflowId, input, triggerSource: opts.triggerSource, triggerId: opts.triggerId, runId: opts.runId || null, oneTimeGrant: opts.oneTimeGrant || null, actorClaim: opts.actorClaim || null },
                headers,
                callerUid
            ).catch(err => {
                if (err instanceof NeedsGrantError) throw jsonrpc.FORBIDDEN(err.message);
                throw err;
            });
        },

        // Stream events emitted during a run (EVENT:WORKFLOW:RESULT / :STATUS).
        events(stream) {
            return redis.streams[stream] || [];
        },

        async stop() {
            await mock.stop();
        },
    };
}

module.exports = { createHarness };
