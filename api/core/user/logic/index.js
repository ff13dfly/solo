const createUserLogic = require('./user');
const createBotLogic = require('./bot');
const createRoleLogic = require('./role');
const createPassportLogic = require('./passport');
const createKeyLogic = require('./key');
const createCategoryLogic = require('../../../library/category');

/**
 * Logic Factory
 * @why Orchestrates the initialization of all business logic modules.
 *      Uses dependency injection (Redis, config, context) to ensure testability.
 */
module.exports = (redis, config, context) => ({
    // --- MODULE COMPOSITION ---
    user: createUserLogic(redis, config, context),
    bot: createBotLogic(redis, config),
    role: createRoleLogic(redis, config),
    passport: createPassportLogic(redis, config, { role: createRoleLogic(redis, config), relay: context?.relay }),
    key: createKeyLogic(redis, config),   // §3.2 — Ed25519 signing keys
    category: createCategoryLogic(redis, context)
});
