/**
 * administrator auth — thin wrapper over the SHARED library/auth Router-token
 * middleware. Replaces the inline pre-library fork in index.js (toFix §6.x:
 * forks rot independently — this one missed the fleet-wide `events` public
 * rollout). administrator exposes no /auth/seed handshake (the Router
 * auto-manages it via ensureAdministratorService); only `middleware` is used.
 *
 * publicMethods: the admin login bootstrap + error-log surface the dev portal
 * reaches before a session exists (BASE covers ping/methods/entities/events).
 */
const config = require('../config');
const { createAuthHandlers } = require('../../../library/auth');

module.exports = createAuthHandlers(config, {
    publicMethods: [
        'admin.login.request',
        'admin.login.verify',
        'admin.log.error',
        'admin.log.clear',
        'logs.get',
        'logs.clear',
        'admin.logs.get',
        'admin.logs.clear',
    ],
});
