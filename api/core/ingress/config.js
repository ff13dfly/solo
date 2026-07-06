require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');

module.exports = {
    // portFor(name, fallback): process.env.PORT > global.__SOLO_PORTS__ > fallback.
    port: portFor('ingress', 8070),
    debug: process.env.DEBUG === 'true',
    serviceName: process.env.SERVICE_NAME || 'ingress',
    version: pkg.version,
    pageSize: 20,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',
    routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
    routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',

    idLengths: {
        source: 8,
    },

    // Shared ops inbox (orchestrator/nexus/notification worker.js pattern) — where
    // schema-rejected deliveries get a notification.send for a human to look at.
    opsInbox: process.env.OPS_INBOX || 'ops',

    // Inbound webhook adapter knobs.
    ingest: {
        streamPrefix: 'EVENT:WEBHOOK:',     // EVENT:WEBHOOK:{SOURCE_UPPER}
        eventType: 'webhook.received',      // generic — domain classification is downstream's job
        defaultDedupTtlSec: 86400,          // 24h, covers most external retry windows
        maxRequestIdLen: 200,               // guard against dedup-key abuse
        keyHashPrefix: 'INGRESS:KEYHASH:',  // {hash} -> sourceId (auth hot-path lookup)
        dedupPrefix: 'INGRESS:DEDUP:',      // {source}:{request_id} SET NX
        // toFix.md AI-injection defense direction: a source's optional `dataSchema`
        // (checkParams flat dialect, library/validate.js) whitelists+types the fields
        // forwarded onto the event bus. A violation (undeclared field OR declared-field
        // type/pattern mismatch) rejects the whole delivery into this bounded review
        // queue instead of forwarding it — a human decides via ingress.review.approve/discard.
        reviewQueueKey: 'INGRESS:REVIEW',
        reviewMaxlen: Number(process.env.INGRESS_REVIEW_MAXLEN) || 500,
    },

    // AI semantic description (Agent intent recognition).
    description: {
        en: {
            main: [
                "inbound webhook ingress adapter (central control plane)",
                "external listeners POST normalized JSON here; ingress authenticates by API key, deduplicates, and emits EVENT:WEBHOOK:* events",
                "dumb pipe: domain classification happens in downstream consumers, not here"
            ],
            methods: {
                "ingress.source.create": ["register an inbound source, returns a one-time API key"],
                "ingress.source.get": ["get a source by id (API key never returned)"],
                "ingress.source.list": ["list inbound sources"],
                "ingress.source.update": ["update source fields (name / dedupTtlSec / enabled)"],
                "ingress.source.enable": ["enable a source"],
                "ingress.source.disable": ["disable a source (downstream unaffected)"],
                "ingress.source.key.rotate": ["rotate a source's API key, returns the new key once"],
                "ingress.source.delete": ["delete a source"],
                "ingress.source.test": ["fire a synthetic webhook.received event for a source (skips dedup)"],
                "ingress.review.list": ["list deliveries held for human review (dataSchema violations)"],
                "ingress.review.approve": ["human reviewed a held delivery and approved it — emits it now"],
                "ingress.review.discard": ["human reviewed a held delivery and discarded it — never emitted"],
                "ping": ["service health check"],
                "methods": ["get service method list"],
                "entities": ["get entity definitions (schema)"]
            }
        },
        zh: {
            main: [
                "外部入站 webhook 适配器（中央控制面）",
                "外部 listener 把归一化 JSON POST 到这里；ingress 用 API key 鉴权、去重，再发出 EVENT:WEBHOOK:* 事件",
                "哑管道：领域分类在下游消费者，不在这里"
            ],
            methods: {
                "ingress.source.create": ["注册一个入站源，返回一次性 API key"],
                "ingress.source.get": ["按 id 获取源（API key 永不回显）"],
                "ingress.source.list": ["列出入站源"],
                "ingress.source.update": ["更新源字段（name / dedupTtlSec / enabled）"],
                "ingress.source.enable": ["启用源"],
                "ingress.source.disable": ["停用源（下游无感）"],
                "ingress.source.key.rotate": ["轮换源的 API key，返回新 key 一次"],
                "ingress.source.delete": ["删除源"],
                "ingress.source.test": ["为某源触发一条合成 webhook.received 事件（跳过去重）"],
                "ingress.review.list": ["列出因 dataSchema 校验不通过而待人工复核的投递"],
                "ingress.review.approve": ["人工复核后批准一条待审投递——现在发出"],
                "ingress.review.discard": ["人工复核后丢弃一条待审投递——永不发出"],
                "ping": ["服务健康检查"],
                "methods": ["获取服务方法列表"],
                "entities": ["获取实体定义 (Schema)"]
            }
        }
    },

    indexes: {},
    seeds: { categories: [] }
};
