const jsonrpc = require('../../../library/jsonrpc');

module.exports = {
    ...jsonrpc,
    RETRY_LATER: (msg, data) => ({
        code: -32007,   // de-collided from -32099 (which is router UPSTREAM_ERROR); registered in CODES
        message: msg || 'Agent 网络错误，请稍后重试',
        data: data || { retryable: true, retryAfter: 3000 },
    }),
};
