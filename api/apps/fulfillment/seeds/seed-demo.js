#!/usr/bin/env node

/**
 * Seed demo data for fulfillment service
 * Writes directly to Redis (bypasses API field restrictions)
 *
 * Usage: node seed-demo.js [--url redis://host:port]
 *   default: redis://localhost:6379
 */

const redis = require('redis');

const REDIS_URL = process.argv.includes('--url')
    ? process.argv[process.argv.indexOf('--url') + 1]
    : process.env.REDIS_URL || 'redis://localhost:6379';

const PREFIX         = 'FULFILLMENT:INSTANCE:';
const INDEX          = 'FULFILLMENT:INSTANCE:INDEX';
const PROFILE_PREFIX = 'FULFILLMENT:PROFILE:';
const PROFILE_INDEX  = 'FULFILLMENT:PROFILE:INDEX';

// --- Profile: standard_trade ---

const STANDARD_TRADE_PROFILE = {
    id: 'standard_trade',
    name: '标准贸易履约',
    version: '2.0.0',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    _deleted: false,
    states: [
        'DRAFT', 'DEPOSIT_PENDING', 'DEPOSIT_CONFIRMED',
        'SOURCING', 'PACKING', 'SHIPPED', 'DELIVERED',
        'AFTER_SALES', 'SETTLED', 'ON_HOLD', 'CANCELLED'
    ],
    transitions: [
        { event: 'order_submitted',     from: 'DRAFT',             to: 'DEPOSIT_PENDING' },
        {
            event: 'payment_received',
            from: 'DEPOSIT_PENDING',
            to: 'DEPOSIT_CONFIRMED',
            condition: {
                and: [
                    { '==': [{ var: 'instance.meta.payment_status' }, 'SUCCESS'] },
                    { '>=': [{ var: 'instance.meta.amount_received' }, { var: 'instance.meta.deposit_required' }] }
                ]
            }
        },
        { event: 'erp_synced',          from: 'DEPOSIT_CONFIRMED', to: 'SOURCING' },
        { event: 'goods_ready',         from: 'SOURCING',          to: 'PACKING' },
        { event: 'packing_done',        from: 'PACKING',           to: 'SHIPPED' },
        { event: 'delivery_confirmed',  from: 'SHIPPED',           to: 'DELIVERED' },
        { event: 'issue_raised',        from: 'DELIVERED',         to: 'AFTER_SALES' },
        { event: 'issue_resolved',      from: 'AFTER_SALES',       to: 'SETTLED' },
        { event: 'settlement_done',     from: 'DELIVERED',         to: 'SETTLED' },
        { event: 'closed',              from: 'SETTLED',           to: 'SETTLED' },
        { event: 'hold_requested',      from: 'SOURCING',          to: 'ON_HOLD' },
        { event: 'hold_requested',      from: 'PACKING',           to: 'ON_HOLD' },
        { event: 'resume',              from: 'ON_HOLD',           to: 'SOURCING' },
        { event: 'cancel_requested',    from: 'DRAFT',             to: 'CANCELLED' },
        { event: 'cancel_requested',    from: 'DEPOSIT_PENDING',   to: 'CANCELLED' }
    ],
    ai_hooks: []
};

// --- Demo Instances (one per state) ---

const now = Date.now();
const DAY = 86400000;

