module.exports = {
    emits: [
        {
            stream:      'EVENT:SENTINEL:{name}',
            type:        '动态 — 由 Sentinel context.emit() 的 action 决定',
            trigger:     'Sentinel autorun 决策循环（agent.decide → emit_event action）',
            description: '每个 Sentinel 可在 decide 阶段发出零或多个事件，stream 名为 EVENT:SENTINEL:{sentinelName}。具体 type 由 Sentinel 配置的 action 决定。',
            mechanism:   'relay → event.emit（system.nexus bot）',
            payload:     '动态 — 由 Sentinel context.emit payload 决定',
        },
        {
            stream:      '由 scheduler emit_event action 配置决定',
            type:        '动态 — 由 Schedule.action.type 字段决定',
            trigger:     'nexus.schedule 到期触发',
            description: '定时任务（Schedule）的 emit_event 动作：到期后向指定 stream 发出指定 type 的事件。',
            mechanism:   'relay → event.emit（system.nexus bot）',
            payload:     '动态 — 由 Schedule.action.payload 配置决定',
        },
    ],
    subscribes: [
        {
            stream:      '由各 Sentinel 的 eventSubscriptions 动态注册',
            type:        '*',
            consumer:    'nexus stream consumer（NEXUS:CONSUMER group，xReadGroup 循环）',
            description: 'Nexus 消费所有活跃 Sentinel 订阅的 stream。具体 stream 列表在运行时由 nexus.sentinel.list 查询。',
        },
    ],
};
