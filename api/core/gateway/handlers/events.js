/**
 * Delivery outcomes on the bus, so a nexus Sentinel can REACT to what actually left the
 * system (before this, `emits` was empty and "nothing was really sent" was invisible).
 *
 * Emitted via the Router `_event` piggyback on the send result (router/handlers/events.js) —
 * no relay/bot token needed. @attention that mechanism rides a SUCCESSFUL result, so a
 * failed send is a FAILED ledger row + log, not an event yet (gateway-gaps G8).
 */
const PAYLOAD = {
    channel:           'string — email | sms | webhook',
    target:            'string — recipient (address / phone / url)',
    provider:          'string — smtp | api | aliyun | twilio | webhook | mock',
    providerMessageId: 'string — provider-side id',
    deliveryId:        'string — gateway.delivery.* ledger row (absent if the audit write failed)',
    templateId:        'string|null — template used, if any',
    status:            "'SENT' | 'MOCKED' — same value as the ledger's deliveryStatus",
};

module.exports = {
    emits: [
        {
            stream:      'EVENT:GATEWAY:DELIVERY',
            type:        'gateway.delivery.sent',
            trigger:     'gateway.{email,sms,webhook}.send accepted by a REAL provider',
            description: '一次出站投递被真实提供商收下。消费者据此确认"确实发出去了"。',
            mechanism:   '_event piggyback on the RPC result (Router extracts + publishes)',
            payload:     PAYLOAD,
        },
        {
            stream:      'EVENT:GATEWAY:DELIVERY',
            type:        'gateway.delivery.mocked',
            trigger:     'send resolved on the mock channel (no provider credentials configured)',
            description: '**什么都没真发出去** —— 无凭证时的静默降级。这是最值得订阅的一条：生产上出现即配置缺失。',
            mechanism:   '_event piggyback on the RPC result (Router extracts + publishes)',
            payload:     PAYLOAD,
        },
        {
            stream:      'EVENT:GATEWAY:DELIVERY',
            type:        'gateway.delivery.failed',
            trigger:     'a send threw at the provider (after recording the FAILED ledger row)',
            description: '投递失败。走 relay event.emit（`_event` 只能搭成功结果），source = system.gateway bot；relay token 未播则只有台账行、无事件（fail-soft）。payload 额外带 `error`。',
            mechanism:   'relay → event.emit (system.gateway bot) — fire-and-forget',
            payload:     { ...PAYLOAD, error: 'string — failure reason (truncated 500)' },
        },
    ],
    subscribes: [],
};
