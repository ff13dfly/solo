#!/usr/bin/env node
//
// inject-workflows.js — directly seed the event-test mock workflows into Redis
// (DEV ONLY). Simulates the state AFTER an AI has authored workflows: they land
// in PENDING_REVIEW, ready for a human to approve in Portal → Workflows.
//
// What it does:
//   1. Reads deploy/mock/workflows/*.json (the "AI-designed" definitions).
//   2. Fills the full orchestrator workflow schema + lifecycle fields and writes
//      each as a RedisJSON doc at ORCHESTRATOR:WORKFLOW:{id} (status PENDING_REVIEW
//      by default — orchestrator has NO index set, the doc alone is enough).
//   3. Writes the event-registry OVERRIDE to Redis (SYSTEM:CONFIG:EVENT_REGISTRY) =
//      the framework defaults MERGED with collection + market sources, so their
//      _event piggyback events pass the Router whitelist. Framework config is left
//      untouched; the override is dev-runtime state the Router picks up (~60s cache).
//
// Why direct injection: bypasses the create() RPC (which forces PENDING_REVIEW and
// is admin-gated anyway) and lets us set event_subscriptions (create() doesn't store
// it, but the matcher reads it from the doc).
//
// Usage:
//   node deploy/mock/inject-workflows.js            # inject as PENDING_REVIEW + registry
//   node deploy/mock/inject-workflows.js --active   # inject as ACTIVE (skip approval, run immediately)
//   node deploy/mock/inject-workflows.js --clean     # remove the injected workflows + registry override
//
// Prereq: dev stack running with redis-stack on 6699 (bash deploy/dev.sh) — RedisJSON required.
//
const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, '..', '..', 'api');
const { createClient } = require(path.join(API_DIR, 'node_modules', 'redis'));
const routerConfig = require(path.join(API_DIR, 'router', 'config.js'));

const WF_DIR = path.join(__dirname, 'workflows');
const WF_PREFIX = 'ORCHESTRATOR:WORKFLOW:';
const WF_INDEX = 'ORCHESTRATOR:WORKFLOW_INDEX';   // orchestrator 现用 SMEMBERS(非 KEYS)发现 workflow
const REGISTRY_KEY = routerConfig.redis.eventRegistryKey; // SYSTEM:CONFIG:EVENT_REGISTRY
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6699';

const argv = process.argv.slice(2);
const ACTIVE = argv.includes('--active');
const CLEAN = argv.includes('--clean');
// --only=<id>[,<id>…] — inject just these workflow ids. The e2e harness uses this:
// the full 5-workflow event chain, left ACTIVE for a whole run, cascades on every
// PAYMENT/SHIPMENT event and pollutes unrelated suites' keyspace/WAL assertions.
const ONLY = (() => {
    const eq = argv.find(a => a.startsWith('--only='));
    if (eq) return new Set(eq.slice('--only='.length).split(',').filter(Boolean));
    const i = argv.indexOf('--only');
    if (i >= 0 && argv[i + 1]) return new Set(argv[i + 1].split(',').filter(Boolean));
    return null;
})();

// Registry entries the event-test fixtures (collection, market) need so their
// _event piggyback events are not BLOCKED by the Router whitelist.
const FIXTURE_REGISTRY = {
    collection: { 'EVENT:PAYMENT:RECEIVED': ['payment.received'], 'EVENT:PAYMENT:SETTLED': ['payment.settled'] },
    market:     { 'EVENT:SHIPMENT:CREATED': ['shipment.created'], 'EVENT:SHIPMENT:SHIPPED': ['shipment.shipped'] },
};

function loadDefs() {
    return fs.readdirSync(WF_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .map(f => JSON.parse(fs.readFileSync(path.join(WF_DIR, f), 'utf8')))
        .filter(def => !ONLY || ONLY.has(def.id));
}

// Fill the full live-schema workflow object (mirrors orchestrator create() defaults).
function toWorkflow(def, now) {
    return {
        id: def.id,
        category: def.category || 'event-test',
        priority: def.priority || 50,
        name: def.name,
        desc: def.desc || '',
        tags: def.tags || [],
        examples: def.examples || [],
        negative: def.negative || [],
        keywords: def.keywords || [],
        required_inputs: def.required_inputs || [],
        optional_inputs: def.optional_inputs || [],
        synonyms: def.synonyms || {},
        steps: def.steps || [],
        resolvers: def.resolvers || {},
        allowed_triggers: def.allowed_triggers || ['event'],
        event_subscriptions: def.event_subscriptions || [],   // create() omits this; matcher reads it
        status: ACTIVE ? 'ACTIVE' : 'PENDING_REVIEW',
        submittedBy: 'ai-agent',                              // simulate AI authorship (≠ approver, so approve() works)
        approvals: [],
        createdAt: now,
        updatedAt: now,
    };
}

(async () => {
    const client = createClient({ url: REDIS_URL });
    client.on('error', (e) => console.error('redis error:', e.message));
    await client.connect();
    const now = Date.now();
    const defs = loadDefs();

    try {
        if (CLEAN) {
            for (const def of defs) { await client.del(WF_PREFIX + def.id); await client.sRem(WF_INDEX, def.id); }
            await client.del(REGISTRY_KEY);
            console.log(`✓ removed ${defs.length} workflow(s) + event-registry override (Router falls back to framework default within ~60s).`);
            return;
        }

        for (const def of defs) {
            const wf = toWorkflow(def, now);
            await client.json.set(WF_PREFIX + def.id, '$', wf);
            await client.sAdd(WF_INDEX, def.id);   // 维护 index set(matcher 靠它发现 workflow)
            console.log(`  ✓ ${wf.id}  [${wf.status}]  ${wf.event_subscriptions.map(s => s.stream).join(',')} → ${wf.steps.map(s => s.method).join(',')}`);
        }

        // Merge framework defaults + fixtures, write the override (plain string; events.js does get+JSON.parse).
        const merged = { ...routerConfig.eventRegistry, ...FIXTURE_REGISTRY };
        await client.set(REGISTRY_KEY, JSON.stringify(merged));
        console.log(`\n✓ injected ${defs.length} workflow(s) as ${ACTIVE ? 'ACTIVE' : 'PENDING_REVIEW'}.`);
        console.log(`✓ event-registry override written (${Object.keys(merged).join(', ')}).`);
        if (!ACTIVE) {
            console.log(`\nNext: Portal → Workflows → APPROVE each (a different user than 'ai-agent') to flip PENDING_REVIEW → ACTIVE.`);
            console.log(`Then fire the chain:  node deploy/mock/simulate.js stripe --direct`);
        } else {
            console.log(`\nFire the chain:  node deploy/mock/simulate.js stripe --direct`);
        }
    } finally {
        await client.quit();
    }
})().catch(e => { console.error('✗', e.message); process.exit(1); });
