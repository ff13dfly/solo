/**
 * Nexus Pipeline Integration Test
 *
 * Verifies the full path:
 *   orchestrator XADD → nexus stream consumer → notification.send → agent inbox
 *
 * Prerequisites:
 *   - Solo services running (deploy/dev.sh)
 *   - system.nexus bot token bootstrapped (docs/runbook/bot-bootstrap.md)
 *   - Test agent registered (setup phase below)
 *
 * Usage — run in order:
 *   node core/nexus/tests/pipeline.integration.js setup    # write test agent to Redis
 *   node core/nexus/tests/pipeline.integration.js trigger  # XADD event (nexus picks up)
 *   node core/nexus/tests/pipeline.integration.js verify   # check notification inbox
 *   node core/nexus/tests/pipeline.integration.js cleanup  # remove all test data
 *
 * Why split? Nexus consumer group starts at '$' (last message at startup).
 * The XADD must happen AFTER nexus is running, otherwise the event is
 * invisible to the consumer group.
 *
 * Redis: redis://localhost:6699
 */

const { createClient } = require('redis');
const crypto = require('crypto');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6699';

const TEST_AGENT_ID = 'test-nexus-pipeline-agent';
const TEST_STREAM   = 'EVENT:WORKFLOW:RESULT';

const NEXUS = {
    agentKey: `NEXUS:SENTINEL:${TEST_AGENT_ID}`,
    sentinelSet: 'NEXUS:SENTINEL:SET',
    subKey:   `NEXUS:SUB:${TEST_STREAM}`,
};
const NOTIFICATION = {
    inboxKey:  `NOTIFICATION:INBOX:${TEST_AGENT_ID}`,
    msgPrefix: 'NOTIFICATION:MSG:',
};

function msgId() { return crypto.randomBytes(8).toString('hex'); }
function sep(label) { console.log(`\n${'─'.repeat(60)}\n  ${label}\n${'─'.repeat(60)}`); }

// ─── phases ───────────────────────────────────────────────────────────────────

async function setup(redis) {
    sep('SETUP — writing test agent to Redis');

    const profile = {
        id:                 TEST_AGENT_ID,
        name:               '[TEST] Nexus Pipeline Probe',
        description:        'Temporary agent for pipeline verification — safe to delete',
        authorityRole:      'test:nexus_pipeline',
        track:              'internal',
        eventSubscriptions: [TEST_STREAM],
        reachability:       'polling',
        webhookUrl:         null,
        status:             'ACTIVE',
        lastSeenAt:         null,
        createdAt:          Date.now(),
    };

    await redis.set(NEXUS.agentKey, JSON.stringify(profile));
    await redis.sAdd(NEXUS.sentinelSet, TEST_AGENT_ID);
    await redis.sAdd(NEXUS.subKey, TEST_AGENT_ID);

    console.log(`  ✓ NEXUS:SENTINEL:${TEST_AGENT_ID}`);
    console.log(`  ✓ ${NEXUS.sentinelSet}  ← ${TEST_AGENT_ID}`);
    console.log(`  ✓ ${NEXUS.subKey}  ← ${TEST_AGENT_ID}`);
    console.log('\n  Next: run trigger.');
}

async function trigger(redis) {
    sep('TRIGGER — XADD to ' + TEST_STREAM);

    let groupExists = false;
    try {
        const groups = await redis.xInfoGroups(TEST_STREAM);
        groupExists = groups.some(g => g.name === 'nexus');
    } catch (_) {
        // stream may not exist yet
    }

    if (!groupExists) {
        console.log('  ✗ Nexus consumer group not found on stream.');
        console.log('    → Start Solo services first, then re-run trigger.');
        return;
    }

    const entryId = await redis.xAdd(TEST_STREAM, '*', {
        workflow_id: 'wf-test-001',
        status:      'completed',
        message_id:  msgId(),
        timestamp:   String(Date.now()),
    });

    console.log(`  ✓ Consumer group "nexus" confirmed`);
    console.log(`  ✓ XADD ${TEST_STREAM}  →  entry-id: ${entryId}`);
    console.log('\n  Nexus should process within 5 s. Then run verify.');
}

async function verify(redis) {
    sep('VERIFY — checking notification inbox');

    const msgIds = await redis.zRange(NOTIFICATION.inboxKey, 0, -1, { REV: true });

    if (msgIds.length === 0) {
        console.log('  ✗ Inbox is empty.');
        console.log('    Possible causes:');
        console.log('      • Nexus or notification service not running');
        console.log('      • system.nexus relay token not injected (run bot bootstrap)');
        console.log('      • trigger not run yet, or event not yet processed');
        return false;
    }

    console.log(`  ✓ Inbox has ${msgIds.length} message(s):\n`);
    for (const mid of msgIds) {
        const raw = await redis.get(NOTIFICATION.msgPrefix + mid);
        if (!raw) continue;
        const msg = JSON.parse(raw);
        console.log(`    ┌─ id:       ${msg.id}`);
        console.log(`    │  type:     ${msg.type}`);
        console.log(`    │  status:   ${msg.status}`);
        console.log(`    │  sourceId: ${msg.sourceId}`);
        console.log(`    │  payload:  ${JSON.stringify(msg.payload)}`);
        console.log(`    └─ created:  ${new Date(msg.createdAt).toISOString()}\n`);
    }

    console.log('  Pipeline verified. Run cleanup when done:');
    console.log('    node core/nexus/tests/pipeline.integration.js cleanup');
    return true;
}

async function cleanup(redis) {
    sep('CLEANUP — removing all test data');

    await redis.del(NEXUS.agentKey);
    await redis.sRem(NEXUS.sentinelSet, TEST_AGENT_ID);
    await redis.sRem(NEXUS.subKey, TEST_AGENT_ID);

    const msgIds = await redis.zRange(NOTIFICATION.inboxKey, 0, -1);
    for (const mid of msgIds) {
        await redis.del(NOTIFICATION.msgPrefix + mid);
    }
    await redis.del(NOTIFICATION.inboxKey);

    console.log(`  ✓ Removed agent and subscription entries`);
    console.log(`  ✓ Removed ${msgIds.length} inbox message(s)`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

const PHASES = { setup, trigger, verify, cleanup };
const phase = process.argv[2];

if (!phase || !PHASES[phase]) {
    console.log('Usage: node core/nexus/tests/pipeline.integration.js <setup|trigger|verify|cleanup>');
    process.exit(1);
}

(async () => {
    const redis = createClient({ url: REDIS_URL });
    redis.on('error', e => { console.error('Redis error:', e.message); process.exit(1); });
    await redis.connect();
    console.log(`Redis: ${REDIS_URL}`);

    try {
        await PHASES[phase](redis);
    } finally {
        await redis.disconnect();
    }
})();
