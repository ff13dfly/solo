module.exports = {
    ...require('../../library/jsonrpc'),
    RATE_LIMIT_EXCEEDED: (retryAfter) => ({
        code: -32029,
        message: 'Rate limit exceeded',
        data: { retry_after: retryAfter },
    }),
    UPSTREAM_ERROR: (service, msg) => ({
        code: -32099,
        message: `Upstream Service Error (${service}): ${msg || 'No response'}`,
    }),
    // Router method-level access-denied (permission gate). Code -32604 is the documented
    // access-denied code (permission-system.md) — intentionally distinct from -32005
    // FORBIDDEN (service/data-level). Named here so it is registered + single-sourced
    // instead of repeated inline across handlers.
    ACCESS_DENIED: (reason) => ({ code: -32604, message: reason || 'Forbidden' }),
};
