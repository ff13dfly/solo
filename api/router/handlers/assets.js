const express = require('express');
const logger = require('../../library/logger').createLogger('Assets');

const authHandler = require('./auth');

/**
 * Setup Static Assets Serving
 * 
 * @param {object} app - Express app instance.
 * @param {object} config - Router configuration.
 * @param {object} redisClient - Active Redis client.
 * @why Enables authenticated access to uploaded files via the Router port when enabled.
 */
function setupAssets(app, config, redisClient) {
    if (!config.enableStaticAssets) {
        return;
    }

    logger.info(`Static assets enabled with auth protection. Serving from: ${config.uploadDir}`);

    // Middleware to protect static assets
    const requireAuth = async (req, res, next) => {
        // Allow token via query param (for <img> tags) or standard headers
        const token = req.query.token || authHandler.extractToken(req);

        if (!token) {
            return res.status(401).send('Unauthorized: Missing token');
        }

        const sessionUser = await authHandler.resolveSessionUser(token, redisClient);

        if (!sessionUser || sessionUser.username === 'guest') {
            return res.status(403).send('Forbidden: Invalid or expired token');
        }

        // Attach user info to request for potential downstream audit logging
        req.user = sessionUser;
        next();
    };

    // Map /assets URL prefix to the physical upload directory, protected by auth
    app.use('/assets', requireAuth, express.static(config.uploadDir));
}

module.exports = {
    setupAssets
};
