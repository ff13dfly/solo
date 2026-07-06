module.exports = {
    ...require('../../../library/jsonrpc'),
    USER_NOT_FOUND:       () => ({ code: -32002, message: 'User not found' }),
    INVALID_CHALLENGE:    () => ({ code: -32603, message: 'Invalid or expired challenge' }),
    ACCOUNT_DELETED:      () => ({ code: -32001, message: 'Account is deleted' }),
    AUTH_FAILED:          () => ({ code: -32001, message: 'Authentication failed' }),
    TRUST_ANCHOR_MISSING: () => ({ code: -32000, message: 'Router Trust Anchor Not Configured' }),
    MALFORMED_TOKEN:      () => ({ code: -32000, message: 'Malformed Auth Token' }),
    // Per-anchor OTP request throttle (passport self-issuance) — mirrors router's canonical -32029.
    RATE_LIMIT_EXCEEDED:  (retryAfter) => ({ code: -32029, message: 'Rate limit exceeded', data: { retry_after: retryAfter } }),
};
