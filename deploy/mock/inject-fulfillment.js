#!/usr/bin/env node
/**
 * deploy/mock/inject-fulfillment.js — dev-only fulfillment sample seeder
 *
 * Seeds ONE realistic order-fulfillment profile + a handful of instances spread
 * across its states, so the operator portal's fulfillment board has real data to
 * render (Redis runs with --save "" in dev, so this re-runs on every boot).
 *
 * Seeds via RPC (not direct Redis writes): fulfillment.profile.create persists
 * rich fields (states / state_meta / meta_fields — verified), and walking
 * instance.transition through the real engine produces genuine history entries
 * AND emits EVENT:FULFILLMENT:TRANSITIONED onto the bus — which also gives the
 * system portal's STREAM LOG tab live data.
 *
 * States/meta are aligned with what the operator UI actually renders:
 *   board columns  — FulfillmentBoard.tsx STATES (DRAFT…SETTLED/ON_HOLD/CANCELLED)
 *   card title     — meta.customer; amount — meta.totalAmount + meta.currency;
 *   tag            — meta.incoterms; SHIPPED extras — meta.vessel/containerNo/eta
 *
 * Idempotent: skips seeding when the profile already has SO-DEMO-* instances.
 * Invoked by dev.sh in the background; safe to run manually any time.
 */
const http = require('http');

const ROUTER_URL = process.env.ROUTER_URL || 'http://127.0.0.1:8600';
const RPC_URL    = `${ROUTER_URL}/jsonrpc`;
const DEV_TOKEN  = 'solo-dev-admin';   // dev session seeded by deploy/seed-bots.js

const PROFILE_ID = 'standard-order';

// ── the sample profile (SOLO-clean: no erp.* methods, no dead actions) ──

const PROFILE = {
    id: PROFILE_ID,
    name: '标准订单履约',
    // Subset of the board's hardcoded columns so every state is visible there.
    states: ['DRAFT', 'DEPOSIT_PENDING', 'DEPOSIT_CONFIRMED', 'SOURCING', 'PACKING', 'SHIPPED', 'DELIVERED', 'SETTLED'],
    state_meta: {
        DRAFT:             { label: { zh: '草稿',     en: 'Draft' } },
        DEPOSIT_PENDING:   { label: { zh: '待付订金', en: 'Deposit pending' } },
        DEPOSIT_CONFIRMED: { label: { zh: '订金到账', en: 'Deposit confirmed' } },
        SOURCING:          { label: { zh: '备货中',   en: 'Sourcing' } },
        PACKING:           { label: { zh: '打包中',   en: 'Packing' } },
        SHIPPED:           { label: { zh: '已发运',   en: 'Shipped' } },
        DELIVERED:         { label: { zh: '已送达',   en: 'Delivered' } },
        SETTLED:           { label: { zh: '已结清',   en: 'Settled' } },
    },
    meta_fields: [
        { key: 'customer',         label: '客户' },
        { key: 'totalAmount',      label: '订单金额' },
        { key: 'currency',         label: '币种' },
        { key: 'incoterms',        label: '贸易条款' },
        { key: 'deposit_required', label: '需付订金' },
        { key: 'total_required',   label: '应付总额' },
        { key: 'amount_received',  label: '已到账金额' },
        { key: 'tracking_number',  label: '物流单号' },
    ],
    transitions: [
        { event: 'order_submitted',  from: 'DRAFT',             to: 'DEPOSIT_PENDING',   condition: null, actions: [] },
        // 订金到账才能确认 —— JsonLogic 条件演示(detail modal 的转移按钮会真实受它约束)
        { event: 'deposit_received', from: 'DEPOSIT_PENDING',   to: 'DEPOSIT_CONFIRMED',
          condition: { '>=': [{ var: 'instance.meta.amount_received' }, { var: 'instance.meta.deposit_required' }] }, actions: [] },
        { event: 'sourcing_started', from: 'DEPOSIT_CONFIRMED', to: 'SOURCING',          condition: null, actions: [] },
        { event: 'packing_started',  from: 'SOURCING',          to: 'PACKING',           condition: null, actions: [] },
        // 有物流单号才能发运
        { event: 'dispatched',       from: 'PACKING',           to: 'SHIPPED',
          condition: { '!!': [{ var: 'instance.meta.tracking_number' }] }, actions: [] },
        { event: 'delivered',        from: 'SHIPPED',           to: 'DELIVERED',         condition: null, actions: [] },
        // 全款到账才能结清
        { event: 'settled',          from: 'DELIVERED',         to: 'SETTLED',
          condition: { '>=': [{ var: 'instance.meta.amount_received' }, { var: 'instance.meta.total_required' }] }, actions: [] },
    ],
};

