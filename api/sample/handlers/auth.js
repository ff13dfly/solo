const config = require('../config');
const { createAuthHandlers } = require('../../library/auth');

module.exports = createAuthHandlers(config);
