/**
 * deploy/bot-permits.js — system.* relay-bot 权限图 · 单一真源
 *
 * 这份 `uid → permit.services` 映射历史上**存在两份**(dev 播种 `deploy/seed-bots.js`
 * 与 e2e mesh 播种 `e2e/harness/setup.js` seedBots()),靠注释"镜像 seedBots"手工保持一致——
 * 加一个 bot(如 v1.1.8 的 system.user)就得两处各写一遍,漏一处即漂。
 * 现收敛为本文件,两处 `require` 同一份(协调性债 coherence-debt.md §2)。
 *
 * 注意:这里**只**是 permit 数据。两处的 seeding *流程*刻意不同、各自保留:
 *   - deploy/seed-bots.js:dev 环境,直写 `RELAY:TOKEN:{svc}`(DEV_TOKEN + waitForRouter 探针)
 *   - e2e/harness/setup.js:e2e mesh,走 `{svc}.token.set` RPC(ADMIN_TOKEN)
 * 都对 BOT_PERMITS 做同一套 `bot.create → update → issue.token → 落 token`。
 *
 * 纯数据、零依赖 —— 可从 deploy/ 与 e2e/ 两处安全 require,不牵涉任何 node_modules。
 *
 * (§3.4 OpenClaw 是外部投稿 agent,自持 token、不是 relay bot —— 不在此 seed;
 *  其窄 permit 由治理 e2e / 生产按需用 user.bot.create + issue.token 供给。)
 */

const BOT_PERMITS = {
    // orchestrator:事件触发的 workflow 步骤跑 collection→market→notification→fulfillment。
    // user.permit.get:H6 footprint 预审要读 bot 自己的 permit(经 Router;getPermit 已能解析 bot uid)。
    // §3.1:高风险 approve 转发 approval.gate.*(open/sign/get)+ 验签读审批人公钥。
    'system.orchestrator': { collection: ['*'], market: ['*'], notification: ['*'], fulfillment: ['*'], user: ['user.permit.get'], approval: ['approval.gate.open', 'approval.gate.sign', 'approval.gate.get'] },

    // nexus:哨兵消费者投递走 notification.send;context 装配的 data_fetcher 读 collection.payment.get;
    // autorun 闭环还经 relay 调 agent.decide(结构化决策契约)。没它哨兵每次投递死在 relay NO_TOKEN。
    'system.nexus':        { orchestrator: ['*'], notification: ['notification.send'], collection: ['collection.payment.get'], agent: ['agent.chat', 'agent.decide'], user: ['user.permit.get'] },

    // notification 投递 worker:gateway.{channel}.send 出站 + user.profile 解析默认出站地址(email/phone)。
    'system.notification': { gateway: ['gateway.email.send', 'gateway.sms.send', 'gateway.webhook.send'], user: ['user.profile'] },

    // passport 自助 OTP 投递:user 经 relay 调 gateway.{email,sms}.send(user/index.js 构造)。
    // Dormant 直到 config.passport 开自助 OTP 发证(默认 'closed');投递 best-effort(otpRequest 吞 relay 错)。
    'system.user':         { gateway: ['gateway.email.send', 'gateway.sms.send'] },

    // ingress:event.emit → EVENT:WEBHOOK:*(无下游服务调用,permit 为空)。
    'system.ingress':      {},

    // fulfillment:emit EVENT:FULFILLMENT:*(经 Router 事件注册表)+ 调 agent.chat 做 profile.generate(NL → profile)。
    'system.fulfillment':  { agent: ['agent.chat'] },

    // §3.1:approval gate 验签时读审批人公钥。
    'system.approval':     { user: ['user.key.public'] },

    // collection.payment.refund 退款前经 relay 验审批单(approval.record.get)——没它 refund 死在 relay NO_TOKEN。
    'system.collection':   { approval: ['approval.record.get'] },
};

module.exports = { BOT_PERMITS };
