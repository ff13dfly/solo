module.exports = {
    emits: [
        {
            stream:      'EVENT:PAYMENT:RECEIVED',
            type:        'payment.received',
            trigger:     'collection.payment.record',
            description: '记录一笔入账后发出',
            mechanism:   '_event piggyback（Router 从 RPC 响应中提取）',
            payload: {
                id:         'string — 支付记录 ID',
                orderId:    'string',
                amount:     'number',
                currency:   'string',
                status:     'string',
                createdAt:  'number',
            },
        },
        {
            stream:      'EVENT:PAYMENT:SETTLED',
            type:        'payment.settled',
            trigger:     'collection.payment.settle',
            description: '标记结算后发出',
            mechanism:   '_event piggyback',
            payload: {
                id:         'string',
                orderId:    'string',
                settledAt:  'number',
                status:     'string',
            },
        },
    ],
    subscribes: [],
};
