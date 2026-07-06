const createPayment = require('./payment');

module.exports = (redis, { config, relay } = {}) => ({
    // relay lets payment.refund verify an approval.record via the Router (no direct call).
    payment: createPayment(redis, { config, relay }),
});
