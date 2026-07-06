const config = require('../config');
const { createBootstrap } = require('../../library/bootstrap');

const { initializeRedis, ensureDefaultCategories } = createBootstrap(config);

module.exports = { initializeRedis, ensureDefaultCategories };
