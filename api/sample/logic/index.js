const createSampleLogic = require('./sample');
const createCategoryLogic = require('./category');
const createItemLogic = require('./item');

/**
 * Logic Factory
 *
 * @why Orchestrates the initialization of all business logic modules.
 *      Uses dependency injection (Redis, config) to ensure testability
 *      and loose coupling.
 */
module.exports = (redis, { config }) => ({
    sample:   createSampleLogic(redis),
    category: createCategoryLogic(redis, { serviceName: config.serviceName }),
    item:     createItemLogic(redis, config)
});
