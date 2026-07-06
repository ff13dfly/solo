const createSentinelLogic = require('./sentinel');
const createStreamConsumer = require('./stream');
const createScheduleLogic = require('./schedule');
const createSchedulerLogic = require('./scheduler');
const createDlqLogic = require('./dlq');
const createEventsLogic = require('./events');
const createIdentity = require('./identity');
const createControl = require('./control');
const { createAssembler } = require('./context');

module.exports = (redis, { config, relay }) => {
    // §1.2 per-Sentinel identity — holds/refreshes each Sentinel bot's token, runs
    // the config-time pre-audit. Shared by sentinel logic (provision/pre-audit) and
    // the assembler (scoped data-fetches via relay.callAs).
    const identity  = createIdentity(redis, config, { relay });
    // Runtime auto↔manual pause (honored by the stream consumer + scheduler loops).
    const control   = createControl(redis, config);
    const sentinel  = createSentinelLogic(redis, config, { relay, identity });
    // context.md v1 —— 上下文装配器（事件到达后、投递前拉数据 + 渲染 prompt）.
    const assembler = createAssembler({ relay, identity });
    const stream    = createStreamConsumer(redis, config, { sentinelLogic: sentinel, relay, assembler, identity, control });
    // event.md §6.2 — schedule CRUD + time-driven tasker (D6: same-process setInterval).
    const schedule  = createScheduleLogic(redis, { config });
    const scheduler = createSchedulerLogic(redis, { config, relay, control });
    // context.md §7.3 — dead-letter inspection / retry for undeliverable events.
    const dlq       = createDlqLogic(redis, config);
    // Read-only event-bus observability (portal STREAM LOG tab).
    const events    = createEventsLogic(redis, { config });
    return { sentinel, stream, schedule, scheduler, dlq, identity, control, events };
};
