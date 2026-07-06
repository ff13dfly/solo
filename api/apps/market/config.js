require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');

module.exports = {
    port: portFor('market', 8056),
    debug: process.env.DEBUG === 'true',
    serviceName: process.env.SERVICE_NAME || 'market',
    version: pkg.version,
    pageSize: 20,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',
    routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
    routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',

    idLengths: {
        shipment: 10,
        order: 10,
    },

    // _event piggyback streams (event.md §4.1). Register source 'market' in the
    // Router event registry for these to pass (see README).
    events: {
        created: { stream: 'EVENT:SHIPMENT:CREATED', type: 'shipment.created' },
        shipped: { stream: 'EVENT:SHIPMENT:SHIPPED', type: 'shipment.shipped' },
    },

    description: {
        en: {
            main: [
                "mock shipment/fulfillment business service (event-flow test fixture)",
                "creates and ships shipments after payment; emits EVENT:SHIPMENT:* via the _event piggyback path",
                "downstream of collection; NOT a framework service — runs in dev, not bundled"
            ],
            methods: {
                "market.shipment.create": ["create a shipment for an order; emits EVENT:SHIPMENT:CREATED"],
                "market.shipment.ship": ["ship a shipment (assign tracking); emits EVENT:SHIPMENT:SHIPPED"],
                "market.shipment.get": ["get a shipment by id"],
                "market.shipment.list": ["list shipments (optionally by state)"],
                "market.order.create": ["place an order (state PLACED); must be paid + AML-cleared to advance"],
                "market.order.pay": ["advance a PLACED order to PAID (payment collected)"],
                "market.order.confirm": ["confirm a PAID order (AML cleared) → CONFIRMED"],
                "market.order.hold": ["hold a PAID order (AML flagged) → HELD"],
                "market.order.get": ["get an order by id"],
                "market.order.list": ["list orders (optionally by state)"],
                "ping": ["service health check"],
                "methods": ["get service method list"],
                "entities": ["get entity definitions (schema)"]
            }
        },
        zh: {
            main: [
                "模拟发货业务服务（event 流程测试夹具）",
                "收款之后创建发货单并发货；经 _event 搭响应路径发出 EVENT:SHIPMENT:*",
                "接在 collection 之后；非框架服务 —— dev 运行、不打包"
            ],
            methods: {
                "market.shipment.create": ["为订单创建发货单；发 EVENT:SHIPMENT:CREATED"],
                "market.shipment.ship": ["发货（分配运单号）；发 EVENT:SHIPMENT:SHIPPED"],
                "market.shipment.get": ["按 id 查发货单"],
                "market.shipment.list": ["列出发货单（可按状态）"],
                "market.order.create": ["下单（状态 PLACED）；须收款 + AML 放行才能推进"],
                "market.order.pay": ["将 PLACED 订单推进为 PAID（已收款）"],
                "market.order.confirm": ["确认 PAID 订单（AML 放行）→ CONFIRMED"],
                "market.order.hold": ["冻结 PAID 订单（AML 命中）→ HELD"],
                "market.order.get": ["按 id 查订单"],
                "market.order.list": ["列出订单（可按状态）"],
                "ping": ["服务健康检查"],
                "methods": ["获取服务方法列表"],
                "entities": ["获取实体定义 (Schema)"]
            }
        }
    },

    indexes: {},
    seeds: { categories: [] }
};
