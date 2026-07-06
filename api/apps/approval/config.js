require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');

module.exports = {
    port: portFor('approval', 8060),
    debug: process.env.DEBUG === 'true',
    serviceName: process.env.SERVICE_NAME || 'approval',
    version: pkg.version,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',
    routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
    routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',

    idLengths: {
        record: 12,
        gate: 12
    },

    // VERSION.md §3.1 — multi-signature approval gate (high-risk lane) defaults.
    gate: {
        defaultExpirySec: parseInt(process.env.APPROVAL_GATE_EXPIRY_SEC) || 259200,   // 72h
        defaultRequiredSigners: parseInt(process.env.APPROVAL_GATE_REQUIRED_SIGNERS) || 1
    },

    description: {
        en: {
            main: [
                "Solo Approval Protocol (SAP): gated, auditable change approval",
                "records a change INTENT (target + operations) and walks it through a state machine",
                "data-agnostic: any service.entity.id can be put behind approval without modification"
            ],
            methods: {
                "approval.record.request": ["file a change request, creates an INIT approval record"],
                "approval.record.verify":  ["verifier approves the request content (INIT -> DISPATCHED)"],
                "approval.record.confirm": ["confirm physical execution of the change (DISPATCHED -> DONE)"],
                "approval.record.reject":  ["reject a request (INIT|DISPATCHED -> REJECTED)"],
                "approval.record.get":     ["get an approval record by id"],
                "approval.record.list":    ["list approval records, filter by target/state"],
                "ping":     ["service health check"],
                "methods":  ["get service method list"],
                "entities": ["get entity definitions"]
            }
        },
        zh: {
            main: [
                "Solo 审批协议 (SAP)：受控、可审计的变更审批",
                "记录的是变更意图(目标 + 操作),并推动其走完状态机",
                "内容中立：任意 service:entity:id 无需改造即可纳入审批"
            ],
            methods: {
                "approval.record.request": ["发起变更申请,生成 INIT 审批记录"],
                "approval.record.verify":  ["审核员核准申请内容 (INIT -> DISPATCHED)"],
                "approval.record.confirm": ["确认变更已物理执行 (DISPATCHED -> DONE)"],
                "approval.record.reject":  ["驳回申请 (INIT|DISPATCHED -> REJECTED)"],
                "approval.record.get":     ["按 id 获取审批记录"],
                "approval.record.list":    ["列出审批记录,可按 target/state 筛选"],
                "ping":     ["服务健康检查"],
                "methods":  ["获取服务方法列表"],
                "entities": ["获取实体定义"]
            }
        }
    }
};
