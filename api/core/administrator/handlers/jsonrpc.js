module.exports = {
    ...require('../../../library/jsonrpc'),
    MISSING_AUTH:         () => ({ code: -32001, message: 'Level 3 Security: Missing Authorization Headers' }),
    INVALID_SIGNATURE:    () => ({ code: -32001, message: 'Invalid Router Signature' }),
    TRUST_ANCHOR_MISSING: () => ({ code: -32000, message: 'Router Trust Anchor Not Configured' }),
    MALFORMED_TOKEN:      () => ({ code: -32000, message: 'Malformed Auth Token' }),
    INVALID_CHALLENGE:    () => ({ code: -32603, message: 'Invalid or expired challenge' }),
    AUTH_FAILED:          () => ({ code: -32603, message: 'Authentication failed' }),
    // SERVICE_NOT_READY now comes from the shared catalog (-32006). Dropped the local
    // -32099 def that collided with router UPSTREAM_ERROR + agent RETRY_LATER.
};