// ── instances: sourceId + base meta + the transition walk that places each one ──

const INSTANCES = [
    { sourceId: 'SO-DEMO-001', meta: { customer: 'Acme Trading GmbH',  totalAmount: 48000, currency: 'USD', incoterms: 'FOB', deposit_required: 14400, total_required: 48000, amount_received: 0 },
      walk: [] },                                                                       // DRAFT
    { sourceId: 'SO-DEMO-002', meta: { customer: 'Nordwind AB',        totalAmount: 12500, currency: 'EUR', incoterms: 'EXW', deposit_required: 3750,  total_required: 12500, amount_received: 0 },
      walk: [{ event: 'order_submitted' }] },                                           // DEPOSIT_PENDING
    { sourceId: 'SO-DEMO-003', meta: { customer: 'Kowalski Sp. z o.o.', totalAmount: 30000, currency: 'USD', incoterms: 'CIF', deposit_required: 9000, total_required: 30000, amount_received: 0 },
      walk: [{ event: 'order_submitted' },
             { event: 'deposit_received', metaUpdate: { amount_received: 9000 } }] },   // DEPOSIT_CONFIRMED
    { sourceId: 'SO-DEMO-004', meta: { customer: 'Sakura Trading KK',  totalAmount: 76000, currency: 'USD', incoterms: 'FOB', deposit_required: 22800, total_required: 76000, amount_received: 0 },
      walk: [{ event: 'order_submitted' },
             { event: 'deposit_received', metaUpdate: { amount_received: 22800 } },
             { event: 'sourcing_started' }] },                                          // SOURCING
    { sourceId: 'SO-DEMO-005', meta: { customer: 'Atlas Importers LLC', totalAmount: 22000, currency: 'USD', incoterms: 'DAP', deposit_required: 6600, total_required: 22000, amount_received: 0 },
      walk: [{ event: 'order_submitted' },
             { event: 'deposit_received', metaUpdate: { amount_received: 6600 } },
             { event: 'sourcing_started' },
             { event: 'packing_started' }] },                                           // PACKING
    { sourceId: 'SO-DEMO-006', meta: { customer: 'Helios Maritime SA', totalAmount: 95000, currency: 'USD', incoterms: 'CIF', deposit_required: 28500, total_required: 95000, amount_received: 0 },
      walk: [{ event: 'order_submitted' },
             { event: 'deposit_received', metaUpdate: { amount_received: 28500 } },
             { event: 'sourcing_started' },
             { event: 'packing_started' },
             { event: 'dispatched', metaUpdate: { tracking_number: 'MSKU1234567', vessel: 'MSC AURORA', containerNo: 'MSCU 882114-3', eta: '2026-07-02' } }] }, // SHIPPED
    { sourceId: 'SO-DEMO-007', meta: { customer: 'Rio Verde Ltda',     totalAmount: 18500, currency: 'USD', incoterms: 'FOB', deposit_required: 5550, total_required: 18500, amount_received: 0 },
      walk: [{ event: 'order_submitted' },
             { event: 'deposit_received', metaUpdate: { amount_received: 5550 } },
             { event: 'sourcing_started' },
             { event: 'packing_started' },
             { event: 'dispatched', metaUpdate: { tracking_number: 'COSU7758201' } },
             { event: 'delivered' }] },                                                 // DELIVERED
];

