module.exports = {
    emits: [
        {
            stream:      'EVENT:FULFILLMENT:TRANSITIONED',
            type:        'instance.transitioned',
            trigger:     'fulfillment.instance.transition / cancel / hold / resume / override',
            description: '每次实例状态成功转换后发出（fire-and-forget，不阻塞 transition 响应）',
            mechanism:   'relay → event.emit',
            payload: {
                instanceId:   'string',
                profileId:    'string',
                sourceId:     'string',
                fromState:    'string',
                toState:      'string',
                event:        'string',
                transitionId: 'string — 格式 {instanceId}-T{N}，幂等键',
                user:         'string|null',
                stamp:        'number — ms epoch',
            },
        },
    ],
    subscribes: [],
};
