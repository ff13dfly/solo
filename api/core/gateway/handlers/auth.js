/**
 * gateway auth — thin wrapper over the SHARED library/auth (Z-handshake +
 * Router token middleware). Replaces the pre-library hand-rolled fork (toFix
 * §6.x: forks rot independently — this one missed the fleet-wide `events`
 * public rollout). No service-specific public methods: every gateway.* send
 * is Router-authenticated; BASE_PUBLIC_METHODS covers discovery.
 */
const config = require('../config');
const { createAuthHandlers } = require('../../../library/auth');

module.exports = createAuthHandlers(config);
