#!/usr/bin/env node
/**
 * Patch foreign_trade_v1 profile: rebuild transitions to match current states
 *
 * States: DRAFT → DEPOSIT_PENDING → DEPOSIT_CONFIRMED → SOURCING → PACKING
 *         → SHIPPED → AFTER_SALES → CANCELLED
 *         + ON_HOLD (暂停，可从多个状态进入)
 *
 * Usage: node patch-foreign-trade-transitions.js [--url redis://host:port]
 */

const redis = require('redis');

const REDIS_URL = process.argv.includes('--url')
    ? process.argv[process.argv.indexOf('--url') + 1]
    : process.env.REDIS_URL || 'redis://localhost:6379';

const PROFILE_KEY = 'FULFILLMENT:PROFILE:foreign_trade_v1';

const NEW_TRANSITIONS = [
    // ── 主线流程 ──────────────────────────────────────────────────────────────
    {
        event: 'order_submitted',
        from: 'DRAFT',
        to: 'DEPOSIT_PENDING'
    },
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
    {
        event: 'sourcing_started',
        from: 'DEPOSIT_CONFIRMED',
        to: 'SOURCING'
    },
    {
        event: 'goods_ready',
        from: 'SOURCING',
        to: 'PACKING'
    },
    {
        event: 'shipped',
        from: 'PACKING',
        to: 'SHIPPED'
    },
    // ── 售后分支 ──────────────────────────────────────────────────────────────
    {
        event: 'issue_raised',
        from: 'SHIPPED',
        to: 'AFTER_SALES'
    },
    {
        event: 'issue_resolved',
        from: 'AFTER_SALES',
        to: 'SHIPPED'
    },
    // ── 暂停 / 恢复 ───────────────────────────────────────────────────────────
    {
        event: 'hold_requested',
        from: 'SOURCING',
        to: 'ON_HOLD'
    },
    {
        event: 'hold_requested',
        from: 'PACKING',
        to: 'ON_HOLD'
    },
    {
        event: 'hold_requested',
        from: 'DEPOSIT_CONFIRMED',
        to: 'ON_HOLD'
    },
    {
        event: 'resume',
        from: 'ON_HOLD',
        to: 'SOURCING'
    },
    // ── 取消 ──────────────────────────────────────────────────────────────────
    {
        event: 'cancel_requested',
        from: 'DRAFT',
        to: 'CANCELLED'
    },
    {
        event: 'cancel_requested',
        from: 'DEPOSIT_PENDING',
        to: 'CANCELLED'
    },
    {
        event: 'cancel_requested',
        from: 'DEPOSIT_CONFIRMED',
        to: 'CANCELLED'
    }
];

async function main() {
    const client = redis.createClient({ url: REDIS_URL });
    client.on('error', err => console.error('Redis error:', err.message));
    await client.connect();

    const raw = await client.get(PROFILE_KEY);
    if (!raw) {
        console.error(`❌ Key not found: ${PROFILE_KEY}`);
        await client.quit();
        process.exit(1);
    }

    const profile = JSON.parse(raw);
    console.log(`\n📋 Current profile: ${profile.name}`);
    console.log(`   States  : ${profile.states?.join(', ')}`);
    console.log(`   Old transitions count: ${profile.transitions?.length ?? 0}`);

    profile.transitions = NEW_TRANSITIONS;
    profile.updatedAt = Date.now();

    await client.set(PROFILE_KEY, JSON.stringify(profile));
    console.log(`\n✅ Transitions rebuilt (${NEW_TRANSITIONS.length} rules):`);
    for (const t of NEW_TRANSITIONS) {
        console.log(`   ${t.from.padEnd(20)} → ${t.to.padEnd(20)}  [${t.event}]`);
    }

    await client.quit();
    console.log('\nDone.\n');
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
