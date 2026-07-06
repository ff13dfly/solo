const identityLogic = require('./identity');
const errorLogic = require('./error');
const displayLogic = require('./display');

module.exports = (redisClient, config, context) => ({
    identity: identityLogic, // identityLogic handles user management and auth details
    error: errorLogic,
    display: displayLogic(redisClient) // entity display-manifest store (Display Protocol §6)
});
