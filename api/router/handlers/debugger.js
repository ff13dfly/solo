/**
 * Debug Logger Middleware
 * Logs incoming requests and outgoing responses when debug mode is enabled
 */

const chalk = require('chalk');

/**
 * Create debug logger middleware
 * @param {object} config - Router configuration object
 * @returns {function} Express middleware
 */
function createDebugLogger(config) {
    return (req, res, next) => {
        if (config.debug) {
            console.log(chalk.blue('INCOMING REQUEST:'), chalk.green(req.method), req.url);
            if (req.body) {
                 console.log(chalk.gray('PAYLOAD:'), JSON.stringify(req.body, null, 2));
            }
            
            // Capture response
            const oldJson = res.json;
            res.json = function(data) {
                console.log(chalk.blue('OUTGOING RESPONSE:'), chalk.cyan(JSON.stringify(data, null, 2)));
                return oldJson.apply(res, arguments);
            };
        }
        next();
    };
}

module.exports = { createDebugLogger };
