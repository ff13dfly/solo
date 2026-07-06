module.exports = {
    emits: [
        {
            stream:      'EVENT:WORKFLOW:RESULT',
            type:        'workflow.run.completed',
            trigger:     'workflow.run 完成（所有 step 执行成功）',
            description: '工作流完整执行成功后发出，携带完整 trace',
            mechanism:   'redis.xAdd 直写（runner.js）',
            payload: {
                workflow_id: 'string',
                status:      "'completed'",
            },
        },
        {
            stream:      'EVENT:WORKFLOW:STATUS',
            type:        'workflow.run.failed',
            trigger:     'workflow.run step 执行失败',
            description: '任一 step 抛错后发出，携带失败 step id 和错误信息',
            mechanism:   'redis.xAdd 直写（runner.js）',
            payload: {
                workflow_id:  'string',
                status:       "'failed'",
                failed_step:  'string',
                error:        'string',
            },
        },
        {
            stream:      'EVENT:WORKFLOW:NEEDS_GRANT',
            type:        'workflow.needs_grant',
            trigger:     'workflow.run 触发 H6 footprint 预审失败（caller permit 不足）',
            description: '运行时权限不足时发出，通知管理员补授权后可继续',
            mechanism:   'relay → event.emit（system.orchestrator bot，worker.js）',
            payload: {
                runId:          'string|null',
                workflowId:     'string',
                missingMethods: 'string[]',
                triggerSource:  'string',
                pausedAt:       'number',
            },
        },
    ],
    subscribes: [
        {
            stream:      '由各 workflow 模板的 event_subscriptions 字段动态决定',
            type:        '*',
            consumer:    'orchestrator matcher（ORCH_MATCHER group，xReadGroup 循环）',
            description: 'Matcher 消费所有 ACTIVE workflow 订阅的 stream，匹配后触发 workflow.run。具体 stream 列表由 workflow.list 查询。',
        },
    ],
};
