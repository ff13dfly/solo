const createTools = require('./tools');

/**
 * Logic Factory — dependency injection (Redis, config, relay).
 *
 * relay is required for every downstream call: this service never uses its own
 * bot identity (no relay.call/relay.setToken here) — every RPC is relay.callAs()
 * under the EXTERNAL caller's own bot token (see logic/tools.js).
 */
module.exports = (redis, { config, relay }) => {
    const tools = createTools(redis, { config, relay });

    return { tools };
};