// ── helpers ───────────────────────────────────────────────────────────────────

function post(body) {
    return new Promise((resolve, reject) => {
        const raw = JSON.stringify(body);
        const req = http.request(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), 'Authorization': `Bearer ${DEV_TOKEN}` },
        }, (res) => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(raw);
        req.end();
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rpc(method, params) {
    const r = await post({ jsonrpc: '2.0', method, params, id: `fseed-${method}` });
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
}

// Same readiness lesson as seed-bots.js: "Router answers" ≠ "service routable" —
// at boot the Router accepts requests before downstream services finish their
// Z-handshake, so an RPC dies with "Method not found" until the owning service
// registers. Probe the actual method until it stops being not-found.
async function waitForMethod(method, maxWaitMs = 90_000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        try {
            const r = await post({ jsonrpc: '2.0', method, params: {}, id: 'fseed-probe' });
            if (r.result) return true;
            const msg = (r.error && r.error.message) || '';
            if (msg && !/not found/i.test(msg)) return true;   // any non-"not found" reply ⇒ routable
        } catch (_) {}
        await sleep(2000);
    }
    return false;
}

// ── the watcher sentinel: how fulfillment and nexus connect ──────────────────
//
// fulfillment emits EVENT:FULFILLMENT:TRANSITIONED on every state change (the
// instance.transition engine). This Sentinel subscribes to that stream and shows
// BOTH reaction knobs:
//   guard     — only wakes for THIS profile's transitions (standard-order)
//   emit_when — only emits a decision event when an order reaches SHIPPED,
//               onto EVENT:SENTINEL:SHIPMENT-WATCH (Router's default registry
//               already whitelists system.nexus → EVENT:SENTINEL:*).
// Every guarded delivery also lands in notification.send (audit inbox); the
// emitted decision event is visible in portal EVENT BUS → STREAM LOG.
// Needs RELAY:TOKEN:nexus (seeded by deploy/seed-bots.js).

const SENTINEL = {
    name: 'Shipment Watch (standard-order)',
    description: '盯标准订单履约的状态转移;订单发运(→SHIPPED)时在总线上发出决策事件',
    authorityRole: 'ops.shipment-watch',
    eventSubscriptions: ['EVENT:FULFILLMENT:TRANSITIONED'],
    context: {
        guard: { '==': [{ var: 'event.payload.profileId' }, PROFILE_ID] },
        emit: {
            stream: 'EVENT:SENTINEL:SHIPMENT-WATCH',
            type: 'sentinel.shipment.dispatched',
            emit_when: { '==': [{ var: 'event.payload.toState' }, 'SHIPPED'] },
            payload_template: {
                instanceId: '{{event.payload.instanceId}}',
                sourceId:   '{{event.payload.sourceId}}',
                fromState:  '{{event.payload.fromState}}',
                toState:    '{{event.payload.toState}}',
                profileId:  '{{event.payload.profileId}}',
            },
        },
    },
};

// ── §1.2 full-identity sentinel: fetches data + runs agent.decide under its OWN bot ──
//
// The realistic counterpart to the SHARED watcher above. When a deposit is confirmed
// it pulls the full instance (data_fetcher, under ITS OWN token), asks agent.decide
// to assess payment risk (autorun, closed choices approve/hold), and emits the
// STRUCTURED decision onto the bus. Exercises every §1.2 rail:
//   permit  — least-privilege bot (instance.get + agent.decide only), seeded below
//   token   — deliberately NOT injected: provisioning is the human step. BOT ACCOUNTS
//             shows the worklist banner → INJECT. Until then deliveries abort → DLQ
//             (no fallback to the broad nexus permit — that's the design).
//   degrade — no LLM key? agent.decide fail-softs to decision=defer/escalate=true,
//             still visible in the emitted event.

