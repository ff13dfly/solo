require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');

module.exports = {
    port: portFor('fulfillment', 8050),
    debug: process.env.DEBUG === 'true',
    serviceName: process.env.SERVICE_NAME || 'fulfillment',
    version: pkg.version,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',
    routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
    routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',

    idLengths: {
        profile: 8
    },

    redis: {
        instancePrefix: 'FULFILLMENT:INSTANCE:',
        instanceIndex:  'FULFILLMENT:INSTANCE:INDEX',
        profilePrefix:  'FULFILLMENT:PROFILE:',
        profileIndex:   'FULFILLMENT:PROFILE:INDEX'
    },

    description: {
        en: {
            main: [
                'Fulfillment Lifecycle Engine',
                'Manages order fulfillment state transitions, business rules, and ERP task orchestration'
            ],
            methods: {
                'fulfillment.instance.create':     ['Create a new fulfillment instance for an order'],
                'fulfillment.instance.get':        ['Get fulfillment instance details and history'],
                'fulfillment.instance.list':       ['List all fulfillment instances'],
                'fulfillment.instance.transition': ['Trigger a state transition on a fulfillment instance'],
                'fulfillment.instance.cancel':     ['Cancel a fulfillment instance (fires cancel_requested)'],
                'fulfillment.instance.hold':       ['Pause a fulfillment instance (fires hold_requested)'],
                'fulfillment.instance.resume':     ['Resume a held fulfillment instance to its prevState'],
                'fulfillment.instance.override':   ['Admin force-advance, skipping the JsonLogic condition'],
                'fulfillment.instance.update':     ['Update instance metadata (merges meta; caches meta_fields.source values)'],
                'fulfillment.profile.generate':    ['Generate a fulfillment profile candidate from a natural-language requirement (LLM + lint + repair); returns a reviewed candidate, does not create it'],
                'fulfillment.profile.submit':      ['Submit a profile for review (lint-gated → PENDING_REVIEW); not usable until approved'],
                'fulfillment.profile.approve':     ['Approve a PENDING_REVIEW profile → APPROVED (admin; approver ≠ submitter)'],
                'fulfillment.profile.reject':      ['Reject a PENDING_REVIEW profile → REJECTED (admin)'],
                'fulfillment.profile.create':      ['Create a fulfillment profile (state machine configuration)'],
                'fulfillment.profile.get':         ['Get a fulfillment profile'],
                'fulfillment.profile.list':        ['List all fulfillment profiles'],
                'fulfillment.profile.update':      ['Update a fulfillment profile'],
                'fulfillment.profile.delete':      ['Soft delete a fulfillment profile'],
                'fulfillment.profile.restore':     ['Restore a soft-deleted profile'],
                'fulfillment.profile.destroy':     ['Permanently delete a fulfillment profile'],
                'ping':    ['Service health check'],
                'methods': ['Get service method list'],
                'entities': ['Get entity schema definitions']
            }
        },
        zh: {
            main: [
                '履约生命周期引擎',
                '管理订单履约状态流转、业务规则校验及 ERP 任务编排'
            ],
            methods: {
                'fulfillment.instance.create':     ['创建新的履约实例'],
                'fulfillment.instance.get':        ['获取履约实例详情及历史'],
                'fulfillment.instance.list':       ['列出所有履约实例'],
                'fulfillment.instance.transition': ['触发履约实例状态流转'],
                'fulfillment.instance.cancel':     ['取消履约实例（触发 cancel_requested）'],
                'fulfillment.instance.hold':       ['暂停履约实例（触发 hold_requested）'],
                'fulfillment.instance.resume':     ['恢复已暂停的履约实例至上一状态'],
                'fulfillment.instance.override':   ['管理员强制推进（跳过 JsonLogic 条件）'],
                'fulfillment.instance.update':     ['更新履约实例元数据（合并 meta；缓存 meta_fields.source 值）'],
                'fulfillment.profile.generate':    ['用自然语言需求生成履约配置模板候选（LLM + 校验 + 修复）；返回经校验的候选，不直接创建'],
                'fulfillment.profile.submit':      ['投稿配置模板供审核（lint 把关 → PENDING_REVIEW）；审批前不可用'],
                'fulfillment.profile.approve':     ['审批通过 PENDING_REVIEW 模板 → APPROVED（管理员；审批人 ≠ 投稿人）'],
                'fulfillment.profile.reject':      ['驳回 PENDING_REVIEW 模板 → REJECTED（管理员）'],
                'fulfillment.profile.create':      ['创建履约配置模板（状态机配置）'],
                'fulfillment.profile.get':         ['获取履约配置模板'],
                'fulfillment.profile.list':        ['列出所有履约配置模板'],
                'fulfillment.profile.update':      ['更新履约配置模板'],
                'fulfillment.profile.delete':      ['软删除履约配置模板'],
                'fulfillment.profile.restore':     ['恢复已软删除的配置模板'],
                'fulfillment.profile.destroy':     ['永久删除履约配置模板'],
                'ping':    ['服务健康检查'],
                'methods': ['获取服务方法列表'],
                'entities': ['获取实体定义']
            }
        }
    },

    seeds: {
        categories: []
    }
};
