require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');

module.exports = {
    port: portFor('collection', 8055),
    debug: process.env.DEBUG === 'true',
    serviceName: process.env.SERVICE_NAME || 'collection',
    version: pkg.version,
    pageSize: 20,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',
    routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
    routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',

    idLengths: {
        payment: 10,
    },

    // _event piggyback streams this service emits (event.md §4.1). For the Router
    // to accept them, register source 'collection' in the event registry (see README).
    events: {
        received: { stream: 'EVENT:PAYMENT:RECEIVED', type: 'payment.received' },
        settled:  { stream: 'EVENT:PAYMENT:SETTLED',  type: 'payment.settled' },
    },

    description: {
        en: {
            main: [
                "mock payment-collection business service (event-flow test fixture)",
                "records incoming payments and emits EVENT:PAYMENT:* via the _event piggyback path",
                "NOT a framework service — runs in dev, registered at runtime, not bundled"
            ],
            methods: {
                "collection.payment.record": ["record an incoming payment; emits EVENT:PAYMENT:RECEIVED"],
                "collection.payment.settle": ["mark a payment settled; emits EVENT:PAYMENT:SETTLED"],
                "collection.payment.refund": ["refund a payment; requires a confirmed, signed approval targeting it"],
                "collection.payment.get": ["get a payment by id"],
                "collection.payment.list": ["list payments (optionally by status)"],
                "collection.token.set": ["set the relay bot token (admin)"],
                "collection.token.status": ["relay token status (admin)"],
                "collection.token.clear": ["clear the relay bot token (admin)"],
                "ping": ["service health check"],
                "methods": ["get service method list"],
                "entities": ["get entity definitions (schema)"]
            }
        },
        zh: {
            main: [
                "模拟收款业务服务（event 流程测试夹具）",
                "记录入账并经 _event 搭响应路径发出 EVENT:PAYMENT:*",
                "非框架服务 —— dev 运行、运行时注册、不打包"
            ],
            methods: {
                "collection.payment.record": ["记录一笔入账；发 EVENT:PAYMENT:RECEIVED"],
                "collection.payment.settle": ["标记结算；发 EVENT:PAYMENT:SETTLED"],
                "collection.payment.refund": ["退款；需要一张已确认、已签名、指向该笔收款的审批单"],
                "collection.payment.get": ["按 id 查收款"],
                "collection.payment.list": ["列出收款（可按状态）"],
                "collection.token.set": ["设置 relay bot token（管理员）"],
                "collection.token.status": ["relay token 状态（管理员）"],
                "collection.token.clear": ["清除 relay bot token（管理员）"],
                "ping": ["服务健康检查"],
                "methods": ["获取服务方法列表"],
                "entities": ["获取实体定义 (Schema)"]
            }
        }
    },

    indexes: {},
    seeds: { categories: [] }
};
