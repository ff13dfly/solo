const createShipment = require('./shipment');
const createOrder = require('./order');

module.exports = (redis, { config }) => ({
    shipment: createShipment(redis, { config }),
    order: createOrder(redis, { config }),
});
