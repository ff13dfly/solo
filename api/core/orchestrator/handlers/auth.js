/**
 * orchestrator auth — thin wrapper over the SHARED library/auth (Z-handshake +
 * Router token middleware). Replaces a pre-library hand-rolled fork (toFix
 * §6.x / autocheck [auth-fork]). Bonus over the fork: req.meta (trace/depth)
 * is now populated, so walContext gets the chain id on the SYNC RPC path too
 * (the fork silently dropped it; only the async worker path threaded trace).
 * No service-specific public methods (BASE covers ping/methods/entities/events).
 */
const config = require('../config');
const { createAuthHandlers } = require('../../../library/auth');

module.exports = createAuthHandlers(config);
