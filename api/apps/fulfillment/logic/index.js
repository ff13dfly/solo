const createInstanceLogic = require('./instance');
const createProfileLogic  = require('./profile');

module.exports = (redis, config, { relay } = {}) => ({
    instance: createInstanceLogic(redis, config, relay),
    profile:  createProfileLogic(redis, config, relay)
});