const DEMO_INSTANCES = [
    {
        id: 'FL-20260325-001',
        sourceId: 'ORD-2026-011',
        profileId: 'standard_trade',
        state: 'DRAFT',
        prevState: null,
        stateChangedAt: now - 1 * DAY,
        createdAt: now - 1 * DAY,
        createdBy: 'fuu',
        meta: {
            customer: 'Accra Building Materials Ltd.',
            incoterms: 'FOB',
            totalAmount: 860000,
            currency: 'USD',
            notes: '草稿中，尚未发给客户确认'
        },
        pending_callbacks: [],
        history: [
            { state: 'DRAFT', event: null, reason: 'CREATED', user: 'fuu', stamp: now - 1 * DAY }
        ]
    },
    {
        id: 'FL-20260323-002',
        sourceId: 'ORD-2026-012',
        profileId: 'standard_trade',
        state: 'DEPOSIT_PENDING',
        prevState: 'DRAFT',
        stateChangedAt: now - 2 * DAY,
        createdAt: now - 3 * DAY,
        createdBy: 'fuu',
        meta: {
            customer: 'Lagos Import Co.',
            incoterms: 'CIF',
            totalAmount: 1225000,
            deposit_required: 367500,
            amount_received: 0,
            payment_status: 'PENDING',
            currency: 'USD',
            notes: '等待 TT 电汇，预计 3 个工作日到账'
        },
        pending_callbacks: [],
        history: [
            { state: 'DRAFT',           event: null,              reason: 'CREATED', user: 'fuu', stamp: now - 3 * DAY },
            { state: 'DEPOSIT_PENDING', event: 'order_submitted', reason: 'MANUAL',  user: 'fuu', stamp: now - 2 * DAY }
        ]
    },
    {
        id: 'FL-20260320-003',
        sourceId: 'ORD-2026-013',
        profileId: 'standard_trade',
        state: 'DEPOSIT_CONFIRMED',
        prevState: 'DEPOSIT_PENDING',
        stateChangedAt: now - 4 * DAY,
        createdAt: now - 6 * DAY,
        createdBy: 'fuu',
        meta: {
            customer: '广州博仕贸易',
            incoterms: 'EXW',
            totalAmount: 980000,
            deposit_required: 294000,
            amount_received: 294000,
            payment_status: 'SUCCESS',
            currency: 'CNY',
            notes: '订金已到账，待同步 ERP 建单'
        },
        pending_callbacks: [],
        history: [
            { state: 'DRAFT',              event: null,               reason: 'CREATED', user: 'fuu',    stamp: now - 6 * DAY },
            { state: 'DEPOSIT_PENDING',    event: 'order_submitted',  reason: 'MANUAL',  user: 'fuu',    stamp: now - 6 * DAY },
            { state: 'DEPOSIT_CONFIRMED',  event: 'payment_received', reason: 'MANUAL',  user: 'fuu',    stamp: now - 4 * DAY }
        ]
    },
    {
        id: 'FL-20260315-004',
        sourceId: 'ORD-2026-014',
        profileId: 'standard_trade',
        state: 'SOURCING',
        prevState: 'DEPOSIT_CONFIRMED',
        stateChangedAt: now - 6 * DAY,
        createdAt: now - 8 * DAY,
        createdBy: 'fuu',
        meta: {
            customer: 'Dakar Distribution SARL',
            incoterms: 'FOB',
            totalAmount: 1570000,
            deposit_required: 471000,
            amount_received: 471000,
            payment_status: 'SUCCESS',
            currency: 'XOF',
            erpOrderId: 'ERP-T20260315-021',
            factory: '深圳华威电气',
            estimatedFinishDate: '2026-04-10'
        },
        pending_callbacks: [],
        history: [
            { state: 'DRAFT',             event: null,               reason: 'CREATED', user: 'fuu',    stamp: now - 8 * DAY },
            { state: 'DEPOSIT_PENDING',   event: 'order_submitted',  reason: 'MANUAL',  user: 'fuu',    stamp: now - 8 * DAY },
            { state: 'DEPOSIT_CONFIRMED', event: 'payment_received', reason: 'MANUAL',  user: 'fuu',    stamp: now - 7 * DAY },
            { state: 'SOURCING',          event: 'erp_synced',       reason: 'AUTO',    user: 'system', stamp: now - 6 * DAY }
        ]
    },
    {
        id: 'FL-20260310-005',
        sourceId: 'ORD-2026-015',
        profileId: 'standard_trade',
        state: 'PACKING',
        prevState: 'SOURCING',
        stateChangedAt: now - 2 * DAY,
        createdAt: now - 14 * DAY,
        createdBy: 'fuu',
        meta: {
            customer: 'Abidjan Steel Works',
            incoterms: 'CFR',
            totalAmount: 2340000,
            deposit_required: 702000,
            amount_received: 702000,
            payment_status: 'SUCCESS',
            currency: 'XOF',
            erpOrderId: 'ERP-T20260310-014',
            packingPhotos: 5,
            notes: '组货中，预计 3 天完成'
        },
        pending_callbacks: [],
        history: [
            { state: 'DRAFT',             event: null,               reason: 'CREATED', user: 'fuu',    stamp: now - 14 * DAY },
            { state: 'DEPOSIT_PENDING',   event: 'order_submitted',  reason: 'MANUAL',  user: 'fuu',    stamp: now - 14 * DAY },
            { state: 'DEPOSIT_CONFIRMED', event: 'payment_received', reason: 'MANUAL',  user: 'fuu',    stamp: now - 12 * DAY },
            { state: 'SOURCING',          event: 'erp_synced',       reason: 'AUTO',    user: 'system', stamp: now - 12 * DAY },
            { state: 'PACKING',           event: 'goods_ready',      reason: 'MANUAL',  user: 'fuu',    stamp: now - 2 * DAY }
        ]
    },
    {
        id: 'FL-20260301-006',
        sourceId: 'ORD-2026-016',
        profileId: 'standard_trade',
        state: 'SHIPPED',
        prevState: 'PACKING',
        stateChangedAt: now - 3 * DAY,
        createdAt: now - 22 * DAY,
        createdBy: 'fuu',
        meta: {
            customer: 'Nairobi Hardware Group',
            incoterms: 'CIF',
            totalAmount: 925000,
            deposit_required: 277500,
            amount_received: 277500,
            payment_status: 'SUCCESS',
            currency: 'USD',
            erpOrderId: 'ERP-T20260301-007',
            vessel: 'COSCO Shipping Rose',
            containerNo: 'CSNU7401832',
            eta: '2026-04-18'
        },
        pending_callbacks: [],
        history: [
            { state: 'DRAFT',             event: null,               reason: 'CREATED', user: 'fuu',    stamp: now - 22 * DAY },
            { state: 'DEPOSIT_PENDING',   event: 'order_submitted',  reason: 'MANUAL',  user: 'fuu',    stamp: now - 22 * DAY },
            { state: 'DEPOSIT_CONFIRMED', event: 'payment_received', reason: 'MANUAL',  user: 'fuu',    stamp: now - 20 * DAY },
            { state: 'SOURCING',          event: 'erp_synced',       reason: 'AUTO',    user: 'system', stamp: now - 20 * DAY },
            { state: 'PACKING',           event: 'goods_ready',      reason: 'MANUAL',  user: 'fuu',    stamp: now - 10 * DAY },
            { state: 'SHIPPED',           event: 'packing_done',     reason: 'MANUAL',  user: 'fuu',    stamp: now - 3 * DAY }
        ]
    },
    {
        id: 'FL-20260220-007',
        sourceId: 'ORD-2026-007',
        profileId: 'standard_trade',
        state: 'DELIVERED',
        prevState: 'SHIPPED',
        stateChangedAt: now - 1 * DAY,
        createdAt: now - 32 * DAY,
        createdBy: 'fuu',
        meta: {
            customer: 'Lomé Pharma Supply',
            incoterms: 'DDP',
            totalAmount: 740000,
            deposit_required: 222000,
            amount_received: 222000,
            payment_status: 'SUCCESS',
            currency: 'XOF',
            erpOrderId: 'ERP-T20260220-002',
            vessel: 'MSC Federica',
            containerNo: 'MSCU3812044',
            eta: '2026-03-24',
            notes: '货物已到港，等待客户提货确认'
        },
        pending_callbacks: [],
        history: [
            { state: 'DRAFT',             event: null,               reason: 'CREATED', user: 'fuu',    stamp: now - 32 * DAY },
            { state: 'DEPOSIT_PENDING',   event: 'order_submitted',  reason: 'MANUAL',  user: 'fuu',    stamp: now - 32 * DAY },
            { state: 'DEPOSIT_CONFIRMED', event: 'payment_received', reason: 'MANUAL',  user: 'fuu',    stamp: now - 30 * DAY },
            { state: 'SOURCING',          event: 'erp_synced',       reason: 'AUTO',    user: 'system', stamp: now - 30 * DAY },
            { state: 'PACKING',           event: 'goods_ready',      reason: 'MANUAL',  user: 'fuu',    stamp: now - 20 * DAY },
            { state: 'SHIPPED',           event: 'packing_done',     reason: 'MANUAL',  user: 'fuu',    stamp: now - 14 * DAY },
            { state: 'DELIVERED',         event: 'delivery_confirmed', reason: 'MANUAL', user: 'fuu',   stamp: now - 1 * DAY }
        ]
    },
    {
        id: 'FL-20260210-008',
        sourceId: 'ORD-2026-008',
        profileId: 'standard_trade',
        state: 'AFTER_SALES',
        prevState: 'DELIVERED',
        stateChangedAt: now - 2 * DAY,
        createdAt: now - 40 * DAY,
        createdBy: 'fuu',
        meta: {
            customer: 'Cotonou Port Logistics',
            incoterms: 'FOB',
            totalAmount: 1100000,
            deposit_required: 330000,
            amount_received: 330000,
            payment_status: 'SUCCESS',
            currency: 'XOF',
            erpOrderId: 'ERP-T20260210-005',
            issue: '客户反映部分货物包装破损，正在跟进补货方案'
        },
        pending_callbacks: [],
        history: [
            { state: 'DRAFT',             event: null,               reason: 'CREATED', user: 'fuu',    stamp: now - 40 * DAY },
            { state: 'DEPOSIT_PENDING',   event: 'order_submitted',  reason: 'MANUAL',  user: 'fuu',    stamp: now - 40 * DAY },
            { state: 'DEPOSIT_CONFIRMED', event: 'payment_received', reason: 'MANUAL',  user: 'fuu',    stamp: now - 38 * DAY },
            { state: 'SOURCING',          event: 'erp_synced',       reason: 'AUTO',    user: 'system', stamp: now - 38 * DAY },
            { state: 'PACKING',           event: 'goods_ready',      reason: 'MANUAL',  user: 'fuu',    stamp: now - 28 * DAY },
            { state: 'SHIPPED',           event: 'packing_done',     reason: 'MANUAL',  user: 'fuu',    stamp: now - 22 * DAY },
            { state: 'DELIVERED',         event: 'delivery_confirmed', reason: 'MANUAL', user: 'fuu',   stamp: now - 8 * DAY },
            { state: 'AFTER_SALES',       event: 'issue_raised',     reason: 'MANUAL',  user: 'fuu',    stamp: now - 2 * DAY }
        ]
    },
    {
        id: 'FL-20260115-009',
        sourceId: 'ORD-2026-009',
        profileId: 'standard_trade',
        state: 'SETTLED',
        prevState: 'DELIVERED',
        stateChangedAt: now - 10 * DAY,
        createdAt: now - 60 * DAY,
        createdBy: 'fuu',
        meta: {
            customer: 'Douala Heavy Equipment',
            incoterms: 'CIF',
            totalAmount: 3200000,
            deposit_required: 960000,
            amount_received: 3200000,
            payment_status: 'SUCCESS',
            currency: 'XOF',
            erpOrderId: 'ERP-T20260115-001',
            notes: '尾款结清，订单完结'
        },
        pending_callbacks: [],
        history: [
            { state: 'DRAFT',             event: null,               reason: 'CREATED', user: 'fuu',    stamp: now - 60 * DAY },
            { state: 'DEPOSIT_PENDING',   event: 'order_submitted',  reason: 'MANUAL',  user: 'fuu',    stamp: now - 60 * DAY },
            { state: 'DEPOSIT_CONFIRMED', event: 'payment_received', reason: 'MANUAL',  user: 'fuu',    stamp: now - 58 * DAY },
            { state: 'SOURCING',          event: 'erp_synced',       reason: 'AUTO',    user: 'system', stamp: now - 58 * DAY },
            { state: 'PACKING',           event: 'goods_ready',      reason: 'MANUAL',  user: 'fuu',    stamp: now - 40 * DAY },
            { state: 'SHIPPED',           event: 'packing_done',     reason: 'MANUAL',  user: 'fuu',    stamp: now - 32 * DAY },
            { state: 'DELIVERED',         event: 'delivery_confirmed', reason: 'MANUAL', user: 'fuu',   stamp: now - 18 * DAY },
            { state: 'SETTLED',           event: 'settlement_done',  reason: 'MANUAL',  user: 'fuu',    stamp: now - 10 * DAY }
        ]
    },
    {
        id: 'FL-20260318-010',
        sourceId: 'ORD-2026-010',
        profileId: 'standard_trade',
        state: 'ON_HOLD',
        prevState: 'SOURCING',
        stateChangedAt: now - 2 * DAY,
        createdAt: now - 10 * DAY,
        createdBy: 'fuu',
        meta: {
            customer: 'Bamako Agri Supplies',
            incoterms: 'FOB',
            totalAmount: 560000,
            deposit_required: 168000,
            amount_received: 168000,
            payment_status: 'SUCCESS',
            currency: 'XOF',
            erpOrderId: 'ERP-T20260318-019',
            notes: '客户要求暂停，等待买方银行 LC 修改确认'
        },
        pending_callbacks: [],
        history: [
            { state: 'DRAFT',             event: null,               reason: 'CREATED', user: 'fuu',    stamp: now - 10 * DAY },
            { state: 'DEPOSIT_PENDING',   event: 'order_submitted',  reason: 'MANUAL',  user: 'fuu',    stamp: now - 10 * DAY },
            { state: 'DEPOSIT_CONFIRMED', event: 'payment_received', reason: 'MANUAL',  user: 'fuu',    stamp: now - 8 * DAY },
            { state: 'SOURCING',          event: 'erp_synced',       reason: 'AUTO',    user: 'system', stamp: now - 8 * DAY },
            { state: 'ON_HOLD',           event: 'hold_requested',   reason: 'MANUAL',  user: 'fuu',    stamp: now - 2 * DAY }
        ]
    },
    {
        id: 'FL-20260320-011',
        sourceId: 'ORD-2026-011b',
        profileId: 'standard_trade',
        state: 'CANCELLED',
        prevState: 'DEPOSIT_PENDING',
        stateChangedAt: now - 3 * DAY,
        createdAt: now - 5 * DAY,
        createdBy: 'fuu',
        meta: {
            customer: '佛山五金批发',
            incoterms: 'EXW',
            totalAmount: 4500000,
            deposit_required: 1350000,
            amount_received: 0,
            currency: 'CNY',
            notes: '客户主动取消，项目推迟'
        },
        pending_callbacks: [],
        history: [
            { state: 'DRAFT',           event: null,              reason: 'CREATED',         user: 'fuu', stamp: now - 5 * DAY },
            { state: 'DEPOSIT_PENDING', event: 'order_submitted', reason: 'MANUAL',           user: 'fuu', stamp: now - 5 * DAY },
            { state: 'CANCELLED',       event: 'cancel_requested', reason: 'CUSTOMER_REQUEST', user: 'fuu', stamp: now - 3 * DAY }
        ]
    }
];

// --- Main ---

async function main() {
    console.log(`\n🌱 Seeding fulfillment demo data → ${REDIS_URL}\n`);

    const client = redis.createClient({ url: REDIS_URL });
    client.on('error', err => console.error('Redis error:', err.message));
    await client.connect();

    // 1. Write profile
    await client.set(`${PROFILE_PREFIX}standard_trade`, JSON.stringify(STANDARD_TRADE_PROFILE));
    await client.sAdd(PROFILE_INDEX, 'standard_trade');
    console.log('  ✅ Profile "standard_trade" written (v2.0.0, 11 states)');

    // 2. Write instances
    for (const inst of DEMO_INSTANCES) {
        await client.set(`${PREFIX}${inst.id}`, JSON.stringify(inst));
        await client.sAdd(INDEX, inst.id);
        console.log(`  📦 ${inst.id} | ${inst.state.padEnd(20)} | ${inst.meta.customer}`);
    }

    await client.quit();
    console.log(`\n✅ Done! 1 profile + ${DEMO_INSTANCES.length} instances seeded (all 11 states covered).\n`);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
