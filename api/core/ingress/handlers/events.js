module.exports = {
    emits: [
        {
            stream:      'EVENT:WEBHOOK:{source}',
            type:        'webhook.received',
            trigger:     'ingress.ingest（外部 webhook 入站）',
            description: '每条入站 webhook 经 API key 鉴权 + 去重后发出。stream 名动态：每个注册的 source 对应一条独立 stream。',
            mechanism:   'relay → event.emit（system.ingress bot）',
            payload: {
                request_id: 'string — 调用方提供的幂等键',
                data:       'object — 原始 webhook body',
            },
        },
    ],
    subscribes: [],
};
