const createWorkflowLogic = require('./workflow');
const createRunnerLogic = require('./runner');
const createWorkerLogic = require('./worker');
const createRunLogic = require('./run');
const createMatcherLogic = require('./matcher');
const createControlLogic = require('./control');
const createTraceAudit = require('./trace-audit');
const createCategoryLogic = require('../../../library/category');

/**
 * Orchestrator Logic Factory
 * @why Centralizes the initialization of all orchestration logic modules.
 * @process Injects dependencies (Redis, context) into sub-modules.
 */
module.exports = (redis, context) => {
    // toFix.md "执行轨迹持久化" — per-run step trace, file-backed (trace-audit.js),
    // injected into runner so both the sync RPC path and the async worker path log
    // through the same single call site.
    const traceAudit = createTraceAudit();
    const workflow = createWorkflowLogic(redis, context);
    const runner = createRunnerLogic(redis, { ...context, traceAudit });
    const category = createCategoryLogic(redis, context);
    // event.md §5.4 / §9 — run entity state machine (async sources only, D8).
    const run = createRunLogic(redis);
    // Runtime auto↔manual pause (honored by worker + matcher loops).
    const control = createControlLogic(redis);
    // event.md §5 — async run-queue worker.
    const worker = createWorkerLogic(redis, { relay: context.relay, runner, run, control });
    // event.md §6.1 — event matcher consumer (step ④). Reads EVENT:* streams,
    // matches events to ACTIVE workflow event_subscriptions, enqueues run-commands.
    const matcher = createMatcherLogic(redis, { config: context.config, worker, control });
    return { workflow, runner, category, worker, run, matcher, control, traceAudit };
};
