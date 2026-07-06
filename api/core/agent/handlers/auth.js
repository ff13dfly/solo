/**
 * agent auth — thin wrapper over the SHARED library/auth (Z-handshake + Router
 * token middleware). Replaces a pre-library hand-rolled fork (toFix §6.x /
 * autocheck [auth-fork]): forks rot independently of the shared library.
 * No service-specific public methods (BASE covers ping/methods/entities/events).
 */
const config = require('../config');
const { createAuthHandlers } = require('../../../library/auth');

module.exports = createAuthHandlers(config);