const RISK_BOT_UID = 'system.fulfillment-risk';
const RISK_BOT_PERMIT = {
    allow_all: false,
    services: {
        fulfillment: ['fulfillment.instance.get'],
        agent: ['agent.decide'],
    },
};

const RISK_SENTINEL = {
    name: 'Deposit Risk Review (standard-order)',
    description: '订金到账时拉取订单全貌,经 agent.decide 评估收款风险(approve/hold),把结构化决策发回总线。§1.2 全配置:自有 bot 身份 + 最小权限;token 需在 BOT ACCOUNTS 注入后才生效。',
    authorityRole: RISK_BOT_UID,
    eventSubscriptions: ['EVENT:FULFILLMENT:TRANSITIONED'],
    context: {
        guard: {
            and: [
                { '==': [{ var: 'event.payload.profileId' }, PROFILE_ID] },
                { '==': [{ var: 'event.payload.toState' }, 'DEPOSIT_CONFIRMED'] },
            ],
        },
        // Runs under the sentinel's OWN token (authorityRole is a system.* uid) —
        // default on_error=abort so a missing/expired token or permit gap surfaces
        // as retry→DLQ instead of being papered over.
        data_fetchers: [
            { key: 'instance', method: 'fulfillment.instance.get', params: { id: '{{event.payload.instanceId}}' } },
        ],
        system_prompt_template:
            '订单 {{event.payload.sourceId}}(客户 {{fetch.instance.meta.customer}})订金已确认到账。' +
            '订单金额 {{fetch.instance.meta.totalAmount}} {{fetch.instance.meta.currency}},贸易条款 {{fetch.instance.meta.incoterms}},' +
            '已收 {{fetch.instance.meta.amount_received}}。请评估收款风险并决定:approve = 放行进入备货;hold = 暂停并转人工复核。',
        autorun: { choices: ['approve', 'hold'], confidence_threshold: 0.7 },
        emit: {
            stream: 'EVENT:SENTINEL:RISK-REVIEW',
            type: 'sentinel.risk.assessed',
            payload_template: {
                instanceId: '{{event.payload.instanceId}}',
                sourceId:   '{{event.payload.sourceId}}',
                decision:   '{{output.decision}}',
                confidence: '{{output.confidence}}',
                escalate:   '{{output.escalate}}',
                reason:     '{{output.reason}}',
            },
        },
    },
};

