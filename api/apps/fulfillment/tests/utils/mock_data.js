/**
 * Shared test fixtures for fulfillment service tests
 *
 * Phase 3 — 智能协同（完整协议）
 * 包含：states + meta_fields + state_config(erp_views) + transitions(workflow) + ai_hooks
 */

const PROFILE_ID = 'standard_trade';

const MOCK_PROFILE = {
    id:          PROFILE_ID,
    name:        '标准外贸',
    version:     '1.0.0',
    description: '适用于一般外贸出口订单的标准履约流程',

    // ── 合法状态集 ─────────────────────────────────────────────────────────
    states: [
        'DRAFT', 'DEPOSIT_PENDING', 'DEPOSIT_CONFIRMED',
        'SOURCING', 'PACKING', 'BALANCE_PENDING',
        'READY_TO_SHIP', 'DISPATCHED', 'DELIVERED',
        'SETTLED', 'CLOSED',
        'ON_HOLD', 'DISPUTE', 'CANCELLED',
    ],

    // ── instance.meta 字段声明（供条件编辑器使用）───────────────────────────
    meta_fields: [
        { key: 'amount_received',  label: '已到账金额' },
        { key: 'deposit_required', label: '需付订金' },
        { key: 'total_required',   label: '应付总金额' },
        { key: 'requires_balance', label: '需付尾款' },
        { key: 'tracking_number',  label: '物流单号' },
        { key: 'erp_order_id',     label: 'ERP 销售订单号' },
        { key: 'erp_dispatch_id',  label: 'ERP 出库单号' },
        { key: 'payment_status',   label: '收款状态' },
    ],

    // ── 各阶段的 ERP 单据视图（per-state）────────────────────────────────────
    state_config: {
        DRAFT: {
            erp_views: [
                { label: '销售订单', method: 'erp.saleorder.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
            ]
        },
        DEPOSIT_PENDING: {
            erp_views: [
                { label: '销售订单', method: 'erp.saleorder.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
                { label: '预收款单', method: 'erp.prepayment.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
            ]
        },
        DEPOSIT_CONFIRMED: {
            erp_views: [
                { label: '销售订单', method: 'erp.saleorder.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
                { label: '预收款单', method: 'erp.prepayment.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
            ]
        },
        SOURCING: {
            erp_views: [
                { label: '采购订单', method: 'erp.purchaseorder.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
            ]
        },
        PACKING: {
            erp_views: [
                { label: '采购订单', method: 'erp.purchaseorder.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
            ]
        },
        BALANCE_PENDING: {
            erp_views: [
                { label: '应收账款', method: 'erp.receivable.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
            ]
        },
        READY_TO_SHIP: {
            erp_views: [
                { label: '出库单', method: 'erp.saledispatch.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
            ]
        },
        DISPATCHED: {
            erp_views: [
                { label: '出库单', method: 'erp.saledispatch.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
            ]
        },
        DELIVERED: {
            erp_views: [
                { label: '出库单', method: 'erp.saledispatch.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
            ]
        },
        SETTLED: {
            erp_views: [
                { label: '销货单', method: 'erp.sale_invoice.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
                { label: '财务凭证', method: 'erp.voucher.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
            ]
        },
        CLOSED: {
            erp_views: [
                { label: '销货单', method: 'erp.sale_invoice.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
                { label: '财务凭证', method: 'erp.voucher.query',
                  params: { externalCode: { var: 'instance.sourceId' } } },
            ]
        },
    },

    // ── 状态转换规则 ───────────────────────────────────────────────────────
    transitions: [
        {
            event:     'order_submitted',
            from:      'DRAFT',
            to:        'DEPOSIT_PENDING',
            condition: null,
            actions:   []
        },
        {
            event: 'payment_received',
            from:  'DEPOSIT_PENDING',
            to:    'DEPOSIT_CONFIRMED',
            condition: null,
            actions: [
                {
                    method: 'erp.order.sync',
                    params: {
                        instanceId: { var: 'instance.id' },
                        sourceId:   { var: 'instance.sourceId' }
                    }
                }
            ]
        },
        {
            // 信用额度豁免路径（无需到账即可确认）
            event:     'credit_approved',
            from:      'DEPOSIT_PENDING',
            to:        'DEPOSIT_CONFIRMED',
            condition: null,
            actions:   []
        },
        {
            event:     'sourcing_started',
            from:      'DEPOSIT_CONFIRMED',
            to:        'SOURCING',
            condition: null,
            actions:   []
        },
        {
            event:     'goods_arrived',
            from:      'SOURCING',
            to:        'PACKING',
            condition: null,
            actions:   []
        },
        {
            // 有尾款条款 → 先收尾款
            event:     'packing_completed',
            from:      'PACKING',
            to:        'BALANCE_PENDING',
            condition: { '==': [{ var: 'instance.meta.requires_balance' }, true] },
            actions:   []
        },
        {
            // 无尾款条款 → 直接待发货
            event:     'packing_completed',
            from:      'PACKING',
            to:        'READY_TO_SHIP',
            condition: { '!=': [{ var: 'instance.meta.requires_balance' }, true] },
            actions:   []
        },
        {
            event: 'balance_received',
            from:  'BALANCE_PENDING',
            to:    'READY_TO_SHIP',
            condition: {
                '>=': [
                    { var: 'instance.meta.amount_received' },
                    { var: 'instance.meta.total_required' }
                ]
            },
            actions: []
        },
        {
            event:     'dispatched',
            from:      'READY_TO_SHIP',
            to:        'DISPATCHED',
            condition: { '!!': [{ var: 'instance.meta.tracking_number' }] },
            actions: [
                {
                    type:       'workflow',
                    workflowId: 'erp-dispatch-sync',
                    input: {
                        instanceId: { var: 'instance.id' },
                        sourceId:   { var: 'instance.sourceId' }
                    },
                    on_complete: {
                        event:      'erp_synced',
                        meta_patch: { erp_dispatch_id: '$step.dispatch.result.id' }
                    }
                }
            ]
        },
        {
            event:     'delivery_confirmed',
            from:      'DISPATCHED',
            to:        'DELIVERED',
            condition: null,
            actions:   []
        },
        {
            event:     'dispute_raised',
            from:      'DELIVERED',
            to:        'DISPUTE',
            condition: null,
            actions:   []
        },
        {
            event:     'no_dispute_timeout',
            from:      'DELIVERED',
            to:        'SETTLED',
            condition: null,
            actions:   []
        },
        {
            event:     'dispute_resolved',
            from:      'DISPUTE',
            to:        'SETTLED',
            condition: null,
            actions:   []
        },
        {
            event:     'dispute_failed',
            from:      'DISPUTE',
            to:        'CANCELLED',
            condition: null,
            actions:   []
        },
        {
            event:     'finance_closed',
            from:      'SETTLED',
            to:        'CLOSED',
            condition: null,
            actions: [
                {
                    type:       'workflow',
                    workflowId: 'erp-finalize',
                    input: {
                        instanceId: { var: 'instance.id' },
                        sourceId:   { var: 'instance.sourceId' }
                    },
                    on_complete: {
                        event:      'erp_synced',
                        meta_patch: {}
                    }
                }
            ]
        },
        // ── 旁路：任意可逆态 ↔ ON_HOLD ──────────────────────────────────────
        {
            event:     'hold_requested',
            from:      'ON_HOLD',   // placeholder，引擎需特殊处理 any→ON_HOLD
            to:        'ON_HOLD',
            condition: null,
            actions:   []
        },
        {
            event:     'hold_released',
            from:      'ON_HOLD',
            to:        'ON_HOLD',   // placeholder，引擎恢复 prevState
            condition: null,
            actions:   []
        },
    ],

    // ── AI 钩子 ────────────────────────────────────────────────────────────
    ai_hooks: [
        {
            trigger: {
                event:     'payment_received',
                condition: { '>': [{ var: 'instance.meta.amount_received' }, 50000] }
            },
            invoke:               'risk.creditAssessment',
            input:                ['instance', 'user'],
            disposition:          'human_confirm',
            confidence_threshold: 0.85,
            outcome_map: {
                approve: { event: 'credit_approved' },
                hold:    { event: 'hold_requested',   reason: 'AI_RECOMMENDED' },
                reject:  { event: 'cancel_requested', reason: 'AI_RECOMMENDED' }
            }
        }
    ]
};

const MOCK_INSTANCE = {
    id:             'FL-20260313-0001',
    sourceId:       'SO-2026-03-0001',
    profileId:      PROFILE_ID,
    state:          'DRAFT',
    prevState:      null,
    stateChangedAt: 1741824000000,
    createdAt:      1741824000000,
    createdBy:      'tester',
    meta: {
        amount_received:  0,
        deposit_required: 15000,
        total_required:   50000,
        requires_balance: true,
        tracking_number:  null,
        erp_order_id:     null,
        erp_dispatch_id:  null,
        payment_status:   'PENDING',
    },
    pending_callbacks: [],
    history: [
        { state: 'DRAFT', event: null, reason: 'MANUAL', user: 'tester', stamp: 1741824000000 }
    ]
};

const MOCK_REQ = { user: 'tester', permit: { allow_all: true }, constraints: null };

module.exports = { PROFILE_ID, MOCK_PROFILE, MOCK_INSTANCE, MOCK_REQ };
