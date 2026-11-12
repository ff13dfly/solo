const createInstanceLogic = require('./instance');
const createProfileLogic  = require('./profile');
const createBarrierLogic  = require('./barrier');

module.exports = (redis, config, { relay } = {}) => {
    const instance = createInstanceLogic(redis, config, relay);
    const profile  = createProfileLogic(redis, config, relay);
    const barrier  = createBarrierLogic(redis, config, { relay, instanceLogic: instance });
    return {
        instance,
        profile,
        barrier,
    };
};
