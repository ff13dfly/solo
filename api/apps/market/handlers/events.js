module.exports = {
    emits: [
        {
            stream:      'EVENT:SHIPMENT:CREATED',
            type:        'shipment.created',
            trigger:     'market.shipment.create',
            description: '为订单创建发货单后发出',
            mechanism:   '_event piggyback（Router 从 RPC 响应中提取）',
            payload: {
                id:        'string — 发货单 ID',
                orderId:   'string',
                status:    'string',
                createdAt: 'number',
            },
        },
        {
            stream:      'EVENT:SHIPMENT:SHIPPED',
            type:        'shipment.shipped',
            trigger:     'market.shipment.ship',
            description: '标记发货（分配运单号）后发出',
            mechanism:   '_event piggyback',
            payload: {
                id:          'string',
                orderId:     'string',
                trackingNo:  'string',
                shippedAt:   'number',
                status:      'string',
            },
        },
    ],
    subscribes: [],
};
