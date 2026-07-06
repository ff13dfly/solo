const config = require('../config');
const { createAuthHandlers } = require('../../../library/auth');

module.exports = createAuthHandlers(config, {
    // No public JSON-RPC methods: the anonymous public path is the standalone /file/:id route
    // (own visibility gate), not RPC. storage.asset.resolve/get now require a session.
    publicMethods: [],
});
