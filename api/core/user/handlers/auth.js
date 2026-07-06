/**
 * user auth — thin wrapper over the SHARED library/auth (Z-handshake + Router
 * token middleware). The hand-rolled fork that used to live here predated
 * library/auth and rotted independently (missed the fleet-wide `events`
 * public-method rollout, no token-freshness gate, no req.meta/trace) — see
 * toFix §6.x. Service-specific surface = the public whitelist below.
 *
 * publicMethods: registration + login bootstrap must be reachable without a
 * session (BASE_PUBLIC_METHODS already covers ping/methods/entities/events).
 */
const config = require('../config');
const { createAuthHandlers } = require('../../../library/auth');

module.exports = createAuthHandlers(config, {
    publicMethods: [
        'user.entities',
        'user.register',
        'user.login.request',
        'user.login.verify',
    ],
});