// Retry helper for cold-boot ordering: the user service may register with the Router
// slightly after fulfillment does.
async function rpcWithRetry(method, params, tries = 10) {
    for (let i = 0; i < tries; i++) {
        try { return await rpc(method, params); }
        catch (e) {
            if (!/not found/i.test(e.message) || i === tries - 1) throw e;
            await sleep(2000);
        }
    }
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
    console.log('  [inject-fulfillment] waiting for fulfillment service...');
    if (!(await waitForMethod('fulfillment.profile.list'))) {
        console.error('  [inject-fulfillment] fulfillment not routable within 90 s — skipping');
        process.exit(0);
    }

    // ① Profile + instances (idempotent: skip when SO-DEMO instances already present).
    const existing = await rpc('fulfillment.instance.list', {}).catch(() => ({ items: [] }));
    if ((existing.items || []).some(i => String(i.sourceId || '').startsWith('SO-DEMO-'))) {
        console.log('  [inject-fulfillment] SO-DEMO instances already present — skipping profile/instances (idempotent)');
    } else {
        // Profile (create; if it survived a previous partial run, update instead).
        try {
            await rpc('fulfillment.profile.create', PROFILE);
            console.log(`  [inject-fulfillment] ✓ profile ${PROFILE_ID} created (${PROFILE.states.length} states / ${PROFILE.transitions.length} transitions)`);
        } catch (e) {
            if (/exist/i.test(e.message)) {
                const { id, ...changes } = PROFILE;
                await rpc('fulfillment.profile.update', { id, ...changes });
                console.log(`  [inject-fulfillment] ✓ profile ${PROFILE_ID} updated (already existed)`);
            } else { throw e; }
        }

        // Instances: create at DRAFT, then walk the real engine (emits TRANSITIONED events).
        for (const spec of INSTANCES) {
            const inst = await rpc('fulfillment.instance.create', { sourceId: spec.sourceId, profileId: PROFILE_ID, meta: spec.meta });
            let state = inst.state;
            for (const step of spec.walk) {
                const r = await rpc('fulfillment.instance.transition', { id: inst.id, event: step.event, ...(step.metaUpdate ? { metaUpdate: step.metaUpdate } : {}) });
                state = r.state;
            }
            console.log(`  [inject-fulfillment] ✓ ${spec.sourceId} → ${state}  (${inst.id}, ${spec.meta.customer})`);
        }
        console.log(`  [inject-fulfillment] ✓ ${INSTANCES.length} instances across the board`);
    }

    // ② + ③ Sentinels — gate on nexus being routable. The §1.2 risk sentinel also
    // touches the user service (user.bot.create). Probe BOTH before any sentinel RPC:
    // the previous bug let nexus.sentinel.list's not-found get swallowed, then
    // nexus.sentinel.create died and the whole seed exited (sentinels left empty).
    if (!(await waitForMethod('nexus.sentinel.list')) || !(await waitForMethod('user.bot.list'))) {
        console.error('  [inject-fulfillment] nexus/user not routable within 90 s — skipping sentinels');
        console.log('  [inject-fulfillment] DONE (profile/instances only)');
        process.exit(0);
    }

    // ② Watcher sentinel (own idempotency: by name).
    const sentinels = await rpc('nexus.sentinel.list', { page: 1, pageSize: 100 }).catch(() => ({ items: [] }));
    if ((sentinels.items || []).some(s => s.name === SENTINEL.name)) {
        console.log('  [inject-fulfillment] sentinel already present — skipping (idempotent)');
    } else {
        const s = await rpc('nexus.sentinel.create', SENTINEL);
        console.log(`  [inject-fulfillment] ✓ sentinel "${SENTINEL.name}" created (${s.id}) — watching EVENT:FULFILLMENT:TRANSITIONED`);
    }

    // ③ §1.2 risk-review sentinel + its least-privilege bot (idempotent by name).
    //    Token is deliberately NOT injected — BOT ACCOUNTS shows the provisioning
    //    banner; INJECT there completes the chain.
    if ((sentinels.items || []).some(s => s.name === RISK_SENTINEL.name)) {
        console.log('  [inject-fulfillment] risk sentinel already present — skipping (idempotent)');
    } else {
        try {
            await rpcWithRetry('user.bot.create', { uid: RISK_BOT_UID, permit: RISK_BOT_PERMIT, desc: 'sentinel identity: Deposit Risk Review (least-privilege: instance.get + agent.decide)' });
        } catch (e) {
            if (!/exist/i.test(e.message)) throw e;
        }
        // Overwrite permit on re-runs (mirrors seed-bots create→update pattern).
        await rpc('user.bot.update', { uid: RISK_BOT_UID, permit: RISK_BOT_PERMIT });
        const rs = await rpc('nexus.sentinel.create', RISK_SENTINEL);
        console.log(`  [inject-fulfillment] ✓ risk sentinel "${RISK_SENTINEL.name}" created (${rs.id})`);
        console.log(`  [inject-fulfillment]   bot ${RISK_BOT_UID} seeded (permit: instance.get + agent.decide) — token NOT injected:`);
        console.log('  [inject-fulfillment]   → system portal BOT ACCOUNTS will show the provisioning banner; INJECT to arm it.');
    }

    console.log('  [inject-fulfillment] DONE');
})().catch((e) => {
    console.error('  [inject-fulfillment] FAILED:', e.message);
    process.exit(1);
});
