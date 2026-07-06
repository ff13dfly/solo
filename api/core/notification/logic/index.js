const createMessageLogic = require('./message');
const createConfigLogic = require('./config');
const createWorker = require('./worker');
const createDeadletterLogic = require('./deadletter');

module.exports = (redis, { config, relay }) => {
    const message = createMessageLogic(redis, config);
    return {
        message,
        config:     createConfigLogic(redis, config),
        // message injected (toFix §6.5): the DLQ-depth alert scanner writes the ops
        // inbox in-process via message.send — no relay hop, fail-soft by design.
        worker:     createWorker(redis, config, { relay, message }),
        deadletter: createDeadletterLogic(redis, config)
    };
};
